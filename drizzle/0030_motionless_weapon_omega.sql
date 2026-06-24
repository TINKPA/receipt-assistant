CREATE TABLE "product_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
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
	CONSTRAINT "product_assets_tier_ck" CHECK ("product_assets"."tier" IN ('manual_seed','user_upload','agent_fetch'))
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preferred_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preferred_asset_chosen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_assets" ADD CONSTRAINT "product_assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_assets_product_hash_uq" ON "product_assets" USING btree ("product_id","content_hash");--> statement-breakpoint
CREATE INDEX "product_assets_product_idx" ON "product_assets" USING btree ("product_id");