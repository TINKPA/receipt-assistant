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
import { ValidationProblem, NotFoundProblem } from "../http/problem.js";
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
import { keepalive, sendEvent, setSseHeaders } from "../http/sse.js";
import { on as busOn } from "../events/bus.js";

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

// ── Server-Sent Events stream ─────────────────────────────────────────
//
// Phase 2b of issue #32. The stream subscribes to the named event bus
// and relays `job.*` / `batch.*` / `reconcile.*` events to the client.
// The worker is responsible for `job.*` and `batch.extracted`; the
// future reconcile module publishes the `reconcile.*` names — we
// subscribe defensively so if nothing publishes, the stream simply
// stays open with keepalives.
//
// Terminal statuses (reconciled / failed) close the stream cleanly
// after delivering one last catch-up event. Client disconnect (TCP FIN
// or abort) tears down the subscriptions and the keepalive timer.

// Event names relayed from the bus to the client. Listed here so the
// subscription/unsubscription loop is symmetric and there's one place
// to add a new name.
const STREAMED_EVENTS = [
  "job.started",
  "job.done",
  "job.error",
  "batch.extracted",
  "batch.failed",
  "batch.reconciled",
  "reconcile.started",
  "reconcile.proposal",
  "reconcile.done",
] as const;

// Batch statuses that terminate the SSE connection. `extracted` does
// NOT terminate — the stream stays open waiting for reconcile events.
const TERMINAL_STATUSES = new Set(["reconciled", "failed"]);

batchesRouter.get(
  "/:id/stream",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);

    // Fetch the batch first so a 404 is served as a normal JSON problem,
    // not an open event stream. `getBatch` throws NotFoundProblem which
    // the error middleware serializes.
    const initial = await getBatch(req.ctx.workspaceId, id);

    setSseHeaders(res);

    // Catch-up frame: always send the current state so a late subscriber
    // can render immediately without polling `GET /v1/batches/:id`.
    sendEvent(res, "hello", {
      batchId: initial.id,
      status: initial.status,
      counts: initial.counts,
    });

    // Already-terminal batch → deliver a second frame reflecting the
    // terminal state (so clients have a consistent "final" event to
    // hang cleanup logic on) and close immediately.
    if (TERMINAL_STATUSES.has(initial.status)) {
      sendEvent(res, "batch.status", {
        batchId: initial.id,
        status: initial.status,
        counts: initial.counts,
      });
      res.end();
      return;
    }

    // Subscribe to every relayed bus event. Each subscription returns
    // an unsubscribe thunk; we collect them so a single cleanup pass
    // removes everything on disconnect.
    const unsubs: Array<() => void> = [];
    let closed = false;

    for (const name of STREAMED_EVENTS) {
      const unsub = busOn(name, (payload: unknown) => {
        if (closed) return;
        // Filter by batchId. All payloads in the bus contract include
        // a `batchId` field; defensively skip anything that doesn't
        // match this stream's batch.
        const bId = (payload as { batchId?: string })?.batchId;
        if (bId && bId !== initial.id) return;
        sendEvent(res, name, payload);

        // Terminal events that close the stream. `batch.extracted`
        // deliberately does NOT close — we hold the connection open
        // for the reconcile phase. `batch.failed` and `batch.reconciled`
        // (emitted by future code) terminate the stream.
        if (name === "batch.failed" || name === "batch.reconciled") {
          cleanup();
          res.end();
        }
      });
      unsubs.push(unsub);
    }

    const ka = keepalive(res);

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(ka);
      for (const u of unsubs) u();
    }

    // Client disconnect (TCP FIN, browser tab close, fetch abort).
    // Never throw from here — we're just releasing resources.
    req.on("close", () => {
      cleanup();
      if (!res.writableEnded) res.end();
    });
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
    path: "/v1/batches/{id}/stream",
    summary:
      "Server-Sent Events stream of per-ingest + per-batch + reconcile " +
      "events. Connects, sends a `hello` catch-up frame with current " +
      "counts + status, then relays `job.*`, `batch.*`, and " +
      "`reconcile.*` events as they fire. Closes on terminal status " +
      "(reconciled / failed) or client disconnect.",
    tags: ["ingest"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description:
          "Event stream. `event:` names: `hello`, `batch.status`, " +
          "`job.started`, `job.done`, `job.error`, `batch.extracted`, " +
          "`batch.failed`, `batch.reconciled`, `reconcile.started`, " +
          "`reconcile.proposal`, `reconcile.done`.",
        content: {
          "text/event-stream": {
            schema: {
              type: "string",
              description:
                "SSE frames of the form `event: <name>\\ndata: <json>\\n\\n`.",
            },
          },
        },
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
