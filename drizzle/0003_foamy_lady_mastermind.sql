CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_place_id" text NOT NULL,
	"formatted_address" text NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"source" text NOT NULL,
	"raw_response" jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "places_google_place_id_unique" UNIQUE("google_place_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "place_id" uuid;--> statement-breakpoint
CREATE INDEX "places_lat_lng_idx" ON "places" USING btree ("lat","lng");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_place_idx" ON "transactions" USING btree ("place_id");