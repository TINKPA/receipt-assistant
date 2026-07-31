-- ═══════════════════════════════════════════════════════════════════════
-- #206 — loyalty points become a currency. DDL ONLY.
--
-- Owner's decision, 2026-07-30: "積分房一定要算，積分也是另外一種貨幣."
-- An award stay is real spend denominated in a non-cash unit, so it gets
-- a currency code and a balanced pair of postings instead of being
-- flattened to total_minor = 0.
--
-- ⚠ This file contains NO DML. The seed rows live in 0039, which sorts
-- after it, because Drizzle runs every pending migration inside ONE
-- transaction: a DELETE/UPDATE on transactions/postings queues events for
-- the DEFERRABLE constraint triggers and a later ALTER TABLE on those
-- tables then dies with PG 55006 "cannot ALTER TABLE ... has pending
-- trigger events", rolling back the whole batch and crash-looping the
-- container on boot (#174, 2026-07-16). Keep DDL and DML in separate,
-- correctly-ordered files.
--
-- ⚠ This migration deliberately does NOT touch a single existing
-- transaction or posting. The 36 rows carrying points/award metadata and
-- the 213 zero-total rows keep every value they have today. The decision
-- record for them is `docs/points-as-currency.md` § "Existing data".
--
-- The CREATE TABLE / ALTER COLUMN / FK / index statements are drizzle-kit
-- generated from `src/schema/{postings,accounts,points_programmes,
-- points_valuations}.ts`. The CHECK constraints are hand-added, because
-- Drizzle cannot express them (same arrangement as
-- `0001_ledger_invariants.sql`).
-- ═══════════════════════════════════════════════════════════════════════

-- ── Widen the currency columns ─────────────────────────────────────────
--
-- char(3) cannot hold `HYATT_PT`. Only the two columns that must carry a
-- points code are widened:
--
--   postings.currency   the leg's own unit
--   accounts.currency   the per-programme points asset account
--
-- Left at char(3) ON PURPOSE, as structural enforcement rather than
-- convention:
--
--   workspaces.base_currency  the base currency must always be cash;
--                             a narrow column makes "base currency =
--                             points" unrepresentable.
--   fx_rates.base / .quote    a points code physically cannot be stored
--                             in the FX cache, so no points amount can
--                             ever be derived from a published FX rate.
--
-- No values change: every existing code is exactly 3 characters, so the
-- bpchar → varchar conversion has no padding to strip.

ALTER TABLE "accounts" ALTER COLUMN "currency" SET DATA TYPE varchar(16);--> statement-breakpoint
ALTER TABLE "postings" ALTER COLUMN "currency" SET DATA TYPE varchar(16);--> statement-breakpoint

-- ── Currency-shape checks: two disjoint namespaces ─────────────────────
--
--   cash    ^[A-Z]{3}$                ISO 4217
--   points  ^[A-Z][A-Z0-9]{1,12}_PT$  underscore, which ISO cannot use
--
-- Disjoint by shape, so classifying a code never needs a lookup table and
-- no future ISO allocation can collide. (Squatting on the X- range would
-- collide: XCD/XOF/XAF/XPF are circulating currencies and XAU/XAG/XDR are
-- real ISO allocations.)

ALTER TABLE "postings" DROP CONSTRAINT "postings_currency_shape_ck";--> statement-breakpoint
ALTER TABLE "postings"
  ADD CONSTRAINT "postings_currency_shape_ck"
  CHECK ("currency" ~ '^[A-Z]{3}$' OR "currency" ~ '^[A-Z][A-Z0-9]{1,12}_PT$');--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_currency_shape_ck";--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_shape_ck"
  CHECK ("currency" ~ '^[A-Z]{3}$' OR "currency" ~ '^[A-Z][A-Z0-9]{1,12}_PT$');--> statement-breakpoint

-- ── Programme registry (world-level) ───────────────────────────────────

CREATE TABLE "points_programmes" (
	"code" varchar(16) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"issuer_brand_id" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "points_programmes"
  ADD CONSTRAINT "points_programmes_code_shape_ck"
  CHECK ("code" ~ '^[A-Z][A-Z0-9]{1,12}_PT$');--> statement-breakpoint

-- ── Valuations (workspace-scoped, versioned by effective date) ─────────
--
-- `minor_per_point` is base-currency MINOR units per one point: 1.7 US
-- cents per Hyatt point is 1.7. Points have no subunit, so one point is
-- one minor unit of its own currency and the conversion is the same plain
-- minor→minor multiply that `postings.fx_rate` already means — which is
-- why this value is exactly what gets written there.
--
-- `confirmed_at IS NULL` marks a number the owner has not signed off on.
-- Such a valuation is still applied (a stay valued at a marked-provisional
-- rate is closer to "積分房一定要算" than a stay valued at zero), but every
-- report discloses how much of its total depends on it.

CREATE TABLE "points_valuations" (
	"workspace_id" uuid NOT NULL,
	"currency" varchar(16) NOT NULL,
	"quote" char(3) NOT NULL,
	"effective_from" date NOT NULL,
	"minor_per_point" numeric(20, 10) NOT NULL,
	"source" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "points_valuations_workspace_id_currency_effective_from_pk" PRIMARY KEY("workspace_id","currency","effective_from")
);
--> statement-breakpoint
ALTER TABLE "points_valuations" ADD CONSTRAINT "points_valuations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_valuations" ADD CONSTRAINT "points_valuations_currency_points_programmes_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."points_programmes"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "points_valuations_lookup_idx" ON "points_valuations" USING btree ("workspace_id","currency","effective_from" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "points_valuations"
  ADD CONSTRAINT "points_valuations_quote_shape_ck"
  CHECK ("quote" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "points_valuations"
  ADD CONSTRAINT "points_valuations_nonneg_ck"
  CHECK ("minor_per_point" >= 0);--> statement-breakpoint

-- ── One points asset account per programme per workspace ───────────────
--
-- The extraction agent upserts against this partial unique index, so an
-- award stay for a programme seen for the first time creates its own
-- credit account inline instead of failing the write for a missing leg.

CREATE UNIQUE INDEX "accounts_points_uq" ON "accounts" USING btree ("workspace_id","currency") WHERE "accounts"."subtype" = 'points';
