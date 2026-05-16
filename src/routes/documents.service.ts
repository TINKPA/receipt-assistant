/**
 * Document service — internal helpers behind the HTTP handlers.
 *
 * Business rules: sha256-based content dedup per workspace, disk write
 * under `UPLOAD_DIR`, insert into `documents`, etc.
 */
import { createHash } from "crypto";
import { mkdir, writeFile, rename } from "fs/promises";
import * as path from "path";
import { and, eq, sql, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { documents, documentLinks } from "../schema/documents.js";
import { transactions, postings, transactionEvents } from "../schema/index.js";
import { derivationEvents } from "../schema/derivation_events.js";
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
  REEXTRACT_PROMPT_VERSION,
  REEXTRACT_MODEL,
} from "../ingest/reextract-prompt.js";
import { buildInfo } from "../generated/build-info.js";

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
  ocrModelVersion: string | null;
  extractionMeta: unknown;
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

  if (filePath) await quarantineFile(filePath);
  return true;
}

interface CascadeReport {
  unlinked: number;
  txns_voided: string[];
  txns_hard_deleted: string[];
  txns_skipped_voided: string[];
}

/**
 * One-call "delete this whole receipt" orchestration.
 *
 * Soft mode (default): linked posted txns → voided; linked draft/error
 * txns → hard-deleted (no audit value); linked already-voided txns →
 * left alone, link kept for history; document → soft-deleted.
 *
 * Hard mode (`hard=true`): all linked txns are hard-deleted (postings
 * cascade via FK; void mirrors are NOT chased — orphan mirrors become
 * the user's problem, matching "user takes responsibility"); document
 * → hard-deleted (row + image file).
 *
 * Both modes refuse if any linked txn is `reconciled`: 409, no writes.
 * Caller must unreconcile first.
 *
 * Everything happens in a single DB transaction — the file unlink
 * (hard mode) runs after commit.
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
        voidedById: transactions.voidedById,
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

    const txnsVoided: string[] = [];
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
        txns_voided: txnsVoided,
        txns_hard_deleted: txnsHardDeleted,
        txns_skipped_voided: txnsSkipped,
      };
    }

    // Soft mode.
    for (const t of linkedTxns) {
      if (t.status === "draft" || t.status === "error") {
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
      } else if (t.status === "posted") {
        await voidTransactionInTx(tx, {
          workspaceId,
          userId,
          txId: t.id,
          expectedVersion: Number(t.version),
          reason: `cascade_soft_delete_document:${documentId}`,
        });
        txnsVoided.push(t.id);
      } else if (t.status === "voided") {
        // Leave alone. Link survives as historical record.
        txnsSkipped.push(t.id);
      }
      // 'reconciled' already short-circuited above.
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
      txns_voided: txnsVoided,
      txns_hard_deleted: txnsHardDeleted,
      txns_skipped_voided: txnsSkipped,
    };
  });

  if (pendingFileUnlink) {
    await quarantineFile(pendingFileUnlink);
  }

  return { ...report, hardDeletedFilePath: pendingFileUnlink };
}

// Internal: void a transaction inside an existing tx scope. Mirrors
// `voidTransaction` in transactions.service.ts but without spinning a
// new outer transaction, so cascades remain atomic. Kept private to
// avoid drift — the public path stays voidTransaction.
async function voidTransactionInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    workspaceId: string;
    userId: string;
    txId: string;
    expectedVersion: number;
    reason: string;
  },
): Promise<void> {
  const { workspaceId, userId, txId, expectedVersion, reason } = args;
  const rows = await tx
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.id, txId), eq(transactions.workspaceId, workspaceId)),
    );
  if (rows.length === 0) throw new NotFoundProblem("Transaction", txId);
  const current = rows[0]!;
  if (Number(current.version) !== expectedVersion) {
    const { VersionMismatchProblem } = await import("../http/problem.js");
    throw new VersionMismatchProblem(Number(current.version), expectedVersion);
  }

  const originalPostings = await tx
    .select()
    .from(postings)
    .where(eq(postings.transactionId, txId));

  const mirrorId = newId();
  const existingMeta = (current.metadata ?? {}) as Record<string, unknown>;
  const mirrorMeta: Record<string, unknown> = {
    ...existingMeta,
    voided: txId,
    void_reason: reason,
  };

  await tx.insert(transactions).values({
    id: mirrorId,
    workspaceId,
    occurredOn: typeof current.occurredOn === "string"
      ? current.occurredOn
      : (current.occurredOn as Date).toISOString().slice(0, 10),
    occurredAt: current.occurredAt,
    payee: `VOID: ${current.payee ?? ""}`.trim(),
    narration: current.narration,
    status: "posted",
    tripId: current.tripId,
    metadata: mirrorMeta,
    createdBy: userId,
  });

  await tx.insert(postings).values(
    originalPostings.map((p) => ({
      id: newId(),
      workspaceId,
      transactionId: mirrorId,
      accountId: p.accountId,
      amountMinor: -BigInt(p.amountMinor),
      currency: p.currency,
      fxRate: p.fxRate,
      amountBaseMinor:
        p.amountBaseMinor === null ? null : -BigInt(p.amountBaseMinor),
      memo: p.memo,
    })),
  );

  await tx
    .update(transactions)
    .set({ status: "voided", voidedById: mirrorId })
    .where(eq(transactions.id, txId));

  await tx.insert(transactionEvents).values([
    {
      id: newId(),
      workspaceId,
      transactionId: txId,
      eventType: "voided",
      actorId: userId,
      payload: { voided_by: mirrorId, reason },
    },
    {
      id: newId(),
      workspaceId,
      transactionId: mirrorId,
      eventType: "created",
      actorId: userId,
      payload: { voids: txId, reason },
    },
  ]);
}

// ── Re-extract (Phase 4c of #80 / #91) ─────────────────────────────────

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
  options: { reExtractor?: ReExtractor } = {},
): Promise<ReExtractDocumentResult | null> {
  const reExtractor = options.reExtractor ?? defaultClaudeReExtractor;

  // 1) Resolve the document + linked transaction.
  const docRows = await db
    .select({
      id: documents.id,
      workspaceId: documents.workspaceId,
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
  if (linkRows.length > 1) {
    throw new HttpProblem(
      422,
      "document-multiple-transactions",
      "Document linked to multiple transactions",
      "Re-extract refuses when a document links to more than one transaction; pick a tx and use a per-tx flow.",
      {
        document_id: documentId,
        transaction_ids: linkRows.map((r) => r.transactionId),
      },
    );
  }
  const transactionId = linkRows[0]!.transactionId;

  // 2) Snapshot BEFORE — projection-domain tx fields only. Layer-3
  //    fields are excluded from the diff because re-extract can't
  //    change them anyway; including them would clutter `changed_keys`.
  const beforeSnapshot = await snapshotReExtractFields(transactionId, doc.id);

  // 3) Spawn the agent. Errors here bubble to the route handler;
  //    nothing has been written yet so the DB state is untouched.
  const { sessionId, stdout } = await reExtractor({
    filePath: doc.filePath,
    workspaceId,
    documentId,
    transactionId,
    userId,
  });

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
      promptVersion: REEXTRACT_PROMPT_VERSION,
      promptGitSha: buildInfo.gitSha,
      model: REEXTRACT_MODEL,
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
