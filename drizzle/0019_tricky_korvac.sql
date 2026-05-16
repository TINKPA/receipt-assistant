-- #101 Phase 2 — promote merchants.brand_id and products.brand_id to FK
-- on the global brands registry (the #86 schema-cleanup residual), add a
-- per-brand metadata jsonb for icon-resolution outcomes, and document
-- the transactions.merchant_id nullable decision.
--
-- The ALTER ADD CONSTRAINT statements only succeed if every existing
-- text value in merchants.brand_id / products.brand_id corresponds to
-- a row in brands. The two INSERT … SELECT statements below backfill
-- stub brands rows (name = brand_id verbatim, domain NULL) for any
-- referenced brand_id that doesn't yet exist. Phase 2.6 of the ingest
-- prompt enriches name/domain on future ingest passes via WebSearch.

ALTER TABLE "brands" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- Backfill stub brands rows for any merchants.brand_id text value that
-- doesn't yet have a brands row. Existing merchants.brand_id is already
-- constrained to ^[a-z0-9-]+$ (see merchants_brand_id_format CHECK),
-- so every value is a valid PK candidate.
INSERT INTO "brands" ("brand_id", "name")
SELECT DISTINCT m."brand_id", m."brand_id"
  FROM "merchants" m
  LEFT JOIN "brands" b ON b."brand_id" = m."brand_id"
 WHERE b."brand_id" IS NULL
   AND m."brand_id" IS NOT NULL;--> statement-breakpoint

-- Same for products.brand_id (nullable; only backfill non-NULL rows).
INSERT INTO "brands" ("brand_id", "name")
SELECT DISTINCT p."brand_id", p."brand_id"
  FROM "products" p
  LEFT JOIN "brands" b ON b."brand_id" = p."brand_id"
 WHERE b."brand_id" IS NULL
   AND p."brand_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("brand_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_brand_id_brands_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("brand_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- transactions.merchant_id stays nullable per #101 default option (b).
-- Voided rows, statement-line aggregates, and `unsupported` classified
-- documents all need a no-merchant affordance; NULL is the honest
-- representation. See #101 / #64 for the decision rationale.
COMMENT ON COLUMN "transactions"."merchant_id" IS
  'Nullable: voided rows, statement-line aggregates, and unsupported-classified docs need a no-merchant affordance. See #101 / #64 for the decision rationale.';
