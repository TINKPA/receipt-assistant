/**
 * `/v1/ingest/batch`, `/v1/batches`, `/v1/ingests` — Phase 1 of #32.
 *
 * Three routers, one OpenAPI registration function. Mounted from
 * `src/app.ts` separately so URL prefixes stay clean:
 *
 *   POST  /v1/ingest/batch      — multipart N-file upload (202)
 *   GET   /v1/batches           — list
 *   GET   /v1/batches/:id       — aggregated state + items
 *   GET   /v1/ingests           — list
 *   GET   /v1/ingests/:id       — single ingest row
 *
 * Reconcile, SSE, and DELETE are deferred to Phase 2.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { parseOrThrow } from "../http/validate.js";
import { ValidationProblem } from "../http/problem.js";
import { emitNextLink } from "../http/pagination.js";
import { IdParam, ProblemDetails, Uuid, paginated } from "../schemas/v1/common.js";
import {
  Batch,
  BatchSummary,
  CreateBatchForm,
  CreateBatchResponse,
  Ingest,
  ListBatchesQuery,
  ListIngestsQuery,
} from "../schemas/v1/ingest.js";
import {
  createBatchFromFiles,
  getBatch,
  getIngest,
  listBatches,
  listIngests,
} from "./ingest.service.js";

// ── Multer for multipart batch uploads ────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 },
});

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function parseAutoReconcile(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.toLowerCase();
    if (v === "false" || v === "0") return false;
    if (v === "true" || v === "1") return true;
  }
  return true;
}

// ── /v1/ingest ────────────────────────────────────────────────────────

export const ingestRouter: Router = Router();

ingestRouter.post(
  "/batch",
  // Accept multiple files under any of the common multipart conventions:
  // `file`, `files`, or `files[]`. Using `.any()` keeps the client free
  // to pick whichever its HTTP library emits.
  upload.any(),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      throw new ValidationProblem(
        [
          {
            path: "files",
            code: "required",
            message: "Attach at least one file via multipart field `file`/`files`",
          },
        ],
        "No files in multipart body",
      );
    }

    const autoReconcile = parseAutoReconcile(
      (req.body as Record<string, unknown>)?.auto_reconcile,
    );

    const { batch, items } = await createBatchFromFiles({
      workspaceId: req.ctx.workspaceId,
      files: files.map((f) => ({
        originalName: f.originalname,
        mimeType: f.mimetype ?? null,
        bytes: f.buffer,
      })),
      autoReconcile,
    });

    res.setHeader("Location", `/v1/batches/${batch.id}`);
    res.status(202).json({
      batchId: batch.id,
      status: batch.status,
      items,
      poll: `/v1/batches/${batch.id}`,
    });
  }),
);

// ── /v1/batches ───────────────────────────────────────────────────────

export const batchesRouter: Router = Router();

batchesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = parseOrThrow(ListBatchesQuery, req.query);
    const out = await listBatches({
      workspaceId: req.ctx.workspaceId,
      cursor: q.cursor,
      limit: q.limit,
      status: q.status,
    });
    emitNextLink(req, res, out.next_cursor);
    res.json(out);
  }),
);

batchesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const out = await getBatch(req.ctx.workspaceId, id);
    res.json(out);
  }),
);

// ── /v1/ingests ───────────────────────────────────────────────────────

export const ingestsRouter: Router = Router();

ingestsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = parseOrThrow(ListIngestsQuery, req.query);
    const out = await listIngests({
      workspaceId: req.ctx.workspaceId,
      cursor: q.cursor,
      limit: q.limit,
      batchId: q.batch_id,
      status: q.status,
    });
    emitNextLink(req, res, out.next_cursor);
    res.json(out);
  }),
);

ingestsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const out = await getIngest(req.ctx.workspaceId, id);
    res.json(out);
  }),
);

// ── OpenAPI registration ──────────────────────────────────────────────

export function registerIngestOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Batch", Batch);
  registry.register("BatchSummary", BatchSummary);
  registry.register("Ingest", Ingest);
  registry.register("CreateBatchForm", CreateBatchForm);
  registry.register("CreateBatchResponse", CreateBatchResponse);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "post",
    path: "/v1/ingest/batch",
    summary:
      "Upload N files for agent classification + extraction. Returns 202 with per-file ingest ids.",
    tags: ["ingest"],
    request: {
      body: {
        required: true,
        content: { "multipart/form-data": { schema: CreateBatchForm } },
      },
    },
    responses: {
      202: {
        description: "Batch accepted — poll /v1/batches/:id for results",
        headers: {
          Location: { schema: { type: "string" } },
        },
        content: {
          "application/json": { schema: CreateBatchResponse },
        },
      },
      422: { description: "No files / validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/batches",
    summary: "List ingestion batches (most recent first)",
    tags: ["ingest"],
    request: { query: ListBatchesQuery },
    responses: {
      200: {
        description: "Paginated batch summaries",
        content: {
          "application/json": { schema: paginated(BatchSummary) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/batches/{id}",
    summary: "Get one batch with all child ingests",
    tags: ["ingest"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Batch + items",
        content: { "application/json": { schema: Batch } },
      },
      404: { description: "Batch not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/ingests",
    summary: "List ingests across batches",
    tags: ["ingest"],
    request: { query: ListIngestsQuery },
    responses: {
      200: {
        description: "Paginated ingests",
        content: {
          "application/json": { schema: paginated(Ingest) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/ingests/{id}",
    summary: "Get one ingest with produced reverse-lookup",
    tags: ["ingest"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Ingest row",
        content: { "application/json": { schema: Ingest } },
      },
      404: { description: "Ingest not found", content: problemContent },
    },
  });
}
