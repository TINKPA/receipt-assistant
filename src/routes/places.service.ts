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
  display_name_zh_source: "google_text" | "photo_ocr" | "user_override" | null;
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
