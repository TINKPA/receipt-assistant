-- ═══════════════════════════════════════════════════════════════════════
-- Run records (wave 1, P1). Additive: the previous image ignores the new
-- table and the two new `ingests` columns, so rolling the image back needs
-- no data step.
--
--   agent_runs              one row per `claude -p` run (ingest or
--                           re-extract), written only by the server. See
--                           src/schema/agent_runs.ts for the lifecycle.
--   ingests.document_id     the document the upload was stored as, written
--                           at upload from now on.
--   ingests.current_run_id  the run that owns a `processing` ingest; the
--                           fence the server writer checks (later phases).
--
-- Columns used only by later phases (lease, heartbeat, extraction_id,
-- repair_rounds, apply_report) are created now so those phases add
-- constraints, not columns. `extraction_id` gets its foreign key when
-- `document_extractions` exists.
--
-- No grant here: `receipts_agent` gets nothing on agent_runs and cannot
-- update the two new ingests columns (its ingests grant is column-level),
-- and `receipts_ro` is re-granted SELECT on every table at boot
-- (src/db/agent-roles.ts::syncAgentRoles).
--
-- DDL first, then one data statement at the very end (the #174 rule: no
-- ALTER after a data change in the same migration).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."agent_run_kind" AS ENUM('ingest', 're_extract');--> statement-breakpoint
CREATE TYPE "public"."agent_run_outcome" AS ENUM('written', 'attached', 'unsupported', 'recorded_only', 'duplicate_skip', 'no_change', 'adopted', 'reapplied', 'invalid_record', 'agent_error', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'finished', 'abandoned');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "agent_run_kind" NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"ingest_id" uuid,
	"document_id" uuid,
	"transaction_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"trigger" text NOT NULL,
	"writer" text NOT NULL,
	"session_id" uuid,
	"worker_id" text,
	"prompt_version" text NOT NULL,
	"prompt_git_sha" text NOT NULL,
	"prompt_bytes" integer,
	"model_requested" text,
	"model_observed" text,
	"cli_version" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"exit_code" integer,
	"exit_signal" text,
	"outcome" "agent_run_outcome",
	"error_class" text,
	"error" text,
	"repair_rounds" smallint DEFAULT 0 NOT NULL,
	"turns" integer,
	"tool_calls" integer,
	"input_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_creation_tokens" bigint,
	"output_tokens" bigint,
	"transcript_bytes" bigint,
	"produced" jsonb,
	"agent_report" jsonb,
	"apply_report" jsonb,
	"extraction_id" uuid,
	"before" jsonb,
	"result" jsonb,
	"derivation_event_id" uuid,
	CONSTRAINT "agent_runs_writer_check" CHECK ("agent_runs"."writer" IN ('agent_sql','server_apply','stub'))
);
--> statement-breakpoint
ALTER TABLE "ingests" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "ingests" ADD COLUMN "current_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ingest_id_ingests_id_fk" FOREIGN KEY ("ingest_id") REFERENCES "public"."ingests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_derivation_event_id_derivation_events_id_fk" FOREIGN KEY ("derivation_event_id") REFERENCES "public"."derivation_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_session_uq" ON "agent_runs" USING btree ("session_id") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_ingest_idx" ON "agent_runs" USING btree ("ingest_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_document_idx" ON "agent_runs" USING btree ("document_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_arm_idx" ON "agent_runs" USING btree ("kind","writer","prompt_version","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("started_at") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "ingests" ADD CONSTRAINT "ingests_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingests" ADD CONSTRAINT "ingests_current_run_id_agent_runs_id_fk" FOREIGN KEY ("current_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingests_document_idx" ON "ingests" USING btree ("document_id");--> statement-breakpoint
-- Backfill: an ingest's document is the one stored under the same
-- sha256-named path in the same workspace. (workspace_id, file_path) is
-- unique among documents, so each ingest matches at most one. Ingests
-- whose document was hard-deleted keep NULL; nothing else points at one.
UPDATE "ingests" i
   SET "document_id" = d."id"
  FROM "documents" d
 WHERE d."workspace_id" = i."workspace_id"
   AND d."file_path" = i."file_path"
   AND i."document_id" IS NULL;
