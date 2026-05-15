-- Phase 2 of the 3-layer data-model rollout (#80 / #89).
--
-- Adds the plumbing for `POST /v1/places/:id/re-derive` and
-- `POST /v1/admin/re-derive`: a per-row provenance bag on `places`,
-- and a shared append-only audit log for every Layer 2 overwrite.
--
--   `places.metadata`       — jsonb. Re-derive writes
--                             `metadata.derivation = { projection_version,
--                             prompt_git_sha, model, ran_at }`. Mirrors
--                             the `transactions.metadata.extraction`
--                             pattern shipped in #88. Lets a single
--                             query answer "what produced this row?"
--                             without joining `derivation_events`.
--
--   `derivation_events`     — append-only audit. Every re-derive
--                             INSERTs one row BEFORE the UPDATE lands,
--                             with the field-level `before` / `after`
--                             jsonb diff. Used to (a) diff a projection
--                             bump after the fact, (b) roll back a bad
--                             re-derive by writing `before` back, (c)
--                             audit `WHERE prompt_version = 'X.Y'` to
--                             see which rows a given version touched.
--                             `entity_id` is `text` to accept both UUIDs
--                             (place / transaction) and Google-style
--                             `ChIJ…` identifiers without a join.
--
-- Layer-3 user-truth columns (e.g. `places.custom_name_zh`) are NEVER
-- written here — re-derive omits them from the UPDATE entirely. New
-- Layer-3 fields must be added to the service-side allowlist when
-- introduced; this is enforced in code, not DB.

CREATE TABLE "derivation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_git_sha" text NOT NULL,
	"model" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"changed_keys" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "derivation_events" ADD CONSTRAINT "derivation_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derivation_events_entity_idx" ON "derivation_events" USING btree ("entity_type","entity_id","ran_at");--> statement-breakpoint
CREATE INDEX "derivation_events_version_idx" ON "derivation_events" USING btree ("prompt_version","ran_at");