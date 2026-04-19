import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createdAt } from "./common.js";
import { ingestStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";
import { batches } from "./batches.js";

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
  },
  (t) => [
    index("ingests_batch_idx").on(t.batchId),
    index("ingests_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
    index("ingests_status_idx").on(t.workspaceId, t.status),
  ],
);
