import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  bigint,
  date,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { extractionOriginEnum, extractionStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";
import { documents } from "./documents.js";
import { ingests } from "./ingests.js";
import { agentRuns } from "./agent_runs.js";

/**
 * One row per reading of a document: the extraction record an agent run
 * handed back (`src/ingest/contract/v1.ts`), as validated, with what the
 * validator found (wave 1, P2; migration 0043). Written only by
 * `src/ingest/records.ts`.
 *
 * Why it exists: under the server writer the ledger is derived from this
 * record in code, so the reading is stored before it is applied. A failed
 * apply is retried by applying the record again, never by reading the
 * document again (about 0.9M tokens a run), and a reading that was not
 * booked (an attached duplicate, an unsupported document, a statement)
 * is still kept. Derived rows point back at it: `transaction_items`,
 * `derivation_events` and `agent_runs` carry `extraction_id`, and the
 * transaction's server-owned `metadata.extraction.extraction_id` names it.
 *
 * IMMUTABLE. A trigger refuses every UPDATE that changes anything but
 * `superseded_at`, except a foreign key's ON DELETE SET NULL clearing a
 * reference to a row that is gone. A newer reading of the same document
 * is a new row that names the old one in `supersedes_id`; the old one
 * gets `superseded_at`. The partial unique index keeps at most one current
 * (not superseded) valid record per document. An invalid record never
 * supersedes anything: it is evidence of what the agent handed back, not
 * a reading the ledger can use.
 *
 * Deleting the document deletes its records (a hard delete is a purge).
 * The `receipts_agent` role has no grant on this table; `receipts_ro`
 * (Ask) reads it like every other table.
 */
export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    ingestId: uuid("ingest_id").references((): AnyPgColumn => ingests.id, {
      onDelete: "set null",
    }),
    agentRunId: uuid("agent_run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "set null",
    }),
    origin: extractionOriginEnum("origin").notNull(),
    status: extractionStatusEnum("status").notNull(),
    /** `EXTRACTION_CONTRACT_VERSION` the record was validated against. */
    contractVersion: integer("contract_version").notNull(),
    promptVersion: text("prompt_version"),
    promptGitSha: text("prompt_git_sha"),
    /** The model the transcript says answered (`model_observed`); never
     *  `cli-default`, NULL when unknown. */
    model: text("model"),
    /** sha256 of the decoded source text shown to the agent (email, HTML). */
    sourceTextSha256: text("source_text_sha256"),
    /** What the run was given: `{phash_neighbors, attachments:[{bytes,sha256}], prompt_bytes}`. */
    inputMeta: jsonb("input_meta").notNull().default({}),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => documentExtractions.id,
      { onDelete: "set null" },
    ),
    /** The only column an UPDATE may change. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    // Promoted copies of the record, for queries that should not dig in
    // `result`. On an invalid record only the values that are well formed.
    classification: text("classification"),
    flow: text("flow"),
    occurredOn: date("occurred_on"),
    totalMinor: bigint("total_minor", { mode: "number" }),
    currency: text("currency"),
    payee: text("payee"),
    identifiers: jsonb("identifiers").notNull().default({}),
    cardLast4: text("card_last4"),
    /** The record as validated (normalised, defaults applied); for an
     *  invalid one, as parsed. */
    result: jsonb("result").notNull(),
    /** The ```receipt-text block that came with the record. */
    rawText: text("raw_text"),
    /** `{errors, warnings, normalizations[, repairs]}` (`ValidationReport`). */
    validation: jsonb("validation")
      .notNull()
      .default({ errors: [], warnings: [], normalizations: [] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("document_extractions_current_uq")
      .on(t.documentId)
      .where(sql`status = 'valid' AND superseded_at IS NULL`),
    index("document_extractions_run_idx").on(t.agentRunId),
    index("document_extractions_ident_gin").using("gin", t.identifiers.op("jsonb_path_ops")),
    check(
      "document_extractions_classification_check",
      sql`${t.status} = 'invalid' OR ${t.classification} IS NOT NULL`,
    ),
  ],
);
