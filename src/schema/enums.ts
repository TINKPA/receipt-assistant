import { pgEnum } from "drizzle-orm/pg-core";

export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

export const txnStatusEnum = pgEnum("txn_status", [
  "draft",
  "posted",
  "voided",
  "reconciled",
  "error",
]);

export const documentKindEnum = pgEnum("document_kind", [
  "receipt_image",
  "receipt_email",
  "receipt_pdf",
  "statement_pdf",
  "other",
]);

export const workspaceRoleEnum = pgEnum("workspace_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

// Batch ingest pipeline (#32). Parent container aggregating N files.
//
//   pending    → row created, no workers started yet
//   processing → at least one child ingest entered processing
//   extracted  → all children terminal (done/error/unsupported)
//   failed     → startup crash recovery marked the batch abandoned
//
// Phase 2 will introduce `reconciling` + `reconciled` + `reconcile_error`;
// the enum already carries them so the column type is stable.
export const batchStatusEnum = pgEnum("batch_status", [
  "pending",
  "processing",
  "extracted",
  "reconciling",
  "reconciled",
  "failed",
  "reconcile_error",
]);

// Single-file ingest state. Siblings are independent — one erroring
// does not fail the batch.
//
//   queued      → inserted, not yet dequeued
//   processing  → worker picked it up, claude running
//   done        → classification + extraction wrote transactions/documents
//   error       → extractor threw or DB write failed
//   unsupported → agent classified as not-a-financial-document
//   dedup       → L1 short-circuit (#124): the file is byte-identical to a
//                 document already linked to a live transaction, so the
//                 agent was never spawned. `produced.transaction_ids`
//                 points at the pre-existing transaction. A terminal state.
//   near_dup    → L2/L3a attach (#134): the agent extracted the document,
//                 judged it a near-duplicate of an existing transaction
//                 (pHash candidate + matching tiebreakers), and ATTACHED
//                 the document to that transaction instead of inserting a
//                 new one. `produced.transaction_ids` points at the
//                 existing transaction; the worker verifies the link
//                 really exists before trusting this state. Terminal.
//                 Probabilistic (vs `dedup`'s byte-certainty) — the
//                 attach is user-reversible by unlinking the document.
export const ingestStatusEnum = pgEnum("ingest_status", [
  "queued",
  "processing",
  "done",
  "error",
  "unsupported",
  "dedup",
  "near_dup",
]);

// Background-enrichment state for merchant rows (#64). New merchants land
// as `pending`; the Places worker advances to `success`/`not_found`/`failed`
// after one round-trip to Google Places. `failed` retries on backoff.
export const merchantEnrichmentStatusEnum = pgEnum("merchant_enrichment_status", [
  "pending",
  "success",
  "not_found",
  "failed",
]);
