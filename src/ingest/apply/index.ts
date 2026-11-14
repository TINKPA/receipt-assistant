/**
 * The server applier's entry points (wave 1; docs/server-writer.md,
 * "applyExtraction"): what the worker (`extractRecordAndApply` in
 * `../worker.ts`) calls under `EXTRACTION_WRITER=server_apply`, or for a
 * record stub, once an agent (or the stub) has handed back an extraction
 * record. Nothing calls them on the `agent_sql` path.
 *
 *   recordExtraction       T1: store the record, valid or invalid,
 *                          in one fenced transaction. An invalid record
 *                          with no repair round left also errors the
 *                          ingest and finishes the run (`invalid_record`).
 *   closeRunWithoutRecord  the same close for a run that handed back no
 *                          record at all (`artefact_missing`); a run that
 *                          no longer owns its ingest finishes `fenced_out`.
 *   applyExtraction        T2: pre-fetch the place outside any
 *                          transaction, then ONE transaction (`write.ts`):
 *                          prologue and fence, the Message-ID check again
 *                          (X9 under the lock), project, candidates,
 *                          decide, the branch's writes, the document stamp,
 *                          the ingest close and the run finish, all or
 *                          nothing. 40001, 40P01, 55P03 and a changed
 *                          attach target are retried in-process twice;
 *                          after that, or on any other failure, a short
 *                          transaction errors the ingest
 *                          (`apply failed: <code>`) and finishes the run
 *                          `failed` / `apply`. The record stays valid and
 *                          unapplied. A fenced-out apply touches neither
 *                          the ingest nor the ledger.
 *   applyMessageIdDuplicate  X9, before any spawn: link a re-forwarded
 *                          email to the live transaction(s) of the earlier
 *                          copy and close the ingest `dedup`. Null when
 *                          the Message-ID is not in the ledger. The run
 *                          is finished with no session, model or CLI:
 *                          nothing was spawned.
 *   reapplyRecord          apply a record that is already stored (an
 *                          apply-only attempt, P6; re-projection, P7). The
 *                          run's outcome is `reapplied`; `apply_report`
 *                          says which branch ran.
 *   dryRun                 project, find candidates and decide in a
 *                          READ ONLY transaction, writing nothing.
 *   runPostCommitPasses    the points valuation, then the FX pass, on what
 *                          an apply wrote (both idempotent, neither throws).
 *
 * The worker's other post-commit steps (SSE, batch completion, reconcile,
 * the lesson append) stay the worker's.
 *
 * The short labels in this directory's comments (T1, T2, X9, hole 5, P6,
 * gate G2, insert step c) are defined in docs/server-writer.md,
 * "Labels used in the code".
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { documentExtractions } from "../../schema/index.js";
import { findPgError } from "../../http/pg-error.js";
import { normalizeFxSafely } from "../../fx/normalize.js";
import { valuePointsSafely } from "../../points/valuation.js";
import { summarizeSessionById } from "../../session-transcript.js";
import { ExtractionV1Schema, isReceiptClassification, type ExtractionV1 } from "../contract/v1.js";
import type { ValidationOutcome } from "../contract/validate.js";
import { currentExtractionRecord, insertExtractionRecord, type ExtractionOrigin } from "../records.js";
import { RECORD_PROMPT_VERSION } from "../prompt-contract.js";
import type { RunErrorClass, RunOutcome } from "../runs.js";
import { readAccountCatalog } from "./accounts.js";
import { findCandidates } from "./candidates.js";
import { decide, type ApplyDecision } from "./decide.js";
import { fingerprintFromDraft, type Fingerprint } from "./fingerprint.js";
import { prefetchPlace, type PlaceFetcher, type PlacePrefetch } from "./places.js";
import { project, type ApplyDraft } from "./project.js";
import { readMerchant } from "./catalog.js";
import {
  ApplyError,
  applyMessageIdDuplicate as messageIdDuplicateIn,
  applyNotBooked,
  applyReceipt,
  closeIngest,
  finishRunIn,
  produced,
  prologue,
  type ApplyIds,
  type ApplyReport,
  type BranchResult,
  type ClosedStatus,
  type DbTx,
  type RunStats,
  type ServerSource,
} from "./write.js";

export {
  ApplyError,
  SERVER_DECODE_VERSION,
  STATEMENT_NOT_BOOKED,
  type ApplyFailureCode,
  type ApplyIds,
  type ApplyReport,
  type RunStats,
  type ServerSource,
} from "./write.js";
export { prefetchPlace, type PlaceFetcher, type PlacePrefetch } from "./places.js";

/** Attempts of one apply transaction: the first and two retries. */
export const APPLY_ATTEMPTS = 3;
/** SQLSTATEs retried in-process: serialization failure, deadlock, lock timeout. */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03"]);

export interface ApplyInput extends ApplyIds {
  /** The `document_extractions` row to apply (T1 stored it). */
  extractionId: string;
  /** What the server decoded from the source before the run. */
  source?: ServerSource | null;
  /** The live transactions behind the document's pHash neighbours. */
  phashTransactionIds?: readonly string[];
  /** The run's transcript summary and exit; read from the session when absent. */
  stats?: RunStats | null;
  /** A place pre-fetch done by the caller; when undefined, done here. */
  place?: PlacePrefetch | null;
  /** The Google fetch `prefetchPlace` uses (default `fetchPlaceV1Dual`). */
  placeFetcher?: PlaceFetcher;
}

export interface ApplyResult {
  /** The run's outcome: `written`, `attached`, `unsupported`,
   *  `recorded_only`, `duplicate_skip`, `reapplied`, or `failed`. */
  outcome: RunOutcome;
  /** What the ingest was closed as; null when it was not touched (fenced out). */
  ingestStatus: ClosedStatus | "error" | null;
  transactionIds: string[];
  extractionId: string | null;
  errorClass: "apply" | "fenced_out" | null;
  error: string | null;
  attempts: number;
  report: ApplyReport | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failureCode(err: unknown): string {
  if (err instanceof ApplyError) return err.code;
  const pg = findPgError(err);
  return pg ? pg.code : "internal";
}

function isTransient(err: unknown): boolean {
  if (err instanceof ApplyError) return err.retryable;
  const pg = findPgError(err);
  return pg !== null && TRANSIENT_SQLSTATES.has(pg.code);
}

/** The ingest's error text for a failed apply: the code and, for our own
 *  refusals and constraint names, what names no value. */
export function applyFailureText(err: unknown): string {
  if (err instanceof ApplyError) return `apply failed: ${err.code}: ${err.message}`;
  const pg = findPgError(err);
  if (pg) return `apply failed: ${pg.code}${pg.constraint ? ` ${pg.constraint}` : ""}`;
  return "apply failed: internal";
}

/** The run's transcript summary, as `finishRun` records it. */
export function statsFromSession(sessionId: string | null): RunStats | null {
  if (!sessionId) return null;
  const s = summarizeSessionById(sessionId);
  if (!s) return null;
  return {
    modelObserved: s.model,
    turns: s.turns,
    toolCalls: s.toolCalls,
    inputTokens: s.freshInput,
    cacheReadTokens: s.cacheRead,
    cacheCreationTokens: s.cacheCreation,
    outputTokens: s.output,
    transcriptBytes: s.transcriptBytes,
  };
}

async function runStatsFor(ids: ApplyIds, given: RunStats | null | undefined): Promise<RunStats | null> {
  if (given !== undefined) return given;
  const run = await db.execute(sql`SELECT session_id, writer FROM agent_runs WHERE id = ${ids.runId}::uuid`);
  const row = run.rows[0] as { session_id: string | null; writer: string } | undefined;
  return row && row.writer !== "stub" ? statsFromSession(row.session_id) : null;
}

/**
 * Run `body` in one transaction, retrying a transient failure
 * (docs/server-writer.md, "Failures and retries").
 * Returns the body's value and the attempt it took, or the last error.
 */
async function withRetries<T>(
  label: string,
  body: (tx: DbTx, attempt: number) => Promise<T>,
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; err: unknown; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await db.transaction((tx) => body(tx, attempt)), attempts: attempt };
    } catch (err) {
      if (isTransient(err) && attempt < APPLY_ATTEMPTS) {
        console.warn(`[apply] ${label}: attempt ${attempt} failed (${failureCode(err)}); retrying`);
        await sleep(50 * attempt);
        continue;
      }
      return { ok: false, err, attempts: attempt };
    }
  }
}

/**
 * After a failed apply: error the ingest (when it is still this run's)
 * and finish the run, in one short transaction. A fenced-out apply only
 * finishes its own run, if that is still running; the ingest belongs to
 * whoever fenced it out.
 *
 * The run's finish runs under a savepoint: whatever goes wrong there,
 * the ingest's close still commits. Before that, a document hard-deleted
 * between T1 and T2 took its record with it, the finish named the gone
 * record, the foreign key refused it, and the whole close rolled back,
 * leaving the ingest `processing` and the batch waiting for a restart.
 * (`finishRunIn` now names a record only while it exists.)
 */
async function closeFailure(
  ids: ApplyIds,
  err: unknown,
  attempts: number,
  extractionId: string | null,
  stats: RunStats | null,
): Promise<ApplyResult> {
  const fenced = err instanceof ApplyError && err.code === "fenced_out";
  const error = (fenced ? `apply fenced out: ${(err as ApplyError).message}` : applyFailureText(err)).slice(0, 2000);
  console.error(
    `[apply] ingest=${ids.ingestId} run=${ids.runId} ${fenced ? "fenced out" : "failed"} after ${attempts} attempt(s):`,
    err,
  );
  const report = { failure: failureCode(err), attempts };
  let ingestStatus: ApplyResult["ingestStatus"] = null;
  try {
    await db.transaction(async (tx) => {
      if (!fenced) {
        const closed = await tx.execute(sql`
          UPDATE ingests
             SET status = 'error',
                 error = ${error},
                 produced = ${JSON.stringify(produced(ids, [], extractionId))}::jsonb,
                 completed_at = now()
           WHERE id = ${ids.ingestId}::uuid AND workspace_id = ${ids.workspaceId}::uuid
             AND current_run_id = ${ids.runId}::uuid AND status = 'processing'
          RETURNING id`);
        if (closed.rows.length === 1) ingestStatus = "error";
      }
      try {
        await tx.transaction((sp) =>
          finishRunIn(sp, ids.runId, {
            outcome: "failed",
            errorClass: fenced ? "fenced_out" : "apply",
            error,
            applyReport: report,
            extractionId,
            stats,
          }),
        );
      } catch (finishErr) {
        // The run stays `running`; boot recovery abandons it. The ingest's
        // close above is what must not be lost.
        console.error(`[apply] could not finish run ${ids.runId} after its failure:`, finishErr);
      }
    });
  } catch (closeErr) {
    console.error(`[apply] could not record the failure of run ${ids.runId}:`, closeErr);
  }
  return {
    outcome: "failed",
    ingestStatus,
    transactionIds: [],
    extractionId,
    errorClass: fenced ? "fenced_out" : "apply",
    error,
    attempts,
    report: null,
  };
}

/** The stored record, re-read through the schema (it is the validator's
 *  output, so it parses as it is). */
async function loadRecord(
  ids: Pick<ApplyIds, "workspaceId" | "documentId">,
  extractionId: string,
): Promise<{ record: ExtractionV1; rawText: string | null }> {
  const rows = await db
    .select({
      status: documentExtractions.status,
      result: documentExtractions.result,
      rawText: documentExtractions.rawText,
    })
    .from(documentExtractions)
    .where(
      and(
        eq(documentExtractions.id, extractionId),
        eq(documentExtractions.workspaceId, ids.workspaceId),
        eq(documentExtractions.documentId, ids.documentId),
      ),
    );
  const row = rows[0];
  if (!row) throw new ApplyError("record_missing", `record ${extractionId} is not this document's`);
  if (row.status !== "valid") throw new ApplyError("record_unusable", `record ${extractionId} is invalid`);
  const parsed = ExtractionV1Schema.safeParse(row.result);
  if (!parsed.success) throw new ApplyError("record_unusable", `record ${extractionId} no longer parses as contract v1`);
  return { record: parsed.data, rawText: row.rawText ?? null };
}

async function applyStored(input: ApplyInput, outcomeOverride?: RunOutcome): Promise<ApplyResult> {
  const ids: ApplyIds = {
    workspaceId: input.workspaceId,
    ingestId: input.ingestId,
    runId: input.runId,
    documentId: input.documentId,
  };
  const stats = await runStatsFor(ids, input.stats);
  let loaded: { record: ExtractionV1; rawText: string | null };
  try {
    loaded = await loadRecord(ids, input.extractionId);
  } catch (err) {
    return closeFailure(ids, err, 0, input.extractionId, stats);
  }
  const { record, rawText } = loaded;
  const receipt = isReceiptClassification(record.classification);
  // Network, outside any transaction: a cache miss is fetched now.
  const place =
    input.place !== undefined
      ? input.place
      : receipt
        ? await prefetchPlace(db, record.place?.google_place_id, input.placeFetcher)
        : null;

  const run = await withRetries(`ingest=${ids.ingestId}`, async (tx, attempt) => {
    const pro = await prologue(tx, ids);
    const c = {
      ids,
      pro,
      extractionId: input.extractionId,
      record,
      rawText,
      source: input.source ?? null,
      phashTransactionIds: input.phashTransactionIds ?? [],
      place,
      stats,
    };
    // X9 again, under the apply lock: the pre-spawn check cannot see a copy
    // of the same email that was applied while this run read (two copies
    // in flight at once). Linked like the pre-spawn case, never inserted
    // twice; the record stays stored as this document's reading.
    const dup = input.source?.email?.messageId
      ? await messageIdDuplicateIn(tx, { ids, pro, source: input.source })
      : null;
    const branch: BranchResult = dup ?? (receipt ? await applyReceipt(tx, c) : await applyNotBooked(tx, c));
    const out = produced(ids, branch.transactionIds, input.extractionId);
    await closeIngest(tx, ids, {
      status: branch.status,
      classification: record.classification,
      produced: out,
      error: branch.error,
    });
    const report: ApplyReport = { ...branch.report, attempts: attempt };
    const outcome = outcomeOverride ?? branch.outcome;
    await finishRunIn(tx, ids.runId, {
      outcome,
      produced: out,
      applyReport: report,
      extractionId: input.extractionId,
      stats,
      required: true,
    });
    return { branch, report, outcome };
  });
  if (!run.ok) return closeFailure(ids, run.err, run.attempts, input.extractionId, stats);
  return {
    outcome: run.value.outcome,
    ingestStatus: run.value.branch.status,
    transactionIds: run.value.branch.transactionIds,
    extractionId: input.extractionId,
    errorClass: null,
    error: null,
    attempts: run.attempts,
    report: run.value.report,
  };
}

/** T2 for a record T1 just stored. See the header. */
export function applyExtraction(input: ApplyInput): Promise<ApplyResult> {
  return applyStored(input);
}

/**
 * Apply a record that is already stored: `extractionId`, or the
 * document's current valid record. The run (a fresh one, holding the
 * ingest's fence) finishes `reapplied`.
 */
export async function reapplyRecord(
  input: Omit<ApplyInput, "extractionId"> & { extractionId?: string },
): Promise<ApplyResult> {
  let extractionId = input.extractionId;
  if (!extractionId) {
    const current = await currentExtractionRecord(db, input.documentId);
    if (!current || current.workspaceId !== input.workspaceId) {
      const ids: ApplyIds = input;
      return closeFailure(
        ids,
        new ApplyError("record_missing", `document ${input.documentId} has no current valid record`),
        0,
        null,
        await runStatsFor(ids, input.stats),
      );
    }
    extractionId = current.id;
  }
  return applyStored({ ...input, extractionId }, "reapplied");
}

export interface MessageIdDuplicateInput extends ApplyIds {
  /** The server's decode of the email; `email.messageId` is what is matched. */
  source: ServerSource;
  stats?: RunStats | null;
}

/** X9. See the header. Null: not a duplicate of anything live, nothing written. */
export async function applyMessageIdDuplicate(input: MessageIdDuplicateInput): Promise<ApplyResult | null> {
  const ids: ApplyIds = input;
  if (!input.source.email?.messageId) return null;
  const stats = input.stats ?? null;
  class NotADuplicate extends Error {}
  const run = await withRetries(`message-id ingest=${ids.ingestId}`, async (tx, attempt) => {
    const pro = await prologue(tx, ids);
    const branch = await messageIdDuplicateIn(tx, { ids, pro, source: input.source });
    if (!branch) throw new NotADuplicate();
    const out = produced(ids, branch.transactionIds, null);
    await closeIngest(tx, ids, { status: branch.status, classification: "receipt_email", produced: out, error: branch.error });
    const report: ApplyReport = { ...branch.report, attempts: attempt };
    await finishRunIn(tx, ids.runId, {
      outcome: branch.outcome,
      produced: out,
      applyReport: report,
      stats,
      required: true,
      noAgent: true,
    });
    return { branch, report };
  });
  if (!run.ok) {
    if (run.err instanceof NotADuplicate) return null;
    return closeFailure(ids, run.err, run.attempts, null, stats);
  }
  return {
    outcome: run.value.branch.outcome,
    ingestStatus: run.value.branch.status,
    transactionIds: run.value.branch.transactionIds,
    extractionId: null,
    errorClass: null,
    error: run.value.branch.error,
    attempts: run.attempts,
    report: run.value.report,
  };
}

// ── T1 ─────────────────────────────────────────────────────────────────

export interface RecordInput extends ApplyIds {
  origin: ExtractionOrigin;
  outcome: ValidationOutcome;
  rawText?: string | null;
  /** Default `RECORD_PROMPT_VERSION`. */
  promptVersion?: string | null;
  sourceTextSha256?: string | null;
  inputMeta?: Record<string, unknown>;
  /** Repair rounds the record went through (stored on the run). */
  repairRounds?: number;
  stats?: RunStats | null;
  /** True when no repair round is left: an invalid record then closes the run. */
  final?: boolean;
  /**
   * A repair round's spawn failed (auth, quota, timeout, a crash) and left
   * the earlier, invalid record standing. The record is stored as evidence
   * all the same, but the run ends `agent_error` with this class and the
   * ingest carries the agent's error: the outage is what happened, not a
   * bad reading, and the watch query must count it as one.
   */
  agentFailure?: { errorClass: RunErrorClass; error: string } | null;
}

export interface RecordResult {
  fencedOut: boolean;
  extractionId: string | null;
  status: "valid" | "invalid" | null;
  /** True when the ingest was errored and the run finished here. */
  closed: boolean;
  /** The ingest's error when `closed`. */
  error: string | null;
}

/** Longest `ingests.error` / `agent_runs.error` written here. */
const ERROR_TEXT_MAX = 2000;

/** The ingest's error for a rejected record: the first error's path and
 *  rule (a path quotes any key that is not a plain name; see `formatPath`). */
export function rejectedText(outcome: ValidationOutcome): string {
  const [first, ...rest] = outcome.report.errors;
  const head = first ? `${first.path === "" ? "record" : first.path}: ${first.rule}` : "record: schema";
  return `extraction record rejected: ${head}${rest.length > 0 ? ` (+${rest.length} more)` : ""}`.slice(0, ERROR_TEXT_MAX);
}

/**
 * T1 (docs/server-writer.md, "The evidence store"). Fenced like the
 * apply: a run that no longer owns the ingest stores nothing. A valid
 * record supersedes the document's current one
 * (`records.ts`). An invalid record is stored as evidence; when `final`,
 * the ingest errors and the run finishes `invalid_record` /
 * `artefact_invalid` (or `agent_error` with `agentFailure`'s class) in the
 * same transaction. A document hard-deleted while the agent read has no
 * row to hang a record on: the ingest errors `document_missing` and the
 * run finishes `failed` / `apply`, as T2 would.
 */
export async function recordExtraction(input: RecordInput): Promise<RecordResult> {
  const ids: ApplyIds = input;
  return db.transaction(async (tx) => {
    const fence = await tx.execute(sql`
      SELECT r.prompt_git_sha
        FROM ingests i JOIN agent_runs r ON r.id = i.current_run_id
       WHERE i.id = ${ids.ingestId}::uuid AND i.workspace_id = ${ids.workspaceId}::uuid
         AND i.current_run_id = ${ids.runId}::uuid AND i.status = 'processing' AND r.status = 'running'
         FOR UPDATE OF i`);
    const run = fence.rows[0] as { prompt_git_sha: string } | undefined;
    if (!run) return { fencedOut: true, extractionId: null, status: null, closed: false, error: null };

    const close = async (
      extractionId: string | null,
      f: { outcome: RunOutcome; errorClass: RunErrorClass; error: string },
    ): Promise<void> => {
      const out = produced(ids, [], extractionId);
      await tx.execute(sql`
        UPDATE ingests
           SET status = 'error', error = ${f.error},
               produced = ${JSON.stringify(out)}::jsonb,
               completed_at = now()
         WHERE id = ${ids.ingestId}::uuid AND current_run_id = ${ids.runId}::uuid AND status = 'processing'`);
      await finishRunIn(tx, ids.runId, {
        outcome: f.outcome,
        errorClass: f.errorClass,
        error: f.error,
        extractionId,
        produced: out,
        stats: input.stats ?? null,
        required: true,
      });
    };

    const doc = await tx.execute(sql`
      SELECT 1 FROM documents WHERE id = ${ids.documentId}::uuid AND workspace_id = ${ids.workspaceId}::uuid`);
    if (doc.rows.length === 0) {
      const error = applyFailureText(
        new ApplyError("document_missing", `document ${ids.documentId} was deleted before its record was stored`),
      );
      await close(null, { outcome: "failed", errorClass: "apply", error });
      return { fencedOut: false, extractionId: null, status: null, closed: true, error };
    }

    const stored = await insertExtractionRecord(tx, {
      workspaceId: ids.workspaceId,
      documentId: ids.documentId,
      ingestId: ids.ingestId,
      agentRunId: ids.runId,
      origin: input.origin,
      promptVersion: input.promptVersion === undefined ? RECORD_PROMPT_VERSION : input.promptVersion,
      promptGitSha: run.prompt_git_sha,
      model: input.stats?.modelObserved ?? null,
      sourceTextSha256: input.sourceTextSha256 ?? null,
      inputMeta: input.inputMeta,
      outcome: input.outcome,
      rawText: input.rawText ?? null,
    });
    if (input.repairRounds) {
      await tx.execute(sql`UPDATE agent_runs SET repair_rounds = ${input.repairRounds}::smallint WHERE id = ${ids.runId}::uuid`);
    }
    if (stored.status === "invalid" && input.final) {
      const failure = input.agentFailure ?? null;
      const error = failure ? failure.error.slice(0, ERROR_TEXT_MAX) : rejectedText(input.outcome);
      await close(stored.id, {
        outcome: failure ? "agent_error" : "invalid_record",
        errorClass: failure ? failure.errorClass : "artefact_invalid",
        error,
      });
      return { fencedOut: false, extractionId: stored.id, status: stored.status, closed: true, error };
    }
    return { fencedOut: false, extractionId: stored.id, status: stored.status, closed: false, error: null };
  });
}

/**
 * A run that handed back no record (`artefact_missing`): error the ingest
 * and finish the run, fenced. Returns false when the run no longer owns
 * the ingest: nothing is written but the run's own finish, as
 * `failed` / `fenced_out` (the record's absence is not what ended it).
 */
export async function closeRunWithoutRecord(
  ids: ApplyIds,
  f: { error: string; stats?: RunStats | null },
): Promise<boolean> {
  const error = f.error.slice(0, ERROR_TEXT_MAX);
  return db.transaction(async (tx) => {
    const closed = await tx.execute(sql`
      UPDATE ingests
         SET status = 'error', error = ${error},
             produced = ${JSON.stringify(produced(ids, [], null))}::jsonb,
             completed_at = now()
       WHERE id = ${ids.ingestId}::uuid AND workspace_id = ${ids.workspaceId}::uuid
         AND current_run_id = ${ids.runId}::uuid AND status = 'processing'
      RETURNING id`);
    const owned = closed.rows.length === 1;
    await finishRunIn(tx, ids.runId, {
      outcome: owned ? "invalid_record" : "failed",
      errorClass: owned ? "artefact_missing" : "fenced_out",
      error: owned ? error : `ingest ${ids.ingestId} is no longer this run's; ${error}`,
      stats: f.stats ?? null,
    });
    return owned;
  });
}

// ── Without writing ────────────────────────────────────────────────────

export interface DryRunResult {
  record: ExtractionV1;
  /** Null for a record that books nothing (unsupported, statement). */
  draft: ApplyDraft | null;
  decision: ApplyDecision | null;
  fingerprint: Fingerprint | null;
}

/**
 * What applying a record would do today, in a READ ONLY transaction:
 * the projection against the current chart of accounts, the candidates
 * (minus `excludeTransactionIds`, e.g. the transaction the record already
 * produced) and the decision. Throws `ApplyError` for a record it cannot
 * load, and a `ProjectionError` as `project` does.
 */
export async function dryRun(p: {
  workspaceId: string;
  documentId: string;
  extractionId: string;
  phashTransactionIds?: readonly string[];
  excludeTransactionIds?: readonly string[];
}): Promise<DryRunResult> {
  const { record, rawText } = await loadRecord(p, p.extractionId);
  if (!isReceiptClassification(record.classification)) {
    return { record, draft: null, decision: null, fingerprint: null };
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const catalog = await readAccountCatalog(tx, p.workspaceId);
    const existingMerchant = await readMerchant(tx, p.workspaceId, record.merchant!.brand_id);
    const draft = project(record, catalog, { existingMerchant });
    const exclude = new Set(p.excludeTransactionIds ?? []);
    const candidates = (
      await findCandidates(tx, { workspaceId: p.workspaceId, record, phashTransactionIds: p.phashTransactionIds ?? [] })
    ).filter((c) => !exclude.has(c.id));
    const decision = decide(record, candidates);
    const doc = await tx.execute(sql`SELECT mime_type FROM documents WHERE id = ${p.documentId}::uuid`);
    const mime = String((doc.rows[0] as { mime_type: string | null } | undefined)?.mime_type ?? "");
    const fingerprint = fingerprintFromDraft(record, draft, {
      ocrTextPresent: (rawText !== null && rawText.trim() !== "") || /rfc822|eml|html/i.test(mime),
    });
    return { record, draft, decision, fingerprint };
  });
}

/**
 * After commit: value points legs, then convert foreign legs, on
 * the transactions an apply wrote. Both passes look for `fx_rate IS NULL`,
 * so running them again changes nothing, and neither throws.
 */
export async function runPostCommitPasses(result: ApplyResult, workspaceId: string): Promise<void> {
  if (result.outcome !== "written" && !(result.outcome === "reapplied" && result.report?.branch === "insert")) return;
  await valuePointsSafely(result.transactionIds, workspaceId);
  await normalizeFxSafely(result.transactionIds, workspaceId);
}
