/**
 * Service layer for the `/v1/ingest`, `/v1/batches`, `/v1/ingests`
 * routes.
 *
 * Split from `ingest.ts` to mirror the accounts / transactions
 * service layout — handlers stay thin, DB access lives here.
 *
 * Phase 1 scope:
 *   - `createBatchFromFiles` — persist batch + N ingest rows and enqueue
 *     each ingest on the in-process worker,
 *   - `getBatch` / `listBatches` — aggregated read views,
 *   - `getIngest` / `listIngests` — per-file read views,
 *
 * Phase 2 will add reconcile endpoints + SSE hooks on top of the same
 * service.
 */
import { and, eq, desc, sql } from "drizzle-orm";
import * as path from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import { db } from "../db/client.js";
import { batches, ingests } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import {
  NotFoundProblem,
  ValidationProblem,
  IngestNotRetryableProblem,
  IngestFileMissingProblem,
} from "../http/problem.js";
import { enqueue, maybeCompleteBatch } from "../ingest/worker.js";
import {
  uploadDocumentBytes,
  getUploadDir,
  extForMime,
  resolveUploadPath,
} from "./documents.service.js";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_LIMIT,
} from "../http/pagination.js";

// ── Row shapes (API layer) ────────────────────────────────────────────

export type IngestStatus =
  | "queued"
  | "processing"
  | "done"
  | "error"
  | "unsupported"
  | "dedup"
  | "near_dup";

export type IngestCategory =
  | "ok"
  | "in_progress"
  | "transient_actionable"
  | "input_problem"
  | "informational";

export interface IngestRow {
  id: string;
  workspace_id: string;
  batch_id: string | null;
  filename: string;
  mime_type: string | null;
  file_path: string;
  status: IngestStatus;
  classification: string | null;
  produced: {
    receipt_ids: string[];
    transaction_ids: string[];
    document_ids: string[];
  } | null;
  error: string | null;
  // #158 derived fields.
  category: IngestCategory;
  retryable: boolean;
  dedup_of: string | null;
  created_at: string;
  completed_at: string | null;
}

// The set surfaced by `GET /v1/ingests/problems` when no explicit status
// filter is given: everything that didn't reach `done` and isn't still in
// flight. Ordered most-actionable first for readability.
export const PROBLEM_INGEST_STATUSES: IngestStatus[] = [
  "error",
  "unsupported",
  "dedup",
  "near_dup",
];

const ALL_INGEST_STATUSES: readonly IngestStatus[] = [
  "queued",
  "processing",
  "done",
  "error",
  "unsupported",
  "dedup",
  "near_dup",
];

// An `error` string matching this pattern is a transient/infrastructure
// fault (expired auth, timeout, rate-limit, upstream 5xx) — re-running the
// same bytes is likely to succeed once the outage clears. Anything else
// (missing date, illegible, "no total") is treated as an input problem
// where a blind retry won't help. Matches the 401 auth-expiry class that
// motivated #158.
const TRANSIENT_ERROR_RE =
  /\b(401|403|429|500|502|503|504)\b|invalid authentication|unauthor|forbidden|timed?[ -]?out|timeout|rate.?limit|overloaded|econnreset|econnrefused|etimedout|network|socket hang up|fetch failed|temporarily|try again/i;

/**
 * Derive the reason bucket + affordance hints for one ingest (#158). Pure
 * function of (status, error, produced) so both the list and problems
 * endpoints stay consistent.
 */
export function categorizeIngest(
  status: IngestStatus,
  error: string | null,
  produced: IngestRow["produced"],
): { category: IngestCategory; retryable: boolean; dedup_of: string | null } {
  switch (status) {
    case "done":
      return { category: "ok", retryable: false, dedup_of: null };
    case "queued":
    case "processing":
      return { category: "in_progress", retryable: false, dedup_of: null };
    case "dedup":
    case "near_dup":
      return {
        category: "informational",
        retryable: false,
        dedup_of: produced?.transaction_ids?.[0] ?? null,
      };
    case "unsupported":
      return { category: "input_problem", retryable: false, dedup_of: null };
    case "error": {
      const transient = TRANSIENT_ERROR_RE.test(error ?? "");
      return {
        category: transient ? "transient_actionable" : "input_problem",
        retryable: transient,
        dedup_of: null,
      };
    }
  }
}

/**
 * Parse the `status` query param — a single token or comma-separated set
 * (#158). Returns null when absent (caller applies its own default).
 * Throws NotFoundProblem-shaped ValidationProblem on unknown tokens.
 */
export function parseStatusFilter(raw: string | undefined): IngestStatus[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: IngestStatus[] = [];
  for (const t of tokens) {
    if (!(ALL_INGEST_STATUSES as readonly string[]).includes(t)) {
      throw new ValidationProblem(
        [
          {
            path: "status",
            code: "invalid_enum_value",
            message: `Unknown ingest status '${t}'. Allowed: ${ALL_INGEST_STATUSES.join(", ")}.`,
          },
        ],
        `Unknown ingest status '${t}'`,
      );
    }
    if (!out.includes(t as IngestStatus)) out.push(t as IngestStatus);
  }
  return out.length > 0 ? out : null;
}

export interface BatchCounts {
  total: number;
  queued: number;
  processing: number;
  done: number;
  error: number;
  unsupported: number;
  // L1 short-circuit hits (#124).
  dedup: number;
  near_dup: number;
}

export interface BatchSummaryRow {
  id: string;
  workspace_id: string;
  status: string;
  file_count: number;
  auto_reconcile: boolean;
  counts: BatchCounts;
  created_at: string;
  completed_at: string | null;
  reconciled_at: string | null;
}

export interface BatchRow extends BatchSummaryRow {
  items: IngestRow[];
}

// ── Mappers ───────────────────────────────────────────────────────────

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function mapIngestRow(r: typeof ingests.$inferSelect): IngestRow {
  const produced = (r.produced ?? null) as IngestRow["produced"];
  const status = r.status as IngestStatus;
  const { category, retryable, dedup_of } = categorizeIngest(
    status,
    r.error,
    produced,
  );
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    batch_id: r.batchId,
    filename: r.filename,
    mime_type: r.mimeType,
    file_path: r.filePath,
    status,
    classification: r.classification,
    produced,
    error: r.error,
    category,
    retryable,
    dedup_of,
    created_at: toIso(r.createdAt)!,
    completed_at: toIso(r.completedAt),
  };
}

// ── Aggregations ──────────────────────────────────────────────────────

async function fetchBatchCounts(batchId: string): Promise<BatchCounts> {
  const res = await db.execute(
    sql`SELECT status, COUNT(*)::int AS n
          FROM ingests
         WHERE batch_id = ${batchId}::uuid
         GROUP BY status`,
  );
  const counts: BatchCounts = {
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

function mapBatchBase(
  r: typeof batches.$inferSelect,
  counts: BatchCounts,
): BatchSummaryRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    status: r.status,
    file_count: r.fileCount,
    auto_reconcile: r.autoReconcile,
    counts,
    created_at: toIso(r.createdAt)!,
    completed_at: toIso(r.completedAt),
    reconciled_at: toIso(r.reconciledAt),
  };
}

// ── Create ────────────────────────────────────────────────────────────

export interface IncomingFile {
  originalName: string;
  mimeType: string | null;
  bytes: Buffer;
}

/**
 * Drive the whole upload pipeline for a batch:
 *   1. Persist every file to disk (once per sha, via the existing
 *      documents service — this guarantees no duplicate on-disk bytes).
 *   2. Create the `batches` row.
 *   3. Create one `ingests` row per file.
 *   4. Enqueue each ingest on the in-process worker.
 *
 * We want an `ingests` row for every file even if its document was a
 * sha256 dedup hit — the ingest is the audit trail for "I tried to
 * process this file today", independent of document storage.
 */
export async function createBatchFromFiles(params: {
  workspaceId: string;
  files: IncomingFile[];
  autoReconcile: boolean;
}): Promise<{
  batch: BatchSummaryRow;
  items: Array<{ ingestId: string; filename: string; mime_type: string | null }>;
}> {
  const { workspaceId, files, autoReconcile } = params;
  if (files.length === 0) {
    throw new Error("createBatchFromFiles called with 0 files");
  }

  const batchId = newId();
  await db.insert(batches).values({
    id: batchId,
    workspaceId,
    status: "pending",
    fileCount: files.length,
    autoReconcile,
  });

  // Upload each file into the documents store first. This hashes the
  // bytes and persists them under UPLOAD_DIR/<sha>.<ext>. The document
  // row will be referenced by the worker when the ingest reports back
  // its produced document_ids.
  //
  // For classification we don't know kind yet — upload as `other` and
  // let the worker rewrite `kind` once classification completes.
  // Actually: the documents service requires kind up-front. We use
  // `receipt_image` as the default since it's the most common case;
  // the worker doesn't update kind today (Phase 2 can).
  const uploadDir = path.join(getUploadDir(), "incoming");
  await mkdir(uploadDir, { recursive: true });

  type SeededIngest = {
    id: string;
    workspaceId: string;
    batchId: string;
    filename: string;
    mimeType: string | null;
    filePath: string;
    documentId: string;
    // L1 dedup (#124): the ingest is born terminal (`status='dedup'`) and
    // is never enqueued — no Claude spawn, no duplicate transaction. See
    // the loop below for why `bornDedup` is decided by "bytes already
    // known", NOT by "a live transaction was found".
    bornDedup: boolean;
    // When known, the pre-existing live transaction these bytes already
    // produced — used only for provenance (deep-link "view it"). May be
    // null on a race-born dedup (the sibling's transaction isn't committed
    // yet); the dup is still suppressed regardless.
    dedupOf: string | null;
  };
  const seeded: SeededIngest[] = [];
  // Docs THIS request has already committed to extracting — so a second
  // byte-identical file in the SAME upload dedups against the first even
  // before any ingest row is inserted (the in-flight DB probe can't see
  // an uncommitted sibling). Keyed by document id.
  const willExtractDocIds = new Set<string>();

  for (const f of files) {
    // Persist the raw bytes via documents.service so we get sha256 +
    // dedup. `kind` at ingest-time is a best guess by extension.
    const kind = guessDocumentKind(f.originalName, f.mimeType);
    const { doc, created } = await uploadDocumentBytes({
      workspaceId,
      bytes: f.bytes,
      mimeType: f.mimeType,
      kind,
    });

    // L1 short-circuit (#124, race-hardened 2026-06-13). A sha256
    // collision (`created === false`) means these EXACT bytes are already
    // a known document — that alone is a 100% duplicate signal. The old
    // code gated the skip on "is there a live transaction yet?", which is
    // a TOCTOU race: the sibling ingest's transaction is still minutes
    // deep in the queue, so the probe returns null and the dup falls
    // through to extraction (the 2026-05-16 incident: 68 dup rows /
    // ~$3,801 over-count; and the 3× New York Chicken seen 2026-06-13).
    // So decide `bornDedup` from "are these bytes already being handled",
    // not from "did I find the transaction". A byte-dup is suppressed
    // when it matches a live transaction, OR a sibling ingest still in
    // flight (another request, or an earlier file in THIS request). The
    // only `!created` case we still extract is a genuine restore: prior
    // transaction voided/errored, nothing live and nothing in flight
    // (findLiveTransactionForDocument deliberately ignores voided links).
    let bornDedup = false;
    let dedupOf: string | null = null;
    if (!created) {
      dedupOf = await findLiveTransactionForDocument(workspaceId, doc.id);
      if (dedupOf) {
        bornDedup = true;
      } else if (
        willExtractDocIds.has(doc.id) ||
        (await hasInFlightIngestForDocument(workspaceId, doc.file_path!))
      ) {
        // Duplicate of an extraction already in progress; its transaction
        // doesn't exist yet, so provenance (dedupOf) stays null. The dup
        // is still correctly suppressed — that's the part that matters.
        bornDedup = true;
      }
    }
    if (!bornDedup) willExtractDocIds.add(doc.id);

    const ingestId = newId();
    seeded.push({
      id: ingestId,
      workspaceId,
      batchId,
      filename: f.originalName,
      mimeType: f.mimeType,
      // Stored form: relative to the uploads dir (#128), sha256-named by
      // the documents service. The worker resolves it to an absolute
      // path (resolveUploadPath) right before the filesystem read.
      filePath: doc.file_path!,
      documentId: doc.id,
      bornDedup,
      dedupOf,
    });
  }

  if (seeded.length > 0) {
    await db.insert(ingests).values(
      seeded.map((s) =>
        s.bornDedup
          ? {
              id: s.id,
              workspaceId: s.workspaceId,
              batchId: s.batchId,
              filename: s.filename,
              mimeType: s.mimeType,
              filePath: s.filePath,
              status: "dedup" as const,
              // Point provenance at the pre-existing transaction so the
              // client can deep-link "already in your ledger → view it".
              // On a race-born dedup (sibling not committed yet) dedupOf is
              // null — provenance is empty but the dup is still suppressed.
              produced: {
                receipt_ids: [],
                transaction_ids: s.dedupOf ? [s.dedupOf] : [],
                document_ids: [s.documentId],
              },
              error: s.dedupOf
                ? "duplicate: identical file already linked to a transaction"
                : "duplicate: identical file already being processed",
              completedAt: new Date(),
            }
          : {
              id: s.id,
              workspaceId: s.workspaceId,
              batchId: s.batchId,
              filename: s.filename,
              mimeType: s.mimeType,
              filePath: s.filePath,
              status: "queued" as const,
            },
      ),
    );
  }

  // Enqueue AFTER the DB commit so the worker never races the insert.
  // Dedup hits are terminal already — never enqueue them.
  for (const s of seeded) {
    if (s.bornDedup) continue;
    enqueue({
      ingestId: s.id,
      workspaceId: s.workspaceId,
      batchId: s.batchId,
      filePath: s.filePath,
      mimeType: s.mimeType,
      filename: s.filename,
    });
  }

  // If every file deduped (or the batch is a mix and the real children
  // are still queued), nudge the batch state machine: an all-dedup batch
  // has no worker child to fire `onBatchChildTerminated`, so without this
  // it would hang in `pending` forever. The UPDATE is guarded to no-op
  // while any non-terminal child remains, so it's safe to always call.
  if (seeded.some((s) => s.bornDedup)) {
    await maybeCompleteBatch(batchId, workspaceId);
  }

  const counts = await fetchBatchCounts(batchId);
  const batchRow = await db
    .select()
    .from(batches)
    .where(eq(batches.id, batchId));
  return {
    batch: mapBatchBase(batchRow[0]!, counts),
    items: seeded.map((s) => ({
      ingestId: s.id,
      filename: s.filename,
      mime_type: s.mimeType,
    })),
  };
}

/**
 * L1 dedup probe (#124). Returns the id of a LIVE transaction (posted or
 * reconciled) already linked to `documentId`, or null if none. A `voided`
 * or `draft` link must NOT suppress a re-ingest — the user may be
 * re-uploading precisely because the prior transaction was voided. One
 * O(ms) indexed lookup per dedup-hit file; `document_links_txn_idx` +
 * the documents PK keep it cheap.
 */
async function findLiveTransactionForDocument(
  workspaceId: string,
  documentId: string,
): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT t.id
      FROM document_links dl
      JOIN transactions t ON t.id = dl.transaction_id
     WHERE dl.document_id = ${documentId}::uuid
       AND t.workspace_id = ${workspaceId}::uuid
       AND t.status IN ('posted', 'reconciled')
     ORDER BY t.created_at ASC
     LIMIT 1
  `);
  const row = res.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Race guard for L1 dedup (#124, 2026-06-13). True when a NON-terminal
 * ingest (`queued` | `processing`) already exists for these exact bytes —
 * i.e. a sibling extraction is mid-flight and will produce the canonical
 * transaction. Lets the scaffold suppress a byte-identical re-upload even
 * before that transaction is committed, closing the TOCTOU window that
 * `findLiveTransactionForDocument` alone leaves open. Keyed on the stored
 * sha256-named `file_path`, which is 1:1 with the document. One O(ms)
 * indexed lookup (`ingests_status_idx`).
 */
async function hasInFlightIngestForDocument(
  workspaceId: string,
  filePath: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1
      FROM ingests
     WHERE workspace_id = ${workspaceId}::uuid
       AND file_path = ${filePath}
       AND status IN ('queued', 'processing')
     LIMIT 1
  `);
  return res.rows.length > 0;
}

function guessDocumentKind(
  filename: string,
  mime: string | null,
): "receipt_image" | "receipt_email" | "receipt_pdf" | "statement_pdf" | "other" {
  const mt = (mime ?? "").toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (mt.startsWith("image/") || [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"].includes(ext)) {
    return "receipt_image";
  }
  if (mt === "message/rfc822" || ext === ".eml") return "receipt_email";
  if (mt === "text/html" || ext === ".html" || ext === ".htm") {
    // Portal invoices saved as HTML (Tekmetric and other shop-management
    // systems) and some web purchase confirmations. Display is gated on
    // mime_type (the viewer renders text/html through /rendered), so this
    // kind only drives the list glyph — receipt_pdf reads best for an
    // invoice-style page. #137.
    return "receipt_pdf";
  }
  if (mt === "application/pdf" || ext === ".pdf") {
    // We can't tell receipt-vs-statement without reading it; the agent
    // classifies authoritatively. Default to receipt_pdf (more common).
    return "receipt_pdf";
  }
  return "other";
}

// ── Reads ─────────────────────────────────────────────────────────────

export async function getBatch(
  workspaceId: string,
  id: string,
): Promise<BatchRow> {
  const rows = await db
    .select()
    .from(batches)
    .where(and(eq(batches.id, id), eq(batches.workspaceId, workspaceId)));
  if (rows.length === 0) throw new NotFoundProblem("Batch", id);
  const b = rows[0]!;

  const ingestRows = await db
    .select()
    .from(ingests)
    .where(eq(ingests.batchId, id))
    .orderBy(ingests.createdAt);
  const items = ingestRows.map(mapIngestRow);

  const counts = await fetchBatchCounts(id);
  return { ...mapBatchBase(b, counts), items };
}

interface BatchListCursor {
  created_at: string;
  id: string;
}

export async function listBatches(params: {
  workspaceId: string;
  cursor?: string;
  limit?: number;
  status?: string;
}): Promise<{ items: BatchSummaryRow[]; next_cursor: string | null }> {
  const limit = clampLimit(params.limit ?? DEFAULT_PAGE_LIMIT);
  const cur = decodeCursor<BatchListCursor>(params.cursor);
  const whereParts: ReturnType<typeof sql>[] = [
    sql`workspace_id = ${params.workspaceId}::uuid`,
  ];
  if (params.status)
    whereParts.push(sql`status = ${params.status}::batch_status`);
  if (cur) {
    whereParts.push(
      sql`(created_at, id) < (${cur.created_at}::timestamptz, ${cur.id}::uuid)`,
    );
  }
  const where = sql.join(whereParts, sql` AND `);
  const res = await db.execute(
    sql`SELECT * FROM batches WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1}`,
  );
  const rows = res.rows as Array<typeof batches.$inferSelect & {
    created_at: Date;
    completed_at: Date | null;
    reconciled_at: Date | null;
    workspace_id: string;
    file_count: number;
    auto_reconcile: boolean;
  }>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: BatchSummaryRow[] = [];
  for (const r of page) {
    const counts = await fetchBatchCounts(r.id);
    // DB driver returns snake_case; map through.
    items.push(
      mapBatchBase(
        {
          id: r.id,
          workspaceId: (r as any).workspace_id,
          status: r.status,
          fileCount: (r as any).file_count,
          autoReconcile: (r as any).auto_reconcile,
          createdAt: r.created_at,
          completedAt: r.completed_at,
          reconciledAt: r.reconciled_at,
        } as typeof batches.$inferSelect,
        counts,
      ),
    );
  }

  let next_cursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor({
      created_at: toIso(last.created_at)!,
      id: last.id,
    });
  }
  return { items, next_cursor };
}

export async function getIngest(
  workspaceId: string,
  id: string,
): Promise<IngestRow> {
  const rows = await db
    .select()
    .from(ingests)
    .where(and(eq(ingests.id, id), eq(ingests.workspaceId, workspaceId)));
  if (rows.length === 0) throw new NotFoundProblem("Ingest", id);
  return mapIngestRow(rows[0]!);
}

interface IngestListCursor {
  created_at: string;
  id: string;
}

export async function listIngests(params: {
  workspaceId: string;
  cursor?: string;
  limit?: number;
  batchId?: string;
  statuses?: IngestStatus[];
}): Promise<{ items: IngestRow[]; next_cursor: string | null }> {
  const limit = clampLimit(params.limit ?? DEFAULT_PAGE_LIMIT);
  const cur = decodeCursor<IngestListCursor>(params.cursor);
  const whereParts: ReturnType<typeof sql>[] = [
    sql`workspace_id = ${params.workspaceId}::uuid`,
  ];
  if (params.batchId)
    whereParts.push(sql`batch_id = ${params.batchId}::uuid`);
  if (params.statuses && params.statuses.length > 0) {
    const list = sql.join(
      params.statuses.map((s) => sql`${s}::ingest_status`),
      sql`, `,
    );
    whereParts.push(sql`status IN (${list})`);
  }
  if (cur) {
    whereParts.push(
      sql`(created_at, id) < (${cur.created_at}::timestamptz, ${cur.id}::uuid)`,
    );
  }
  const where = sql.join(whereParts, sql` AND `);
  const res = await db.execute(
    sql`SELECT * FROM ingests WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1}`,
  );
  const rowsRaw = res.rows as any[];
  const hasMore = rowsRaw.length > limit;
  const page = hasMore ? rowsRaw.slice(0, limit) : rowsRaw;
  const items = page.map((r) =>
    mapIngestRow({
      id: r.id,
      workspaceId: r.workspace_id,
      batchId: r.batch_id,
      filename: r.filename,
      mimeType: r.mime_type,
      filePath: r.file_path,
      status: r.status,
      classification: r.classification,
      produced: r.produced,
      error: r.error,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    } as typeof ingests.$inferSelect),
  );

  let next_cursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor({
      created_at: toIso(last.created_at)!,
      id: last.id,
    });
  }
  return { items, next_cursor };
}

// ── Retry (#158) ──────────────────────────────────────────────────────

/**
 * Re-run a failed/unsupported ingest against its original stored bytes.
 *
 * Rather than surgically re-opening the (already terminal) batch, we route
 * the stored bytes back through `createBatchFromFiles` — the normal upload
 * pipeline. That reuses the full batch → worker → auto-reconcile lifecycle
 * and, crucially, the L1 dedup "genuine restore" branch (#124): because the
 * errored ingest produced no live transaction, `findLiveTransactionForDocument`
 * returns null and nothing is in flight, so the byte-known input is enqueued
 * for a real re-extract instead of being suppressed as a duplicate.
 *
 * The original errored ingest row is left intact as the historical record
 * of the failure; the returned `ingest` is the freshly-created one the
 * caller should poll.
 *
 * Guards: only `error` / `unsupported` are retryable. `done` already
 * succeeded; `queued`/`processing` are still in flight; `dedup`/`near_dup`
 * are duplicates whose canonical transaction is reachable via `dedup_of`.
 */
export async function retryIngest(
  workspaceId: string,
  id: string,
): Promise<{
  retried_ingest_id: string;
  batch_id: string;
  ingest: IngestRow;
  poll: string;
}> {
  const original = await getIngest(workspaceId, id); // throws NotFound
  if (original.status !== "error" && original.status !== "unsupported") {
    throw new IngestNotRetryableProblem(id, original.status);
  }

  const abs = resolveUploadPath(original.file_path);
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    throw new IngestFileMissingProblem(id, original.file_path);
  }

  const { batch, items } = await createBatchFromFiles({
    workspaceId,
    files: [
      {
        originalName: original.filename,
        mimeType: original.mime_type,
        bytes,
      },
    ],
    autoReconcile: true,
  });

  const newIngestId = items[0]!.ingestId;
  const ingest = await getIngest(workspaceId, newIngestId);
  return {
    retried_ingest_id: id,
    batch_id: batch.id,
    ingest,
    poll: `/v1/batches/${batch.id}`,
  };
}
