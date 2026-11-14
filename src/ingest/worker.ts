/**
 * In-process async worker for `/v1/ingest/batch`.
 *
 * Two writers, chosen per run by `EXTRACTION_WRITER` (`extractionWriter`
 * in `./runs.ts`) and recorded on the run as `agent_runs.writer`:
 *
 *   agent_sql (default)  Phase 2 of #32 (landed 2026-04-20): the worker
 *       spawns `claude -p` with a prompt that teaches the agent to write
 *       directly to the ledger via psql, then reads back the `ingests` row
 *       the agent updated, puts it through the #125 / #133 / #134 guards
 *       and builds the SSE event from it (`extractAndClose`).
 *   server_apply (wave 1, plan §2)  the agent reads and hands back an
 *       extraction record; the server writes (`extractRecordAndApply`):
 *       the pre-spawn Message-ID check (X9), the decode and the pHash
 *       neighbours, `runRecordExtraction` (spawn, parse, validate, repair
 *       round), T1 (`recordExtraction`: the record is stored, valid or
 *       not), T2 (`applyExtraction`: one fenced transaction writes the
 *       ledger, closes the ingest and finishes the run), then the
 *       post-commit passes, the SSE event, the batch and the lesson
 *       append. The agent has no database, so none of the guards apply.
 *
 * A stub upload (sandbox only, `EXTRACTOR_STUB_ALLOWED=1`) carries its own
 * path whatever the variable says: a `terminal` stub the legacy one (run
 * writer `stub`), a `record` stub the server writer's (`server_apply`).
 *
 * Design notes
 *   - Concurrency is capped by `MAX_CLAUDE_CONCURRENCY` (code default 1;
 *     production compose pins 1, the sandbox 6). Production is serialized
 *     for CORRECTNESS, not throughput: overlapping extractions of two
 *     documents describing one money event cannot see each other's
 *     not-yet-written transaction, so same-batch dedup misses and the
 *     ledger double counts (#225). Serial extraction closes that window.
 *     Uploads are fire-and-forget, so the wall-clock cost is unfelt. The
 *     default is the safe value so that a deploy which forgets the env
 *     var does not quietly turn the window back on.
 *   - A slot is released only when the agent's process group is gone:
 *     `runClaude` settles on the child's `close`, after a timeout has
 *     killed the whole group and the groups its tool commands run in, so
 *     the next job never overlaps a timed-out one.
 *   - Every run is recorded in `agent_runs` (`./runs.ts`): inserted before
 *     the spawn, in the transaction that moves the ingest to `processing`,
 *     and finished before the SSE event for the ingest goes out.
 *   - No resume on restart. On boot we mark every `pending/processing`
 *     batch `failed`; in-flight ingests of those batches flip to `error`
 *     (retryable), and their runs become `abandoned`. Durable queuing is
 *     a later phase of wave 1.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import {
  batches,
  ingests,
  documents as documentsTable,
  workspaces,
} from "../schema/index.js";
import { normalizeFxSafely } from "../fx/normalize.js";
import { valuePointsSafely } from "../points/valuation.js";
import {
  defaultClaudeExtractor,
  runRecordExtraction,
  type Extractor,
  type ExtractorResult,
} from "./extractor.js";
import { emit as busEmit, type BatchCountsPayload } from "../events/bus.js";
import {
  decodeSourceForAgent,
  resolveUploadPath,
  type DocumentKindValue,
} from "../routes/documents.service.js";
import { ingestScratchDir, type DecodedAttachment } from "./document-read-prompt.js";
import { phashDistance } from "../images/phash.js";
import {
  readStubMode,
  recordStubSpawn,
  stubFileExtractor,
  type RecordStub,
} from "./stub-extractor.js";
import { appendLessonProposal } from "./prompt.js";
import {
  applyExtraction,
  applyMessageIdDuplicate,
  closeRunWithoutRecord,
  recordExtraction,
  runPostCommitPasses,
  statsFromSession,
  type ApplyIds,
  type ApplyResult,
  type RunStats,
  type ServerSource,
} from "./apply/index.js";
import {
  abandonInterruptedRuns,
  agentFailure,
  extractionWriter,
  finishRun,
  ingestErrorText,
  startIngestRun,
  stdoutTail,
  type RunFinish,
  type RunHandle,
  type RunTrigger,
  type RunWriter,
} from "./runs.js";

/**
 * How one ingest is extracted: by an extractor that writes the ledger and
 * closes the ingest itself (the agent's SQL, or a legacy stub), or by a
 * record handed back to the server writer (the agent, or a record stub).
 */
type ExtractionPath =
  | { writer: "agent_sql" | "stub"; extractor: Extractor }
  | { writer: "server_apply"; stub: RecordStub | null };

/**
 * `EXTRACTION_WRITER`, read per run, unless the upload is a stub.
 *
 * Test-only escape hatch (#134/#135 hardening): when the sandbox sets
 * EXTRACTOR_STUB_ALLOWED=1 AND the uploaded file is a stub instruction
 * JSON, route to the stub instead of `claude -p`, on the path the stub
 * names. Both conditions are required; production compose never sets the
 * env, so this is dead code there. Real receipts in the sandbox still go
 * to the real agent — the two coexist per-file. Throws on a record stub
 * whose fields are malformed.
 */
async function pickPath(absPath: string): Promise<ExtractionPath> {
  if (process.env.EXTRACTOR_STUB_ALLOWED === "1") {
    const stub = await readStubMode(absPath);
    if (stub?.mode === "legacy") return { writer: "stub", extractor: stubFileExtractor };
    if (stub?.mode === "record") return { writer: "server_apply", stub: stub.stub };
  }
  return extractionWriter() === "server_apply"
    ? { writer: "server_apply", stub: null }
    : { writer: "agent_sql", extractor: defaultClaudeExtractor };
}

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 1;

export function getConcurrency(): number {
  const raw = Number(process.env.MAX_CLAUDE_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
}

// ── In-process queue ──────────────────────────────────────────────────

interface QueueItem {
  ingestId: string;
  workspaceId: string;
  batchId: string;
  /** Stored form: relative to the uploads dir (#128). Resolve via
   *  resolveUploadPath() before any filesystem access. */
  filePath: string;
  mimeType: string | null;
  filename: string;
  /** What started this extraction, for the run record. */
  trigger?: Extract<RunTrigger, "upload" | "retry">;
}

const queue: QueueItem[] = [];
let activeWorkers = 0;

export function enqueue(item: QueueItem): void {
  queue.push(item);
  maybeSpawnWorker();
}

function maybeSpawnWorker(): void {
  const maxC = getConcurrency();
  while (activeWorkers < maxC && queue.length > 0) {
    const item = queue.shift()!;
    activeWorkers += 1;
    runOne(item)
      .catch((err) => {
        // runOne already stamps the DB row; this is a belt-and-braces
        // safety net so a thrown error never crashes the whole process.
        // eslint-disable-next-line no-console
        console.error("[ingest worker] uncaught:", err);
      })
      .finally(() => {
        activeWorkers -= 1;
        // Spawn more as long as queue has work.
        maybeSpawnWorker();
      });
  }
}

// ── Per-file processing ───────────────────────────────────────────────
//
// Phase 2 of #32: Claude writes the ledger itself via psql. The worker
// only spawns the agent, passes in the ingest/document/workspace ids
// the agent needs for its INSERTs, then reads the `ingests` row the
// agent updated. See `src/ingest/prompt.ts` for the agent-side SQL.

/**
 * Aggregate ingest counts for one batch, shaped to match the SSE event
 * contract. Used when emitting `batch.extracted` / `batch.status` /
 * `batch.failed` so subscribers get fresh totals without a separate
 * round-trip.
 */
async function fetchCountsForEvent(batchId: string): Promise<BatchCountsPayload> {
  const res = await db.execute(
    sql`SELECT status, COUNT(*)::int AS n
          FROM ingests
         WHERE batch_id = ${batchId}::uuid
         GROUP BY status`,
  );
  const counts: BatchCountsPayload = {
    total: 0,
    queued: 0,
    processing: 0,
    done: 0,
    error: 0,
    unsupported: 0,
    dedup: 0,
    near_dup: 0,
  };
  for (const row of res.rows as Array<{ status: string; n: number }>) {
    const n = Number(row.n);
    counts.total += n;
    if (row.status in counts) {
      (counts as unknown as Record<string, number>)[row.status] = n;
    }
  }
  return counts;
}

async function markError(
  ingestId: string,
  workspaceId: string,
  err: unknown,
): Promise<void> {
  const message = ingestErrorText(err);
  await db
    .update(ingests)
    .set({
      status: "error",
      error: message.slice(0, 2000),
      produced: { receipt_ids: [], transaction_ids: [], document_ids: [] },
      completedAt: new Date(),
    })
    .where(and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)));
}

/**
 * `markError` for an ingest that is still open (`queued` / `processing`),
 * and only then. True when it closed the row. For a failure that may come
 * after the agent already closed the ingest, which must not be undone.
 */
async function markErrorIfOpen(
  ingestId: string,
  workspaceId: string,
  err: unknown,
): Promise<boolean> {
  const rows = await db
    .update(ingests)
    .set({
      status: "error",
      error: ingestErrorText(err).slice(0, 2000),
      produced: { receipt_ids: [], transaction_ids: [], document_ids: [] },
      completedAt: new Date(),
    })
    .where(
      and(
        eq(ingests.id, ingestId),
        eq(ingests.workspaceId, workspaceId),
        inArray(ingests.status, ["queued", "processing"]),
      ),
    )
    .returning({ id: ingests.id });
  return rows.length > 0;
}

/**
 * Read the terminal state the agent wrote into the `ingests` row.
 * Returns null if the agent didn't close out (row is still in a
 * non-terminal state) — the caller treats that as an error.
 */
async function readIngestTerminal(
  ingestId: string,
  workspaceId: string,
): Promise<{
  status: "done" | "unsupported" | "error" | "near_dup";
  classification: string | null;
  produced: {
    transaction_ids: string[];
    document_ids: string[];
    receipt_ids: string[];
  };
  error: string | null;
} | null> {
  const rows = await db
    .select({
      status: ingests.status,
      classification: ingests.classification,
      produced: ingests.produced,
      error: ingests.error,
    })
    .from(ingests)
    .where(and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)));
  const row = rows[0];
  if (!row) return null;
  if (
    row.status !== "done" &&
    row.status !== "unsupported" &&
    row.status !== "error" &&
    row.status !== "near_dup"
  ) {
    return null;
  }
  const p = (row.produced ?? {}) as Record<string, unknown>;
  const coerceArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    status: row.status,
    classification:
      typeof row.classification === "string" ? row.classification : null,
    produced: {
      transaction_ids: coerceArr(p.transaction_ids),
      document_ids: coerceArr(p.document_ids),
      receipt_ids: coerceArr(p.receipt_ids),
    },
    error: typeof row.error === "string" ? row.error : null,
  };
}

/**
 * #134 L2: find existing documents perceptually near (pHash hamming
 * distance <= 2) the just-uploaded one, restricted to documents already
 * linked to a live transaction (the only useful attach targets). "Live"
 * is the view's definition: a soft-deleted transaction keeps status
 * `posted`, so a status filter alone offered deleted rows as attach
 * targets. Returns at most 5, nearest first. Full scan over hashed rows — sub-ms
 * at the current corpus scale; revisit if documents grows past ~10k.
 */
async function findPhashNeighbors(
  workspaceId: string,
  documentId: string,
): Promise<{ documentId: string; transactionId: string; distance: number }[]> {
  const self = await db.execute(
    sql`SELECT phash FROM documents WHERE id = ${documentId}::uuid`,
  );
  const phash = (self.rows[0] as { phash: string | null } | undefined)?.phash;
  if (!phash) return [];
  const others = await db.execute(
    sql`SELECT DISTINCT d.id AS document_id, d.phash, dl.transaction_id
          FROM documents d
          JOIN document_links dl ON dl.document_id = d.id
          JOIN ${liveTransactions} t ON t.id = dl.transaction_id
         WHERE d.workspace_id = ${workspaceId}::uuid
           AND d.id <> ${documentId}::uuid
           AND d.phash IS NOT NULL
           AND d.deleted_at IS NULL`,
  );
  const out: { documentId: string; transactionId: string; distance: number }[] =
    [];
  for (const r of others.rows as {
    document_id: string;
    phash: string;
    transaction_id: string;
  }[]) {
    const distance = phashDistance(phash, r.phash);
    if (distance <= 2) {
      out.push({
        documentId: r.document_id,
        transactionId: r.transaction_id,
        distance,
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, 5);
}

async function runOne(item: QueueItem): Promise<void> {
  const { ingestId, workspaceId, batchId, filePath, mimeType } = item;

  // Resolve workspace owner + the pre-existing document row id. The
  // agent needs both inside its SQL (transactions.created_by and
  // document_links.document_id). Both were set during upload.
  const wsRows = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const ownerId = wsRows[0]?.ownerId;
  if (!ownerId) {
    await markError(ingestId, workspaceId, new Error("workspace not found"));
    busEmit("job.error", {
      batchId,
      ingestId,
      error: "workspace not found",
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  const userId = ownerId;

  const docRows = await db
    .select({ id: documentsTable.id, kind: documentsTable.kind })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.workspaceId, workspaceId),
        eq(documentsTable.filePath, filePath),
      ),
    );
  const documentId = docRows[0]?.id;
  if (!documentId) {
    await markError(
      ingestId,
      workspaceId,
      new Error(`document row not found for filePath=${filePath}`),
    );
    busEmit("job.error", {
      batchId,
      ingestId,
      error: "document row not found",
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  // Queue items carry the stored (uploads-relative, #128) path; the
  // agent needs a container-absolute path it can open.
  const absPath = resolveUploadPath(filePath);

  // Known before the claim, because the run row records the writer.
  let path: ExtractionPath;
  try {
    path = await pickPath(absPath);
  } catch (err) {
    console.error(`[ingest worker] ingest=${ingestId} has an unusable stub file:`, err);
    await markError(ingestId, workspaceId, err);
    busEmit("job.error", { batchId, ingestId, error: ingestErrorText(err) });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  const writer: RunWriter = path.writer;

  // T0: the run row and `processing` in one transaction, with a session id
  // minted here, so a run that dies at once still has both. Nothing has
  // been spawned if this fails, and the ingest is errored like any other
  // failure of ours (retryable).
  let run: RunHandle;
  try {
    run = await startIngestRun({
      ingestId,
      workspaceId,
      documentId,
      writer,
      trigger: item.trigger ?? "upload",
      // A stub, of either kind, runs no CLI: no model or CLI version on its run.
      agent: "extractor" in path ? path.writer !== "stub" : path.stub === null,
    });
  } catch (err) {
    console.error(`[ingest worker] ingest=${ingestId} could not start its run:`, err);
    await markError(ingestId, workspaceId, err);
    busEmit("job.error", { batchId, ingestId, error: ingestErrorText(err) });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  await onBatchChildStarted(batchId, workspaceId);
  busEmit("job.started", { batchId, ingestId });

  let finished = false;
  const finish = async (f: RunFinish): Promise<void> => {
    if (finished) return;
    finished = true;
    await finishRun(run, f);
  };
  const base = {
    item,
    documentId,
    documentKind: (docRows[0]?.kind ?? null) as DocumentKindValue | null,
    userId,
    absPath,
    run,
  };
  try {
    if ("extractor" in path) {
      await extractAndClose({ ...base, extractor: path.extractor }, finish);
    } else {
      await extractRecordAndApply({ ...base, stub: path.stub }, finish);
    }
  } catch (err) {
    // A failure of the server's own after the run started (the agent's
    // failures are handled inside). Record it, and close the ingest if it
    // is still open: before run records, such an ingest sat in
    // `processing` until the next restart errored it.
    console.error(`[ingest worker] ingest=${ingestId} failed after its run started:`, err);
    await finish({ outcome: "failed", errorClass: "apply", error: err });
    if (await markErrorIfOpen(ingestId, workspaceId, err)) {
      busEmit("job.error", { batchId, ingestId, error: ingestErrorText(err) });
    }
    // Also when the agent had already closed the ingest and a query of
    // ours failed after that: the ingest is terminal either way, and if it
    // was the batch's last one the batch must not wait for a restart. The
    // call is guarded (no open child, batch still pending/processing).
    await onBatchChildTerminated(batchId, workspaceId);
    throw err;
  }
}

interface ClaimedIngest {
  item: QueueItem;
  documentId: string;
  documentKind: DocumentKindValue | null;
  userId: string;
  absPath: string;
  run: RunHandle;
}

interface ExtractContext extends ClaimedIngest {
  extractor: Extractor;
}

/**
 * Spawn the agent for one claimed ingest, verify what it reports, and
 * finish its run. Every exit records the run (`finish`) BEFORE the SSE
 * event and the batch bookkeeping, so a client that sees the batch
 * complete can read a finished run row.
 */
async function extractAndClose(
  ctx: ExtractContext,
  finish: (f: RunFinish) => Promise<void>,
): Promise<void> {
  const { item, documentId, userId, absPath, extractor, run } = ctx;
  const { ingestId, workspaceId, batchId, mimeType } = item;

  // #134 L2: surface perceptually-near existing documents (pHash d ≤ 2,
  // linked to a live transaction) as candidates for the agent's Phase
  // 4a.0 near-dup decision. Candidate-surfacing only — production
  // calibration showed same-app-template screenshots of DIFFERENT
  // purchases collide at d=2, so extracted fields decide, never the
  // hash. Full scan is fine at corpus scale (~hundreds of rows).
  const phashNeighbors = await findPhashNeighbors(workspaceId, documentId);

  // #261: decode an email / HTML upload before the agent starts, as
  // re-extract always has. Never throws; images and PDFs come back empty.
  const source = await decodeSourceForAgent(
    {
      id: documentId,
      kind: ctx.documentKind,
      mimeType,
    },
    absPath,
    ingestScratchDir(ingestId),
    "ingest",
  );

  let promptBytes: number | null = null;
  let result: ExtractorResult;
  try {
    result = await extractor({
      filePath: absPath,
      sourceText: source.text,
      attachments: source.attachments,
      mimeType,
      filename: item.filename,
      ingestId,
      workspaceId,
      documentId,
      userId,
      phashNeighbors,
      sessionId: run.sessionId,
      onPrompt: (bytes) => {
        promptBytes = bytes;
      },
    });
  } catch (err) {
    // Agent died / timed out before closing out the ingest row. Stamp
    // it with the error; leave place_id etc. untouched (the agent may
    // have gotten partway through — operators can inspect `ingests`).
    //
    // This console.error is load-bearing, do not drop it. Because this
    // catch handles the rejection, the `[ingest worker] uncaught:` path
    // never fires — so without a log here a total extraction outage
    // produces container output indistinguishable from an idle healthy
    // run. That is exactly how the 2026-07-28 E2BIG outage (#194) went
    // ~11h unnoticed: 19 log lines, none of them an error.
    console.error(`[ingest worker] ingest=${ingestId} FAILED:`, err);
    await markError(ingestId, workspaceId, err);
    await finish(agentFailure(err, { promptBytes }));
    busEmit("job.error", {
      batchId,
      ingestId,
      error: ingestErrorText(err),
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  // What every finish below carries about the agent's own exit.
  const exited = {
    exitCode: result.exitCode,
    promptBytes,
    agentReport: stdoutTail(result.stdout),
  };

  // The agent is responsible for UPDATE ingests SET status=... at the
  // end of its run (see Phase 5 of prompt.ts).
  const terminal = await readIngestTerminal(ingestId, workspaceId);

  if (!terminal) {
    // Agent exited 0 but didn't close out — treat as error.
    const msg =
      "agent did not close out ingest row (status still processing). stdout: " +
      result.stdout.slice(0, 500);
    await markError(ingestId, workspaceId, new Error(msg));
    await finish({ ...exited, outcome: "failed", errorClass: "no_closeout", error: msg });
    busEmit("job.error", {
      batchId,
      ingestId,
      error: msg,
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  // #134 — verify an agent-reported `near_dup` before trusting it: the
  // attach contract requires a committed document_links row pointing
  // this document at a live transaction. An unverified near_dup would
  // silently drop a receipt under the cover of "already in the ledger"
  // — the same failure class #125 guards `done` against. "Live" is the
  // view's definition, so an attach to a soft-deleted transaction is
  // rejected here too: that document's purchase would otherwise exist
  // nowhere in the ledger.
  if (terminal.status === "near_dup") {
    const target = terminal.produced.transaction_ids[0];
    const linked = target
      ? await db.execute(
          sql`SELECT 1 FROM document_links dl
                JOIN ${liveTransactions} t ON t.id = dl.transaction_id
               WHERE dl.document_id = ${documentId}::uuid
                 AND dl.transaction_id = ${target}::uuid
                 AND t.workspace_id = ${workspaceId}::uuid`,
        )
      : { rows: [] };
    if (!target || linked.rows.length === 0) {
      const msg =
        "near_dup claimed but no committed document_links row to a live transaction — forcing error (#134 guard)";
      await db
        .update(ingests)
        .set({ status: "error", error: msg, completedAt: new Date() })
        .where(
          and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)),
        );
      await finish({
        ...exited,
        outcome: "failed",
        errorClass: "guard",
        error: msg,
        produced: terminal.produced,
      });
      busEmit("job.error", { batchId, ingestId, error: msg });
      await onBatchChildTerminated(batchId, workspaceId);
      return;
    }
  }

  // #125 — don't trust the agent's self-reported `done`. For a receipt
  // classification, `done` with zero transactions is silent data loss
  // (the user/mail-ingest skill sees success and discards the source
  // email). The only legitimate zero-transaction `done` is the email
  // dedup skip (error sentinel below). `unsupported` has its own
  // status, the L1 byte-dedup path (#124) never enters the worker, and
  // `near_dup` (#134) is verified above.
  const RECEIPT_KINDS = ["receipt_image", "receipt_email", "receipt_pdf"];
  if (
    terminal.status === "done" &&
    terminal.classification !== null &&
    RECEIPT_KINDS.includes(terminal.classification) &&
    terminal.produced.transaction_ids.length === 0 &&
    !(terminal.error ?? "").startsWith("duplicate Message-ID")
  ) {
    // #133 — before forcing error, cross-check the ledger itself: the
    // 2026-05-29 incident agent DID write a posted transaction but
    // reported produced=[]. `transactions.source_ingest_id` is ground
    // truth; if rows exist, self-heal `produced` instead of erroring.
    const written = await db.execute(
      sql`SELECT id FROM transactions
           WHERE workspace_id = ${workspaceId}::uuid
             AND source_ingest_id = ${ingestId}::uuid
             AND status IN ('posted','reconciled','draft')`,
    );
    const foundIds = (written.rows as { id: string }[]).map((r) => r.id);
    if (foundIds.length > 0) {
      console.log(
        `[worker] #133 self-heal: ingest ${ingestId} reported produced=[] but wrote tx [${foundIds.join(",")}] — repairing produced`,
      );
      await db.execute(
        sql`UPDATE ingests
               SET produced = jsonb_set(COALESCE(produced,'{}'::jsonb), '{transaction_ids}', ${JSON.stringify(foundIds)}::jsonb)
             WHERE id = ${ingestId}::uuid AND workspace_id = ${workspaceId}::uuid`,
      );
      terminal.produced.transaction_ids = foundIds;
    } else {
      const msg =
        "receipt classified but no transaction written — forcing error (agent self-reported done; see #125)";
      // Not markError(): that helper wipes `produced`, and the agent may
      // have legitimately written document_ids worth keeping for triage.
      await db
        .update(ingests)
        .set({
          status: "error",
          error: msg,
          completedAt: new Date(),
        })
        .where(
          and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)),
        );
      await finish({
        ...exited,
        outcome: "failed",
        errorClass: "guard",
        error: msg,
        produced: terminal.produced,
      });
      busEmit("job.error", { batchId, ingestId, error: msg });
      await onBatchChildTerminated(batchId, workspaceId);
      return;
    }
  }

  if (terminal.status === "error") {
    await finish({
      ...exited,
      outcome: "agent_error",
      errorClass: "agent_reported",
      error: terminal.error ?? "agent-reported error",
      produced: terminal.produced,
    });
    busEmit("job.error", {
      batchId,
      ingestId,
      error: terminal.error ?? "agent-reported error",
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  // #184 — the agent writes the receipt's own numbers and nothing else;
  // converting a foreign-currency posting into the workspace base
  // currency is our job, at the receipt's date. Runs after the #125/#133
  // guards have settled `produced.transaction_ids`, and before job.done
  // so the SSE consumer never sees a pre-conversion total. Never throws:
  // an unconvertible posting keeps fx_rate NULL for the backfill pass
  // rather than failing an otherwise good extraction.
  // #206 — same shape, different authority: a points leg carries the
  // programme's configured valuation, not a market rate. Runs BEFORE the
  // FX pass so the agent's placeholder base amount (which equals the raw
  // points count) is replaced before anything measures a residual against
  // it. The two passes touch disjoint legs, so the order only matters for
  // that.
  await valuePointsSafely(terminal.produced.transaction_ids, workspaceId);
  await normalizeFxSafely(terminal.produced.transaction_ids, workspaceId);

  await finish({
    ...exited,
    outcome: closedOutcome(terminal),
    produced: terminal.produced,
  });
  busEmit("job.done", {
    batchId,
    ingestId,
    classification: terminal.classification ?? "unsupported",
    produced: {
      receipt_ids: terminal.produced.receipt_ids,
      transaction_ids: terminal.produced.transaction_ids,
      document_ids:
        terminal.produced.document_ids.length > 0
          ? terminal.produced.document_ids
          : [documentId],
    },
  });
  await onBatchChildTerminated(batchId, workspaceId);
}

/**
 * The outcome of a run whose agent closed the ingest and passed the
 * guards. `done` with no transaction is the Message-ID duplicate skip
 * (the only one production has) or, for a classification the #125 guard
 * does not cover, a run that changed nothing.
 */
function closedOutcome(terminal: {
  status: "done" | "unsupported" | "near_dup" | "error";
  produced: { transaction_ids: string[] };
  error: string | null;
}): RunFinish["outcome"] {
  if (terminal.status === "error") return "agent_error"; // handled before; kept total
  if (terminal.status === "near_dup") return "attached";
  if (terminal.status === "unsupported") return "unsupported";
  if (terminal.produced.transaction_ids.length > 0) return "written";
  if ((terminal.error ?? "").startsWith("duplicate Message-ID")) return "duplicate_skip";
  return "no_change";
}

// ── The server writer (EXTRACTION_WRITER=server_apply) ─────────────────

interface RecordContext extends ClaimedIngest {
  /** The record stub standing in for the agent, or null for a real run. */
  stub: RecordStub | null;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** When the document was uploaded, as this ingest saw it: record dates
 *  are judged against it, never against the clock (`validate.ts`). */
async function ingestUploadedAt(ingestId: string): Promise<Date> {
  const rows = await db
    .select({ createdAt: ingests.createdAt })
    .from(ingests)
    .where(eq(ingests.id, ingestId));
  return rows[0]?.createdAt ?? new Date();
}

/** `document_extractions.input_meta`: what the run was shown besides the
 *  document (plan §8.2). Attachment hashes are best effort. */
async function recordInputMeta(
  neighbours: { documentId: string; transactionId: string; distance: number }[],
  attachments: DecodedAttachment[],
  promptBytes: number | null,
): Promise<Record<string, unknown>> {
  const files: { bytes: number; sha256: string | null }[] = [];
  for (const a of attachments) {
    let digest: string | null = null;
    try {
      digest = sha256(await readFile(a.path));
    } catch {
      /* the scratch copy is gone; the size is still worth keeping */
    }
    files.push({ bytes: a.bytes, sha256: digest });
  }
  return {
    phash_neighbors: neighbours.map((n) => ({
      document_id: n.documentId,
      transaction_id: n.transactionId,
      distance: n.distance,
    })),
    attachments: files,
    prompt_bytes: promptBytes,
  };
}

/**
 * Error the ingest of a run whose agent failed before handing anything
 * back, fenced: only while the ingest is still this run's and open.
 */
async function errorIngestOfRun(ids: ApplyIds, err: unknown): Promise<boolean> {
  const rows = await db.execute(sql`
    UPDATE ingests
       SET status = 'error',
           error = ${ingestErrorText(err).slice(0, 2000)},
           produced = ${JSON.stringify({ receipt_ids: [], transaction_ids: [], document_ids: [ids.documentId] })}::jsonb,
           completed_at = now()
     WHERE id = ${ids.ingestId}::uuid AND workspace_id = ${ids.workspaceId}::uuid
       AND current_run_id = ${ids.runId}::uuid AND status IN ('queued','processing')
    RETURNING id`);
  return rows.rows.length > 0;
}

/**
 * One ingest under the server writer (plan §2). The agent reads; the
 * server stores what it handed back and writes the ledger. Every exit
 * finishes the run before the SSE event and the batch bookkeeping, as the
 * legacy path does; here the run is finished by the transaction that
 * closes the ingest (T1 for a rejected record, T2 for an applied one).
 *
 *   1. Decode an email or HTML upload (the text the agent is shown, and
 *      the envelope from the server's own MIME parse; a record stub may
 *      supply the envelope).
 *   2. X9: when another document carries the email's Message-ID and its
 *      purchase is still live, link this document to it and close `dedup`
 *      without spawning anything.
 *   3. The pHash neighbours: candidates for the applier's dedup decision,
 *      never a decision.
 *   4. `runRecordExtraction`: spawn, parse, validate, repair rounds.
 *   5. T1 (`recordExtraction`): store the record, valid or invalid. An
 *      invalid one is final here, so the ingest errors with
 *      `extraction record rejected: <path>: <rule>` and the run finishes
 *      `invalid_record` / `artefact_invalid`. No record at all finishes it
 *      `invalid_record` / `artefact_missing`.
 *   6. T2 (`applyExtraction`): the place pre-fetch outside any
 *      transaction, then one transaction for the ledger, the ingest close
 *      and the run finish. A failure leaves the record valid and unapplied
 *      and errors the ingest (`apply failed: <code>`).
 *   7. After commit: points, then FX, the SSE event, the batch (and so
 *      reconcile), and the record's lesson proposal, best effort.
 */
async function extractRecordAndApply(
  ctx: RecordContext,
  finish: (f: RunFinish) => Promise<void>,
): Promise<void> {
  const { item, documentId, userId, absPath, run, stub } = ctx;
  const { ingestId, workspaceId, batchId, mimeType } = item;
  const ids: ApplyIds = { workspaceId, ingestId, runId: run.runId, documentId };
  const failed = async (error: string): Promise<void> => {
    busEmit("job.error", { batchId, ingestId, error });
    await onBatchChildTerminated(batchId, workspaceId);
  };

  // 1. Never throws; images and PDFs come back empty.
  const decoded = await decodeSourceForAgent(
    { id: documentId, kind: ctx.documentKind, mimeType },
    absPath,
    ingestScratchDir(ingestId),
    "ingest",
  );
  const source: ServerSource = {
    text: decoded.text,
    email: stub ? stub.email : (decoded.email ?? null),
  };

  // 2. X9, before any spawn.
  if (source.email?.messageId) {
    const dup = await applyMessageIdDuplicate({ ...ids, source, stats: null });
    if (dup) {
      await closeApplied(ctx, dup, "receipt_email", null);
      return;
    }
  }

  // 3. A record stub stands in for an image upload's pHash.
  if (stub?.phash) {
    await db.execute(sql`
      UPDATE documents SET phash = ${stub.phash}
       WHERE id = ${documentId}::uuid AND workspace_id = ${workspaceId}::uuid`);
  }
  const neighbours = await findPhashNeighbors(workspaceId, documentId);

  // 4. Spawn, parse, validate, repair. Writes nothing.
  const res = await runRecordExtraction({
    filePath: absPath,
    ingestId,
    workspaceId,
    documentId,
    userId,
    sourceText: decoded.text,
    attachments: decoded.attachments,
    sessionId: run.sessionId,
    uploadedAt: await ingestUploadedAt(ingestId),
    ...(stub ? { spawn: recordStubSpawn(stub) } : {}),
  });
  // A stub renders the prompt but sends it nowhere: no prompt size, and
  // no transcript to read.
  const promptBytes = stub ? null : res.promptBytes;

  if (res.status === "agent_error") {
    // Load-bearing log line, as on the legacy path (#194).
    console.error(`[ingest worker] ingest=${ingestId} FAILED:`, res.error);
    await errorIngestOfRun(ids, res.error);
    await finish(agentFailure(res.error, { promptBytes, agentReport: res.stdoutTail }));
    await failed(ingestErrorText(res.error));
    return;
  }

  // `agent_report`: where the record was found, and whether the message
  // went on after it. The stdout tail only when no valid record came back:
  // a valid one is stored whole, and its tail would be the record again.
  const stats: RunStats = {
    ...(stub ? {} : (statsFromSession(run.sessionId) ?? {})),
    exitCode: 0,
    promptBytes,
    repairRounds: res.repairRounds,
    agentReport: {
      artefact_source: res.artefactSource,
      trailing_text: res.trailingText,
      ...(res.status === "valid" ? {} : (res.stdoutTail ?? {})),
    },
  };

  if (res.status === "missing") {
    const error = res.errorText ?? "extraction record missing";
    console.warn(`[ingest worker] ingest=${ingestId} handed back no extraction record`);
    await closeRunWithoutRecord(ids, { error, stats });
    await failed(error);
    return;
  }

  // 5. T1. The outcome is final: the repair rounds are behind us.
  const stored = await recordExtraction({
    ...ids,
    origin: stub ? "stub" : "agent",
    outcome: res.outcome!,
    rawText: res.rawText,
    sourceTextSha256: decoded.text ? sha256(decoded.text) : null,
    inputMeta: await recordInputMeta(neighbours, decoded.attachments, promptBytes),
    repairRounds: res.repairRounds,
    stats,
    final: true,
  });
  if (stored.fencedOut) {
    const error = `ingest ${ingestId} is no longer this run's; the record was not stored`;
    console.error(`[ingest worker] ${error} (run ${run.runId})`);
    await finish({ outcome: "failed", errorClass: "fenced_out", error, exitCode: 0, promptBytes });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  if (stored.closed) {
    console.warn(`[ingest worker] ingest=${ingestId} ${res.errorText ?? "extraction record rejected"}`);
    await failed(res.errorText ?? "extraction record rejected");
    return;
  }

  if (stub && stub.pauseAfterRecordS > 0) {
    console.log(
      `[ingest worker] ingest=${ingestId} stub pause: record ${stored.extractionId} stored, ` +
        `applying in ${stub.pauseAfterRecordS} s`,
    );
    await new Promise((r) => setTimeout(r, stub.pauseAfterRecordS * 1000));
  }

  // 6. T2.
  const applied = await applyExtraction({
    ...ids,
    extractionId: stored.extractionId!,
    source,
    phashTransactionIds: neighbours.map((n) => n.transactionId),
    stats,
  });
  await closeApplied(ctx, applied, res.record!.classification, res.record!.lesson_proposal ?? null);
}

/**
 * After an apply (or the X9 link) has committed or failed: the post-commit
 * passes, the SSE event, the batch, and the lesson proposal (plan §6.1).
 * The run is already finished, by the apply's own transaction.
 */
async function closeApplied(
  ctx: ClaimedIngest,
  applied: ApplyResult,
  classification: string,
  lessonProposal: string | null,
): Promise<void> {
  const { ingestId, workspaceId, batchId } = ctx.item;
  if (applied.outcome === "failed") {
    // A fenced-out apply left the ingest to whoever owns it now.
    if (applied.ingestStatus === "error") {
      busEmit("job.error", { batchId, ingestId, error: applied.error ?? "apply failed" });
    }
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  // #184 / #206: points valuation, then FX, on what the apply wrote,
  // before job.done so no client sees a pre-conversion total.
  await runPostCommitPasses(applied, workspaceId);
  busEmit("job.done", {
    batchId,
    ingestId,
    classification,
    produced: {
      receipt_ids: [],
      transaction_ids: applied.transactionIds,
      document_ids: [ctx.documentId],
    },
  });
  await onBatchChildTerminated(batchId, workspaceId);
  if (lessonProposal) appendLessonProposal(classification, lessonProposal);
}

// ── Batch state machine ───────────────────────────────────────────────

async function onBatchChildStarted(
  batchId: string,
  workspaceId: string,
): Promise<void> {
  // Flip pending → processing on first child pickup. Use a single SQL
  // round-trip with a guarded WHERE so we don't stomp a terminal state.
  await db.execute(
    sql`UPDATE batches
         SET status = 'processing'
       WHERE id = ${batchId}::uuid
         AND workspace_id = ${workspaceId}::uuid
         AND status = 'pending'`,
  );
}

async function onBatchChildTerminated(
  batchId: string,
  workspaceId: string,
): Promise<void> {
  // flip the batch to `extracted` and stamp completed_at. RETURNING
  // tells us whether THIS call effected the transition — concurrent
  // children finishing at the same moment will race into this code but
  // only one row will update. Only the winner fires `batch.extracted`
  // and kicks off auto-reconcile.
  //
  // `dedup` (#124) is terminal too: an L1 short-circuit hit never enters
  // the worker, so its ingest row is born terminal. It must count as
  // "done" for batch-completion or a mixed batch (some extracted, some
  // deduped) would hang forever waiting on a child that never runs.
  const res = await db.execute(
    sql`UPDATE batches
         SET status = 'extracted',
             completed_at = NOW()
       WHERE id = ${batchId}::uuid
         AND workspace_id = ${workspaceId}::uuid
         AND status IN ('pending','processing')
         AND NOT EXISTS (
           SELECT 1 FROM ingests
            WHERE batch_id = ${batchId}::uuid
              AND status NOT IN ('done','error','unsupported','dedup','near_dup')
         )
      RETURNING id, auto_reconcile`,
  );
  if (res.rows.length === 0) return;
  const counts = await fetchCountsForEvent(batchId);
  busEmit("batch.extracted", { batchId, counts });
  const flipped = res.rows[0] as { auto_reconcile: boolean };
  if (flipped.auto_reconcile) {
    await triggerAutoReconcile(batchId, workspaceId);
  }
}

/**
 * Public entry point for the L1 dedup path (#124).
 *
 * When `createBatchFromFiles` short-circuits one or more files (byte-
 * identical to an already-linked document), those ingests are born in the
 * terminal `dedup` state and never enqueued — so the per-child completion
 * hook never fires for them. An all-dedup batch would otherwise stay
 * `pending` forever, and a mixed batch's last real child must see `dedup`
 * siblings as terminal. The service calls this after seeding the batch;
 * the underlying UPDATE is guarded (status IN pending/processing + no
 * non-terminal child), so it's a safe no-op while real children are still
 * queued.
 */
export async function maybeCompleteBatch(
  batchId: string,
  workspaceId: string,
): Promise<void> {
  await onBatchChildTerminated(batchId, workspaceId);
}

// ── Auto-reconcile hook (#32 Phase 2a) ───────────────────────────────

/**
 * Fire-and-forget the reconcile pipeline for a batch that just reached
 * `extracted`. The extractor path must not block on reconcile — a
 * reconcile failure leaves the batch in `reconcile_error` but does NOT
 * revert extraction, per the acceptance criteria in #32 Phase 2a.
 */
async function triggerAutoReconcile(
  batchId: string,
  workspaceId: string,
): Promise<void> {
  // Dynamic import: reconcile is only needed once a batch finishes, so
  // the engine is loaded then rather than at worker start.
  const { runReconcile } = await import("../reconcile/engine.js");

  const wsRows = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const userId = wsRows[0]?.ownerId;
  if (!userId) return;

  runReconcile({ workspaceId, userId, batchId }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[ingest worker] auto-reconcile failed for batch ${batchId}:`,
      err,
    );
  });
}

// ── Startup recovery ──────────────────────────────────────────────────

/**
 * Scan for batches that were left mid-flight by a prior crash and mark
 * them `failed`. Their stuck ingests flip to `error` so clients stop
 * polling forever, and every run still `running` becomes `abandoned` /
 * `interrupted` (`abandonInterruptedRuns`). All three in one transaction,
 * so a finished-looking run never points at an ingest still open.
 *
 * Runs once at server boot (from `src/server.ts`), BEFORE the HTTP server
 * listens. BOOT-ONLY: the queue lives in this process's memory, so at
 * that moment every `pending/processing` batch is orphaned by
 * construction — whatever its age. Calling this while the worker is
 * draining would fail live batches.
 *
 * There is deliberately no age window (#247). One used to skip batches
 * younger than 5 minutes, which are exactly the ones a restart is most
 * likely to have interrupted; they stayed `queued/processing` forever,
 * and the retry endpoint refuses rows that still look in-progress.
 */
export async function recoverStaleBatches(): Promise<{
  failedBatches: number;
  erroredIngests: number;
  abandonedRuns: { ingest: number; re_extract: number };
}> {
  return db.transaction(async (tx) => {
    const abandonedRuns = await abandonInterruptedRuns(tx);
    const stale = await tx
      .select({ id: batches.id })
      .from(batches)
      .where(sql`status IN ('pending','processing')`);
    if (stale.length === 0) {
      return { failedBatches: 0, erroredIngests: 0, abandonedRuns };
    }

    const batchIds = stale.map((b) => b.id);
    await tx
      .update(batches)
      .set({ status: "failed", completedAt: new Date() })
      .where(inArray(batches.id, batchIds));
    const erroredRes = await tx
      .update(ingests)
      .set({
        status: "error",
        error: "worker restart: batch abandoned",
        completedAt: new Date(),
      })
      .where(
        and(
          inArray(ingests.batchId, batchIds),
          inArray(ingests.status, ["queued", "processing"]),
        ),
      )
      .returning({ id: ingests.id });

    return {
      failedBatches: batchIds.length,
      erroredIngests: erroredRes.length,
      abandonedRuns,
    };
  });
}

/**
 * Start the worker. Call once, at boot (see `recoverStaleBatches`). For
 * Phase 1 there's nothing async to spin up; the queue drains on its own
 * once `enqueue` is called.
 *
 * Always logs what recovery did, zeros included: a restart that cut
 * runs short is otherwise visible only in the rows it touched.
 */
export async function start(): Promise<void> {
  try {
    const r = await recoverStaleBatches();
    console.log(
      `[ingest worker] boot recovery: ${r.failedBatches} batch(es) failed, ` +
        `${r.erroredIngests} ingest(s) errored, ` +
        `${r.abandonedRuns.ingest + r.abandonedRuns.re_extract} run(s) abandoned ` +
        `(ingest ${r.abandonedRuns.ingest}, re-extract ${r.abandonedRuns.re_extract})`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ingest worker] recovery failed:", err);
  }
}
