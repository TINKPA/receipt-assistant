-- Phase 3 of the 3-layer data model (#80) — #90.
--
-- `place_snapshots` is the append-only history of every Google/Yelp
-- raw_response we've fetched for a `places` row. `places.raw_response`
-- stays as the latest pointer (fast reads); this table accumulates
-- every fetch so #91's refresh path can diff snapshot N vs N-1
-- without re-paying API quota and without losing pre-refresh state.
--
-- Backfill at the bottom: every existing places row with a non-null
-- raw_response gets ONE snapshot row using `last_seen_at` as a
-- best-effort `fetched_at`. `fetched_by_sha` is NULL for backfilled
-- rows — we cannot reconstruct which commit produced each historical
-- fetch.
CREATE TABLE "place_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" uuid NOT NULL,
	"source" text NOT NULL,
	"raw_response" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"fetched_by_sha" text
);
--> statement-breakpoint
ALTER TABLE "place_snapshots" ADD CONSTRAINT "place_snapshots_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_snapshots_place_idx" ON "place_snapshots" USING btree ("place_id","fetched_at");--> statement-breakpoint

-- Backfill: one snapshot per existing places row (raw_response IS NOT NULL).
-- `fetched_at = last_seen_at` is the closest we have to "when did Google
-- last say this?"; `fetched_by_sha` is left NULL (unknown).
INSERT INTO "place_snapshots" ("place_id", "source", "raw_response", "fetched_at", "fetched_by_sha")
SELECT id, source, raw_response, last_seen_at, NULL
  FROM "places"
 WHERE raw_response IS NOT NULL;
