/**
 * `/v1/documents` — multipart upload + content serve + link management.
 *
 * Endpoints:
 *   POST   /v1/documents                 — multipart upload (sha256 dedup)
 *   GET    /v1/documents/:id             — metadata + ETag/If-None-Match
 *   GET    /v1/documents/:id/content     — binary stream
 *   POST   /v1/documents/:id/links       — link to a transaction
 *   DELETE /v1/documents/:id/links/:txn  — unlink
 *   DELETE /v1/documents/:id             — soft delete (default), or
 *                                          ?hard=true (row + file moved
 *                                          to .trash/) / ?cascade=true
 *                                          (also handle linked txns;
 *                                          combine with ?hard=true for
 *                                          full purge — file still goes
 *                                          to .trash/, never unlinked)
 *   POST   /v1/documents/:id/restore     — clear deleted_at
 *
 * Idempotency here is intentionally *not* driven by the
 * `Idempotency-Key` header — sha256 of the file bytes is the natural
 * idempotency token. Re-uploading identical bytes returns the existing
 * row with 200 OK, not 201. Re-uploading bytes whose row is currently
 * soft-deleted resurrects the row (clears deleted_at).
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import * as path from "path";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  Document,
  DocumentKind,
  CreateDocumentLinkRequest,
  UploadDocumentForm,
  ReExtractDocumentResponse,
} from "../schemas/v1/document.js";
import { ProblemDetails, Uuid } from "../schemas/v1/common.js";
import { NotFoundProblem } from "../http/problem.js";
import { setEtag, handleIfNoneMatch } from "../http/etag.js";
import { parseOrThrow } from "../http/validate.js";
import {
  getDocumentById,
  uploadDocumentBytes,
  linkDocumentToTransaction,
  unlinkDocumentFromTransaction,
  softDeleteDocument,
  hardDeleteDocument,
  restoreDocument,
  cascadeDeleteDocument,
  reExtractDocument,
  extForMime,
  type DocumentKindValue,
} from "./documents.service.js";

export const documentsRouter: Router = Router();

// Multer with memory storage so we can sha256 the bytes *before*
// committing them to disk — critical for the dedup contract.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

/**
 * Documents don't carry a `version` column in the schema, so ETag is
 * derived from a synthetic value: `1` for "freshly-materialized
 * immutable metadata". This matches the pattern in issue #28 — the
 * caller just wants a stable token for If-None-Match caching.
 */
const DOC_VERSION = 1;

// ── Helpers ────────────────────────────────────────────────────────────

function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

const IdOnlyParams = z.object({ id: Uuid });
const LinkParams = z.object({ id: Uuid, txn_id: Uuid });

// ── POST /v1/documents ─────────────────────────────────────────────────

documentsRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      // Explicit 422 to match the rest of the surface — missing field
      // is a validation issue, not a generic 400.
      throw new (await import("../http/problem.js")).ValidationProblem([
        { path: "file", code: "required", message: "multipart field `file` is required" },
      ]);
    }

    const rawKind = (req.body?.kind as string | undefined) ?? "other";
    const kind = parseOrThrow(DocumentKind, rawKind) as DocumentKindValue;

    const { doc, created } = await uploadDocumentBytes({
      workspaceId: req.ctx.workspaceId,
      bytes: file.buffer,
      mimeType: file.mimetype ?? null,
      kind,
    });

    setEtag(res, DOC_VERSION);
    if (created) {
      res.setHeader("Location", `/v1/documents/${doc.id}`);
      res.status(201).json(doc);
    } else {
      // Dedup hit — same bytes, same row, 200 OK.
      res.status(200).json(doc);
    }
  }),
);

// ── GET /v1/documents/:id ──────────────────────────────────────────────

const IncludeDeletedQuery = z.object({
  include_deleted: z
    .union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")])
    .optional(),
});

function parseIncludeDeleted(q: unknown): boolean {
  const parsed = IncludeDeletedQuery.safeParse(q);
  if (!parsed.success) return false;
  const v = parsed.data.include_deleted;
  return v === "true" || v === "1";
}

documentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const includeDeleted = parseIncludeDeleted(req.query);
    const doc = await getDocumentById(req.ctx.workspaceId, id, { includeDeleted });
    if (!doc) throw new NotFoundProblem("Document", id);

    if (handleIfNoneMatch(req, res, DOC_VERSION)) return;
    setEtag(res, DOC_VERSION);
    res.json(doc);
  }),
);

// ── GET /v1/documents/:id/content ──────────────────────────────────────

documentsRouter.get(
  "/:id/content",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const doc = await getDocumentById(req.ctx.workspaceId, id);
    if (!doc) throw new NotFoundProblem("Document", id);
    if (!doc.file_path) throw new NotFoundProblem("Document content", id);

    try {
      await stat(doc.file_path);
    } catch {
      throw new NotFoundProblem("Document content", id);
    }

    const ext = extForMime(doc.mime_type) ?? path.extname(doc.file_path).replace(/^\./, "");
    const filename = ext ? `${doc.id}.${ext}` : doc.id;
    res.setHeader(
      "Content-Type",
      doc.mime_type ?? "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename}"`,
    );
    setEtag(res, DOC_VERSION);
    createReadStream(doc.file_path).pipe(res);
  }),
);

// ── POST /v1/documents/:id/links ───────────────────────────────────────

documentsRouter.post(
  "/:id/links",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const body = parseOrThrow(CreateDocumentLinkRequest, req.body ?? {});

    await linkDocumentToTransaction({
      workspaceId: req.ctx.workspaceId,
      documentId: id,
      transactionId: body.transaction_id,
    });

    res.status(204).end();
  }),
);

// ── DELETE /v1/documents/:id/links/:txn_id ─────────────────────────────

documentsRouter.delete(
  "/:id/links/:txn_id",
  asyncHandler(async (req, res) => {
    const { id, txn_id } = parseOrThrow(LinkParams, req.params);
    const removed = await unlinkDocumentFromTransaction({
      workspaceId: req.ctx.workspaceId,
      documentId: id,
      transactionId: txn_id,
    });
    if (!removed) {
      throw new NotFoundProblem("DocumentLink", `${id}→${txn_id}`);
    }
    res.status(204).end();
  }),
);

// ── DELETE /v1/documents/:id ───────────────────────────────────────────
//
// Default: soft delete. Optional flags:
//   ?hard=true               — actually remove row + image file
//   ?cascade=true            — also handle linked transactions
//   ?cascade=true&hard=true  — full purge (txns + links + doc + file)

const DeleteQuery = z.object({
  hard: z.union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")]).optional(),
  cascade: z.union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")]).optional(),
});

function flagTrue(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

documentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const q = parseOrThrow(DeleteQuery, req.query);
    const hard = flagTrue(q.hard);
    const cascade = flagTrue(q.cascade);

    if (cascade) {
      await cascadeDeleteDocument({
        workspaceId: req.ctx.workspaceId,
        userId: req.ctx.userId,
        documentId: id,
        hard,
      });
      res.status(204).end();
      return;
    }

    if (hard) {
      const removed = await hardDeleteDocument({
        workspaceId: req.ctx.workspaceId,
        documentId: id,
      });
      if (!removed) throw new NotFoundProblem("Document", id);
      res.status(204).end();
      return;
    }

    const ok = await softDeleteDocument({
      workspaceId: req.ctx.workspaceId,
      documentId: id,
    });
    if (!ok) throw new NotFoundProblem("Document", id);
    res.status(204).end();
  }),
);

// ── POST /v1/documents/:id/restore ─────────────────────────────────────

documentsRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const doc = await restoreDocument({
      workspaceId: req.ctx.workspaceId,
      documentId: id,
    });
    if (!doc) throw new NotFoundProblem("Document", id);
    setEtag(res, DOC_VERSION);
    res.json(doc);
  }),
);

// ── POST /v1/documents/:id/re-extract ──────────────────────────────────

documentsRouter.post(
  "/:id/re-extract",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const out = await reExtractDocument(
      req.ctx.workspaceId,
      req.ctx.userId,
      id,
    );
    if (!out) throw new NotFoundProblem("Document", id);
    res.json(out);
  }),
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerDocumentsOpenApi(registry: OpenAPIRegistry): void {
  // Ensure component schemas are registered (idempotent — registry
  // deduplicates by z.ZodType identity, which is stable across calls).
  registry.register("Document", Document);
  registry.register("DocumentKind", DocumentKind);
  registry.register("UploadDocumentForm", UploadDocumentForm);
  registry.register("CreateDocumentLinkRequest", CreateDocumentLinkRequest);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "post",
    path: "/v1/documents",
    summary: "Upload a document (multipart, sha256 content-dedup)",
    tags: ["documents"],
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": { schema: UploadDocumentForm },
        },
      },
    },
    responses: {
      200: {
        description:
          "Duplicate upload detected — returns the existing document row",
        content: { "application/json": { schema: Document } },
      },
      201: {
        description: "Document created",
        headers: {
          Location: { schema: { type: "string" } },
          ETag: { schema: { type: "string" } },
        },
        content: { "application/json": { schema: Document } },
      },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/documents/{id}",
    summary: "Get document metadata",
    tags: ["documents"],
    request: {
      params: z.object({ id: Uuid }),
      query: z.object({
        include_deleted: z
          .enum(["true", "false", "1", "0"])
          .optional()
          .openapi({
            description:
              "Include soft-deleted documents in the response. Default false.",
          }),
      }),
    },
    responses: {
      200: {
        description: "Document",
        headers: { ETag: { schema: { type: "string" } } },
        content: { "application/json": { schema: Document } },
      },
      304: { description: "Not modified (If-None-Match matched)" },
      404: { description: "Not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/documents/{id}/content",
    summary: "Stream document binary content",
    tags: ["documents"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Raw file bytes",
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      404: { description: "Not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/documents/{id}/links",
    summary: "Link a document to a transaction (idempotent)",
    tags: ["documents"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        required: true,
        content: { "application/json": { schema: CreateDocumentLinkRequest } },
      },
    },
    responses: {
      204: { description: "Linked (or already linked — idempotent)" },
      404: {
        description: "Document or transaction not found",
        content: problemContent,
      },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/documents/{id}/links/{txn_id}",
    summary: "Unlink a document from a transaction",
    tags: ["documents"],
    request: {
      params: z.object({ id: Uuid, txn_id: Uuid }),
    },
    responses: {
      204: { description: "Unlinked" },
      404: { description: "Link not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/documents/{id}",
    summary:
      "Delete a document. Soft-deletes by default; ?hard=true removes the row and quarantines the file under .trash/; ?cascade=true also handles linked transactions.",
    description:
      "Default: soft delete (sets deleted_at). " +
      "?hard=true: hard delete (row removed; file moved to <uploads_dir>/.trash/<timestamp>__<basename>, NOT unlinked); requires no remaining links unless ?cascade=true is also set. " +
      "?cascade=true: linked posted transactions are voided, draft/error transactions are hard-deleted, voided transactions are left intact, reconciled transactions abort the operation with 409. " +
      "?cascade=true&hard=true: every linked transaction is hard-deleted (postings cascade), the document row is removed, and the image file is moved to .trash/ (never unlinked). " +
      "Reconciled transactions always block hard cascades — unreconcile first.",
    tags: ["documents"],
    request: {
      params: z.object({ id: Uuid }),
      query: z.object({
        hard: z.enum(["true", "false", "1", "0"]).optional().openapi({
          description:
            "Hard-delete the row and quarantine the on-disk image into <uploads_dir>/.trash/. " +
            "The image is moved, not unlinked — recoverable by hand. Default false.",
        }),
        cascade: z.enum(["true", "false", "1", "0"]).optional().openapi({
          description:
            "Also process transactions linked to this document. Combine with hard=true for full purge.",
        }),
      }),
    },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not found", content: problemContent },
      409: {
        description:
          "Hard delete refused because document has links (use cascade), or cascade refused because a linked transaction is reconciled.",
        content: problemContent,
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/documents/{id}/restore",
    summary: "Restore a soft-deleted document",
    tags: ["documents"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Restored",
        content: { "application/json": { schema: Document } },
      },
      404: {
        description: "Document not found or not deleted",
        content: problemContent,
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/documents/{id}/re-extract",
    summary: "Re-OCR the receipt and UPDATE the linked transaction in place.",
    description:
      "Phase 4c of the 3-layer rollout (#80 / #91). Spawns `claude -p` " +
      "with a narrow re-extract prompt; the agent reads the cached " +
      "image bytes and refreshes `transactions.{payee, occurred_on, " +
      "occurred_at, metadata.extraction}` plus `documents.{ocr_text, " +
      "ocr_model_version}`. **Out of scope**: postings, place_id, " +
      "merchant_id, document_links — those have their own paths. " +
      "**Layer-3 shielded**: HARD fields (status, narration, trip_id, " +
      "identity columns) never touched; SOFT fields (occurred_on, " +
      "occurred_at, payee) protected by `metadata.user_edited.<field>` " +
      "CASE expressions, so user PATCH overrides survive. " +
      "Returns 422 if the document has zero or >1 linked transactions.",
    tags: ["documents"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Re-extract committed",
        content: { "application/json": { schema: ReExtractDocumentResponse } },
      },
      404: {
        description: "Document not found or soft-deleted",
        content: problemContent,
      },
      422: {
        description:
          "Document not linked to exactly one transaction, or has no file_path",
        content: problemContent,
      },
    },
  });
}
