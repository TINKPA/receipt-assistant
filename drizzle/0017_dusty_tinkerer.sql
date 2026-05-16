-- #84 Phase 2: owned_items — physical-instance inventory register.
-- The agent decides at ingest if a durable line is worth tracking
-- (price × uniqueness × warranty-relevance), and creates N rows for
-- a quantity-N purchase (instance_index 1..N). Re-extract idempotency
-- is the UNIQUE (transaction_item_id, instance_index) constraint;
-- manually-added rows leave transaction_item_id NULL so PG's NULL-is-
-- distinct semantics let each manual entry coexist unconstrained.

CREATE TABLE "owned_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"transaction_item_id" uuid,
	"instance_index" integer DEFAULT 1 NOT NULL,
	"serial_number" text,
	"location" text,
	"acquired_on" date,
	"warranty_until" date,
	"condition" text,
	"retired_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owned_items" ADD CONSTRAINT "owned_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_items" ADD CONSTRAINT "owned_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_items" ADD CONSTRAINT "owned_items_transaction_item_id_transaction_items_id_fk" FOREIGN KEY ("transaction_item_id") REFERENCES "public"."transaction_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owned_items_tx_item_instance_uq" ON "owned_items" USING btree ("transaction_item_id","instance_index");--> statement-breakpoint
CREATE INDEX "owned_items_workspace_product_idx" ON "owned_items" USING btree ("workspace_id","product_id");--> statement-breakpoint
-- Partial index for the "what do I currently own" view.
CREATE INDEX "owned_items_workspace_live_idx" ON "owned_items" USING btree ("workspace_id") WHERE retired_at IS NULL;--> statement-breakpoint
-- Location lookup — "show me everything in 客厅".
CREATE INDEX "owned_items_workspace_location_idx" ON "owned_items" USING btree ("workspace_id","location");