-- #101 Phase 1: global brand registry + multi-candidate asset table.
--
-- Schema only — agent acquisition (Phase 5a/5b in the ingest prompt)
-- and the MerchantIcon frontend component ship as #101 Phase 2 follow-
-- ups so this PR stays reviewable. The tables are addressable today
-- via the new routes; ingest doesn't write to them yet (so they stay
-- empty until #101 Phase 2 lands).
--
-- `brands.preferred_asset_id` is a forward reference to
-- `brand_assets.id`; declared as a plain UUID column here so the two
-- tables can be created in either order. We add the FK after both
-- exist.

CREATE TABLE "brand_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" text NOT NULL,
	"tier" text NOT NULL,
	"source_url" text,
	"local_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"acquired_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"agent_relevance" smallint,
	"agent_notes" text,
	"extraction_version" integer DEFAULT 1 NOT NULL,
	"user_rating" smallint,
	"user_uploaded" boolean DEFAULT false NOT NULL,
	"user_notes" text,
	"retired_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "brand_assets_tier_ck" CHECK ("brand_assets"."tier" IN ('itunes','svgl','logo_dev','simple_icons','user_upload','manual_url'))
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"brand_id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"domain" text,
	"preferred_asset_id" uuid,
	"user_chose_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_brand_id_brands_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("brand_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_parent_id_brands_brand_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."brands"("brand_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_assets_brand_hash_uq" ON "brand_assets" USING btree ("brand_id","content_hash");--> statement-breakpoint
CREATE INDEX "brand_assets_brand_idx" ON "brand_assets" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "brand_assets_brand_tier_idx" ON "brand_assets" USING btree ("brand_id","tier");--> statement-breakpoint
-- Partial index over live (non-retired) assets — the hot path for
-- "show me every candidate for brand X."
CREATE INDEX "brand_assets_brand_live_idx" ON "brand_assets" USING btree ("brand_id") WHERE retired_at IS NULL;--> statement-breakpoint
-- Now both tables exist — add the preferred-asset FK on brands.
-- (Drizzle would emit this if we declared the .references() on the
-- column, but doing it here avoids forward-reference ordering issues
-- with the auto-generator.)
ALTER TABLE "brands" ADD CONSTRAINT "brands_preferred_asset_id_brand_assets_id_fk" FOREIGN KEY ("preferred_asset_id") REFERENCES "public"."brand_assets"("id") ON DELETE set null;