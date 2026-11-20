ALTER TABLE "wish_items" ADD COLUMN "kind" text DEFAULT 'thing' NOT NULL;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "place_id" uuid;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "image_path" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "image_sha256" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "image_mime_type" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "capture_status" text;--> statement-breakpoint
ALTER TABLE "wish_items" ADD COLUMN "capture" jsonb;--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wish_items_place_idx" ON "wish_items" USING btree ("place_id");--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_kind_check" CHECK ("wish_items"."kind" IN ('thing', 'place'));--> statement-breakpoint
ALTER TABLE "wish_items" ADD CONSTRAINT "wish_items_capture_status_check" CHECK ("wish_items"."capture_status" IS NULL OR "wish_items"."capture_status" IN ('reading', 'done', 'failed'));