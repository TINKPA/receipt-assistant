import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { places } from "./places.js";

/**
 * Append-only history of every Google Places / Yelp raw_response we've
 * fetched for a `places` row (#80 / #90).
 *
 * `places.raw_response` is the *latest pointer* — fast reads, no join.
 * `place_snapshots` is the full history — every ingest writes one row
 * here BEFORE the `places` upsert overwrites `raw_response`, so we can
 * answer "what did Google say about this place last month?" without
 * paying API quota to re-fetch.
 *
 * Phase 4 (#91) uses this table as the canonical input to the
 * "refresh + diff" path: snapshot N vs N-1 reveals what Google changed
 * (renamed merchant, moved address, closed business). Without this
 * table, refresh would be destructive and the audit story would be
 * incomplete.
 *
 * Schema notes:
 *   - `place_id` is a real FK (ON DELETE CASCADE) — when a place is
 *     hard-deleted (`/v1/places/:id` DELETE, future), its snapshot
 *     history goes with it. Soft-delete (if added later) wouldn't
 *     touch this table.
 *   - `source` is the same `'google_geocode' | 'google_places' | 'yelp'`
 *     vocabulary as `places.source`. Pre-Yelp rows are all Google.
 *   - `raw_response` is NOT NULL — backfill skips `places` rows whose
 *     `raw_response IS NULL`, and ingest only ever inserts when it has
 *     a fresh body to record.
 *   - `fetched_by_sha` is `buildInfo.gitShortSha` at fetch time. NULL
 *     for backfilled rows (we can't reconstruct which commit fetched
 *     each historical row).
 */
export const placeSnapshots = pgTable(
  "place_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    placeId: uuid("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    /** `'google_geocode' | 'google_places' | 'yelp'` — mirrors
     *  `places.source` for the fetch that produced this body. */
    source: text("source").notNull(),
    /** Full v1 response body. Multi-language envelope shape post-#74. */
    rawResponse: jsonb("raw_response").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    /** `buildInfo.gitShortSha` at fetch time. NULL for migration
     *  backfill rows (provenance unknown for historical fetches). */
    fetchedBySha: text("fetched_by_sha"),
  },
  (t) => [
    // Latest-N for one place: `WHERE place_id = ? ORDER BY fetched_at DESC LIMIT N`.
    index("place_snapshots_place_idx").on(t.placeId, t.fetchedAt),
  ],
);
