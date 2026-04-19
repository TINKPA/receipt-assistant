/**
 * Document service — internal helpers shared by the HTTP handlers and
 * the FastMCP tools.
 *
 * The two clients (Express + MCP) speak different I/O idioms but share
 * the same business rules: sha256-based content dedup per workspace,
 * disk write under `UPLOAD_DIR`, insert into `documents`, etc.
 *
 * Keeping this logic in one module makes the MCP `upload_document` tool
 * and the HTTP `POST /v1/documents` provably equivalent.
 */
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { documents, documentLinks } from "../schema/documents.js";
import { transactions } from "../schema/transactions.js";
import { newId } from "../http/uuid.js";
import {
  DocumentHasLinksProblem,
  NotFoundProblem,
} from "../http/problem.js";

export type DocumentKindValue =
  | "receipt_image"
  | "receipt_email"
  | "receipt_pdf"
  | "statement_pdf"
  | "other";

export interface DocumentRow {
  id: string;
  workspace_id: string;
  kind: DocumentKindValue;
  file_path: string | null;
  mime_type: string | null;
  sha256: string;
  ocr_text: string | null;
  extraction_meta: Record<string, unknown> | null;
  source_ingest_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadResult {
  doc: DocumentRow;
  created: boolean;
}

export function getUploadDir(): string {
  return process.env.UPLOAD_DIR ?? "/data/uploads";
}

/**
 * Minimal mime → extension map. A dependency on the whole `mime-types`
 * package would be overkill for the ~6 content types we actually
 * ingest; the fallback just leaves the on-disk file extension-less,
 * which is fine since the authoritative type lives in the DB column.
 */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "message/rfc822": "eml",
  "text/plain": "txt",
  "text/html": "html",
};

export function extForMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const k = mime.toLowerCase().split(";")[0]!.trim();
  return MIME_EXT[k] ?? null;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** DB row → API shape (snake_case + ISO timestamps). */
function rowToApi(r: {
  id: string;
  workspaceId: string;
  kind: string;
  filePath: string | null;
  mimeType: string | null;
  sha256: string;
  ocrText: string | null;
  extractionMeta: unknown;
  sourceIngestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DocumentRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    kind: r.kind as DocumentKindValue,
    file_path: r.filePath,
    mime_type: r.mimeType,
    sha256: r.sha256,
    ocr_text: r.ocrText,
    extraction_meta:
      r.extractionMeta == null
        ? null
        : (r.extractionMeta as Record<string, unknown>),
    source_ingest_id: r.sourceIngestId,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/**
 * Idempotent upload: if a document with the same sha256 already exists
 * in the workspace, return it verbatim — no new disk write, no new DB
 * row. This is the documented contract (sha256 is the dedup key per
 * issue #28 header table).
 */
export async function uploadDocumentBytes(params: {
  workspaceId: string;
  bytes: Buffer;
  mimeType: string | null;
  kind: DocumentKindValue;
}): Promise<UploadResult> {
  const { workspaceId, bytes, mimeType, kind } = params;
  const sha = sha256Hex(bytes);

  // Dedup-lookup first. Unique index is (workspace_id, sha256).
  const existing = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), eq(documents.sha256, sha)));
  if (existing.length > 0) {
    return { doc: rowToApi(existing[0]!), created: false };
  }

  // Persist bytes under UPLOAD_DIR/<sha>.<ext>.
  const dir = getUploadDir();
  await mkdir(dir, { recursive: true });
  const ext = extForMime(mimeType);
  const filename = ext ? `${sha}.${ext}` : sha;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, bytes);

  const id = newId();
  const inserted = await db
    .insert(documents)
    .values({
      id,
      workspaceId,
      kind,
      filePath: fullPath,
      mimeType: mimeType ?? null,
      sha256: sha,
      ocrText: null,
      extractionMeta: null,
      sourceIngestId: null,
    })
    .returning();

  return { doc: rowToApi(inserted[0]!), created: true };
}

export async function getDocumentById(
  workspaceId: string,
  id: string,
): Promise<DocumentRow | null> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
  return rows.length > 0 ? rowToApi(rows[0]!) : null;
}

export async function linkDocumentToTransaction(params: {
  workspaceId: string;
  documentId: string;
  transactionId: string;
}): Promise<void> {
  const { workspaceId, documentId, transactionId } = params;

  // Both must belong to the caller's workspace. Validate explicitly
  // rather than rely on FK violations — clearer error payload.
  const doc = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  if (doc.length === 0) throw new NotFoundProblem("Document", documentId);

  const tx = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.workspaceId, workspaceId)));
  if (tx.length === 0) throw new NotFoundProblem("Transaction", transactionId);

  // Composite PK is (document_id, transaction_id) — re-link is a no-op.
  await db
    .insert(documentLinks)
    .values({ documentId, transactionId })
    .onConflictDoNothing();
}

export async function unlinkDocumentFromTransaction(params: {
  workspaceId: string;
  documentId: string;
  transactionId: string;
}): Promise<boolean> {
  const { workspaceId, documentId, transactionId } = params;

  // Scope via a join to documents to enforce workspace.
  const existing = await db
    .select({ d: documentLinks.documentId })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(
      and(
        eq(documentLinks.documentId, documentId),
        eq(documentLinks.transactionId, transactionId),
        eq(documents.workspaceId, workspaceId),
      ),
    );
  if (existing.length === 0) return false;

  await db
    .delete(documentLinks)
    .where(
      and(
        eq(documentLinks.documentId, documentId),
        eq(documentLinks.transactionId, transactionId),
      ),
    );
  return true;
}

export async function deleteDocument(params: {
  workspaceId: string;
  documentId: string;
}): Promise<boolean> {
  const { workspaceId, documentId } = params;

  const doc = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  if (doc.length === 0) return false;

  // Refuse to delete while links exist — caller must unlink first.
  const linkCountRes = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentLinks)
    .where(eq(documentLinks.documentId, documentId));
  const linkCount = linkCountRes[0]?.n ?? 0;
  if (linkCount > 0) {
    throw new DocumentHasLinksProblem(documentId, linkCount);
  }

  await db.delete(documents).where(eq(documents.id, documentId));
  return true;
}
