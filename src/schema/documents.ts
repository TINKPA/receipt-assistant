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
    /** RFC822 Message-ID for email-sourced documents (kind=receipt_email).
     *  NULL for non-email docs. This is the dedup key for the email
     *  channel: a re-forwarded copy of the same email has different bytes
     *  (so the sha256 index misses it) but the same Message-ID. Enforced
     *  by the partial unique index below. See #122. */
    messageId: text("message_id"),
    /** 64-bit DCT perceptual hash, 16 hex chars. Image documents only;
     *  NULL for pdf/eml, undecodable files, and legacy rows until
     *  backfilled (`scripts/backfill-phash.ts`). L2 dedup signal
     *  (#134): byte-different copies of the same shot land at d ≤ 2 —
     *  but so can two DIFFERENT purchases captured from the same app
     *  UI template (production calibration 2026-06-10), and same-table
     *  re-shots of different receipts appear from d = 4. A pHash hit
     *  is therefore a candidate-surfacing signal for the extraction
     *  agent's near-dup decision; extracted fields decide, never the
     *  hash alone. */
    phash: text("phash"),
    /** Channel provenance for non-image sources, kept separate from
     *  `extraction_meta` (which records what produced the row). For
     *  email: `{channel:'eml', sender, subject, received_at, message_id}`.
     *  See #122. */
    sourceMeta: jsonb("source_meta"),
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
    // Email-channel dedup: one document per (workspace, Message-ID).
    // Partial so it only constrains email docs; non-email rows have a
    // NULL message_id and are unaffected. See #122.
    uniqueIndex("documents_workspace_message_id_uniq")
      .on(t.workspaceId, t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
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
