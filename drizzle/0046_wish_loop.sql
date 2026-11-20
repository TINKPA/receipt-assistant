ALTER TABLE "wish_items" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "converted_by" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "dismissed_transaction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "reactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "image_source_sha256" text;--> statement-breakpoint
-- Rows captured before this migration: the stored file is the upload
-- (no conversion existed), so its sha is the source sha. Only the oldest
-- row per (workspace, sha) gets it, so the unique index below can be built
-- over a workspace that already holds the same image twice.
UPDATE "wish_items" w SET "image_source_sha256" = w."image_sha256"
 WHERE w."image_sha256" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "wish_items" o
                    WHERE o."workspace_id" = w."workspace_id" AND o."image_sha256" = w."image_sha256"
                      AND (o."created_at", o."id") < (w."created_at", w."id"));--> statement-breakpoint
-- A wish converted before the loop existed was converted by hand.
UPDATE "wish_items" SET "converted_by" = 'user', "converted_at" = "updated_at" WHERE "status" = 'converted';--> statement-breakpoint
CREATE UNIQUE INDEX "wish_items_image_source_uq" ON "wish_items" USING btree ("workspace_id","image_source_sha256") WHERE "wish_items"."image_source_sha256" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_converted_by_check" CHECK ("wish_items"."converted_by" IS NULL OR "wish_items"."converted_by" IN ('user', 'receipt'));