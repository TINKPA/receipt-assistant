/**
 * `/v1/documents` — multipart upload + content serve + link management.
 *
 * Endpoints:
 *   POST   /v1/documents                 — multipart upload (sha256 dedup)
 *   GET    /v1/documents/:id             — metadata + ETag/If-None-Match
 *   GET    /v1/documents/:id/content     — binary stream
 *   POST   /v1/documents/:id/links       — link to a transaction
 *   DELETE /v1/documents/:id/links/:txn  — unlink
 *   DELETE /v1/documents/:id             — hard delete (409 if linked)
 *
 * Idempotency here is intentionally *not* driven by the
 * `Idempotency-Key` header — sha256 of the file bytes is the natural
 * idempotency token. Re-uploading identical bytes returns the existing
 * row with 200 OK, not 201.
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
  deleteDocument,
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

documentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const doc = await getDocumentById(req.ctx.workspaceId, id);
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

documentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdOnlyParams, req.params);
    const removed = await deleteDocument({
      workspaceId: req.ctx.workspaceId,
      documentId: id,
    });
    if (!removed) throw new NotFoundProblem("Document", id);
    res.status(204).end();
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
    request: { params: z.object({ id: Uuid }) },
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
    summary: "Hard-delete a document (only if it has no links)",
    tags: ["documents"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not found", content: problemContent },
      409: {
        description: "Document has links — unlink first",
        content: problemContent,
      },
    },
  });
}
