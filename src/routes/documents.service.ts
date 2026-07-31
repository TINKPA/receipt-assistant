/**
 * Document service — internal helpers behind the HTTP handlers.
 *
 * Business rules: sha256-based content dedup per workspace, disk write
 * under `UPLOAD_DIR`, insert into `documents`, etc.
 */
import { createHash } from "crypto";
import { mkdir, writeFile, rename, readFile, stat } from "fs/promises";
import * as path from "path";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { and, eq, sql, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { documents, documentLinks } from "../schema/documents.js";
import { transactions, transactionEvents } from "../schema/index.js";
import { derivationEvents } from "../schema/derivation_events.js";
import { computePhash, isHashableImageMime } from "../images/phash.js";
import { newId } from "../http/uuid.js";
import {
  DocumentHasLinksProblem,
  HttpProblem,
  NotFoundProblem,
} from "../http/problem.js";
import {
  defaultClaudeReExtractor,
  type ReExtractor,
} from "../ingest/extractor.js";
import {
  PROMPT_VERSION,
  EXTRACTION_MODEL,
} from "../ingest/prompt-contract.js";
import { buildInfo } from "../generated/build-info.js";
import { trackLangfuse } from "../langfuse.js";

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
  /** Model identifier under which `ocr_text` was produced. NULL on
   *  legacy rows (pre-#91 Phase 4b). Set by ingest going forward;
   *  overwritten by re-extract (Phase 4c). */
  ocr_model_version: string | null;
  extraction_meta: Record<string, unknown> | null;
  /** RFC822 Message-ID for email-sourced docs; NULL otherwise (#122). */
  message_id: string | null;
  /** Channel provenance, e.g. `{channel,sender,subject,received_at}` for
   *  email; NULL otherwise (#122). */
  source_meta: Record<string, unknown> | null;
  source_ingest_id: string | null;
  deleted_at: string | null;
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
 * `documents.file_path` / `ingests.file_path` are stored RELATIVE to
 * `getUploadDir()` (#128) so the same DB rows resolve on the host
 * (`UPLOAD_DIR=.../data/uploads`) and in the container (`/data/uploads`)
 * alike. Every filesystem access must go through this resolver.
 *
 * Legacy rows hold absolute paths from whichever environment ingested
 * them; migration 0024 rewrites those, and the isAbsolute branch keeps
 * a not-yet-migrated row readable in the environment that wrote it.
 */
export function resolveUploadPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(getUploadDir(), stored);
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

/**
 * Normalize a stored `mime_type` to its bare type: drop any `; charset=…`
 * parameters, trim, lowercase. Absent/empty input normalizes to `""`, so
 * callers can compare against a literal without a null check first.
 */
export function baseMimeType(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

export function extForMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  return MIME_EXT[baseMimeType(mime)] ?? null;
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
  ocrModelVersion: string | null;
  extractionMeta: unknown;
  messageId: string | null;
  sourceMeta: unknown;
  sourceIngestId: string | null;
  deletedAt: Date | null;
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
    ocr_model_version: r.ocrModelVersion,
    extraction_meta:
      r.extractionMeta == null
        ? null
        : (r.extractionMeta as Record<string, unknown>),
    message_id: r.messageId,
    source_meta:
      r.sourceMeta == null
        ? null
        : (r.sourceMeta as Record<string, unknown>),
    source_ingest_id: r.sourceIngestId,
    deleted_at: r.deletedAt ? r.deletedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/**
 * Idempotent upload: if a document with the same sha256 already exists
 * in the workspace, return it verbatim — no new disk write, no new DB
 * row. This is the documented contract (sha256 is the dedup key per
 * issue #28 header table).
 *
 * If the existing row is soft-deleted, re-uploading the same bytes
 * resurrects it (clears `deleted_at`). This is the cheapest restore
 * path — `POST /:id/restore` is the explicit version, but a re-upload
 * is the natural undo when the user still has the file in hand.
 */
export async function uploadDocumentBytes(params: {
  workspaceId: string;
  bytes: Buffer;
  mimeType: string | null;
  kind: DocumentKindValue;
}): Promise<UploadResult> {
  const { workspaceId, bytes, mimeType, kind } = params;
  const sha = sha256Hex(bytes);

  // Dedup-lookup first. Unique index is (workspace_id, sha256) and
  // intentionally spans soft-deleted rows so re-upload resurrects.
  const existing = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), eq(documents.sha256, sha)));
  if (existing.length > 0) {
    const row = existing[0]!;
    if (row.deletedAt) {
      const restored = await db
        .update(documents)
        .set({ deletedAt: null })
        .where(eq(documents.id, row.id))
        .returning();
      return { doc: rowToApi(restored[0]!), created: false };
    }
    return { doc: rowToApi(row), created: false };
  }

  // Persist bytes under UPLOAD_DIR/<sha>.<ext>.
  const dir = getUploadDir();
  await mkdir(dir, { recursive: true });
  const ext = extForMime(mimeType);
  const filename = ext ? `${sha}.${ext}` : sha;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, bytes);

  // L2 dedup evidence (#134): perceptual hash for images. Null on
  // decode failure or non-image — never blocks the upload.
  const phash = isHashableImageMime(mimeType)
    ? await computePhash(bytes)
    : null;

  const id = newId();
  const inserted = await db
    .insert(documents)
    .values({
      id,
      workspaceId,
      kind,
      // Stored relative to the uploads dir (#128) — see resolveUploadPath.
      filePath: filename,
      phash,
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
  opts: { includeDeleted?: boolean } = {},
): Promise<DocumentRow | null> {
  const conds = [eq(documents.id, id), eq(documents.workspaceId, workspaceId)];
  if (!opts.includeDeleted) conds.push(isNull(documents.deletedAt));
  const rows = await db
    .select()
    .from(documents)
    .where(and(...conds));
  return rows.length > 0 ? rowToApi(rows[0]!) : null;
}

// ── Email rendering (#122) ──────────────────────────────────────────────
//
// A receipt_email document's `file_path` holds the raw RFC822 `.eml`,
// which is not directly renderable (MIME, quoted-printable). This decodes
// it to the HTML body and sanitizes it for the frontend's "Original email"
// fold. Remote images are intentionally KEPT (product decision: fidelity
// over tracking-pixel privacy for a single-user app). The real XSS
// boundary is the frontend's sandboxed iframe + a strict CSP on the
// response; this sanitize pass is defense-in-depth (drops script/iframe/
// form/event-handlers) while preserving inline styles, tables, and imgs.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const EMAIL_SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img", "center", "font", "table", "thead", "tbody", "tfoot",
    "tr", "td", "th", "colgroup", "col", "h1", "h2", "h3", "h4", "h5",
    "h6", "span", "u", "s", "strike", "small", "big", "sup", "sub",
  ]),
  allowedAttributes: {
    "*": [
      "style", "class", "align", "valign", "width", "height", "bgcolor",
      "color", "dir", "colspan", "rowspan", "cellpadding", "cellspacing",
      "border", "title",
    ],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "style", "title"],
    font: ["color", "face", "size"],
  },
  // Keep remote images (product decision). `cid:` covers inline parts.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  // Links open in a new tab and never leak referrer / opener.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    }),
  },
};

/**
 * Decode + sanitize an HTML rendering of a document for the detail
 * page's "Original receipt / email" fold. Two renderable sources (#137):
 *   - `.eml` email (`kind = receipt_email`) → RFC822-decode, take the
 *     HTML (or text-as-HTML) body.
 *   - raw `text/html` file (`mime_type = text/html`) → sanitize the file
 *     bytes directly; there is no envelope to decode.
 * Both pass through the same `EMAIL_SANITIZE` allowlist (drops <script>,
 * event handlers, etc.), so together with the route's strict CSP and the
 * frontend's sandboxed iframe the untrusted markup has three independent
 * containment layers.
 * Returns null when the document is missing/soft-deleted or its file is
 * unreadable (→ 404). Throws 422 for a document that is neither source.
 */
export async function renderDocumentHtml(
  workspaceId: string,
  id: string,
): Promise<string | null> {
  const doc = await getDocumentById(workspaceId, id);
  if (!doc) return null;
  const isEmail = doc.kind === "receipt_email";
  // Accept application/xhtml+xml alongside text/html — otherwise an
  // HTML-by-extension doc with a near-miss mime would fall through to the
  // non-sandboxed /content viewer. #137.
  const baseMime = baseMimeType(doc.mime_type);
  const isHtml = baseMime === "text/html" || baseMime === "application/xhtml+xml";
  if (!isEmail && !isHtml) {
    throw new HttpProblem(
      422,
      "document-not-renderable",
      "Document has no HTML rendering",
      `Document ${id} (kind=${doc.kind}, mime_type=${doc.mime_type ?? "null"}) is not a renderable HTML source; /rendered serves receipt_email (.eml) or text/html documents.`,
      { document_id: id, kind: doc.kind, mime_type: doc.mime_type },
    );
  }
  if (!doc.file_path) return null;
  const absPath = resolveUploadPath(doc.file_path);
  try {
    await stat(absPath);
  } catch {
    return null;
  }
  const raw = await readFile(absPath);
  if (isEmail) {
    const parsed = await simpleParser(raw);
    const body =
      typeof parsed.html === "string" && parsed.html.length > 0
        ? parsed.html
        : parsed.textAsHtml ?? `<pre>${escapeHtml(parsed.text ?? "")}</pre>`;
    return sanitizeHtml(body, EMAIL_SANITIZE);
  }
  // Raw text/html file (portal invoice, saved confirmation): the bytes
  // are the HTML document — sanitize them as-is.
  return sanitizeHtml(raw.toString("utf8"), EMAIL_SANITIZE);
}

export async function linkDocumentToTransaction(params: {
  workspaceId: string;
  documentId: string;
  transactionId: string;
}): Promise<void> {
  const { workspaceId, documentId, transactionId } = params;

  // Both must belong to the caller's workspace. Validate explicitly
  // rather than rely on FK violations — clearer error payload.
  // Soft-deleted documents cannot be linked.
  const doc = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.workspaceId, workspaceId),
        isNull(documents.deletedAt),
      ),
    );
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

/**
 * Soft delete: mark `deleted_at = NOW()`. Idempotent (already-deleted
 * rows are returned as `false` so the route emits 404). Links survive
 * — they record a historical association even if the doc is hidden.
 */
export async function softDeleteDocument(params: {
  workspaceId: string;
  documentId: string;
}): Promise<boolean> {
  const { workspaceId, documentId } = params;
  const rows = await db
    .select({ id: documents.id, deletedAt: documents.deletedAt })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  if (rows.length === 0) return false;
  if (rows[0]!.deletedAt) return false; // already deleted → 404 to caller

  await db
    .update(documents)
    .set({ deletedAt: new Date() })
    .where(eq(documents.id, documentId));
  return true;
}

/**
 * Restore a soft-deleted document: clear `deleted_at`. Returns false
 * if the doc isn't found or wasn't deleted (caller maps to 404).
 */
export async function restoreDocument(params: {
  workspaceId: string;
  documentId: string;
}): Promise<DocumentRow | null> {
  const { workspaceId, documentId } = params;
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  if (rows.length === 0) return null;
  if (!rows[0]!.deletedAt) return null;

  const restored = await db
    .update(documents)
    .set({ deletedAt: null })
    .where(eq(documents.id, documentId))
    .returning();
  return rowToApi(restored[0]!);
}

/**
 * Move a hard-deleted receipt's bytes into a `.trash/` subfolder of the
 * uploads directory instead of unlinking them. Same filesystem, so
 * `rename` is atomic; same bind mount, so the file stays inside the
 * existing iCloud + Time Machine coverage.
 *
 * Why: receipt images are user PII the user wants permanently. The
 * historical `unlink` path made hard delete irreversible, and recovery
 * required Time-Machine APFS-snapshot forensics — see #72 for the
 * incident report. A trash subfolder keeps the bytes one `mv` away.
 *
 * Best-effort: a missing source file (e.g. already moved by a prior
 * cascade, or never written) returns silently. The DB row is the
 * source-of-truth state; quarantining is a recoverability bonus.
 */
async function quarantineFile(filePath: string): Promise<string | null> {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const trashDir = path.join(dir, ".trash");
    await mkdir(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(trashDir, `${stamp}__${base}`);
    await rename(filePath, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Hard delete: row + on-disk bytes. By default refuses if links exist
 * (caller is expected to call cascade or unlink first). The image
 * file is moved to `.trash/` AFTER the DB commit so a rollback doesn't
 * leave a quarantined-on-disk-but-present-in-db state. The reverse
 * risk (file quarantined, row missed) is acceptable because the bytes
 * are recoverable from the trash subfolder.
 */
export async function hardDeleteDocument(params: {
  workspaceId: string;
  documentId: string;
}): Promise<boolean> {
  const { workspaceId, documentId } = params;
  const rows = await db
    .select({ id: documents.id, filePath: documents.filePath })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
  if (rows.length === 0) return false;
  const filePath = rows[0]!.filePath;

  const linkCountRes = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentLinks)
    .where(eq(documentLinks.documentId, documentId));
  const linkCount = linkCountRes[0]?.n ?? 0;
  if (linkCount > 0) throw new DocumentHasLinksProblem(documentId, linkCount);

  await db.delete(documents).where(eq(documents.id, documentId));

  if (filePath) await quarantineFile(resolveUploadPath(filePath));
  return true;
}

interface CascadeReport {
  unlinked: number;
  txns_soft_deleted: string[];
  txns_hard_deleted: string[];
  txns_skipped: string[];
}

/**
 * One-call "delete this whole receipt" orchestration.
 *
 * Soft mode (default): linked posted txns → soft-deleted (deleted_at);
 * linked draft/error txns → hard-deleted (no audit value); linked
 * already-deleted txns → left alone, link kept for history; document →
 * soft-deleted.
 *
 * Hard mode (`hard=true`): all linked txns are hard-deleted (postings
 * cascade via FK); document → hard-deleted (row + image file).
 *
 * Both modes refuse if any linked txn is `reconciled`: 409, no writes.
 * Caller must unreconcile first.
 *
 * Everything happens in a single DB transaction — the file quarantine
 * (hard mode) runs after commit. The bytes are MOVED into `.trash/`,
 * never unlinked; see `quarantineFile` and #72.
 */
export async function cascadeDeleteDocument(params: {
  workspaceId: string;
  userId: string;
  documentId: string;
  hard: boolean;
}): Promise<CascadeReport & { hardDeletedFilePath?: string | null }> {
  const { workspaceId, userId, documentId, hard } = params;

  let pendingFileUnlink: string | null = null;

  const report = await db.transaction(async (tx) => {
    // Load doc (allow soft-deleted — user may want to fully purge a
    // soft-deleted row + its surviving links via cascade hard).
    const docRows = await tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)),
      );
    if (docRows.length === 0) throw new NotFoundProblem("Document", documentId);
    const doc = docRows[0]!;

    // Find all linked transactions with their current state.
    const linkedTxns = await tx
      .select({
        id: transactions.id,
        status: transactions.status,
        deletedAt: transactions.deletedAt,
        version: transactions.version,
      })
      .from(documentLinks)
      .innerJoin(transactions, eq(transactions.id, documentLinks.transactionId))
      .where(eq(documentLinks.documentId, documentId));

    // Reconciled guard — refuse the whole batch.
    const reconciled = linkedTxns.filter((t) => t.status === "reconciled");
    if (reconciled.length > 0) {
      throw new HttpProblem(
        409,
        "cascade-blocked-reconciled",
        "Cannot cascade-delete: linked transaction is reconciled",
        `Document ${documentId} is linked to ${reconciled.length} reconciled transaction(s). Unreconcile first, then retry.`,
        { document_id: documentId, reconciled_transaction_ids: reconciled.map((r) => r.id) },
      );
    }

    const txnsSoftDeleted: string[] = [];
    const txnsHardDeleted: string[] = [];
    const txnsSkipped: string[] = [];

    if (hard) {
      // Unlink first (FK cascade would also do it, but being explicit
      // makes the audit trail readable: the unlinks happen, then the
      // txns vanish).
      const linkCount = linkedTxns.length;
      if (linkCount > 0) {
        await tx
          .delete(documentLinks)
          .where(eq(documentLinks.documentId, documentId));
      }
      // Hard delete all linked txns. Postings + remaining links cascade.
      for (const t of linkedTxns) {
        await tx.insert(transactionEvents).values({
          id: newId(),
          workspaceId,
          transactionId: t.id,
          eventType: "hard_deleted",
          actorId: userId,
          payload: {
            reason: "cascade_delete_document",
            document_id: documentId,
            prior_status: t.status,
          },
        });
        await tx.delete(transactions).where(eq(transactions.id, t.id));
        txnsHardDeleted.push(t.id);
      }
      // Hard delete the doc.
      await tx.delete(documents).where(eq(documents.id, documentId));
      pendingFileUnlink = doc.filePath;

      return {
        unlinked: linkCount,
        txns_soft_deleted: txnsSoftDeleted,
        txns_hard_deleted: txnsHardDeleted,
        txns_skipped: txnsSkipped,
      };
    }

    // Soft mode.
    for (const t of linkedTxns) {
      if (t.deletedAt) {
        // Already removed. Leave alone; link survives as historical record.
        txnsSkipped.push(t.id);
      } else if (t.status === "draft" || t.status === "error") {
        await tx.insert(transactionEvents).values({
          id: newId(),
          workspaceId,
          transactionId: t.id,
          eventType: "hard_deleted",
          actorId: userId,
          payload: {
            reason: "cascade_soft_delete_document",
            document_id: documentId,
            prior_status: t.status,
          },
        });
        await tx.delete(transactions).where(eq(transactions.id, t.id));
        txnsHardDeleted.push(t.id);
      } else {
        // posted (reconciled short-circuited above) → soft-delete the
        // transaction: it stays restorable but drops out of money queries.
        await tx
          .update(transactions)
          .set({ deletedAt: new Date() })
          .where(eq(transactions.id, t.id));
        await tx.insert(transactionEvents).values({
          id: newId(),
          workspaceId,
          transactionId: t.id,
          eventType: "deleted",
          actorId: userId,
          payload: {
            reason: `cascade_soft_delete_document:${documentId}`,
            prior_status: t.status,
          },
        });
        txnsSoftDeleted.push(t.id);
      }
    }

    // Soft-delete the doc itself (idempotent).
    if (!doc.deletedAt) {
      await tx
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, documentId));
    }

    return {
      unlinked: 0,
      txns_soft_deleted: txnsSoftDeleted,
      txns_hard_deleted: txnsHardDeleted,
      txns_skipped: txnsSkipped,
    };
  });

  if (pendingFileUnlink) {
    await quarantineFile(resolveUploadPath(pendingFileUnlink));
  }

  return { ...report, hardDeletedFilePath: pendingFileUnlink };
}

// ── Source text for re-extract (#167) ──────────────────────────────────

/**
 * Tags whose CONTENT is never receipt data — dropped wholesale rather
 * than reduced to their text.
 */
const TEXT_EXTRACT_DROP = [
  "script",
  "style",
  "head",
  "noscript",
  "title",
  "textarea",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/**
 * `String.fromCodePoint` with the guard the call sites actually need.
 *
 * `Number.isFinite` is the WRONG test here: `fromCodePoint` throws a
 * RangeError for anything outside U+0000–U+10FFFF, and a finite
 * `99999999` sails past `isFinite` straight into that throw. The failure
 * is silent and total, not local — `decodeEntities` runs inside
 * `htmlToPlainText`, whose only caller (`extractSourceText`) is wrapped
 * in a try/catch that merely logs, so ONE malformed entity anywhere in a
 * receipt email discards the ENTIRE document's source text and
 * re-extract then runs with no body at all.
 *
 * The range check is the WHOLE guard — do NOT also reject surrogates
 * (U+D800–U+DFFF). `fromCodePoint` accepts them without throwing, and
 * Outlook/Exchange and anything built on `charCodeAt()` spell an astral
 * character as a surrogate PAIR of entities (`&#xD83D;&#xDE00;`, or the
 * decimal `&#55357;&#56832;`), which is routine in emoji-bearing order
 * confirmations. Each half decodes to one code unit and the two
 * concatenate back into a well-formed 😀; a per-entity guard cannot see
 * the pairing, so rejecting surrogates kills both halves and leaves the
 * raw entities in the text.
 */
function fromCodePointOrNull(cp: number): string | null {
  if (!Number.isInteger(cp)) return null;
  if (cp < 0 || cp > 0x10ffff) return null;
  return String.fromCodePoint(cp);
}

function decodeEntities(s: string): string {
  // `#[xX]` in BOTH the regex and the prefix test: the old pattern only
  // admitted a lowercase `x`, so `&#X41;` never even matched and the
  // `startsWith("#X")` branch below it was dead code. HTML numeric
  // character references are case-insensitive on the `x`.
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return fromCodePointOrNull(Number.parseInt(body.slice(2), 16)) ?? whole;
    }
    if (body.startsWith("#")) {
      return fromCodePointOrNull(Number.parseInt(body.slice(1), 10)) ?? whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Linearize HTML into receipt-shaped plain text.
 *
 * Table structure is load-bearing, not cosmetic: Square and Toast lay
 * their item lists out as `<table>`, so a naive tag-strip collapses
 * "Uni  $12.00" into a column of orphaned words and the agent loses the
 * name↔price pairing. Cells are joined on ONE line; rows and block
 * elements each start a new one.
 *
 * Built on `sanitize-html` (already a dependency) rather than adding
 * `html-to-text`: sanitize-html does the genuinely hard part — parsing
 * malformed real-world email markup and dropping `<script>` / `<style>`
 * bodies and comments — so the pass below only ever sees well-formed,
 * attribute-free tags.
 */
export function htmlToPlainText(html: string): string {
  const safe = sanitizeHtml(html, {
    allowedTags: [
      "p", "div", "br", "table", "thead", "tbody", "tfoot", "tr", "td",
      "th", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "span",
      "strong", "b", "em", "i", "u", "small", "big", "a", "hr", "section",
      "article", "header", "footer", "center", "font", "blockquote", "pre",
    ],
    allowedAttributes: {},
    nonTextTags: TEXT_EXTRACT_DROP,
  });

  const linearized = safe
    // Cell boundary → a soft separator, so a "name / qty / price" row
    // survives as one readable line.
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|tr|li|h[1-6]|section|article|header|footer|center|blockquote|pre|table)>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "");

  return decodeEntities(linearized)
    .split("\n")
    // Collapse runs of spaces (but not the cell tabs) first, then turn
    // each tab into a visible two-space gutter.
    .map((line) =>
      line
        // NBSP written as an escape: a literal U+00A0 here is invisible
        // in the source and the next editor would delete it by accident.
        .replace(/\u00a0/g, " ")
        .replace(/[^\S\t]+/g, " ")
        .replace(/\t+/g, "  ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Best-effort plain text for the source file behind a document, used to
 * seed re-extract (#167).
 *
 * `parsed.text` alone is NOT sufficient, measured on real fixtures:
 * Square's Sushi Nozomi `.eml` carries a short `text/plain` stub with no
 * line items at all, and Toast's Elysee `.eml` has no `text/plain` part.
 * Both carry the full itemization — including the #162 two-level
 * modifier structure — only in `text/html`, so the HTML branch is the
 * one that matters and the longer of the two wins.
 *
 * Returns null for images and PDFs: those the agent reads itself, and a
 * bad text stand-in would be worse than none.
 */
async function extractSourceText(
  doc: { kind: DocumentKindValue | null; mimeType: string | null },
  absPath: string,
): Promise<string | null> {
  const baseMime = baseMimeType(doc.mimeType);
  const isHtml =
    baseMime === "text/html" || baseMime === "application/xhtml+xml";

  if (doc.kind === "receipt_email") {
    const parsed = await simpleParser(await readFile(absPath));
    const fromHtml =
      typeof parsed.html === "string" && parsed.html.length > 0
        ? htmlToPlainText(parsed.html)
        : "";
    const fromText = (parsed.text ?? "").trim();
    const body = fromHtml.length >= fromText.length ? fromHtml : fromText;
    const headers = [
      parsed.from?.text ? `From: ${parsed.from.text}` : null,
      parsed.subject ? `Subject: ${parsed.subject}` : null,
      parsed.date ? `Date (envelope): ${parsed.date.toISOString()}` : null,
    ].filter((l): l is string => l !== null);
    const joined = [headers.join("\n"), body].filter(Boolean).join("\n\n");
    return joined.length > 0 ? joined : null;
  }

  if (isHtml) {
    const text = htmlToPlainText((await readFile(absPath)).toString("utf8"));
    return text.length > 0 ? text : null;
  }

  return null;
}

/**
 * Tail guard on the decoded source inlined into the re-extract prompt (#198).
 *
 * 65,536 B is 3.3x the p99 of the live corpus (19,875 B) and 1.24x the largest
 * real document (Home Depot, 52,852 B), so it fires on approximately nothing
 * today and exists for the document that has not arrived yet.
 *
 * Pre-#195 an uncapped body was a crash: prompt on argv, 131,071 B ceiling.
 * The Home Depot order confirmation already cleared it — 52,852 B decoded,
 * 135,546 B of total prompt — and never fired only because that document
 * happened to have zero re-extract runs. Now the prompt travels on stdin, so
 * the failure mode changed from a loud E2BIG into a silent one: a 50 KB
 * marketing footer diluting the extraction context and inflating the bill.
 *
 * Head AND tail, never head-only. Retailer order confirmations — exactly the
 * risk class here, Home Depot / Groupon / Robinhood — print the total and the
 * payment method in the footer. Truncating from the front alone would drop the
 * two fields the extraction most needs while looking like it worked.
 *
 * Caps the DECODED text, never the raw file size, which is not merely a weak
 * predictor but anti-correlated: the largest HTML document on disk (3,214,335 B)
 * decodes to 1,837 B, while the breaker decodes from 121,986 to 52,852.
 */
const REEXTRACT_SOURCE_CAP_BYTES = 65_536;
const REEXTRACT_SOURCE_HEAD_BYTES = 49_152;
const REEXTRACT_SOURCE_TAIL_BYTES = 8_192;

export function capSourceText(
  text: string | null,
  documentId: string,
): string | null {
  if (text === null) return null;
  const size = Buffer.byteLength(text, "utf8");
  if (size <= REEXTRACT_SOURCE_CAP_BYTES) return text;

  const buf = Buffer.from(text, "utf8");
  const head = buf.subarray(0, REEXTRACT_SOURCE_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - REEXTRACT_SOURCE_TAIL_BYTES).toString("utf8");
  const elided = size - REEXTRACT_SOURCE_HEAD_BYTES - REEXTRACT_SOURCE_TAIL_BYTES;

  // Loud on purpose. An unannounced truncation is precisely the silent
  // degradation this guard exists to prevent, so it must never be the thing
  // that becomes invisible.
  console.warn(
    `[re-extract] doc=${documentId} decoded source ${size} B exceeds ` +
      `${REEXTRACT_SOURCE_CAP_BYTES} B cap — kept head ${REEXTRACT_SOURCE_HEAD_BYTES} B ` +
      `+ tail ${REEXTRACT_SOURCE_TAIL_BYTES} B, elided ${elided} B`,
  );
  return `${head}\n\n[… ${elided} bytes elided by the ${REEXTRACT_SOURCE_CAP_BYTES} B source cap; head and tail kept …]\n\n${tail}`;
}

// ── Re-extract (Phase 4c of #80 / #91) ─────────────────────────────────

/**
 * What the run actually did (#167).
 *
 * The old signal — "did `re_extracted_at` advance?" — was structurally
 * blind: that column only moves as a side effect of the agent's own psql
 * block, so a run that wrote NOTHING was indistinguishable from a
 * successful one, and the frontend rendered "No changes — the agent
 * produced the same output." That string is exactly what made #167
 * invisible for weeks. Key future batch tooling on `outcome`, never on a
 * timestamp.
 */
export type ReExtractOutcome = "written" | "no_change" | "agent_error";

export interface ReExtractDocumentResult {
  document_id: string;
  transaction_id: string;
  derivation_event_id: string;
  changed_keys: string[];
  /** Convenience flag so the caller can tell "OCR text actually changed"
   *  from "only metadata.extraction was stamped." */
  ocr_text_changed: boolean;
  /** Re-extract is observability-first; carry the session id so the
   *  operator can pull the Langfuse trace without a join. */
  session_id: string;
  /** `written` when the agent's psql block moved something, `no_change`
   *  when it demonstrably wrote nothing. `agent_error` is part of the
   *  vocabulary but never reaches a 200 — it surfaces as a 422. */
  outcome: ReExtractOutcome;
}

/**
 * Re-OCR an already-ingested receipt and UPDATE the linked transaction
 * in place. Layer-3 shielded — see `src/projection/layer3.ts`.
 *
 * Contract:
 *   - Resolves the linked transaction via `document_links`. If the
 *     document has zero links or more than one, returns null (404) or
 *     422 respectively — re-extract is per-tx and we don't pick.
 *   - Snapshots Layer-2 tx fields BEFORE spawning the agent. The agent
 *     writes the UPDATE itself (Layer-3 CASE shielding lives in the
 *     prompt). After the agent returns we snapshot again, diff, and
 *     INSERT a `derivation_events` row with `entity_type='document'`
 *     so the audit trail is unified with re-derive (#89).
 *   - Soft-deleted documents are rejected (404).
 *   - Out-of-scope: postings, place_id, merchant_id, document_links.
 *     See `src/ingest/reextract-prompt.ts` header for why.
 *
 * Returns null when the document is missing or soft-deleted.
 * Throws a `MultipleLinksProblem` (422) when the document links to
 * more than one transaction.
 */
export async function reExtractDocument(
  workspaceId: string,
  userId: string,
  documentId: string,
  options: { reExtractor?: ReExtractor; transactionId?: string } = {},
): Promise<ReExtractDocumentResult | null> {
  const reExtractor = options.reExtractor ?? defaultClaudeReExtractor;

  // 1) Resolve the document + linked transaction.
  const docRows = await db
    .select({
      id: documents.id,
      workspaceId: documents.workspaceId,
      kind: documents.kind,
      mimeType: documents.mimeType,
      filePath: documents.filePath,
      ocrText: documents.ocrText,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.workspaceId, workspaceId),
      ),
    );
  if (docRows.length === 0) return null;
  const doc = docRows[0]!;
  if (doc.deletedAt) return null;
  if (!doc.filePath) {
    throw new HttpProblem(
      422,
      "document-no-file-path",
      "Re-extract requires the original file",
      "Document has no file_path on disk; re-extract has nothing to read.",
      { document_id: documentId },
    );
  }

  // 1b) Preflight the file BEFORE spending a 15-minute `claude -p` round
  //     trip (#167). 95 of 1600 live `file_path` values did not resolve;
  //     every one of them used to burn a full agent run and come back as
  //     a misleading `200 {}` with empty `changed_keys`, which reads as
  //     "the agent produced the same output" rather than "there was no
  //     file". Same `stat` guard `renderDocumentHtml` already uses.
  const absPath = resolveUploadPath(doc.filePath);
  try {
    await stat(absPath);
  } catch {
    throw new HttpProblem(
      422,
      "document-file-missing",
      "Source file is missing on disk",
      `Document ${documentId} points at ${doc.filePath}, which does not resolve to a readable file. Re-extract has nothing to read; restore the file before retrying.`,
      { document_id: documentId, file_path: doc.filePath },
    );
  }

  const linkRows = await db
    .select({ transactionId: documentLinks.transactionId })
    .from(documentLinks)
    .where(eq(documentLinks.documentId, documentId));
  if (linkRows.length === 0) {
    throw new HttpProblem(
      422,
      "document-no-transaction",
      "Document not linked to a transaction",
      "Re-extract operates per-transaction; this document has zero linked transactions.",
      { document_id: documentId },
    );
  }
  let transactionId: string;
  if (linkRows.length === 1) {
    transactionId = linkRows[0]!.transactionId;
  } else if (
    options.transactionId &&
    linkRows.some((r) => r.transactionId === options.transactionId)
  ) {
    // Multi-link documents are no longer a dead end (#167): the caller
    // names which transaction to re-derive via `?transaction_id=`.
    transactionId = options.transactionId;
  } else {
    throw new HttpProblem(
      422,
      "document-multiple-transactions",
      "Document linked to multiple transactions",
      "Re-extract operates per-transaction and will not pick for you; pass ?transaction_id=<uuid> naming one of the linked transactions.",
      {
        document_id: documentId,
        transaction_ids: linkRows.map((r) => r.transactionId),
      },
    );
  }

  // 2) Snapshot BEFORE — projection-domain tx fields only. Layer-3
  //    fields are excluded from the diff because re-extract can't
  //    change them anyway; including them would clutter `changed_keys`.
  const beforeSnapshot = await snapshotReExtractFields(transactionId, doc.id);

  // 2b) Give an email / HTML document a TEXT source (#167). The agent
  //     can open an image or a PDF itself, but an `.eml` body is
  //     MIME-encoded and its itemization usually lives only in the
  //     `text/html` part. Inlining the decoded text into the prompt is
  //     what makes re-extract produce anything at all on these.
  //     Deliberately NOT written to `documents.ocr_text` first: the
  //     agent has no `SELECT ocr_text` instruction, and its own psql
  //     block overwrites that column at the end of the run anyway.
  let sourceText: string | null = null;
  try {
    sourceText = capSourceText(await extractSourceText(doc, absPath), documentId);
  } catch (err) {
    console.warn(
      `[re-extract] doc=${documentId} source-text extraction failed: ${(err as Error).message}`,
    );
  }

  // 3) Spawn the agent. Errors here bubble to the route handler;
  //    nothing has been written yet so the DB state is untouched.
  const { sessionId, stdout } = await reExtractor({
    // The agent needs a container-absolute path it can open (#128).
    filePath: absPath,
    workspaceId,
    documentId,
    transactionId,
    userId,
    ocrText: sourceText,
  });

  // 3c) The prompt's own contract: on an unreadable source the agent
  //     writes NOTHING and prints `ERROR <reason>`. Honour it before
  //     inserting a `derivation_events` row — that row asserts a
  //     derivation ran, and writing one for a run that refused is a
  //     false audit record.
  const lastLine =
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop() ?? "";
  if (/^ERROR\b/.test(lastLine)) {
    throw new HttpProblem(
      422,
      "re-extract-agent-error",
      "The extraction agent could not read this document",
      lastLine.replace(/^ERROR\s*/, "") || "Agent reported an error.",
      {
        document_id: documentId,
        transaction_id: transactionId,
        session_id: sessionId,
      },
    );
  }

  // 3b) Ship the session transcript to Langfuse (#181). Fire-and-forget
  //     — `trackLangfuse` never throws and never blocks the response.
  //     Without this, re-extract produced ZERO traces (every trace on
  //     the box came from ingest), so there was no way to measure token
  //     burn or turn count on the path the re-extract campaign uses.
  trackLangfuse(sessionId, [documentId, transactionId, "re-extract"]);

  // 4) Snapshot AFTER. Agent has now UPDATEd transactions + documents.
  const afterSnapshot = await snapshotReExtractFields(transactionId, doc.id);

  // 5) Compute diff and write derivation_events. We do this in TS
  //    (not the prompt) so the audit row reflects ground truth after
  //    the agent's writes have committed, not the agent's intent.
  const changedKeys: string[] = [];
  const beforeAny = beforeSnapshot as unknown as Record<string, unknown>;
  const afterAny = afterSnapshot as unknown as Record<string, unknown>;
  for (const k of Object.keys(beforeAny)) {
    if (!reExtractFieldEq(beforeAny[k], afterAny[k])) changedKeys.push(k);
  }

  const [evt] = await db
    .insert(derivationEvents)
    .values({
      workspaceId,
      entityType: "document",
      entityId: documentId,
      promptVersion: PROMPT_VERSION,
      promptGitSha: buildInfo.gitSha,
      model: EXTRACTION_MODEL,
      ranAt: new Date(),
      before: beforeSnapshot as unknown as Record<string, unknown>,
      after: afterSnapshot as unknown as Record<string, unknown>,
      // (`as unknown as` so TS accepts the cast across the
      // ReExtractSnapshot → Record<string, unknown> jump.)
      changedKeys,
    })
    .returning({ id: derivationEvents.id });

  // Surface stdout to console so operators can grep DONE/ERROR lines.
  if (stdout && stdout.trim().length > 0) {
    console.info(`[re-extract] doc=${documentId} tx=${transactionId} ${stdout.trim().split("\n").pop()}`);
  }

  return {
    document_id: documentId,
    transaction_id: transactionId,
    derivation_event_id: evt!.id,
    changed_keys: changedKeys,
    ocr_text_changed: !reExtractFieldEq(
      beforeSnapshot.ocr_text,
      afterSnapshot.ocr_text,
    ),
    session_id: sessionId,
    // The agent's metadata UPDATE always rewrites `extraction.ran_at`
    // with NOW(), so `metadata_extraction` is present whenever the psql
    // block ran at all. An EMPTY `changed_keys` therefore means the
    // agent wrote nothing — a no-op, not a confirmation that the output
    // was identical. Production corroborates: 118 of 122
    // `derivation_events` contain the key; the 4 empties are exactly the
    // #167 no-ops.
    outcome: changedKeys.length > 0 ? "written" : "no_change",
  };
}

interface ReExtractSnapshot {
  payee: string | null;
  occurred_on: string | null;
  occurred_at: string | null;
  metadata_extraction: unknown;
  ocr_text: string | null;
  ocr_model_version: string | null;
}

async function snapshotReExtractFields(
  transactionId: string,
  documentId: string,
): Promise<ReExtractSnapshot> {
  const tx = await db
    .select({
      payee: transactions.payee,
      occurredOn: transactions.occurredOn,
      occurredAt: transactions.occurredAt,
      metadata: transactions.metadata,
    })
    .from(transactions)
    .where(eq(transactions.id, transactionId));

  const doc = await db
    .select({
      ocrText: documents.ocrText,
      ocrModelVersion: documents.ocrModelVersion,
    })
    .from(documents)
    .where(eq(documents.id, documentId));

  const t = tx[0]!;
  const d = doc[0]!;
  const meta = (t.metadata as Record<string, unknown> | null) ?? {};

  return {
    payee: t.payee,
    occurred_on: t.occurredOn,
    occurred_at:
      t.occurredAt instanceof Date ? t.occurredAt.toISOString() : null,
    metadata_extraction: meta.extraction ?? null,
    ocr_text: d.ocrText,
    ocr_model_version: d.ocrModelVersion,
  };
}

function reExtractFieldEq(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}
