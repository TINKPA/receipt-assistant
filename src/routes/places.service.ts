/**
 * Places service — reads the shared `places` table for the transaction
 * response JOIN.
 *
 * Writes to this table happen agent-side in Phase 2 of #32 (see
 * `src/ingest/prompt.ts`). The Node worker no longer calls an upsert
 * helper; the agent issues `INSERT ... ON CONFLICT (google_place_id)
 * DO UPDATE` inline inside its main BEGIN/COMMIT block.
 */
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { places } from "../schema/places.js";

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
