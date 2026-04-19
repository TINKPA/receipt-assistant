import {
  pgTable,
  uuid,
  text,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
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
    extractionMeta: jsonb("extraction_meta"),
    sourceIngestId: uuid("source_ingest_id").references(
      (): AnyPgColumn => ingests.id,
      { onDelete: "set null" },
    ),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Content dedupe per workspace. Globally unique sha256 would break
    // multi-tenant isolation (workspace A can't see B's upload).
    uniqueIndex("documents_workspace_sha_uniq").on(t.workspaceId, t.sha256),
    index("documents_kind_idx").on(t.workspaceId, t.kind),
    index("documents_source_ingest_idx").on(t.sourceIngestId),
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
