import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, updatedAt } from "./common.js";
import { documentKindEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";
import { transactions } from "./transactions.js";
import { ingests } from "./ingests.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: documentKindEnum("kind").notNull(),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    sha256: text("sha256").notNull(),
    ocrText: text("ocr_text"),
    /** Model identifier under which `ocr_text` was produced. NULL on
     *  legacy rows (anything ingested before #91 / Phase 4b). Set by
     *  the ingest worker on new uploads and overwritten by
     *  `POST /v1/documents/:id/re-extract` (Phase 4c). Distinct from
     *  `transactions.metadata.extraction.model` (#88) because OCR text
     *  and transaction-structure extraction can in principle run
     *  under different models (vision OCR vs structured extraction).
     *  Today they share one call, so both fields end up equal — the
     *  split matters once re-extract decouples them. */
    ocrModelVersion: text("ocr_model_version"),
    extractionMeta: jsonb("extraction_meta"),
    sourceIngestId: uuid("source_ingest_id").references(
      (): AnyPgColumn => ingests.id,
      { onDelete: "set null" },
    ),
    // Soft-delete tombstone. NULL = visible. Set to NOW() by
    // `DELETE /v1/documents/:id` (default soft delete). Hard delete
    // (`?hard=true`) removes the row outright. Re-uploading the same
    // bytes resurrects a soft-deleted row by clearing this column.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Content dedupe per workspace. Spans soft-deleted rows on purpose:
    // re-uploading identical bytes hits the same row and resurrects it.
    uniqueIndex("documents_workspace_sha_uniq").on(t.workspaceId, t.sha256),
    index("documents_kind_idx").on(t.workspaceId, t.kind),
    index("documents_source_ingest_idx").on(t.sourceIngestId),
    // Partial index for the hot path: list/get default to live rows.
    index("documents_workspace_live_idx")
      .on(t.workspaceId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const documentLinks = pgTable(
  "document_links",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.transactionId] }),
    index("document_links_txn_idx").on(t.transactionId),
  ],
);
