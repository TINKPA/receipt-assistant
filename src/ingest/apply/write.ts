/**
 * The apply transaction's body (wave 1, plan §6.2–§6.3): the prologue, the
 * five branches, the document stamp, the ingest close and the run finish.
 * Everything here runs on ONE caller-owned DB transaction (`index.ts`
 * opens it, retries it and closes a failed one); nothing here commits.
 *
 * PROLOGUE (§6.2), in this order:
 *   lock_timeout 10 s, statement_timeout 60 s;
 *   the workspace apply lock (`takeWorkspaceApplyLock`), so candidates and
 *     the insert see no other apply in between;
 *   the run fence: the ingest row `FOR UPDATE` where `current_run_id` is
 *     this run and the status is `processing`, and the run row still
 *     `running`. Zero rows is `fenced_out`: a newer run owns the ingest,
 *     or this run's apply already closed it;
 *   no transaction may already carry `source_ingest_id = <ingest>`;
 *   the document exists in the workspace and is not deleted.
 *
 * The document is read WITHOUT a lock there. The plan's prologue took it
 * `FOR KEY SHARE` before the attach target's `FOR UPDATE`: document before
 * head row, against CLAUDE.md's lock order (postings, transaction rows,
 * then the document), and a cascade delete (which locks head rows and then
 * the document `FOR UPDATE`) could deadlock with it. The lock is taken
 * where the order puts it instead: by `linkDocumentIn` after the new or
 * target transaction row (it re-checks `deleted_at` under the lock), and
 * by the stamp's UPDATE (`... AND deleted_at IS NULL`, zero rows is
 * `document_deleted`) on the branches that link nothing. The ingest row
 * and the advisory lock are outside that order; nothing else holds an
 * ingest row while waiting on a ledger row.
 *
 * Ids always come from the server's context (the ingest, run and record
 * rows), never from the record.
 */
import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db/client.js";
import { liveTransactions } from "../../db/live.js";
import { agentRuns } from "../../schema/index.js";
import { newId } from "../../http/uuid.js";
import { linkDocumentIn, type DecodedEmailHeaders } from "../../routes/documents.service.js";
import type { RunOutcome, RunErrorClass } from "../runs.js";
import type { ExtractionV1 } from "../contract/v1.js";
import type { ValidationWarning } from "../contract/validate.js";
import { readAccountCatalog } from "./accounts.js";
import { findCandidates, takeWorkspaceApplyLock } from "./candidates.js";
import { decide, type ApplyCandidate, type ApplyDecision } from "./decide.js";
import { buildTransactionMetadata } from "./metadata.js";
import { ProjectionError, project, unbalancedCurrencies, type ApplyDraft, type AccountRef } from "./project.js";
import { writePlace, type PlacePrefetch, type PlaceWrite } from "./places.js";
import {
  addOwnedItems,
  ensurePointsAccount,
  ensureProductBrands,
  readMerchant,
  recomputeTouchedProducts,
  retireSoldItem,
  upsertMerchant,
  upsertMerchantBrand,
  writeItems,
  writeParties,
  type WrittenItem,
} from "./catalog.js";
import { APPLIER_VERSION } from "./version.js";

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `documents.ocr_model_version` when the text is the server's own decode
 *  of an email or HTML source, not a model's reading. */
export const SERVER_DECODE_VERSION = "server-decode/1";

/** The `error` of a statement ingest (X10: recorded, not booked). */
export const STATEMENT_NOT_BOOKED =
  "statement recorded as evidence; statement booking is not built (#175)";

export type ApplyFailureCode =
  | "fenced_out"
  | "already_applied"
  | "document_missing"
  | "document_deleted"
  | "record_missing"
  | "record_unusable"
  | "account_missing"
  | "attach_target_changed"
  | "unbalanced";

/** A refusal of the applier's own. `retryable` ones are retried in-process
 *  like a deadlock (`index.ts`). The message names rules and ids, never a
 *  value from the record. */
export class ApplyError extends Error {
  constructor(
    readonly code: ApplyFailureCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApplyError";
  }
}

/** The ids an apply works under, all from server context. */
export interface ApplyIds {
  workspaceId: string;
  ingestId: string;
  runId: string;
  documentId: string;
}

/** What the transcript says about the run (`summarizeSession`), and the
 *  child's own exit; written on the run row when it is finished. */
export interface RunStats {
  modelObserved?: string | null;
  turns?: number | null;
  toolCalls?: number | null;
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  outputTokens?: number | null;
  transcriptBytes?: number | null;
  exitCode?: number | null;
  exitSignal?: string | null;
  promptBytes?: number | null;
  repairRounds?: number | null;
  agentReport?: unknown;
}

/** What the server decoded from the source before the run (`decodeSourceForAgent`). */
export interface ServerSource {
  /** The decoded email or HTML text the agent was shown, or null. */
  text: string | null;
  /** The email's envelope from the server's own MIME parse. */
  email?: DecodedEmailHeaders | null;
}

export interface RunRow {
  sessionId: string | null;
  modelRequested: string | null;
  promptGitSha: string;
}

export interface Prologue {
  ownerId: string;
  run: RunRow;
  document: { kind: string | null; mimeType: string | null };
}

const one = <T>(rows: unknown[]): T | undefined => rows[0] as T | undefined;

/** §6.2. Throws `ApplyError` for every refusal; see the header. */
export async function prologue(tx: DbTx, ids: ApplyIds): Promise<Prologue> {
  await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
  await takeWorkspaceApplyLock(tx, ids.workspaceId);

  const fence = await tx.execute(sql`
    SELECT status FROM ingests
     WHERE id = ${ids.ingestId}::uuid AND workspace_id = ${ids.workspaceId}::uuid
       AND current_run_id = ${ids.runId}::uuid AND status = 'processing'
       FOR UPDATE`);
  if (fence.rows.length === 0) {
    throw new ApplyError("fenced_out", `ingest ${ids.ingestId} is not processing under run ${ids.runId}`);
  }
  const run = one<{ session_id: string | null; model_requested: string | null; prompt_git_sha: string }>(
    (
      await tx.execute(sql`
        SELECT session_id, model_requested, prompt_git_sha FROM agent_runs
         WHERE id = ${ids.runId}::uuid AND workspace_id = ${ids.workspaceId}::uuid AND status = 'running'`)
    ).rows,
  );
  if (!run) throw new ApplyError("fenced_out", `run ${ids.runId} is not running`);

  const written = await tx.execute(sql`
    SELECT 1 FROM transactions
     WHERE workspace_id = ${ids.workspaceId}::uuid AND source_ingest_id = ${ids.ingestId}::uuid LIMIT 1`);
  if (written.rows.length > 0) {
    throw new ApplyError("already_applied", `a transaction already names ingest ${ids.ingestId}`);
  }

  const doc = one<{ kind: string | null; mime_type: string | null; deleted: boolean }>(
    (
      await tx.execute(sql`
        SELECT kind::text AS kind, mime_type, deleted_at IS NOT NULL AS deleted FROM documents
         WHERE id = ${ids.documentId}::uuid AND workspace_id = ${ids.workspaceId}::uuid`)
    ).rows,
  );
  if (!doc) throw new ApplyError("document_missing", `document ${ids.documentId} is not in the workspace`);
  if (doc.deleted) throw new ApplyError("document_deleted", `document ${ids.documentId} was deleted`);

  const owner = one<{ owner_id: string }>(
    (await tx.execute(sql`SELECT owner_id FROM workspaces WHERE id = ${ids.workspaceId}::uuid`)).rows,
  );
  return {
    ownerId: owner!.owner_id,
    run: { sessionId: run.session_id, modelRequested: run.model_requested, promptGitSha: run.prompt_git_sha },
    document: { kind: doc.kind, mimeType: doc.mime_type },
  };
}

// ── Every branch: the document stamp, the ingest close, the run finish ──

export interface StampText {
  text: string | null;
  /** `documents.ocr_model_version` for that text. */
  version: string | null;
}

/**
 * The text `documents.ocr_text` gets (§6.3): the record's receipt-text
 * block, stamped with the model that read it; else the server's decode of
 * an email or HTML source, stamped `server-decode/1`; else nothing (the
 * column keeps what it has).
 */
export function stampText(rawText: string | null, source: ServerSource | null, model: string | null): StampText {
  if (rawText !== null && rawText.trim() !== "") return { text: rawText, version: model };
  if (source?.text && source.text.trim() !== "") return { text: source.text, version: SERVER_DECODE_VERSION };
  return { text: null, version: null };
}

/**
 * Stamp the document: this ingest, the text, and for an email the
 * envelope from the server's MIME parse (never from the model). The
 * `message_id` column is left alone when another document of the workspace
 * already holds that id (the unique index; that one is the original), but
 * `source_meta` still records it. Takes the document's row lock, which is
 * why it runs after any transaction row is locked. Zero rows means the
 * document was deleted since the prologue read it.
 */
export async function stampDocument(
  tx: DbTx,
  ids: ApplyIds,
  stamp: StampText,
  email: DecodedEmailHeaders | null | undefined,
): Promise<{ messageIdStored: boolean }> {
  const mid = email?.messageId ?? null;
  const meta = email
    ? JSON.stringify({
        channel: "eml",
        sender: email.from,
        subject: email.subject,
        received_at: email.date,
        message_id: email.messageId,
      })
    : null;
  const res = await tx.execute(sql`
    UPDATE documents
       SET source_ingest_id  = ${ids.ingestId}::uuid,
           ocr_text          = COALESCE(${stamp.text}::text, ocr_text),
           ocr_model_version = CASE WHEN ${stamp.text}::text IS NOT NULL THEN ${stamp.version}::text ELSE ocr_model_version END,
           message_id        = CASE
                                 WHEN ${mid}::text IS NULL OR message_id IS NOT NULL THEN message_id
                                 WHEN EXISTS (SELECT 1 FROM documents o
                                               WHERE o.workspace_id = ${ids.workspaceId}::uuid
                                                 AND o.message_id = ${mid}::text
                                                 AND o.id <> ${ids.documentId}::uuid) THEN NULL
                                 ELSE ${mid}::text
                               END,
           source_meta       = COALESCE(${meta}::jsonb, source_meta),
           updated_at        = now()
     WHERE id = ${ids.documentId}::uuid AND workspace_id = ${ids.workspaceId}::uuid AND deleted_at IS NULL
    RETURNING message_id`);
  const row = one<{ message_id: string | null }>(res.rows);
  if (!row) throw new ApplyError("document_deleted", `document ${ids.documentId} was deleted during the apply`);
  return { messageIdStored: mid !== null && row.message_id === mid };
}

export type ClosedStatus = "done" | "near_dup" | "unsupported" | "dedup";

export interface Produced {
  receipt_ids: string[];
  transaction_ids: string[];
  document_ids: string[];
  extraction_ids: string[];
}

export function produced(ids: ApplyIds, transactionIds: string[], extractionId: string | null): Produced {
  return {
    receipt_ids: [],
    transaction_ids: transactionIds,
    document_ids: [ids.documentId],
    extraction_ids: extractionId ? [extractionId] : [],
  };
}

/** Close the ingest in the apply transaction: exactly one row, still this
 *  run's and still processing (the prologue holds its lock). */
export async function closeIngest(
  tx: DbTx,
  ids: ApplyIds,
  close: { status: ClosedStatus; classification: string; produced: Produced; error: string | null },
): Promise<void> {
  const res = await tx.execute(sql`
    UPDATE ingests
       SET status = ${close.status}::ingest_status,
           classification = ${close.classification},
           produced = ${JSON.stringify(close.produced)}::jsonb,
           error = ${close.error},
           completed_at = now()
     WHERE id = ${ids.ingestId}::uuid AND workspace_id = ${ids.workspaceId}::uuid
       AND current_run_id = ${ids.runId}::uuid AND status = 'processing'
    RETURNING id`);
  if (res.rows.length !== 1) {
    throw new ApplyError("fenced_out", `ingest ${ids.ingestId} could not be closed under run ${ids.runId}`);
  }
}

/** The run row's columns for `stats`, only those given. */
function statsColumns(stats: RunStats | null | undefined): Partial<typeof agentRuns.$inferInsert> {
  if (!stats) return {};
  const out: Partial<typeof agentRuns.$inferInsert> = {};
  if (stats.modelObserved !== undefined) out.modelObserved = stats.modelObserved;
  if (stats.turns !== undefined) out.turns = stats.turns;
  if (stats.toolCalls !== undefined) out.toolCalls = stats.toolCalls;
  if (stats.inputTokens !== undefined) out.inputTokens = stats.inputTokens;
  if (stats.cacheReadTokens !== undefined) out.cacheReadTokens = stats.cacheReadTokens;
  if (stats.cacheCreationTokens !== undefined) out.cacheCreationTokens = stats.cacheCreationTokens;
  if (stats.outputTokens !== undefined) out.outputTokens = stats.outputTokens;
  if (stats.transcriptBytes !== undefined) out.transcriptBytes = stats.transcriptBytes;
  if (stats.exitCode !== undefined) out.exitCode = stats.exitCode;
  if (stats.exitSignal !== undefined) out.exitSignal = stats.exitSignal;
  if (stats.promptBytes !== undefined) out.promptBytes = stats.promptBytes;
  if (stats.repairRounds !== undefined && stats.repairRounds !== null) out.repairRounds = stats.repairRounds;
  if (stats.agentReport !== undefined) out.agentReport = stats.agentReport;
  return out;
}

/**
 * Finish the run on `executor` (the apply transaction, or the short one
 * that closes a failure). `required` makes a run that is no longer
 * `running` a `fenced_out` refusal; otherwise it is skipped quietly, the
 * honest record of a run another path already ended.
 */
export async function finishRunIn(
  executor: DbTx | Pick<typeof db, "update">,
  runId: string,
  f: {
    outcome: RunOutcome;
    produced?: unknown;
    applyReport?: unknown;
    extractionId?: string | null;
    errorClass?: RunErrorClass | "fenced_out" | "artefact_missing" | "artefact_invalid" | null;
    error?: string | null;
    stats?: RunStats | null;
    required?: boolean;
  },
): Promise<boolean> {
  const rows = await executor
    .update(agentRuns)
    .set({
      status: "finished",
      finishedAt: new Date(),
      outcome: f.outcome,
      errorClass: f.errorClass ?? null,
      error: f.error ? f.error.slice(0, 2000) : null,
      produced: f.produced ?? null,
      applyReport: f.applyReport ?? null,
      ...(f.extractionId ? { extractionId: f.extractionId } : {}),
      ...statsColumns(f.stats),
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (rows.length === 0 && f.required) throw new ApplyError("fenced_out", `run ${runId} is not running`);
  return rows.length > 0;
}

async function event(
  tx: DbTx,
  p: { workspaceId: string; transactionId: string; type: string; actorId: string; payload: Record<string, unknown> },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
    VALUES (${newId()}::uuid, ${p.workspaceId}::uuid, ${p.transactionId}::uuid, ${p.type}, ${p.actorId}::uuid,
            ${JSON.stringify(p.payload)}::jsonb)`);
}

/**
 * §6.3 j: fire the deferred balance trigger now, then check what it does
 * not: every currency of the transaction sums to zero in `amount_minor`.
 */
export async function assertNativeBalance(tx: DbTx, transactionId: string): Promise<void> {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const res = await tx.execute(sql`
    SELECT amount_minor::text AS "amountMinor", currency FROM postings WHERE transaction_id = ${transactionId}::uuid`);
  const off = unbalancedCurrencies(res.rows as { amountMinor: string; currency: string }[]);
  if (off.length > 0) {
    throw new ApplyError("unbalanced", `transaction ${transactionId} does not balance in ${off.join(", ")}`);
  }
}

// ── The branches ───────────────────────────────────────────────────────

/** What the apply decided and wrote, stored on `agent_runs.apply_report`. */
export interface ApplyReport {
  applier_version: string;
  branch: "insert" | "attach" | "unsupported" | "statement" | "message_id_duplicate";
  outcome: RunOutcome;
  attempts?: number;
  decision?: Record<string, unknown>;
  candidates?: { id: string; matched_on: string[]; date_distance: number }[];
  accounts?: Record<string, unknown>;
  brand?: { brand_id: string; created: boolean; name_kept: boolean };
  merchant?: { id: string; created: boolean };
  place?: Record<string, unknown> | null;
  items?: { lines: number; products: number };
  owned_instances?: number;
  sold_item?: { retired_id: string | null; note: string | null } | null;
  parties?: number;
  ocr_text?: "receipt_text" | "server_decode" | null;
  message_id_stored?: boolean;
  warnings: ValidationWarning[];
}

export interface BranchResult {
  outcome: RunOutcome;
  status: ClosedStatus;
  transactionIds: string[];
  /** The ingest's `error` on close (a branch that books nothing says why). */
  error: string | null;
  report: ApplyReport;
}

export interface ApplyContext {
  ids: ApplyIds;
  pro: Prologue;
  extractionId: string;
  record: ExtractionV1;
  rawText: string | null;
  source: ServerSource | null;
  phashTransactionIds: readonly string[];
  place: PlacePrefetch | null;
  stats: RunStats | null;
}

function textOf(c: ApplyContext): { stamp: StampText; kind: ApplyReport["ocr_text"] } {
  const model = c.stats?.modelObserved ?? c.pro.run.modelRequested ?? null;
  const stamp = stampText(c.rawText, c.source, model && model !== "cli-default" ? model : null);
  return {
    stamp,
    kind: stamp.text === null ? null : stamp.version === SERVER_DECODE_VERSION ? "server_decode" : "receipt_text",
  };
}

/** `unsupported` and `statement_pdf`: stamp and close, nothing booked. */
export async function applyNotBooked(tx: DbTx, c: ApplyContext): Promise<BranchResult> {
  const statement = c.record.classification === "statement_pdf";
  const { stamp, kind } = textOf(c);
  const { messageIdStored } = await stampDocument(tx, c.ids, stamp, c.source?.email);
  const u = c.record.unsupported;
  const error = statement ? STATEMENT_NOT_BOOKED : (u?.note ?? `unsupported: ${u?.reason ?? "other"}`);
  return {
    outcome: statement ? "recorded_only" : "unsupported",
    status: "unsupported",
    transactionIds: [],
    error,
    report: {
      applier_version: APPLIER_VERSION,
      branch: statement ? "statement" : "unsupported",
      outcome: statement ? "recorded_only" : "unsupported",
      ocr_text: kind,
      ...(c.source?.email ? { message_id_stored: messageIdStored } : {}),
      warnings: [],
    },
  };
}

function decisionReport(d: ApplyDecision): Record<string, unknown> {
  const considered = d.considered.map((v) => ({
    id: v.id,
    same_merchant: v.sameMerchant,
    identifier_matches: v.identifierMatches,
    identifier_conflicts: v.identifierConflicts,
    hard_tuple: v.hardTuple,
    strong: v.strong,
  }));
  return d.action === "attach"
    ? { action: "attach", target: d.targetId, tiebreaker: d.tiebreaker, reason: d.reason, considered, dropped: d.dropped }
    : {
        action: "insert",
        verdict: d.verdict,
        flagged_for_review: d.flaggedForReview,
        refund_of: d.refundOf,
        reason: d.reason,
        considered,
        dropped: d.dropped,
      };
}

const candidateReport = (cs: readonly ApplyCandidate[]) =>
  cs.map((c) => ({ id: c.id, matched_on: c.matched_on, date_distance: c.date_distance }));

/**
 * A receipt record (§6.3 receipt_*): project, find candidates, decide,
 * then attach or insert. The attach target is locked `FOR UPDATE` and the
 * decision re-taken under that lock; a different answer (the target was
 * deleted or changed meanwhile) is a retryable `attach_target_changed`, so
 * the retry starts over without the lock and sees the change.
 */
export async function applyReceipt(tx: DbTx, c: ApplyContext): Promise<BranchResult> {
  const { record, ids } = c;
  const catalog = await readAccountCatalog(tx, ids.workspaceId);
  const existingMerchant = await readMerchant(tx, ids.workspaceId, record.merchant!.brand_id);
  let draft: ApplyDraft;
  try {
    draft = project(record, catalog, { existingMerchant });
  } catch (err) {
    if (err instanceof ProjectionError) {
      throw new ApplyError(err.code === "account_missing" ? "account_missing" : "record_unusable", err.message);
    }
    throw err;
  }

  const candidates = await findCandidates(tx, {
    workspaceId: ids.workspaceId,
    record,
    phashTransactionIds: c.phashTransactionIds,
  });
  const decision = decide(record, candidates);

  if (decision.action === "attach") {
    await tx.execute(sql`SELECT id FROM transactions WHERE id = ${decision.targetId}::uuid FOR UPDATE`);
    const again = decide(
      record,
      await findCandidates(tx, { workspaceId: ids.workspaceId, record, phashTransactionIds: c.phashTransactionIds }),
    );
    if (again.action !== "attach" || again.targetId !== decision.targetId) {
      throw new ApplyError(
        "attach_target_changed",
        `attach target ${decision.targetId} changed before it was locked`,
        true,
      );
    }
    return attach(tx, c, draft, decision, candidates);
  }
  return insert(tx, c, draft, decision, candidates);
}

async function attach(
  tx: DbTx,
  c: ApplyContext,
  draft: ApplyDraft,
  decision: Extract<ApplyDecision, { action: "attach" }>,
  candidates: readonly ApplyCandidate[],
): Promise<BranchResult> {
  const { ids } = c;
  const target = decision.targetId;
  // The target row is held FOR UPDATE (applyReceipt); the link takes the
  // document after it, in the lock order.
  await linkDocumentIn(tx, { workspaceId: ids.workspaceId, documentId: ids.documentId, transactionId: target });
  // The UPDATE moves `version` and `updated_at` (the transactions
  // triggers), as the legacy attach's did.
  const audit = {
    attached_document_id: ids.documentId,
    source_ingest_id: ids.ingestId,
    extraction_id: c.extractionId,
    run_id: ids.runId,
    decision: "attach",
    tiebreaker: decision.tiebreaker,
    reason: decision.reason,
    decided_by: "applier",
    applier_version: APPLIER_VERSION,
    at: new Date().toISOString(),
  };
  await tx.execute(sql`
    UPDATE transactions
       SET metadata = jsonb_set(metadata, '{merge_audit}',
                                COALESCE(metadata->'merge_audit', '[]'::jsonb) || jsonb_build_array(${JSON.stringify(audit)}::jsonb))
     WHERE id = ${target}::uuid`);
  await event(tx, {
    workspaceId: ids.workspaceId,
    transactionId: target,
    type: "document_linked",
    actorId: c.pro.ownerId,
    payload: {
      document_id: ids.documentId,
      ingest_id: ids.ingestId,
      run_id: ids.runId,
      extraction_id: c.extractionId,
      reason: decision.reason,
    },
  });
  const { stamp, kind } = textOf(c);
  const { messageIdStored } = await stampDocument(tx, ids, stamp, c.source?.email);
  return {
    outcome: "attached",
    status: "near_dup",
    transactionIds: [target],
    error: null,
    report: {
      applier_version: APPLIER_VERSION,
      branch: "attach",
      outcome: "attached",
      decision: decisionReport(decision),
      candidates: candidateReport(candidates),
      ocr_text: kind,
      ...(c.source?.email ? { message_id_stored: messageIdStored } : {}),
      warnings: [...draft.warnings, ...decision.warnings],
    },
  };
}

async function insert(
  tx: DbTx,
  c: ApplyContext,
  draft: ApplyDraft,
  decision: Extract<ApplyDecision, { action: "insert" }>,
  candidates: readonly ApplyCandidate[],
): Promise<BranchResult> {
  const { ids, record } = c;
  const ws = ids.workspaceId;
  const warnings: ValidationWarning[] = [...draft.warnings, ...decision.warnings];

  // a, b: brands, the merchant's before the product stubs.
  const brand = await upsertMerchantBrand(tx, draft.merchantBrand);
  await ensureProductBrands(tx, draft.items);
  // c: the points account, created under Assets when the programme is new.
  const points = await ensurePointsAccount(tx, ws, draft.pointsAccount);
  // d: account ids (resolved by `project`); a new points account is the one just made.
  const accountId = (a: AccountRef): string => (a.kind === "existing" ? a.id : points!.id);
  // e: the merchant, frozen at first sight.
  const merchant = await upsertMerchant(tx, ws, draft.merchant);
  // o (before f, so the header carries the place): cache hit or insert.
  const place: PlaceWrite = await writePlace(tx, c.place, draft.place?.nameZhPrinted ?? null);
  warnings.push(...place.warnings);
  // l (before f, so the header carries the note): the sold item, income only.
  const sold = await retireSoldItem(tx, {
    workspaceId: ws,
    soldItem: draft.soldItem,
    payee: draft.header.payee,
    occurredOn: draft.header.occurredOn,
  });
  if (sold.warning) warnings.push(sold.warning);

  // f: the transaction.
  const txId = newId();
  const metadata = buildTransactionMetadata(
    record,
    draft,
    {
      ingestId: ids.ingestId,
      runId: ids.runId,
      sessionId: c.pro.run.sessionId,
      extractionId: c.extractionId,
      promptGitSha: c.pro.run.promptGitSha,
      modelObserved: c.stats?.modelObserved ?? null,
      modelRequested: c.pro.run.modelRequested,
      ranAt: new Date().toISOString(),
    },
    { refundOf: decision.refundOf, nearDupCheck: decision.nearDupCheck, ownedItemsNote: sold.note },
  );
  await tx.execute(sql`
    INSERT INTO transactions (id, workspace_id, occurred_on, occurred_at, payee, status,
                              source_ingest_id, merchant_id, place_id, metadata, created_by)
    VALUES (${txId}::uuid, ${ws}::uuid, ${draft.header.occurredOn}::date, ${draft.header.occurredAt}::timestamptz,
            ${draft.header.payee}, 'posted', ${ids.ingestId}::uuid, ${merchant.id}::uuid, ${place.placeId}::uuid,
            ${JSON.stringify(metadata)}::jsonb, ${c.pro.ownerId}::uuid)`);

  // g: the postings; base = native and no fx_rate, for the post-commit passes.
  for (const p of draft.postings) {
    await tx.execute(sql`
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      VALUES (${newId()}::uuid, ${txId}::uuid, ${ws}::uuid, ${accountId(p.account)}::uuid,
              ${p.amountMinor}::bigint, ${p.currency}, ${p.amountBaseMinor}::bigint)`);
  }
  // h: the link (transaction row, then the document, under their locks).
  await linkDocumentIn(tx, { workspaceId: ws, documentId: ids.documentId, transactionId: txId });
  // i: products and line items, run 1, pointing at the record.
  const items: WrittenItem[] = await writeItems(tx, {
    workspaceId: ws,
    transactionId: txId,
    merchantId: merchant.id,
    extractionId: c.extractionId,
    draft,
  });
  // j: balance.
  await assertNativeBalance(tx, txId);
  // k: owned items.
  const owned = await addOwnedItems(tx, { workspaceId: ws, transactionId: txId, owned: draft.owned });
  // m: product statistics over live transactions.
  const stats = await recomputeTouchedProducts(tx, ws, items);
  // n: parties.
  const parties = await writeParties(tx, { workspaceId: ws, transactionId: txId, parties: draft.parties, items });
  // p: the created event, the shape `createTransaction` writes plus the run's ids.
  await event(tx, {
    workspaceId: ws,
    transactionId: txId,
    type: "created",
    actorId: c.pro.ownerId,
    payload: {
      source: "ingest",
      ingest_id: ids.ingestId,
      run_id: ids.runId,
      extraction_id: c.extractionId,
      occurred_on: draft.header.occurredOn,
      payee: draft.header.payee,
      narration: null,
      status: "posted",
      posting_count: draft.postings.length,
      document_ids: [ids.documentId],
    },
  });
  // q: the document stamp (the close and the run finish are the caller's).
  const { stamp, kind } = textOf(c);
  const { messageIdStored } = await stampDocument(tx, ids, stamp, c.source?.email);

  const mirrorPosting = draft.postings.find((p) => p.role === "mirror" || p.role === "deposit");
  return {
    outcome: "written",
    status: "done",
    transactionIds: [txId],
    error: null,
    report: {
      applier_version: APPLIER_VERSION,
      branch: "insert",
      outcome: "written",
      decision: decisionReport(decision),
      candidates: candidateReport(candidates),
      accounts: {
        mirror: draft.mirror.accountName,
        mirror_account_id: mirrorPosting ? accountId(mirrorPosting.account) : null,
        expense_or_income: draft.flow === "income" ? "income" : draft.merchant.category,
        ...(points ? { points_account_id: points.id, points_account_created: points.created } : {}),
      },
      brand: { brand_id: draft.merchantBrand.brandId, created: brand.created, name_kept: brand.nameKept },
      merchant: { id: merchant.id, created: merchant.created },
      place: c.place
        ? {
            google_place_id: c.place.googlePlaceId,
            place_id: place.placeId,
            cache: place.cache,
            snapshot_id: place.snapshotId,
            receipt_zh_stored: place.receiptZhStored,
          }
        : null,
      items: { lines: items.length, products: stats.length },
      owned_instances: owned,
      sold_item: draft.soldItem ? { retired_id: sold.retiredId, note: sold.note } : null,
      parties,
      ocr_text: kind,
      ...(c.source?.email ? { message_id_stored: messageIdStored } : {}),
      warnings,
    },
  };
}

/**
 * X9, before any spawn: an email whose Message-ID another document of the
 * workspace already carries, and that document's purchase is still live.
 * The new document is linked to every live transaction the earlier copy
 * supports (each locked `FOR UPDATE` in id order, re-read under the lock),
 * with a `merge_audit` entry and a `document_linked` event, stamped with
 * the server's decode, and the ingest closes `dedup`. Returns null, having
 * written nothing, when no live transaction holds the id: an email whose
 * purchase was deleted is extracted again (the legacy check matched any
 * earlier document, live or not).
 */
export async function applyMessageIdDuplicate(
  tx: DbTx,
  c: { ids: ApplyIds; pro: Prologue; source: ServerSource },
): Promise<BranchResult | null> {
  const { ids } = c;
  const mid = c.source.email?.messageId ?? null;
  if (!mid) return null;
  const found = await tx.execute(sql`
    SELECT DISTINCT t.id, o.id AS original_document_id
      FROM documents o
      JOIN document_links dl ON dl.document_id = o.id
      JOIN ${liveTransactions} t ON t.id = dl.transaction_id
     WHERE o.workspace_id = ${ids.workspaceId}::uuid
       AND o.message_id = ${mid}
       AND o.id <> ${ids.documentId}::uuid
     ORDER BY t.id`);
  const rows = found.rows as { id: string; original_document_id: string }[];
  if (rows.length === 0) return null;
  const targets = [...new Set(rows.map((r) => r.id))].sort();
  for (const id of targets) {
    await tx.execute(sql`SELECT id FROM transactions WHERE id = ${id}::uuid FOR UPDATE`);
  }
  const live = await tx.execute(sql`
    SELECT id FROM ${liveTransactions}
     WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb))::uuid)
     ORDER BY id`);
  const kept = (live.rows as { id: string }[]).map((r) => r.id);
  if (kept.length === 0) return null;
  const reason = "duplicate Message-ID: the same email is already in the ledger";
  for (const target of kept) {
    await linkDocumentIn(tx, { workspaceId: ids.workspaceId, documentId: ids.documentId, transactionId: target });
    const audit = {
      attached_document_id: ids.documentId,
      source_ingest_id: ids.ingestId,
      extraction_id: null,
      run_id: ids.runId,
      decision: "message_id",
      reason,
      decided_by: "applier",
      applier_version: APPLIER_VERSION,
      at: new Date().toISOString(),
    };
    await tx.execute(sql`
      UPDATE transactions
         SET metadata = jsonb_set(metadata, '{merge_audit}',
                                  COALESCE(metadata->'merge_audit', '[]'::jsonb) || jsonb_build_array(${JSON.stringify(audit)}::jsonb))
       WHERE id = ${target}::uuid`);
    await event(tx, {
      workspaceId: ids.workspaceId,
      transactionId: target,
      type: "document_linked",
      actorId: c.pro.ownerId,
      payload: { document_id: ids.documentId, ingest_id: ids.ingestId, run_id: ids.runId, extraction_id: null, reason },
    });
  }
  const stamp = stampText(null, c.source, null);
  const { messageIdStored } = await stampDocument(tx, ids, stamp, c.source.email);
  return {
    outcome: "duplicate_skip",
    status: "dedup",
    transactionIds: kept,
    error: "duplicate: same Message-ID as an email already linked to a transaction",
    report: {
      applier_version: APPLIER_VERSION,
      branch: "message_id_duplicate",
      outcome: "duplicate_skip",
      decision: {
        action: "message_id",
        original_document_ids: [...new Set(rows.map((r) => r.original_document_id))],
        targets: kept,
        reason,
      },
      ocr_text: stamp.text === null ? null : "server_decode",
      message_id_stored: messageIdStored,
      warnings: [],
    },
  };
}
