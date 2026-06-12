CREATE TABLE "wish_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"target_price_minor" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"planned_days" integer,
	"urgency" text DEFAULT 'someday' NOT NULL,
	"snoozed_until" date,
	"status" text DEFAULT 'active' NOT NULL,
	"converted_transaction_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owned_items" ADD COLUMN "target_days" integer;--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_converted_transaction_id_transactions_id_fk" FOREIGN KEY ("converted_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wish_items_workspace_status_idx" ON "wish_items" USING btree ("workspace_id","status");