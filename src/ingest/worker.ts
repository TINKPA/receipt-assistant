/**
 * In-process async worker for `/v1/ingest/batch`.
 *
 * Phase 2 of #32 (landed 2026-04-20): the worker no longer calls
 * `createTransaction()` / `linkDocumentToTransaction()` / `upsertPlace`.
 * It spawns `claude -p` with a prompt that teaches the agent to write
 * directly to the ledger via psql, then reads back the `ingests` row
 * the agent updated to build the SSE event payload.
 *
 * Design notes
 *   - Concurrency is capped by `MAX_CLAUDE_CONCURRENCY` (default 3).
 *     Claude CLI calls dominate latency (30-60s each with geocoding +
 *     SQL writes) and three in parallel is empirically enough for a
 *     laptop host without starving OAuth refresh.
 *   - No resume on restart. On boot we scan for `pending/processing`
 *     batches older than 5 minutes and mark them `failed`; in-flight
 *     ingests of those batches flip to `error`. Durable queuing is a
 *     future concern.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  batches,
  ingests,
  documents as documentsTable,
  workspaces,
} from "../schema/index.js";
import { newId } from "../http/uuid.js";
import {
  defaultClaudeExtractor,
  type ExtractorResult,
} from "./extractor.js";
import { emit as busEmit, type BatchCountsPayload } from "../events/bus.js";
import { resolveUploadPath } from "../routes/documents.service.js";
import { phashDistance } from "../images/phash.js";
import { isStubFile, stubFileExtractor } from "./stub-extractor.js";

/**
 * Test-only escape hatch (#134/#135 hardening): when the sandbox sets
 * EXTRACTOR_STUB_ALLOWED=1 AND the uploaded file is a stub instruction
 * JSON, route to the stub extractor instead of `claude -p`. Both
 * conditions are required; production compose never sets the env, so
 * this is dead code there. Real receipts in the sandbox still go to
 * the real agent — the two coexist per-file.
 */
async function pickExtractor(absPath: string) {
  if (process.env.EXTRACTOR_STUB_ALLOWED !== "1") return defaultClaudeExtractor;
  return (await isStubFile(absPath)) ? stubFileExtractor : defaultClaudeExtractor;
}
import { ingestSession, getSessionJsonlPath } from "../langfuse.js";

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;
const STARTUP_RECOVERY_AGE_MS = 5 * 60 * 1000;

function getConcurrency(): number {
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

async function markProcessing(ingestId: string, workspaceId: string): Promise<void> {
  await db
    .update(ingests)
    .set({ status: "processing" })
    .where(and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)));
}

async function markDone(
  ingestId: string,
  workspaceId: string,
  classification: string,
  produced: {
    transaction_ids: string[];
    document_ids: string[];
    receipt_ids?: string[];
  },
): Promise<void> {
  await db
    .update(ingests)
    .set({
      status: "done",
      classification,
      produced: {
        receipt_ids: produced.receipt_ids ?? [],
        transaction_ids: produced.transaction_ids,
        document_ids: produced.document_ids,
      },
      completedAt: new Date(),
    })
    .where(and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)));
}

async function markUnsupported(
  ingestId: string,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await db
    .update(ingests)
    .set({
      status: "unsupported",
      classification: "unsupported",
      produced: { receipt_ids: [], transaction_ids: [], document_ids: [] },
      error: reason,
      completedAt: new Date(),
    })
    .where(and(eq(ingests.id, ingestId), eq(ingests.workspaceId, workspaceId)));
}

async function markError(
  ingestId: string,
  workspaceId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
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
 * linked to a live transaction (the only useful attach targets).
 * Returns at most 5, nearest first. Full scan over hashed rows — sub-ms
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
          JOIN transactions t ON t.id = dl.transaction_id
         WHERE d.workspace_id = ${workspaceId}::uuid
           AND d.id <> ${documentId}::uuid
           AND d.phash IS NOT NULL
           AND d.deleted_at IS NULL
           AND t.status IN ('posted','reconciled')`,
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
    .select({ id: documentsTable.id })
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

  await markProcessing(ingestId, workspaceId);
  await onBatchChildStarted(batchId, workspaceId);
  busEmit("job.started", { batchId, ingestId });

  // #134 L2: surface perceptually-near existing documents (pHash d ≤ 2,
  // linked to a live transaction) as candidates for the agent's Phase
  // 4a.0 near-dup decision. Candidate-surfacing only — production
  // calibration showed same-app-template screenshots of DIFFERENT
  // purchases collide at d=2, so extracted fields decide, never the
  // hash. Full scan is fine at corpus scale (~hundreds of rows).
  const phashNeighbors = await findPhashNeighbors(workspaceId, documentId);

  const extractor = await pickExtractor(resolveUploadPath(filePath));
  let result: ExtractorResult;
  try {
    result = await extractor({
      // Queue items carry the stored (uploads-relative, #128) path; the
      // agent needs a container-absolute path it can open.
      filePath: resolveUploadPath(filePath),
      mimeType,
      filename: item.filename,
      ingestId,
      workspaceId,
      documentId,
      userId,
      phashNeighbors,
    });
  } catch (err) {
    // Agent died / timed out before closing out the ingest row. Stamp
    // it with the error; leave place_id etc. untouched (the agent may
    // have gotten partway through — operators can inspect `ingests`).
    await markError(ingestId, workspaceId, err);
    busEmit("job.error", {
      batchId,
      ingestId,
      error: err instanceof Error ? err.message : String(err),
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  // The agent is responsible for UPDATE ingests SET status=... at the
  // end of its run (see Phase 5 of prompt.ts). Read the row it wrote
  // BEFORE kicking off Langfuse ingestion so the classification tag
  // (which tests and trace filters rely on) is available.
  const terminal = await readIngestTerminal(ingestId, workspaceId);

  if (result.sessionId) {
    const tags: string[] = [batchId, ingestId];
    if (terminal?.classification) tags.push(terminal.classification);
    trackLangfuse(result.sessionId, tags);
  }
  if (!terminal) {
    // Agent exited 0 but didn't close out — treat as error.
    const msg =
      "agent did not close out ingest row (status still processing). stdout: " +
      result.stdout.slice(0, 500);
    await markError(ingestId, workspaceId, new Error(msg));
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
  // — the same failure class #125 guards `done` against.
  if (terminal.status === "near_dup") {
    const target = terminal.produced.transaction_ids[0];
    const linked = target
      ? await db.execute(
          sql`SELECT 1 FROM document_links dl
                JOIN transactions t ON t.id = dl.transaction_id
               WHERE dl.document_id = ${documentId}::uuid
                 AND dl.transaction_id = ${target}::uuid
                 AND t.workspace_id = ${workspaceId}::uuid
                 AND t.status IN ('posted','reconciled')`,
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
      busEmit("job.error", { batchId, ingestId, error: msg });
      await onBatchChildTerminated(batchId, workspaceId);
      return;
    }
  }

  if (terminal.status === "error") {
    busEmit("job.error", {
      batchId,
      ingestId,
      error: terminal.error ?? "agent-reported error",
    });
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

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

// ── Langfuse trace ingestion (fire-and-forget) ───────────────────────

/**
 * Kick off Langfuse ingestion for a finished extraction without blocking
 * the worker. `ingestSession` itself swallows errors, so Langfuse
 * downtime never fails a batch.
 */
function trackLangfuse(sessionId: string, tags: string[]): void {
  ingestSession(getSessionJsonlPath(sessionId), tags).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[ingest worker] langfuse ingestion failed:", err);
  });
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
  // Dynamic import avoids a circular import (engine → transactions.service
  // → documents/service chains), plus delays work until genuinely needed.
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
 * polling forever.
 *
 * Runs once at server boot (from `src/server.ts`). Safe to call
 * multiple times; the WHERE clause filters on the age window + status
 * so newly-minted batches aren't touched.
 */
export async function recoverStaleBatches(): Promise<{
  failedBatches: number;
  erroredIngests: number;
}> {
  const cutoff = new Date(Date.now() - STARTUP_RECOVERY_AGE_MS).toISOString();
  const stale = await db
    .select({ id: batches.id })
    .from(batches)
    .where(
      sql`status IN ('pending','processing') AND created_at < ${cutoff}::timestamptz`,
    );
  if (stale.length === 0) return { failedBatches: 0, erroredIngests: 0 };

  const batchIds = stale.map((b) => b.id);
  await db
    .update(batches)
    .set({ status: "failed", completedAt: new Date() })
    .where(inArray(batches.id, batchIds));
  const erroredRes = await db
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
  };
}

/**
 * Start the worker. Idempotent. For Phase 1 there's nothing async to
 * spin up; the queue drains on its own once `enqueue` is called.
 */
export async function start(): Promise<void> {
  await recoverStaleBatches().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[ingest worker] recovery failed:", err);
  });
}
