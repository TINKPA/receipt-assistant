/**
 * Places service.
 *
 * Reads the shared `places` table (denormalized into the transaction
 * response JOIN) and exposes CRUD helpers for the new
 * `/v1/places/:id` endpoint added in #74.
 *
 * Writes still happen agent-side during ingest — the extractor issues
 * `INSERT ... ON CONFLICT (google_place_id) DO UPDATE` inline inside
 * its BEGIN/COMMIT block. The only writer-side helper here is the
 * user-facing PATCH that sets `custom_name_zh`.
 */
import { and, eq, inArray, sql, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { places, placePhotos } from "../schema/places.js";
import { derivationEvents } from "../schema/derivation_events.js";
import {
  PROJECTION_MODEL,
  PROJECTION_VERSION,
  projectPlace,
  type ProjectedPlaceFields,
  type RawResponseV1,
} from "../projection/derive.js";
import { PROMPT_VERSION } from "../ingest/prompt.js";
import { buildInfo } from "../generated/build-info.js";
import { NoRawResponseProblem } from "../http/problem.js";

/**
 * Public-facing shape of a place. Mirrors the v1 zod Place schema —
 * any field added to one must be added to the other.
 */
export interface PlaceRow {
  id: string;
  google_place_id: string;
  formatted_address: string;
  lat: number;
  lng: number;
  source: string;

  display_name_en: string | null;
  display_name_zh: string | null;
  display_name_zh_locale: string | null;
  display_name_zh_source:
    | "google_text"
    | "photo_ocr"
    | "receipt_ocr"
    | "user_override"
    | null;
  /** Whether `display_name_zh` is the merchant's native-script name
   *  (true) or a Google-translated gloss (false). See `places.ts`
   *  schema for the full definition. */
  display_name_zh_is_native: boolean | null;
  custom_name_zh: string | null;

  primary_type: string | null;
  primary_type_display_zh: string | null;
  maps_type_label_zh: string | null;
  types: string[] | null;

  formatted_address_en: string | null;
  formatted_address_zh: string | null;
  postal_code: string | null;
  country_code: string | null;

  business_status: string | null;
  business_hours: unknown | null;
  time_zone: string | null;

  rating: number | null;
  user_rating_count: number | null;

  national_phone_number: string | null;
  website_uri: string | null;
  google_maps_uri: string | null;

  photos:
    | {
        rank: number;
        width_px: number | null;
        height_px: number | null;
        has_local_copy: boolean;
        ocr_extracted: unknown | null;
      }[]
    | null;
}

/**
 * Project a Drizzle row into the API response shape. Drizzle returns
 * `numeric` as string; coerce to number for the json payload.
 */
function rowToApi(r: typeof places.$inferSelect): Omit<PlaceRow, "photos"> {
  return {
    id: r.id,
    google_place_id: r.googlePlaceId,
    formatted_address: r.formattedAddress,
    lat: Number(r.lat),
    lng: Number(r.lng),
    source: r.source,
    display_name_en: r.displayNameEn,
    display_name_zh: r.displayNameZh,
    display_name_zh_locale: r.displayNameZhLocale,
    display_name_zh_source:
      (r.displayNameZhSource as PlaceRow["display_name_zh_source"]) ?? null,
    display_name_zh_is_native: r.displayNameZhIsNative,
    custom_name_zh: r.customNameZh,
    primary_type: r.primaryType,
    primary_type_display_zh: r.primaryTypeDisplayZh,
    maps_type_label_zh: r.mapsTypeLabelZh,
    types: r.types,
    formatted_address_en: r.formattedAddressEn,
    formatted_address_zh: r.formattedAddressZh,
    postal_code: r.postalCode,
    country_code: r.countryCode,
    business_status: r.businessStatus,
    business_hours: r.businessHours,
    time_zone: r.timeZone,
    rating: r.rating != null ? Number(r.rating) : null,
    user_rating_count: r.userRatingCount,
    national_phone_number: r.nationalPhoneNumber,
    website_uri: r.websiteUri,
    google_maps_uri: r.googleMapsUri,
  };
}

/**
 * Bulk-load by internal UUID. Used by transactions.service.ts to JOIN
 * place subobjects into the transaction response. Skips the photos
 * subquery — transaction lists don't need photo refs, the standalone
 * /v1/places/:id endpoint provides them.
 */
export async function loadPlacesByIds(
  ids: string[],
): Promise<Map<string, PlaceRow>> {
  const map = new Map<string, PlaceRow>();
  if (ids.length === 0) return map;
  const rows = await db.select().from(places).where(inArray(places.id, ids));
  for (const r of rows) {
    map.set(r.id, { ...rowToApi(r), photos: null });
  }
  return map;
}

/**
 * Single-place fetch including photo refs. Used by GET /v1/places/:id.
 *
 * Identifier accepts EITHER the row's UUID `id` OR Google's stable
 * `google_place_id` (`ChIJ…`-shaped). The latter is what
 * `merchants.place_id` stores (the field name is misleading — it
 * holds Google's id, not our FK; schema comment in
 * `src/schema/merchants.ts:52`). Recognizing both keeps callers from
 * having to maintain a separate lookup path for that distinction.
 */
export async function loadPlaceById(id: string): Promise<PlaceRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const rows = await db
    .select()
    .from(places)
    .where(isUuid ? eq(places.id, id) : eq(places.googlePlaceId, id));
  if (rows.length === 0) return null;
  // Photos are keyed by the row's UUID — even if the caller passed a
  // Google place_id we must resolve to UUID for the photos join.
  const placeUuid = rows[0]!.id;
  const photoRows = await db
    .select({
      rank: placePhotos.rank,
      width_px: placePhotos.widthPx,
      height_px: placePhotos.heightPx,
      file_path: placePhotos.filePath,
      ocr_extracted: placePhotos.ocrExtracted,
    })
    .from(placePhotos)
    .where(eq(placePhotos.placeId, placeUuid))
    .orderBy(placePhotos.rank);
  return {
    ...rowToApi(rows[0]!),
    photos: photoRows.map((p) => ({
      rank: p.rank,
      width_px: p.width_px,
      height_px: p.height_px,
      has_local_copy: p.file_path != null,
      ocr_extracted: p.ocr_extracted,
    })),
  };
}

/**
 * Update the user-overridable field. Returns the new full row, or null
 * if the place doesn't exist.
 */
export async function updatePlace(
  id: string,
  patch: { custom_name_zh?: string | null },
): Promise<PlaceRow | null> {
  const set: Partial<typeof places.$inferInsert> = {};
  if ("custom_name_zh" in patch) {
    set.customNameZh = patch.custom_name_zh ?? null;
  }
  if (Object.keys(set).length === 0) {
    return loadPlaceById(id);
  }
  const rows = await db
    .update(places)
    .set(set)
    .where(eq(places.id, id))
    .returning();
  if (rows.length === 0) return null;
  return loadPlaceById(id);
}

// ── Re-derive (#89) ────────────────────────────────────────────────

/** Keys in `ProjectedPlaceFields` that re-derive is eligible to
 *  touch. Reused for the `before` / `after` snapshots and the
 *  `changed_keys[]` diff in `derivation_events`. */
const PROJECTED_KEYS = [
  "display_name_en",
  "display_name_zh",
  "display_name_zh_locale",
  "display_name_zh_source",
  "display_name_zh_is_native",
  "primary_type",
  "primary_type_display_zh",
  "maps_type_label_zh",
  "types",
  "formatted_address_en",
  "formatted_address_zh",
  "postal_code",
  "country_code",
  "business_status",
  "business_hours",
  "time_zone",
  "rating",
  "user_rating_count",
  "national_phone_number",
  "website_uri",
  "google_maps_uri",
] as const satisfies ReadonlyArray<keyof ProjectedPlaceFields>;

/** True when `display_name_zh` was set by reading the merchant's
 *  own surface (storefront photo, receipt header) rather than by
 *  projecting Google's response. Those sources are outside this
 *  module's input domain — re-derive must preserve them, not
 *  overwrite them with `NULL` just because Google has no Chinese. */
function isOcrSourcedZh(source: string | null | undefined): boolean {
  return source === "photo_ocr" || source === "receipt_ocr";
}

/** Pick the Layer 2 keys from a `places` row into the JSON shape
 *  we put on `derivation_events.before / .after`. Drizzle returns
 *  `numeric` as `string`; we keep it as-is so a re-derive that
 *  hands back the same numeric value produces an exact diff hit. */
function snapshotProjectedFields(
  row: typeof places.$inferSelect,
): ProjectedPlaceFields {
  return {
    display_name_en: row.displayNameEn,
    display_name_zh: row.displayNameZh,
    display_name_zh_locale: row.displayNameZhLocale,
    display_name_zh_source:
      (row.displayNameZhSource as ProjectedPlaceFields["display_name_zh_source"]) ?? null,
    display_name_zh_is_native: row.displayNameZhIsNative,
    primary_type: row.primaryType,
    primary_type_display_zh: row.primaryTypeDisplayZh,
    maps_type_label_zh: row.mapsTypeLabelZh,
    types: row.types,
    formatted_address_en: row.formattedAddressEn,
    formatted_address_zh: row.formattedAddressZh,
    postal_code: row.postalCode,
    country_code: row.countryCode,
    business_status: row.businessStatus,
    business_hours: row.businessHours,
    time_zone: row.timeZone,
    rating: row.rating,
    user_rating_count: row.userRatingCount,
    national_phone_number: row.nationalPhoneNumber,
    website_uri: row.websiteUri,
    google_maps_uri: row.googleMapsUri,
  };
}

/** Equality test for projection field values. Arrays compare
 *  element-wise; everything else uses `===`. JSON values
 *  (business_hours) compare by JSON.stringify — good enough since
 *  the projection is deterministic and emits stable key orders. */
function projectedFieldEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export interface ReDeriveResult {
  /** Internal UUID of the place row. */
  place_id: string;
  /** Always present in the response. Empty array means the
   *  projection happened to match the current row; `derivation_event_id`
   *  is still set (we audit the no-op run too — see schema header). */
  changed_keys: string[];
  /** UUID of the `derivation_events` row written by this call. */
  derivation_event_id: string;
}

/**
 * Re-run the Layer 2 projection over a single `places` row's cached
 * `raw_response` and commit the result.
 *
 * Behavior contract (Phase 2 / #89):
 *   - 422 `NoRawResponseProblem` when `raw_response IS NULL`.
 *   - `places.custom_name_zh` is NEVER in the UPDATE column list
 *     (Layer 3 user-truth — see schema header).
 *   - When the current `display_name_zh_source` is `'photo_ocr'`
 *     or `'receipt_ocr'`, the four zh-related fields are preserved
 *     verbatim (the projection only handles Google-source data).
 *   - All other projection fields are direct overwrites (NOT
 *     COALESCE) — this is the whole point of re-derive: the new
 *     projection's value, including `NULL`, wins.
 *   - `places.metadata.derivation` is stamped with the current
 *     `PROJECTION_VERSION` + `buildInfo.gitSha` + run timestamp.
 *   - A `derivation_events` row is INSERTED inside the same
 *     transaction as the UPDATE — never one without the other.
 *
 * `placeId` accepts either the internal UUID `id` or Google's
 * stable `google_place_id`, matching `loadPlaceById`.
 */
export async function reDerivePlace(
  workspaceId: string,
  placeId: string,
): Promise<ReDeriveResult | null> {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      placeId,
    );
  const rows = await db
    .select()
    .from(places)
    .where(isUuid ? eq(places.id, placeId) : eq(places.googlePlaceId, placeId));
  if (rows.length === 0) return null;
  const row = rows[0]!;

  if (row.rawResponse == null) {
    throw new NoRawResponseProblem(row.id);
  }

  const before = snapshotProjectedFields(row);
  const projected = projectPlace(row.rawResponse as RawResponseV1);

  // Policy: preserve OCR-sourced zh fields. The projection only
  // looks at Google's response, but a row's zh name may have come
  // from a storefront photo / receipt OCR. Don't reclassify those
  // back to NULL just because Google has no Chinese.
  if (isOcrSourcedZh(row.displayNameZhSource)) {
    projected.display_name_zh = before.display_name_zh;
    projected.display_name_zh_locale = before.display_name_zh_locale;
    projected.display_name_zh_source = before.display_name_zh_source;
    projected.display_name_zh_is_native = before.display_name_zh_is_native;
  }

  const changedKeys: string[] = [];
  for (const k of PROJECTED_KEYS) {
    if (!projectedFieldEq(before[k], projected[k])) changedKeys.push(k);
  }

  const ranAt = new Date();
  const derivation = {
    projection_version: PROJECTION_VERSION,
    prompt_git_sha: buildInfo.gitSha,
    model: PROJECTION_MODEL,
    ran_at: ranAt.toISOString(),
  };

  return await db.transaction(async (tx) => {
    const [evt] = await tx
      .insert(derivationEvents)
      .values({
        workspaceId,
        entityType: "place",
        entityId: row.id,
        promptVersion: PROMPT_VERSION,
        promptGitSha: buildInfo.gitSha,
        model: PROJECTION_MODEL,
        ranAt,
        before: before as unknown as Record<string, unknown>,
        after: projected as unknown as Record<string, unknown>,
        changedKeys,
      })
      .returning({ id: derivationEvents.id });

    await tx
      .update(places)
      .set({
        displayNameEn: projected.display_name_en,
        displayNameZh: projected.display_name_zh,
        displayNameZhLocale: projected.display_name_zh_locale,
        displayNameZhSource: projected.display_name_zh_source,
        displayNameZhIsNative: projected.display_name_zh_is_native,
        primaryType: projected.primary_type,
        primaryTypeDisplayZh: projected.primary_type_display_zh,
        mapsTypeLabelZh: projected.maps_type_label_zh,
        types: projected.types,
        formattedAddressEn: projected.formatted_address_en,
        formattedAddressZh: projected.formatted_address_zh,
        postalCode: projected.postal_code,
        countryCode: projected.country_code,
        businessStatus: projected.business_status,
        businessHours: projected.business_hours,
        timeZone: projected.time_zone,
        rating: projected.rating,
        userRatingCount: projected.user_rating_count,
        nationalPhoneNumber: projected.national_phone_number,
        websiteUri: projected.website_uri,
        googleMapsUri: projected.google_maps_uri,
        // Layer-3 (customNameZh) and physical facts (lat/lng,
        // formattedAddress) are intentionally absent — see
        // service header.
        metadata: sql`jsonb_set(COALESCE(${places.metadata}, '{}'::jsonb), '{derivation}', ${JSON.stringify(derivation)}::jsonb)`,
      })
      .where(eq(places.id, row.id));

    return {
      place_id: row.id,
      changed_keys: changedKeys,
      derivation_event_id: evt!.id,
    };
  });
}

/**
 * Iterate every `places` row and re-derive in sequence. Per #89
 * out-of-scope, this is sync — at the current corpus size (~tens
 * of places) it finishes in <1 s. Async / queued is Phase 4.
 *
 * Rows with `raw_response IS NULL` are skipped (NOT errored —
 * mirrors the single-place 422 semantically: nothing to project
 * from, so nothing to update). Rows where the projection happens
 * to match the current row are counted as `updated` because we
 * still write a `derivation_events` row marking the version bump.
 */
export interface ReDeriveBatchResult {
  scope: "places";
  total: number;
  updated: number;
  skipped: number;
  errors: Array<{ id: string; message: string }>;
  ran_at: string;
}

export async function reDeriveAllPlaces(
  workspaceId: string,
): Promise<ReDeriveBatchResult> {
  const startedAt = new Date();
  const rows = await db
    .select({ id: places.id, hasRaw: sql<boolean>`raw_response IS NOT NULL` })
    .from(places);

  const result: ReDeriveBatchResult = {
    scope: "places",
    total: rows.length,
    updated: 0,
    skipped: 0,
    errors: [],
    ran_at: startedAt.toISOString(),
  };

  for (const r of rows) {
    if (!r.hasRaw) {
      result.skipped += 1;
      continue;
    }
    try {
      const out = await reDerivePlace(workspaceId, r.id);
      if (out == null) {
        // Row vanished between the SELECT and the re-derive. Race
        // is harmless — count as error so the operator sees it.
        result.errors.push({ id: r.id, message: "row not found" });
      } else {
        result.updated += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ id: r.id, message });
    }
  }

  console.info(
    `[re-derive] scope=places total=${result.total} updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`,
  );
  return result;
}

/**
 * Resolve a place photo row by (place_id, rank) for the binary stream
 * endpoint. Returns the local file_path + mime_type or null.
 */
export async function loadPlacePhotoForStream(
  placeId: string,
  rank: number,
): Promise<{ file_path: string; mime_type: string | null } | null> {
  const rows = await db
    .select({
      file_path: placePhotos.filePath,
      mime_type: placePhotos.mimeType,
    })
    .from(placePhotos)
    .where(
      and(
        eq(placePhotos.placeId, placeId),
        eq(placePhotos.rank, rank),
        isNotNull(placePhotos.filePath),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { file_path: rows[0]!.file_path!, mime_type: rows[0]!.mime_type };
}
