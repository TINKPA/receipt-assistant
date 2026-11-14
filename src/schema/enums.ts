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

// One `claude -p` run (or a stub standing in for one), recorded by the
// server in `agent_runs`. See `src/schema/agent_runs.ts` for what each
// value means and who writes it.
export const agentRunKindEnum = pgEnum("agent_run_kind", ["ingest", "re_extract"]);

//   queued    → reserved for the durable queue (wave 1, P6); nothing writes it yet
//   running   → the run row exists and the child was (about to be) spawned
//   finished  → the server saw the child exit and recorded the outcome
//   abandoned → the server restarted while the run was `running`; nobody
//               saw it end. Set at boot (`abandonInterruptedRuns`).
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "finished",
  "abandoned",
]);

// Created whole in migration 0042 so later phases add no enum value;
// P1 writes written / attached / unsupported / duplicate_skip / no_change /
// agent_error / failed / interrupted. The rest belong to the server writer
// (recorded_only, invalid_record, reapplied) and the durable queue (adopted).
export const agentRunOutcomeEnum = pgEnum("agent_run_outcome", [
  "written",
  "attached",
  "unsupported",
  "recorded_only",
  "duplicate_skip",
  "no_change",
  "adopted",
  "reapplied",
  "invalid_record",
  "agent_error",
  "failed",
  "interrupted",
]);

// Where a `document_extractions` record came from (wave 1, P2): the
// extraction agent, the sandbox stub, a record synthesised from an
// existing ledger row (wave 2), or a person.
export const extractionOriginEnum = pgEnum("extraction_origin", [
  "agent",
  "stub",
  "ledger_backfill",
  "manual",
]);

// Whether a stored extraction record passed validation. An invalid one is
// kept as evidence of what the agent handed back and is never applied.
export const extractionStatusEnum = pgEnum("extraction_status", ["valid", "invalid"]);

// Background-enrichment state for merchant rows (#64). New merchants land
// as `pending`; the Places worker advances to `success`/`not_found`/`failed`
// after one round-trip to Google Places. `failed` retries on backoff.
export const merchantEnrichmentStatusEnum = pgEnum("merchant_enrichment_status", [
  "pending",
  "success",
  "not_found",
  "failed",
]);
