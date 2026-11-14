-- ═══════════════════════════════════════════════════════════════════════
-- Extraction records (wave 1, P2). Additive: the previous image ignores the
-- new table and the three new columns, so rolling the image back needs no
-- data step, and nothing writes here while EXTRACTION_WRITER=agent_sql.
--
--   document_extractions      one row per reading of a document: the record
--                             an agent run handed back, as validated, and
--                             what the validator found. Written only by
--                             src/ingest/records.ts. See
--                             src/schema/document_extractions.ts.
--   agent_runs.extraction_id  gets the foreign key 0042 left out.
--   transaction_items.extraction_id, derivation_events.extraction_id
--                             point a derived row back at its record.
--   derivation_events.applier_version
--                             the applier that projected it (re-extract on
--                             records, a later phase).
--
-- Immutable: the trigger at the end refuses any UPDATE that changes a
-- column other than superseded_at (or a foreign key nulling a reference to a
-- deleted row). A newer reading is a new row that names the old one
-- (supersedes_id); the partial unique index keeps at most one current valid
-- record per document.
--
-- No grant here: receipts_agent gets nothing on the new table (it is not in
-- AGENT_GRANTS), and receipts_ro reads it through the default privilege
-- 0041 set up, re-asserted at boot (src/db/agent-roles.ts::syncAgentRoles).
-- No data statement.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."extraction_origin" AS ENUM('agent', 'stub', 'ledger_backfill', 'manual');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('valid', 'invalid');--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ingest_id" uuid,
	"agent_run_id" uuid,
	"origin" "extraction_origin" NOT NULL,
	"status" "extraction_status" NOT NULL,
	"contract_version" integer NOT NULL,
	"prompt_version" text,
	"prompt_git_sha" text,
	"model" text,
	"source_text_sha256" text,
	"input_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supersedes_id" uuid,
	"superseded_at" timestamp with time zone,
	"classification" text,
	"flow" text,
	"occurred_on" date,
	"total_minor" bigint,
	"currency" text,
	"payee" text,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"card_last4" text,
	"result" jsonb NOT NULL,
	"raw_text" text,
	"validation" jsonb DEFAULT '{"errors":[],"warnings":[],"normalizations":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extractions_classification_check" CHECK ("document_extractions"."status" = 'invalid' OR "document_extractions"."classification" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "transaction_items" ADD COLUMN "extraction_id" uuid;--> statement-breakpoint
ALTER TABLE "derivation_events" ADD COLUMN "extraction_id" uuid;--> statement-breakpoint
ALTER TABLE "derivation_events" ADD COLUMN "applier_version" text;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_ingest_id_ingests_id_fk" FOREIGN KEY ("ingest_id") REFERENCES "public"."ingests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_supersedes_id_document_extractions_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_extractions_current_uq" ON "document_extractions" USING btree ("document_id") WHERE status = 'valid' AND superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "document_extractions_run_idx" ON "document_extractions" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "document_extractions_ident_gin" ON "document_extractions" USING gin ("identifiers" jsonb_path_ops);--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivation_events" ADD CONSTRAINT "derivation_events_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_extraction_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_items_extraction_idx" ON "transaction_items" USING btree ("extraction_id") WHERE extraction_id IS NOT NULL;--> statement-breakpoint
-- Only superseded_at may change after insert. The one other change let
-- through is what the three ON DELETE SET NULL foreign keys do: a reference
-- (ingest_id, agent_run_id, supersedes_id) cleared because the row it named
-- is gone. Without that, deleting a workspace, an ingest or a run would be
-- refused by this trigger instead of nulling the pointer as declared.
CREATE FUNCTION "document_extractions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD) - 'superseded_at';
  new_row jsonb := to_jsonb(NEW) - 'superseded_at';
BEGIN
  IF OLD.ingest_id IS NOT NULL AND NEW.ingest_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ingests WHERE id = OLD.ingest_id) THEN
    old_row := old_row - 'ingest_id';
    new_row := new_row - 'ingest_id';
  END IF;
  IF OLD.agent_run_id IS NOT NULL AND NEW.agent_run_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.agent_run_id) THEN
    old_row := old_row - 'agent_run_id';
    new_row := new_row - 'agent_run_id';
  END IF;
  IF OLD.supersedes_id IS NOT NULL AND NEW.supersedes_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM document_extractions WHERE id = OLD.supersedes_id) THEN
    old_row := old_row - 'supersedes_id';
    new_row := new_row - 'supersedes_id';
  END IF;
  IF new_row IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'document_extractions % is immutable except superseded_at', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "document_extractions_immutable" BEFORE UPDATE ON "document_extractions"
  FOR EACH ROW EXECUTE FUNCTION "document_extractions_immutable"();
