/**
 * Places service — manages the shared `places` table.
 *
 * Populated by the ingest worker when the extraction agent resolves a
 * merchant to a Google Places entry (see `src/ingest/prompt.ts` Phase
 * 3). Keyed by Google's stable `google_place_id`; the same merchant
 * seen by two ingests (same or different workspace) hits one row.
 *
 * The shape returned by `upsertPlace` is the row's internal UUID —
 * callers (the ingest worker) store this in `transactions.place_id`.
 * The row itself is read by `loadPlacesByIds` for the transaction
 * response JOIN.
 */
import { sql, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { places } from "../schema/places.js";
import type { ExtractorGeoInfo } from "../ingest/extractor.js";

export interface PlaceRow {
  id: string;
  google_place_id: string;
  formatted_address: string;
  /** Decimal degrees. Stored as numeric in PG, returned as string by the
   * driver — this service coerces to number for the API response. */
  lat: number;
  lng: number;
  source: "google_geocode" | "google_places";
}

/**
 * Insert a new places row or bump hit_count + last_seen_at on an
 * existing row keyed by google_place_id. Returns the row's UUID.
 *
 * The `formatted_address` / `lat` / `lng` on an existing row are NOT
 * updated on conflict — Google's place_id is considered stable and we
 * trust the first sighting. Raw response is overwritten with the
 * latest body for debugging convenience.
 */
export async function upsertPlace(geo: ExtractorGeoInfo): Promise<string> {
  const rows = await db
    .insert(places)
    .values({
      googlePlaceId: geo.place_id,
      formattedAddress: geo.formatted_address,
      lat: String(geo.lat),
      lng: String(geo.lng),
      source: geo.source,
      rawResponse: geo as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: places.googlePlaceId,
      set: {
        lastSeenAt: sql`NOW()`,
        hitCount: sql`${places.hitCount} + 1`,
      },
    })
    .returning({ id: places.id });
  return rows[0]!.id;
}

/**
 * Bulk-load by internal UUID. Used by transactions.service.ts to JOIN
 * in the response. Returns a Map so callers can lookup by id without
 * a second pass.
 */
export async function loadPlacesByIds(
  ids: string[],
): Promise<Map<string, PlaceRow>> {
  const map = new Map<string, PlaceRow>();
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(places)
    .where(inArray(places.id, ids));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      google_place_id: r.googlePlaceId,
      formatted_address: r.formattedAddress,
      lat: Number(r.lat),
      lng: Number(r.lng),
      source: r.source as "google_geocode" | "google_places",
    });
  }
  return map;
}
