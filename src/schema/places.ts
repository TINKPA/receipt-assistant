import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt } from "./common.js";

/**
 * Normalized Google Places entries, keyed by Google's stable
 * `google_place_id`. Shared across workspaces: the data is public
 * (street address + lat/lng), and de-duplication across tenants is a
 * feature — the same merchant visited by two users is one row.
 *
 * Populated by the ingest worker when the extraction agent returns a
 * `geo` block (see `src/ingest/prompt.ts` Phase 3). Transactions point
 * here via `transactions.place_id`; the response shape for
 * `GET /v1/transactions/:id` joins this table and returns a nested
 * `place` subobject.
 *
 * Never updated with per-workspace data. `hit_count` and `last_seen_at`
 * are informational (observability for "most-visited places") and bump
 * on every ingest, but they are not workspace-partitioned — a single
 * workspace can't use them for private stats without a join through
 * transactions.
 */
export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Google's stable place_id. Unique across the table. */
    googlePlaceId: text("google_place_id").notNull().unique(),
    formattedAddress: text("formatted_address").notNull(),
    /** Decimal degrees, ±90.000000. */
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    /** Decimal degrees, ±180.000000. */
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    /** Which Google endpoint produced this entry. */
    source: text("source").notNull(),
    /**
     * Full Google response body at first sighting. Kept for debugging
     * and future feature extraction (Places `types`, opening hours,
     * etc.). Not refreshed on subsequent hits.
     */
    rawResponse: jsonb("raw_response"),
    firstSeenAt: createdAt,
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    hitCount: integer("hit_count").notNull().default(1),
  },
  (t) => [
    // Geo-bbox filtering for future trip clustering. Btree on (lat, lng)
    // isn't ideal for range queries (a GiST + PostGIS index would be
    // better), but it's cheap, indexed, and sufficient for the small
    // data volumes we expect pre-PostGIS.
    index("places_lat_lng_idx").on(t.lat, t.lng),
  ],
);
