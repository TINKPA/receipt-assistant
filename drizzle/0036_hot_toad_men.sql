ALTER TABLE "transaction_items" ALTER COLUMN "extraction_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source" text DEFAULT 'extraction' NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "source" text DEFAULT 'extraction' NOT NULL;