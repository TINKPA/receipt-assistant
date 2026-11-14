/**
 * The merchant's place, as the server applier writes it (wave 1, X5;
 * docs/server-writer.md, "The place").
 *
 * The record names a Google place id (the agent's Phase 3a judgment); the
 * server fetches, projects, stores and links it. Two halves, because one
 * of them is a network call and the apply transaction must never wait on
 * Google:
 *
 *   prefetchPlace  OUTSIDE any transaction. A place already in `places`
 *                  is a cache hit and nothing is fetched. A miss is
 *                  fetched with `fetchPlaceV1Dual` (en + zh-CN, the v1
 *                  envelope refresh already stores). A missing key or a
 *                  failed fetch is the warning `place_fetch_failed`, and
 *                  the apply goes on without a place.
 *
 *   writePlace     INSIDE the apply transaction.
 *                  Cache hit: `hit_count + 1`, `last_seen_at = now()`,
 *                  nothing else. `raw_response` is untouched and no
 *                  snapshot is written (#264: the legacy upsert replaced
 *                  the cached body and wrote a snapshot on every visit).
 *                  Miss with a fetched envelope: INSERT with the
 *                  `projectPlace` columns (src/projection/derive.ts, the
 *                  one place-naming rule set) and the envelope as
 *                  `raw_response`, plus ONE `place_snapshots` row. An
 *                  envelope that cannot fill the NOT NULL columns
 *                  (address, latitude, longitude) is `place_not_projectable`
 *                  and links nothing. A row another apply inserted
 *                  meanwhile turns the insert into a hit.
 *
 * `custom_name` is never written (Layer 3). The receipt's own Chinese name
 * (`merchant.name_zh_printed`, Phase 3e) goes in as `receipt_ocr` only
 * where the place has no Chinese name at all, on a miss and on a hit alike
 * (the legacy upsert's COALESCE did the same on a hit); only its longest
 * CJK run is kept, and a name with none is ignored. `reDerivePlace`
 * preserves a `receipt_ocr` name, so a later re-derive does not erase it.
 */
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";
import {
  GooglePlacesApiKeyMissing,
  GooglePlacesError,
  fetchPlaceV1Dual,
  type PlaceV1Envelope,
} from "../../google/places-fetch.js";
import {
  PROJECTION_MODEL,
  PROJECTION_VERSION,
  projectPlace,
  stripToLongestCjkRun,
  type ProjectedPlaceFields,
  type RawResponseV1,
} from "../../projection/derive.js";
import { buildInfo } from "../../generated/build-info.js";
import { newId } from "../../http/uuid.js";
import type { ValidationWarning } from "../contract/validate.js";

type Executor = Pick<typeof db, "execute">;

/** `places.source` for a row the applier inserted (refresh uses the same). */
export const PLACE_SOURCE = "google_places";

export interface PlacePrefetch {
  googlePlaceId: string;
  /** The row existed when looked up: nothing was fetched. */
  cached: boolean;
  /** The fetched v1 envelope on a miss, or null. */
  envelope: PlaceV1Envelope | null;
  /** `place_fetch_failed` when a miss could not be fetched. */
  warning: ValidationWarning | null;
}

export type PlaceFetcher = (googlePlaceId: string) => Promise<PlaceV1Envelope>;

/**
 * The network half: look the place up, and fetch it on a miss. Never
 * throws for Google's sake; returns null when the record names no place.
 * `fetcher` defaults to `fetchPlaceV1Dual` (which reads
 * `GOOGLE_MAPS_API_KEY`).
 */
export async function prefetchPlace(
  executor: Executor,
  googlePlaceId: string | null | undefined,
  fetcher: PlaceFetcher = (id) => fetchPlaceV1Dual(id),
): Promise<PlacePrefetch | null> {
  if (!googlePlaceId) return null;
  const hit = await executor.execute(sql`SELECT 1 FROM places WHERE google_place_id = ${googlePlaceId}`);
  if (hit.rows.length > 0) return { googlePlaceId, cached: true, envelope: null, warning: null };
  try {
    return { googlePlaceId, cached: false, envelope: await fetcher(googlePlaceId), warning: null };
  } catch (err) {
    const why =
      err instanceof GooglePlacesApiKeyMissing
        ? "GOOGLE_MAPS_API_KEY is not set"
        : err instanceof GooglePlacesError
          ? `Google answered ${err.status}`
          : err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`)
            ? "the fetch timed out"
            : "the fetch failed";
    console.warn(`[apply] place ${googlePlaceId} not fetched: ${why}`);
    return {
      googlePlaceId,
      cached: false,
      envelope: null,
      warning: { rule: "place_fetch_failed", path: "place.google_place_id", message: `the place was not in the cache and ${why}` },
    };
  }
}

/** The legacy NOT NULL columns a new row needs, from the envelope's en body. */
function physicalFacts(envelope: PlaceV1Envelope): { formattedAddress: string; lat: number; lng: number } | null {
  const en = envelope?.v1?.en as Record<string, unknown> | null | undefined;
  if (!en || typeof en !== "object") return null;
  const loc = en.location as Record<string, unknown> | undefined;
  const formattedAddress = typeof en.formattedAddress === "string" ? en.formattedAddress : null;
  const lat = typeof loc?.latitude === "number" ? loc.latitude : null;
  const lng = typeof loc?.longitude === "number" ? loc.longitude : null;
  if (!formattedAddress || lat === null || lng === null) return null;
  return { formattedAddress, lat, lng };
}

export interface PlaceWrite {
  placeId: string | null;
  /** `hit` (the row existed), `inserted`, or `none` (nothing linked). */
  cache: "hit" | "inserted" | "none";
  snapshotId: string | null;
  /** True when the receipt's Chinese name was stored on the place. */
  receiptZhStored: boolean;
  warnings: ValidationWarning[];
}

/**
 * The transaction half. `prefetch` is what `prefetchPlace` returned for
 * the same place id; `nameZhPrinted` the record's `merchant.name_zh_printed`.
 */
export async function writePlace(
  tx: Executor,
  prefetch: PlacePrefetch | null,
  nameZhPrinted: string | null,
): Promise<PlaceWrite> {
  const none: PlaceWrite = { placeId: null, cache: "none", snapshotId: null, receiptZhStored: false, warnings: [] };
  if (!prefetch) return none;
  const zh = nameZhPrinted ? stripToLongestCjkRun(nameZhPrinted) : null;

  // In an UPDATE every expression reads the row as it was, so all four
  // CASEs see the same "no Chinese name yet".
  const fillZh = sql`places.display_name_zh IS NULL AND ${zh}::text IS NOT NULL`;
  const bump = async (): Promise<{ id: string; zhStored: boolean } | null> => {
    const res = await tx.execute(sql`
      WITH old AS (
        SELECT id, display_name_zh IS NULL AS no_zh FROM places WHERE google_place_id = ${prefetch.googlePlaceId} FOR UPDATE
      )
      UPDATE places
         SET hit_count    = places.hit_count + 1,
             last_seen_at = now(),
             display_name_zh           = CASE WHEN ${fillZh} THEN ${zh}::text    ELSE places.display_name_zh END,
             display_name_zh_locale    = CASE WHEN ${fillZh} THEN 'zh'           ELSE places.display_name_zh_locale END,
             display_name_zh_source    = CASE WHEN ${fillZh} THEN 'receipt_ocr'  ELSE places.display_name_zh_source END,
             display_name_zh_is_native = CASE WHEN ${fillZh} THEN true           ELSE places.display_name_zh_is_native END
        FROM old
       WHERE places.id = old.id
      RETURNING places.id, old.no_zh`);
    const row = res.rows[0] as { id: string; no_zh: boolean } | undefined;
    return row ? { id: row.id, zhStored: zh !== null && row.no_zh } : null;
  };

  const existing = await bump();
  if (existing) return { ...none, placeId: existing.id, cache: "hit", receiptZhStored: existing.zhStored };

  if (prefetch.cached) {
    return {
      ...none,
      warnings: [
        {
          rule: "place_fetch_failed",
          path: "place.google_place_id",
          message: "the place was in the cache when looked up and gone when the apply ran",
        },
      ],
    };
  }
  if (!prefetch.envelope) return { ...none, warnings: prefetch.warning ? [prefetch.warning] : [] };
  const facts = physicalFacts(prefetch.envelope);
  if (!facts) {
    return {
      ...none,
      warnings: [
        {
          rule: "place_not_projectable",
          path: "place.google_place_id",
          message: "the fetched place has no English body with an address and a location",
        },
      ],
    };
  }
  const p: ProjectedPlaceFields = projectPlace(prefetch.envelope as unknown as RawResponseV1);
  const useReceiptZh = p.display_name_zh === null && zh !== null;
  const derivation = {
    projection_version: PROJECTION_VERSION,
    prompt_git_sha: buildInfo.gitSha,
    model: PROJECTION_MODEL,
    ran_at: new Date().toISOString(),
  };
  const id = newId();
  // A JS array in a drizzle template becomes a parenthesised list, so the
  // `text[]` column is built from a jsonb parameter.
  const types = p.types === null ? null : JSON.stringify(p.types);
  const ins = await tx.execute(sql`
    INSERT INTO places (
      id, google_place_id, formatted_address, lat, lng, source, raw_response,
      last_seen_at, hit_count,
      display_name_en, display_name_zh, display_name_zh_locale, display_name_zh_source, display_name_zh_is_native,
      primary_type, primary_type_display_zh, maps_type_label_zh, types,
      formatted_address_en, formatted_address_zh, postal_code, country_code,
      business_status, business_hours, time_zone,
      rating, user_rating_count,
      national_phone_number, website_uri, google_maps_uri,
      metadata
    ) VALUES (
      ${id}::uuid, ${prefetch.googlePlaceId}, ${facts.formattedAddress}, ${facts.lat}::numeric, ${facts.lng}::numeric,
      ${PLACE_SOURCE}, ${JSON.stringify(prefetch.envelope)}::jsonb,
      now(), 1,
      ${p.display_name_en},
      ${useReceiptZh ? zh : p.display_name_zh},
      ${useReceiptZh ? "zh" : p.display_name_zh_locale},
      ${useReceiptZh ? "receipt_ocr" : p.display_name_zh_source},
      ${useReceiptZh ? true : p.display_name_zh_is_native}::boolean,
      ${p.primary_type}, ${p.primary_type_display_zh}, ${p.maps_type_label_zh},
      CASE WHEN ${types}::jsonb IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(${types}::jsonb)) END,
      ${p.formatted_address_en}, ${p.formatted_address_zh}, ${p.postal_code}, ${p.country_code},
      ${p.business_status}, ${p.business_hours === null ? null : JSON.stringify(p.business_hours)}::jsonb, ${p.time_zone},
      ${p.rating}::numeric, ${p.user_rating_count}::int,
      ${p.national_phone_number}, ${p.website_uri}, ${p.google_maps_uri},
      ${JSON.stringify({ derivation })}::jsonb
    )
    ON CONFLICT (google_place_id) DO NOTHING
    RETURNING id`);
  if (ins.rows.length === 0) {
    // Inserted by another writer since the prefetch: a hit after all.
    const raced = await bump();
    return raced ? { ...none, placeId: raced.id, cache: "hit", receiptZhStored: raced.zhStored } : none;
  }
  const snap = await tx.execute(sql`
    INSERT INTO place_snapshots (place_id, source, raw_response, fetched_at, fetched_by_sha)
    VALUES (${id}::uuid, ${PLACE_SOURCE}, ${JSON.stringify(prefetch.envelope)}::jsonb,
            ${prefetch.envelope.fetched_at}::timestamptz, ${buildInfo.gitShortSha})
    RETURNING id`);
  return {
    placeId: id,
    cache: "inserted",
    snapshotId: (snap.rows[0] as { id: string }).id,
    receiptZhStored: useReceiptZh,
    warnings: [],
  };
}
