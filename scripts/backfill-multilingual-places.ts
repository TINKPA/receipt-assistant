/**
 * One-shot backfill: pull the multilingual record from Google Places v1
 * for every `places` row that pre-dates #74 (i.e. no `display_name_en`)
 * and populate the new typed columns + `raw_response.v1.en/zh-CN`.
 *
 * Photo bytes are NOT downloaded by this script — the extractor handles
 * photos on a per-receipt basis. Photos for already-cached places only
 * get downloaded when the next receipt at that place comes in. Keeping
 * the backfill text-only avoids paying Google's photo media quota for
 * places the user may never see again.
 *
 * Usage (inside the receipt-assistant container, where DATABASE_URL +
 * GOOGLE_MAPS_API_KEY are both set):
 *
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-multilingual-places.ts
 *
 * Flags:
 *     --dry-run         Print what would change; touch nothing.
 *     --limit N         Process at most N places (default: all).
 *     --only-id UUID    Process a single place row (debug).
 *
 * Safety:
 *   - Skips rows where `display_name_en IS NOT NULL` — never overwrites
 *     a row that already has multilingual data. Re-runs are idempotent.
 *   - The Google call uses FieldMask=*  — Enterprise tier (~$0.025/call)
 *     × the entire table is well under \$1 at the current data volume.
 *   - UPDATEs run one place at a time; an interrupted run leaves any
 *     successfully-updated rows persisted.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

interface Args {
  dryRun: boolean;
  limit: number | null;
  onlyId: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: null, onlyId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10) || null;
    else if (a === "--only-id") out.onlyId = argv[++i] ?? null;
  }
  return out;
}

interface PendingRow {
  id: string;
  google_place_id: string;
}

async function loadPending(args: Args): Promise<PendingRow[]> {
  let q = sql`
    SELECT id::text, google_place_id
    FROM places
    WHERE display_name_en IS NULL
  `;
  if (args.onlyId) {
    q = sql`SELECT id::text, google_place_id FROM places WHERE id = ${args.onlyId}::uuid`;
  } else if (args.limit) {
    q = sql`
      SELECT id::text, google_place_id
      FROM places
      WHERE display_name_en IS NULL
      LIMIT ${args.limit}
    `;
  }
  const res = await db.execute(q);
  return res.rows as unknown as PendingRow[];
}

/** Hit v1 places/{id} once for the given languageCode with FieldMask=*. */
async function fetchPlace(placeId: string, languageCode: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  const url = `https://places.googleapis.com/v1/places/${placeId}?languageCode=${languageCode}`;
  const r = await fetch(url, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "*" },
  });
  if (!r.ok) {
    console.warn(`  ${placeId} [${languageCode}] HTTP ${r.status}: ${await r.text().catch(() => "")}`);
    return null;
  }
  return (await r.json()) as Record<string, unknown>;
}

interface MultilingualFields {
  display_name_en: string | null;
  display_name_zh: string | null;
  display_name_zh_locale: string | null;
  display_name_zh_source: string | null;
  primary_type: string | null;
  primary_type_display_zh: string | null;
  maps_type_label_zh: string | null;
  types: string[] | null;
  formatted_address_en: string | null;
  formatted_address_zh: string | null;
  postal_code: string | null;
  country_code: string | null;
  business_status: string | null;
  business_hours: unknown;
  time_zone: string | null;
  rating: string | null;
  user_rating_count: number | null;
  national_phone_number: string | null;
  website_uri: string | null;
  google_maps_uri: string | null;
  raw_response: { v1: Record<string, unknown>; fetched_at: string };
}

/** Read JSON path, return string|null. */
function s(obj: Record<string, unknown> | null, ...path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : null;
}
function n(obj: Record<string, unknown> | null, ...path: string[]): number | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : null;
}

function derive(en: Record<string, unknown> | null, zh: Record<string, unknown> | null): MultilingualFields {
  const enLocale = s(en, "displayName", "languageCode");
  const zhLocale = s(zh, "displayName", "languageCode");
  // Only treat the zh response's displayName as Chinese if Google actually
  // returned a `zh*` locale — otherwise it fell back to en, no zh to store.
  const zhIsChinese = zhLocale != null && zhLocale.startsWith("zh");

  const types = en?.types;
  const ratingNum = n(en, "rating");
  return {
    display_name_en: s(en, "displayName", "text"),
    display_name_zh: zhIsChinese ? s(zh, "displayName", "text") : null,
    display_name_zh_locale: zhIsChinese ? zhLocale : null,
    display_name_zh_source: zhIsChinese ? "google_text" : null,
    primary_type: s(en, "primaryType"),
    primary_type_display_zh: s(zh, "primaryTypeDisplayName", "text"),
    maps_type_label_zh: s(zh, "googleMapsTypeLabel", "text"),
    types: Array.isArray(types) ? (types as string[]) : null,
    formatted_address_en: s(en, "formattedAddress"),
    formatted_address_zh: s(zh, "formattedAddress"),
    postal_code: s(en, "postalAddress", "postalCode"),
    country_code: s(en, "postalAddress", "regionCode"),
    business_status: s(en, "businessStatus"),
    business_hours: (en as Record<string, unknown> | null)?.regularOpeningHours ?? null,
    time_zone: s(en, "timeZone", "id"),
    rating: ratingNum != null ? String(ratingNum) : null,
    user_rating_count: n(en, "userRatingCount"),
    national_phone_number: s(en, "nationalPhoneNumber"),
    website_uri: s(en, "websiteUri"),
    google_maps_uri: s(en, "googleMapsUri"),
    raw_response: {
      v1: { en: en ?? {}, "zh-CN": zh ?? {} },
      fetched_at: new Date().toISOString(),
    },
  };
}

/**
 * Encode a `string[]` as a Postgres array literal (`{a,b,c}`) bound as
 * a single text parameter, then cast to `text[]` on the server. Drizzle's
 * default tuple-expansion (`($1, $2, ...)`) won't satisfy a `text[]`
 * column, so we route the value through the canonical pg array format.
 */
function pgArrayLiteral(arr: string[] | null): string | null {
  if (arr == null) return null;
  // Each element gets quoted and any `"` / `\` is escaped.
  const esc = arr.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${esc.join(",")}}`;
}

async function applyUpdate(row: PendingRow, fields: MultilingualFields, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] would update ${row.id} (${row.google_place_id})`);
    console.log(`    en=${fields.display_name_en ?? "<null>"}`);
    console.log(`    zh=${fields.display_name_zh ?? "<null>"} locale=${fields.display_name_zh_locale ?? "<null>"}`);
    return;
  }
  const typesLit = pgArrayLiteral(fields.types);
  await db.execute(sql`
    UPDATE places SET
      display_name_en          = ${fields.display_name_en},
      display_name_zh          = ${fields.display_name_zh},
      display_name_zh_locale   = ${fields.display_name_zh_locale},
      display_name_zh_source   = ${fields.display_name_zh_source},
      primary_type             = ${fields.primary_type},
      primary_type_display_zh  = ${fields.primary_type_display_zh},
      maps_type_label_zh       = ${fields.maps_type_label_zh},
      types                    = ${typesLit}::text[],
      formatted_address_en     = ${fields.formatted_address_en},
      formatted_address_zh     = ${fields.formatted_address_zh},
      postal_code              = ${fields.postal_code},
      country_code             = ${fields.country_code},
      business_status          = ${fields.business_status},
      business_hours           = ${fields.business_hours == null ? null : JSON.stringify(fields.business_hours)}::jsonb,
      time_zone                = ${fields.time_zone},
      rating                   = ${fields.rating},
      user_rating_count        = ${fields.user_rating_count},
      national_phone_number    = ${fields.national_phone_number},
      website_uri              = ${fields.website_uri},
      google_maps_uri          = ${fields.google_maps_uri},
      raw_response             = ${JSON.stringify(fields.raw_response)}::jsonb
    WHERE id = ${row.id}::uuid
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await loadPending(args);
  console.log(`backfill-multilingual-places: ${rows.length} place${rows.length === 1 ? "" : "s"} pending`);
  if (rows.length === 0) {
    console.log("nothing to do.");
    return;
  }

  let ok = 0, failed = 0, zhFound = 0;
  for (const r of rows) {
    try {
      const [en, zh] = await Promise.all([
        fetchPlace(r.google_place_id, "en"),
        fetchPlace(r.google_place_id, "zh-CN"),
      ]);
      if (!en && !zh) {
        console.warn(`  ${r.google_place_id} - both lookups failed, skipping`);
        failed++;
        continue;
      }
      const fields = derive(en, zh);
      await applyUpdate(r, fields, args.dryRun);
      ok++;
      if (fields.display_name_zh) zhFound++;
      console.log(
        `  ${ok}/${rows.length} ${r.google_place_id}` +
          ` en=${fields.display_name_en ?? "?"}` +
          ` zh=${fields.display_name_zh ?? "—"}`,
      );
    } catch (e) {
      failed++;
      console.error(`  ${r.google_place_id} ERROR: ${(e as Error).message}`);
    }
  }

  console.log(`\ndone. updated=${ok} failed=${failed} with_zh=${zhFound}/${ok}${args.dryRun ? " (DRY RUN)" : ""}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
