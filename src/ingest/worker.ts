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
 *   - The extractor is injectable. Integration tests call
 *     `setExtractor(stub)` to avoid shelling out to `claude`. Stubs
 *     must honor the Phase 2 contract: write terminal state into the
 *     `ingests` row themselves (status/classification/produced).
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
  type Extractor,
  type ExtractorResult,
} from "./extractor.js";
import { emit as busEmit, type BatchCountsPayload } from "../events/bus.js";
import { ingestSession, getSessionJsonlPath } from "../langfuse.js";

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;
const STARTUP_RECOVERY_AGE_MS = 5 * 60 * 1000;

function getConcurrency(): number {
  const raw = Number(process.env.MAX_CLAUDE_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
}

// ── Injectable extractor ──────────────────────────────────────────────

let currentExtractor: Extractor = defaultClaudeExtractor;
export function setExtractor(fn: Extractor): void {
  currentExtractor = fn;
}
export function resetExtractor(): void {
  currentExtractor = defaultClaudeExtractor;
}
export function getExtractor(): Extractor {
  return currentExtractor;
}

// ── Injectable Langfuse ingestor ──────────────────────────────────────

export type LangfuseIngestor = (
  sessionId: string,
  tags: string[],
) => Promise<void>;

const defaultLangfuseIngestor: LangfuseIngestor = async (sessionId, tags) => {
  await ingestSession(getSessionJsonlPath(sessionId), tags);
};

let currentLangfuseIngestor: LangfuseIngestor = defaultLangfuseIngestor;
export function setLangfuseIngestor(fn: LangfuseIngestor): void {
  currentLangfuseIngestor = fn;
}
export function resetLangfuseIngestor(): void {
  currentLangfuseIngestor = defaultLangfuseIngestor;
}
export function getLangfuseIngestor(): LangfuseIngestor {
  return currentLangfuseIngestor;
}

// ── In-process queue ──────────────────────────────────────────────────

interface QueueItem {
  ingestId: string;
  workspaceId: string;
  batchId: string;
  filePath: string;
  mimeType: string | null;
  filename: string;
}

const queue: QueueItem[] = [];
let activeWorkers = 0;
// Tracks all work promises so tests can await quiescence deterministically.
const inflight = new Set<Promise<unknown>>();
// Resolved when the queue becomes empty AND no workers are active.
let drainResolvers: Array<() => void> = [];

function resolveDrainWaiters(): void {
  if (queue.length === 0 && activeWorkers === 0 && inflight.size === 0) {
    const pending = drainResolvers;
    drainResolvers = [];
    for (const r of pending) r();
  }
}

/**
 * Await the point where all currently-enqueued work has terminated.
 * Useful for integration tests; not otherwise exported to HTTP callers.
 */
export function drain(): Promise<void> {
  if (queue.length === 0 && activeWorkers === 0 && inflight.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    drainResolvers.push(resolve);
  });
}

export function enqueue(item: QueueItem): void {
  queue.push(item);
  maybeSpawnWorker();
}

function maybeSpawnWorker(): void {
  const maxC = getConcurrency();
  while (activeWorkers < maxC && queue.length > 0) {
    const item = queue.shift()!;
    activeWorkers += 1;
    const p = runOne(item)
      .catch((err) => {
        // runOne already stamps the DB row; this is a belt-and-braces
        // safety net so a thrown error never crashes the whole process.
        // eslint-disable-next-line no-console
        console.error("[ingest worker] uncaught:", err);
      })
      .finally(() => {
        activeWorkers -= 1;
        inflight.delete(p);
        // Spawn more as long as queue has work.
        maybeSpawnWorker();
        resolveDrainWaiters();
      });
    inflight.add(p);
  }
  resolveDrainWaiters();
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
  status: "done" | "unsupported" | "error";
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
    row.status !== "error"
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

  let result: ExtractorResult;
  try {
    result = await currentExtractor({
      filePath,
      mimeType,
      filename: item.filename,
      ingestId,
      workspaceId,
      documentId,
      userId,
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

  if (result.sessionId) {
    trackLangfuse(result.sessionId, [batchId, ingestId]);
  }

  // The agent is responsible for UPDATE ingests SET status=... at the
  // end of its run (see Phase 5 of prompt.ts). Read the row it wrote.
  const terminal = await readIngestTerminal(ingestId, workspaceId);
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
              AND status NOT IN ('done','error','unsupported')
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

// ── Langfuse trace ingestion (fire-and-forget) ───────────────────────

/**
 * Kick off Langfuse ingestion for a finished extraction without blocking
 * the worker. The promise is wired into `inflight` so `drain()` still
 * waits for it — integration tests can assert on the spy synchronously.
 * `ingestSession` itself swallows errors, so Langfuse downtime never
 * fails a batch.
 */
function trackLangfuse(sessionId: string, tags: string[]): void {
  const p = currentLangfuseIngestor(sessionId, tags)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[ingest worker] langfuse ingestion failed:", err);
    })
    .finally(() => {
      inflight.delete(p);
      resolveDrainWaiters();
    });
  inflight.add(p);
}

// ── Auto-reconcile hook (#32 Phase 2a) ───────────────────────────────

/**
 * Fire-and-forget the reconcile pipeline for a batch that just reached
 * `extracted`. The extractor path must not block on reconcile — a
 * reconcile failure leaves the batch in `reconcile_error` but does NOT
 * revert extraction, per the acceptance criteria in #32 Phase 2a.
 *
 * We wire the promise into the worker's `inflight` set so integration
 * tests can `await drain()` and observe the post-reconcile state
 * deterministically without sleeping.
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

  const p = runReconcile({ workspaceId, userId, batchId })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[ingest worker] auto-reconcile failed for batch ${batchId}:`,
        err,
      );
    })
    .finally(() => {
      inflight.delete(p);
      resolveDrainWaiters();
    });
  inflight.add(p);
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
 * Start the worker. Idempotent — safe to call from both `main()` in
 * production and per-suite setup in tests. For Phase 1 there's nothing
 * async to spin up; the queue drains on its own once `enqueue` is
 * called.
 */
export async function start(): Promise<void> {
  await recoverStaleBatches().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[ingest worker] recovery failed:", err);
  });
}
