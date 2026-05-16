-- #84 Phase 1: products SSOT + transaction_items allocation & versioning.
--
-- Three things land together because they only make sense together:
--   1. `products` table — canonical catalog ("what is this thing")
--   2. `transaction_items` extensions — per-line tax/tip/discount
--      allocation columns + product_id FK + soft-delete versioning
--   3. `transaction_items_live` view — filter convenience for callers
--
-- See issue #84 for the full motivation. Carbon-copy values to
-- watch: `item_class` is the ONLY enumerated CHECK column on this
-- migration — every other taxonomy is free text per the user's
-- explicit "越少 hard-code" principle.

CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"canonical_name" text NOT NULL,
	"merchant_id" uuid,
	"brand_id" text,
	"item_class" text NOT NULL,
	"model" text,
	"color" text,
	"size" text,
	"variant" text,
	"sku" text,
	"manufacturer" text,
	"first_purchased_on" date,
	"last_purchased_on" date,
	"purchase_count" integer DEFAULT 0 NOT NULL,
	"total_spent_minor" bigint DEFAULT 0 NOT NULL,
	"custom_name" text,
	"notes" text,
	"retired_from_catalog_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "products_item_class_ck" CHECK ("products"."item_class" IN ('durable','consumable','food_drink','service','other'))
);
--> statement-breakpoint
DROP INDEX "transaction_items_line_no_uq";--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "line_type" text DEFAULT 'product' NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "tax_minor" bigint;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "tip_share_minor" bigint;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "discount_share_minor" bigint;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "effective_total_minor" bigint GENERATED ALWAYS AS (line_total_minor + COALESCE(tax_minor, 0) + COALESCE(tip_share_minor, 0) - COALESCE(discount_share_minor, 0)) STORED;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "extraction_run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- NULLS NOT DISTINCT (PG 15+) so merchant_id=NULL (portable products
-- like iPhone) participates in the unique constraint. Without this,
-- two iPhone rows could be inserted because PG treats NULL as
-- distinct from NULL by default.
CREATE UNIQUE INDEX "products_workspace_merchant_key_uq" ON "products" USING btree ("workspace_id","merchant_id","product_key") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "products_workspace_class_idx" ON "products" USING btree ("workspace_id","item_class");--> statement-breakpoint
CREATE INDEX "products_workspace_brand_idx" ON "products" USING btree ("workspace_id","brand_id");--> statement-breakpoint
CREATE INDEX "products_workspace_merchant_idx" ON "products" USING btree ("workspace_id","merchant_id");--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_items_line_no_run_uq" ON "transaction_items" USING btree ("transaction_id","line_no","extraction_run");--> statement-breakpoint
-- Partial indexes: only over LIVE rows. Re-extract soft-deletes
-- prior runs via `retired_at`; every query must filter
-- `retired_at IS NULL` to skip them.
CREATE INDEX "transaction_items_workspace_line_type_live_idx" ON "transaction_items" USING btree ("workspace_id","line_type") WHERE retired_at IS NULL;--> statement-breakpoint
CREATE INDEX "transaction_items_workspace_product_live_idx" ON "transaction_items" USING btree ("workspace_id","product_id") WHERE retired_at IS NULL;--> statement-breakpoint
CREATE INDEX "transaction_items_tx_extraction_run_idx" ON "transaction_items" USING btree ("transaction_id","extraction_run");--> statement-breakpoint
-- Ergonomic view so callers don't forget the retired filter.
CREATE VIEW "transaction_items_live" AS
  SELECT * FROM "transaction_items" WHERE retired_at IS NULL;