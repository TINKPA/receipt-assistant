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
import { assertCursorShape, emitNextLink } from "../http/pagination.js";
import { IdParam, ProblemDetails, Uuid, paginated } from "../schemas/v1/common.js";
import {
  Batch,
  BatchSummary,
  CreateBatchForm,
  CreateBatchResponse,
  Ingest,
  IngestProblemsQuery,
  ListBatchesQuery,
  ListIngestsQuery,
  RetryIngestBody,
  RetryIngestResponse,
  UploaderNote,
} from "../schemas/v1/ingest.js";
import {
  createBatchFromFiles,
  getBatch,
  getIngest,
  listBatches,
  listIngests,
  parseStatusFilter,
  retryIngest,
  PROBLEM_INGEST_STATUSES,
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

/**
 * The uploader notes of a multipart upload (#289), out of `req.body`.
 *
 * multer's field parser reads `note[<name>]` as a nested key, so `note`
 * arrives as a string (one batch note), an object (per-file notes, with
 * the batch note under the key ""), or an array (`note` sent twice, a
 * 422). A file name the parser cannot nest (one with brackets in it)
 * stays a literal `note[…]` key, read here too. Every note goes through
 * `UploaderNote`; a per-file note that names no uploaded file is a 422,
 * so a typo never drops a note silently.
 */
function readUploadNotes(
  body: Record<string, unknown>,
  filenames: readonly string[],
): { rest: Record<string, unknown>; batchNote: string | null; perFile: Map<string, string | null> } {
  const rest: Record<string, unknown> = {};
  const raw: Array<[string | null, unknown]> = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "note") {
      if (Array.isArray(value)) {
        throw new ValidationProblem(
          [{ path: "note", code: "invalid_type", message: "send `note` once; per-file notes go in `note[<filename>]`" }],
          "Field `note` sent more than once",
        );
      }
      if (value !== null && typeof value === "object") {
        for (const [name, v] of Object.entries(value as Record<string, unknown>)) raw.push([name === "" ? null : name, v]);
      } else {
        raw.push([null, value]);
      }
    } else if (key.startsWith("note[") && key.endsWith("]")) {
      raw.push([key.slice(5, -1), value]);
    } else {
      rest[key] = value;
    }
  }
  let batchNote: string | null = null;
  const perFile = new Map<string, string | null>();
  for (const [name, value] of raw) {
    const path = name === null ? "note" : `note[${name}]`;
    if (typeof value !== "string") {
      throw new ValidationProblem(
        [{ path, code: "invalid_type", message: "a note is one text field" }],
        `Field \`${path}\` is not text`,
      );
    }
    const parsed = UploaderNote.safeParse(value);
    if (!parsed.success) {
      throw new ValidationProblem(
        parsed.error.issues.map((i) => ({ path, code: i.code, message: i.message })),
        `Field \`${path}\` is not a valid note`,
      );
    }
    const note = parsed.data === "" ? null : parsed.data;
    if (name === null) {
      batchNote = note;
    } else {
      if (!filenames.includes(name)) {
        throw new ValidationProblem(
          [{ path, code: "unknown_file", message: `no file named '${name}' in this upload` }],
          `Per-file note names no uploaded file`,
        );
      }
      perFile.set(name, note);
    }
  }
  return { rest, batchNote, perFile };
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

    // The text fields, checked before anything is written. A flag this
    // route cannot read is a 422, never a guess; on is only the default
    // for a flag that was not sent.
    const notes = readUploadNotes(
      (req.body ?? {}) as Record<string, unknown>,
      files.map((f) => f.originalname),
    );
    const fields = parseOrThrow(CreateBatchForm, notes.rest);
    const autoReconcile = fields.auto_reconcile ?? true;

    const { batch, items } = await createBatchFromFiles({
      workspaceId: req.ctx.workspaceId,
      files: files.map((f) => ({
        originalName: f.originalname,
        mimeType: f.mimetype ?? null,
        bytes: f.buffer,
        note: notes.perFile.has(f.originalname) ? notes.perFile.get(f.originalname)! : notes.batchNote,
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
    assertCursorShape(q.cursor, ["created_at", "id"]);
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
    assertCursorShape(q.cursor, ["created_at", "id"]);
    const out = await listIngests({
      workspaceId: req.ctx.workspaceId,
      cursor: q.cursor,
      limit: q.limit,
      batchId: q.batch_id,
      statuses: parseStatusFilter(q.status) ?? undefined,
    });
    emitNextLink(req, res, out.next_cursor);
    res.json(out);
  }),
);

// Problem inbox (#158): every upload that didn't reach `done` and isn't
// still in flight, enriched with `category` / `retryable` / `dedup_of` so a
// client can render "retry" vs "view duplicate" vs "explain" without
// string-parsing `error`. Registered BEFORE `/:id` so `problems` isn't
// captured as an id param.
ingestsRouter.get(
  "/problems",
  asyncHandler(async (req, res) => {
    const q = parseOrThrow(IngestProblemsQuery, req.query);
    assertCursorShape(q.cursor, ["created_at", "id"]);
    const out = await listIngests({
      workspaceId: req.ctx.workspaceId,
      cursor: q.cursor,
      limit: q.limit,
      statuses: parseStatusFilter(q.status) ?? PROBLEM_INGEST_STATUSES,
      hideSettledErrors: true,
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

// Retry a failed/unsupported ingest against its original stored bytes
// (#158). Returns the freshly-created ingest to poll.
ingestsRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    // #289: an optional JSON body `{ note }`; no body is the old retry.
    const body = parseOrThrow(RetryIngestBody, req.body ?? {});
    const out = await retryIngest(req.ctx.workspaceId, id, { note: body.note });
    res.setHeader("Location", out.poll);
    res.status(202).json(out);
  }),
);

// ── OpenAPI registration ──────────────────────────────────────────────

export function registerIngestOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Batch", Batch);
  registry.register("BatchSummary", BatchSummary);
  registry.register("Ingest", Ingest);
  registry.register("CreateBatchForm", CreateBatchForm);
  registry.register("CreateBatchResponse", CreateBatchResponse);
  registry.register("RetryIngestBody", RetryIngestBody);
  registry.register("RetryIngestResponse", RetryIngestResponse);

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
      422: {
        description:
          "No files; `auto_reconcile` is not one of true / 1 / false / 0; or a `note` is too long, " +
          "sent twice, or (`note[<filename>]`) names no uploaded file",
        content: problemContent,
      },
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
    path: "/v1/ingests/problems",
    summary:
      "List uploads needing attention (#158) — every ingest that didn't " +
      "reach `done` and isn't still in flight (default: " +
      "error, unsupported, dedup, near_dup). Each row carries `category`, " +
      "`retryable`, and `dedup_of` so a client can choose the right " +
      "affordance without string-parsing `error`. An errored ingest is " +
      "left out once a later ingest of the same document (a retry, or the " +
      "same bytes uploaded again) ended as done, dedup, near_dup or " +
      "unsupported.",
    tags: ["ingest"],
    request: { query: IngestProblemsQuery },
    responses: {
      200: {
        description: "Paginated problem ingests",
        content: {
          "application/json": { schema: paginated(Ingest) },
        },
      },
      422: {
        description: "Unknown status token in filter",
        content: problemContent,
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

  registry.registerPath({
    method: "post",
    path: "/v1/ingests/{id}/retry",
    summary:
      "Retry a failed ingest (#158). Re-runs the original stored bytes " +
      "through the batch pipeline (genuine-restore dedup branch — not " +
      "suppressed). Returns 202 with the freshly-created ingest to poll. " +
      "Accepts exactly the ingests whose `retryable` field is true, i.e. " +
      "category `transient_actionable` or `infrastructure_fault` (#199); " +
      "anything else 409s. `unsupported` was accepted before #199 despite " +
      "always reporting `retryable: false`, and no longer is. " +
      "Optional JSON body `{ \"note\": \"…\" }` (#289): the new attempt carries that " +
      "uploader note instead of the retried ingest's (blank or null clears it; no body keeps " +
      "it), and a non-empty note also makes an `unsupported` ingest retryable " +
      "(`retryable_with_note`), since the note is the context the document lacked.",
    tags: ["ingest"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        required: false,
        content: { "application/json": { schema: RetryIngestBody } },
      },
    },
    responses: {
      202: {
        description: "Retry enqueued — poll the returned ingest / batch",
        headers: { Location: { schema: { type: "string" } } },
        content: { "application/json": { schema: RetryIngestResponse } },
      },
      404: { description: "Ingest not found", content: problemContent },
      409: {
        description: "Ingest is not in a retryable state",
        content: problemContent,
      },
      422: {
        description: "Stored source bytes missing, or the body's `note` is not valid",
        content: problemContent,
      },
    },
  });
}
