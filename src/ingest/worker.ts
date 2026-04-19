/**
 * In-process async worker for `/v1/ingest/batch`.
 *
 * Runs in the same Node process as the HTTP server so:
 *   - it shares the Drizzle connection pool (no double bookkeeping),
 *   - it calls `createTransaction()` / `linkDocumentToTransaction()`
 *     directly instead of self-HTTP, preserving all the v1 invariants
 *     (balanced postings, audit log, document dedup by sha256),
 *   - Phase 2 SSE can hook into the same event emitter without IPC.
 *
 * Design notes
 *   - Concurrency is capped by `MAX_CLAUDE_CONCURRENCY` (default 3).
 *     Claude CLI calls dominate latency (15-30s each) and three in
 *     parallel is empirically enough for a laptop host without
 *     starving OAuth refresh.
 *   - No resume on restart. On boot we scan for `pending/processing`
 *     batches older than 5 minutes and mark them `failed`; in-flight
 *     ingests of those batches flip to `error`. Durable queuing is a
 *     Phase 2 concern.
 *   - The extractor is injectable. Integration tests call
 *     `setExtractor(stub)` to avoid shelling out to `claude`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  batches,
  ingests,
  accounts,
  documents as documentsTable,
  workspaces,
} from "../schema/index.js";
import { newId } from "../http/uuid.js";
import {
  defaultClaudeExtractor,
  type Extractor,
  type ExtractorResult,
} from "./extractor.js";
import {
  createTransaction,
  type TransactionRow,
} from "../routes/transactions.service.js";
import { linkDocumentToTransaction } from "../routes/documents.service.js";

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

// ── Account resolution (same heuristic as the smoke harness) ──────────

type CategoryBucket =
  | "groceries"
  | "dining"
  | "cafe"
  | "retail"
  | "transport"
  | "other";

interface WorkspaceAccountsMap {
  groceries: string;
  dining: string;
  cafe: string; // folded into dining in the seed chart
  retail: string;
  transport: string;
  other: string;
  creditCard: string;
}

async function resolveWorkspaceAccounts(
  workspaceId: string,
): Promise<WorkspaceAccountsMap> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId));

  const find = (
    pred: (a: typeof rows[number]) => boolean,
    label: string,
  ): string => {
    const a = rows.find(pred);
    if (!a) throw new Error(`seeded account missing: ${label}`);
    return a.id;
  };

  const groceries = find(
    (a) => a.type === "expense" && a.name === "Groceries",
    "Expenses:Groceries",
  );
  const dining = find(
    (a) => a.type === "expense" && a.name === "Dining",
    "Expenses:Dining",
  );
  const transport = find(
    (a) => a.type === "expense" && a.name === "Transport",
    "Expenses:Transport",
  );
  // Two "Other" rows exist (income + expense); pick expense.
  const other = find(
    (a) => a.type === "expense" && a.name === "Other",
    "Expenses:Other",
  );
  const creditCard = find(
    (a) => a.type === "liability" && a.subtype === "credit_card",
    "Liabilities:Credit Card",
  );

  return {
    groceries,
    dining,
    cafe: dining,
    retail: other,
    transport,
    other,
    creditCard,
  };
}

function pickExpenseAccount(
  map: WorkspaceAccountsMap,
  categoryHint: string | undefined,
): string {
  const h = (categoryHint ?? "").toLowerCase().trim() as CategoryBucket;
  switch (h) {
    case "groceries":
      return map.groceries;
    case "dining":
      return map.dining;
    case "cafe":
      return map.cafe;
    case "retail":
      return map.retail;
    case "transport":
      return map.transport;
    default:
      return map.other;
  }
}

// ── Per-file processing ───────────────────────────────────────────────

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
 * Attach the `source_ingest_id` to a document the worker just linked
 * to a transaction. The v1 service doesn't take this field on upload
 * because the document may be linked to zero-or-more ingests; for the
 * batch-ingest path we know exactly which ingest owns each doc so we
 * backfill after insert.
 */
async function stampDocumentSource(
  workspaceId: string,
  documentId: string,
  ingestId: string,
): Promise<void> {
  await db
    .update(documentsTable)
    .set({ sourceIngestId: ingestId })
    .where(
      and(
        eq(documentsTable.id, documentId),
        eq(documentsTable.workspaceId, workspaceId),
      ),
    );
}

/**
 * Materialize one receipt-kind extraction as a transaction with two
 * postings (expense debit + credit-card credit) using the same sign
 * convention as the smoke harness.
 */
async function writeReceiptTransaction(
  args: {
    workspaceId: string;
    userId: string | null;
    ingestId: string;
    result: Extract<ExtractorResult, { classification: "receipt_image" | "receipt_email" | "receipt_pdf" }>;
  },
  accountMap: WorkspaceAccountsMap,
): Promise<TransactionRow> {
  const { workspaceId, userId, ingestId, result } = args;
  const ex = result.extracted;
  const expenseId = pickExpenseAccount(accountMap, ex.category_hint);
  const amount = ex.total_minor;
  // SEED_USER_ID is a real FK; in tests it equals SEED_USER_ID. If caller
  // passes null we let the service default to null (createdBy is nullable).
  const tx = await createTransaction(workspaceId, userId ?? "", {
    occurred_on: ex.occurred_on,
    payee: ex.payee,
    postings: [
      {
        account_id: expenseId,
        amount_minor: amount,
        currency: "USD",
        amount_base_minor: amount,
      },
      {
        account_id: accountMap.creditCard,
        amount_minor: -amount,
        currency: "USD",
        amount_base_minor: -amount,
      },
    ],
    metadata: {
      source: "ingest",
      source_ingest_id: ingestId,
      classification: result.classification,
      category_hint: ex.category_hint,
    },
  });

  // source_ingest_id is a first-class column but the service does not yet
  // expose it as an input — set it directly. We do this AFTER the create
  // because the balance trigger on postings is deferred, and the service
  // has already committed the row.
  await db.execute(
    sql`UPDATE transactions
         SET source_ingest_id = ${ingestId}::uuid
       WHERE id = ${tx.id}::uuid
         AND workspace_id = ${workspaceId}::uuid`,
  );

  return tx;
}

async function runOne(item: QueueItem): Promise<void> {
  const { ingestId, workspaceId, batchId, filePath, mimeType } = item;

  // Workspace owner acts as the "actor" for the synthesized transaction.
  // The v1 service requires a string userId; we defer FK constraints to
  // the DB (`created_by` is nullable with ON DELETE SET NULL, but at
  // insert time drizzle receives whatever we pass through).
  const wsRows = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const ownerId = wsRows[0]?.ownerId;
  if (!ownerId) {
    // Workspace vanished between enqueue and dequeue — shouldn't happen
    // outside a test teardown, but fail the ingest cleanly.
    await markError(ingestId, workspaceId, new Error("workspace not found"));
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }
  const userId = ownerId;

  await markProcessing(ingestId, workspaceId);
  await onBatchChildStarted(batchId, workspaceId);

  let result: ExtractorResult;
  try {
    result = await currentExtractor({
      filePath,
      mimeType,
      filename: item.filename,
    });
  } catch (err) {
    await markError(ingestId, workspaceId, err);
    await onBatchChildTerminated(batchId, workspaceId);
    return;
  }

  try {
    if (result.classification === "unsupported") {
      await markUnsupported(ingestId, workspaceId, result.reason);
      await onBatchChildTerminated(batchId, workspaceId);
      return;
    }

    if (result.classification === "statement_pdf") {
      // Phase 1 explicitly defers the statement pipeline. Mark unsupported
      // with a pointer so operators know why no transactions appeared.
      await markUnsupported(
        ingestId,
        workspaceId,
        "statement pipeline not yet implemented (Phase 2 of #32)",
      );
      await onBatchChildTerminated(batchId, workspaceId);
      return;
    }

    // receipt_image | receipt_email | receipt_pdf
    const accountMap = await resolveWorkspaceAccounts(workspaceId);
    const tx = await writeReceiptTransaction(
      { workspaceId, userId, ingestId, result },
      accountMap,
    );

    // Link the uploaded document to the new transaction. The ingest row
    // owns exactly one sha256-identified document — find it by path.
    const docRows = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.workspaceId, workspaceId),
          eq(documentsTable.filePath, filePath),
        ),
      );
    const documentIds: string[] = [];
    if (docRows.length > 0) {
      const doc = docRows[0]!;
      await linkDocumentToTransaction({
        workspaceId,
        documentId: doc.id,
        transactionId: tx.id,
      });
      await stampDocumentSource(workspaceId, doc.id, ingestId);
      documentIds.push(doc.id);
    }

    await markDone(ingestId, workspaceId, result.classification, {
      transaction_ids: [tx.id],
      document_ids: documentIds,
      receipt_ids: [],
    });
    await onBatchChildTerminated(batchId, workspaceId);
  } catch (err) {
    await markError(ingestId, workspaceId, err);
    await onBatchChildTerminated(batchId, workspaceId);
  }
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
  // If all children of this batch are terminal (done/error/unsupported),
  // flip the batch to `extracted` and stamp completed_at.
  await db.execute(
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
         )`,
  );
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
