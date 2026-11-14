import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt } from "./common.js";
import { ingestStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";
import { batches } from "./batches.js";
import { documents } from "./documents.js";
import { agentRuns } from "./agent_runs.js";

/**
 * One row per file in a batch. The agent's classification lands in
 * `classification`; downstream-produced ids (transactions, documents)
 * live in `produced` JSONB so clients can follow provenance in either
 * direction:
 *
 *   - ingest.produced → [{ transaction_ids, document_ids }]
 *   - transactions.source_ingest_id → ingest.id
 *   - documents.source_ingest_id → ingest.id
 *
 * `batch_id` is nullable so single-file `POST /receipt`-style callers
 * can stay wired through the same pipeline (Phase 2 work, but the
 * column shape is already correct).
 *
 * `document_id` is the document the file was stored as. It used to be
 * re-derived by matching `file_path` on every read; it is now written at
 * upload (migration 0042 backfilled older rows the same way).
 *
 * `current_run_id` points at the `agent_runs` row that owns the ingest
 * while it is `processing`, written in the same transaction that moves
 * it there. It is the run fence the server writer will check before it
 * writes (wave 1). The extraction agent's role cannot update either
 * column (`AGENT_GRANTS.ingests`).
 */
export const ingests = pgTable(
  "ingests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => batches.id, {
      onDelete: "cascade",
    }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type"),
    filePath: text("file_path").notNull(),
    status: ingestStatusEnum("status").notNull().default("queued"),
    classification: text("classification"),
    produced: jsonb("produced"),
    error: text("error"),
    createdAt,
    completedAt: timestamp("completed_at", { withTimezone: true }),
    documentId: uuid("document_id").references((): AnyPgColumn => documents.id, {
      onDelete: "set null",
    }),
    currentRunId: uuid("current_run_id").references(
      (): AnyPgColumn => agentRuns.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("ingests_batch_idx").on(t.batchId),
    index("ingests_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
    index("ingests_status_idx").on(t.workspaceId, t.status),
    index("ingests_document_idx").on(t.documentId),
  ],
);
