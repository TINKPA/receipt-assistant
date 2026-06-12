CREATE TABLE "transaction_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"transaction_item_id" uuid,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"brand_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "transaction_parties_identity_uq" UNIQUE NULLS NOT DISTINCT("transaction_id","transaction_item_id","role","display_name")
);
--> statement-breakpoint
ALTER TABLE "transaction_parties" ADD CONSTRAINT "transaction_parties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_parties" ADD CONSTRAINT "transaction_parties_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_parties" ADD CONSTRAINT "transaction_parties_transaction_item_id_transaction_items_id_fk" FOREIGN KEY ("transaction_item_id") REFERENCES "public"."transaction_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_parties_workspace_brand_idx" ON "transaction_parties" USING btree ("workspace_id","brand_id","role");--> statement-breakpoint
CREATE INDEX "transaction_parties_tx_idx" ON "transaction_parties" USING btree ("transaction_id");