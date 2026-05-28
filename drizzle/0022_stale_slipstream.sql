ALTER TABLE "documents" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_meta" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_workspace_message_id_uniq" ON "documents" USING btree ("workspace_id","message_id") WHERE "documents"."message_id" IS NOT NULL;