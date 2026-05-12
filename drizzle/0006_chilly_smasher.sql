CREATE TYPE "public"."merchant_enrichment_status" AS ENUM('pending', 'success', 'not_found', 'failed');--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"category" text,
	"place_id" text,
	"photo_url" text,
	"photo_attribution" text,
	"address" text,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"enrichment_status" "merchant_enrichment_status" DEFAULT 'pending' NOT NULL,
	"enrichment_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "merchants_brand_id_format" CHECK ("merchants"."brand_id" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_workspace_brand_idx" ON "merchants" USING btree ("workspace_id","brand_id");--> statement-breakpoint
CREATE INDEX "merchants_workspace_idx" ON "merchants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "merchants_enrichment_pending_idx" ON "merchants" USING btree ("enrichment_status");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_merchant_idx" ON "transactions" USING btree ("workspace_id","merchant_id");