-- #81 Phase 2: lift `transactions.metadata.items` to a typed table.
-- Phase 1 (#105) parked items inside `metadata.items` JSONB; this
-- creates the relational store. Same field names, no taxonomy churn.
-- Idempotency: UNIQUE (transaction_id, line_no) lets re-extract do
-- DELETE-then-INSERT in one txn. Transactions service falls back to
-- reading `metadata.items` when no rows exist (pre-#105 history).

CREATE TABLE "transaction_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"raw_name" text NOT NULL,
	"normalized_name" text,
	"quantity" numeric,
	"unit" text,
	"unit_price_minor" bigint,
	"line_total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"item_class" text NOT NULL,
	"durability_tier" text,
	"food_kind" text,
	"tags" text[],
	"confidence" text NOT NULL,
	"extraction_version" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "transaction_items_item_class_ck"
		CHECK (item_class IN ('durable','consumable','food_drink','service','other')),
	CONSTRAINT "transaction_items_durability_tier_ck"
		CHECK (durability_tier IS NULL OR durability_tier IN ('luxury','standard')),
	CONSTRAINT "transaction_items_food_kind_ck"
		CHECK (food_kind IS NULL OR food_kind IN ('restaurant_dish','grocery_food','beverage')),
	CONSTRAINT "transaction_items_confidence_ck"
		CHECK (confidence IN ('high','medium','low'))
);
--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_items_line_no_uq" ON "transaction_items" USING btree ("transaction_id","line_no");--> statement-breakpoint
CREATE INDEX "transaction_items_tx_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_items_workspace_class_created_idx" ON "transaction_items" USING btree ("workspace_id","item_class","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transaction_items_tags_idx" ON "transaction_items" USING GIN ("tags");