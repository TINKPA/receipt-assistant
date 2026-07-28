CREATE TABLE "fx_rates" (
	"as_of" date NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"as_of_actual" date NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "fx_rates_as_of_base_quote_pk" PRIMARY KEY("as_of","base","quote")
);
--> statement-breakpoint
CREATE INDEX "fx_rates_pair_idx" ON "fx_rates" USING btree ("base","quote","as_of");