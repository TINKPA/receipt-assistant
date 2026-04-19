CREATE TYPE "public"."batch_status" AS ENUM('pending', 'processing', 'extracted', 'reconciling', 'reconciled', 'failed', 'reconcile_error');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('queued', 'processing', 'done', 'error', 'unsupported');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" "batch_status" DEFAULT 'pending' NOT NULL,
	"file_count" integer NOT NULL,
	"auto_reconcile" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ingests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text,
	"file_path" text NOT NULL,
	"status" "ingest_status" DEFAULT 'queued' NOT NULL,
	"classification" text,
	"produced" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reconcile_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"score" real,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingests" ADD CONSTRAINT "ingests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingests" ADD CONSTRAINT "ingests_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconcile_proposals" ADD CONSTRAINT "reconcile_proposals_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_workspace_created_idx" ON "batches" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "ingests_batch_idx" ON "ingests" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "ingests_workspace_created_idx" ON "ingests" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ingests_status_idx" ON "ingests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "reconcile_proposals_batch_idx" ON "reconcile_proposals" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "reconcile_proposals_kind_idx" ON "reconcile_proposals" USING btree ("batch_id","kind");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_ingest_id_ingests_id_fk" FOREIGN KEY ("source_ingest_id") REFERENCES "public"."ingests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_ingest_id_ingests_id_fk" FOREIGN KEY ("source_ingest_id") REFERENCES "public"."ingests"("id") ON DELETE set null ON UPDATE no action;