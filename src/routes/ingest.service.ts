/**
 * Service layer for the `/v1/ingest`, `/v1/batches`, `/v1/ingests`
 * routes.
 *
 * Split from `ingest.ts` so the HTTP + future MCP callers share the
 * same DB access paths (mirrors the accounts / transactions services).
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
import { mkdir, writeFile } from "fs/promises";
import { db } from "../db/client.js";
import { batches, ingests } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import { NotFoundProblem } from "../http/problem.js";
import { enqueue } from "../ingest/worker.js";
import { uploadDocumentBytes, getUploadDir, extForMime } from "./documents.service.js";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_LIMIT,
} from "../http/pagination.js";

// ── Row shapes (API layer) ────────────────────────────────────────────

export interface IngestRow {
  id: string;
  workspace_id: string;
  batch_id: string | null;
  filename: string;
  mime_type: string | null;
  file_path: string;
  status: "queued" | "processing" | "done" | "error" | "unsupported";
  classification: string | null;
  produced: {
    receipt_ids: string[];
    transaction_ids: string[];
    document_ids: string[];
  } | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BatchCounts {
  total: number;
  queued: number;
  processing: number;
  done: number;
  error: number;
  unsupported: number;
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
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    batch_id: r.batchId,
    filename: r.filename,
    mime_type: r.mimeType,
    file_path: r.filePath,
    status: r.status as IngestRow["status"],
    classification: r.classification,
    produced,
    error: r.error,
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
  };
  const seeded: SeededIngest[] = [];

  for (const f of files) {
    // Persist the raw bytes via documents.service so we get sha256 +
    // dedup. `kind` at ingest-time is a best guess by extension.
    const kind = guessDocumentKind(f.originalName, f.mimeType);
    const { doc } = await uploadDocumentBytes({
      workspaceId,
      bytes: f.bytes,
      mimeType: f.mimeType,
      kind,
    });

    const ingestId = newId();
    seeded.push({
      id: ingestId,
      workspaceId,
      batchId,
      filename: f.originalName,
      mimeType: f.mimeType,
      // The worker reads bytes from doc.file_path via the filesystem —
      // this is the canonical on-disk path sha256-deduped by the
      // documents service.
      filePath: doc.file_path!,
    });
  }

  if (seeded.length > 0) {
    await db.insert(ingests).values(
      seeded.map((s) => ({
        id: s.id,
        workspaceId: s.workspaceId,
        batchId: s.batchId,
        filename: s.filename,
        mimeType: s.mimeType,
        filePath: s.filePath,
        status: "queued" as const,
      })),
    );
  }

  // Enqueue AFTER the DB commit so the worker never races the insert.
  for (const s of seeded) {
    enqueue({
      ingestId: s.id,
      workspaceId: s.workspaceId,
      batchId: s.batchId,
      filePath: s.filePath,
      mimeType: s.mimeType,
      filename: s.filename,
    });
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
  status?: string;
}): Promise<{ items: IngestRow[]; next_cursor: string | null }> {
  const limit = clampLimit(params.limit ?? DEFAULT_PAGE_LIMIT);
  const cur = decodeCursor<IngestListCursor>(params.cursor);
  const whereParts: ReturnType<typeof sql>[] = [
    sql`workspace_id = ${params.workspaceId}::uuid`,
  ];
  if (params.batchId)
    whereParts.push(sql`batch_id = ${params.batchId}::uuid`);
  if (params.status)
    whereParts.push(sql`status = ${params.status}::ingest_status`);
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
