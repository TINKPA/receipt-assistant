/**
 * HTTP routes for `/v1/transactions` (CRUD + void + reconcile + bulk +
 * nested postings).
 *
 * The heavy lifting — DB transaction wrapping, balance-trigger error
 * translation, audit-log writes — lives in `transactions.service.ts`
 * so the MCP tools can reuse the same code path without spinning a
 * fake HTTP request.
 *
 * Error handling: every handler is an `async (req, res, next)` that
 * forwards thrown `HttpProblem`s to `next(err)` — the final
 * `problemHandler` in `app.ts` serializes them as 7807.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { db } from "../db/client.js";
import { transactions } from "../schema/index.js";
import { eq, and } from "drizzle-orm";
import {
  CreateTransactionRequest,
  UpdateTransactionRequest,
  VoidTransactionRequest,
  UnreconcileTransactionRequest,
  UpdatePostingRequest,
  NewPosting,
  ListTransactionsQuery,
  BulkRequest,
  Transaction as TransactionSchema,
  Posting as PostingSchema,
  BulkResponse,
} from "../schemas/v1/transaction.js";
import { parseOrThrow } from "../http/validate.js";
import {
  setEtag,
  requireIfMatch,
  handleIfNoneMatch,
  parseEtag,
} from "../http/etag.js";
import {
  PreconditionRequiredProblem,
  NotFoundProblem,
  HttpProblem,
  VersionMismatchProblem,
} from "../http/problem.js";
import { idempotencyMiddleware } from "../http/idempotency.js";
import { emitNextLink } from "../http/pagination.js";
import {
  createTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  voidTransaction,
  reconcileTransaction,
  unreconcileTransaction,
  addPosting,
  updatePosting,
  deletePosting,
} from "./transactions.service.js";
import { ProblemDetails, paginated, IdParam, Uuid } from "../schemas/v1/common.js";

export const transactionsRouter: Router = Router();

// Parse `application/merge-patch+json` bodies on PATCH routes. The app-
// level `express.json()` only covers `application/json`; patch requests
// using the RFC 7396 content type would otherwise arrive with an empty
// body. Harmless on non-PATCH methods — only fires when the header is
// present.
transactionsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "25mb" }),
);

// Helper: load current version (for If-Match check) before mutation.
async function loadVersion(
  workspaceId: string,
  id: string,
): Promise<number> {
  const rows = await db
    .select({ version: transactions.version })
    .from(transactions)
    .where(
      and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
    );
  if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
  return Number(rows[0]!.version);
}

// ── POST /v1/transactions ──────────────────────────────────────────────

transactionsRouter.post(
  "/",
  idempotencyMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.header("Idempotency-Key")) {
        throw new PreconditionRequiredProblem("Idempotency-Key");
      }
      const body = parseOrThrow(CreateTransactionRequest, req.body);
      const result = await createTransaction(
        req.ctx.workspaceId,
        req.ctx.userId,
        body,
      );
      res.setHeader("Location", `/v1/transactions/${result.id}`);
      setEtag(res, result.version);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/transactions ───────────────────────────────────────────────

transactionsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Zod's z.coerce.boolean() treats any non-empty string as `true`,
      // including the literal "false". Normalize the raw query string
      // BEFORE parsing so `has_document=false` → boolean false.
      const raw = { ...(req.query as Record<string, unknown>) };
      if (typeof raw.has_document === "string") {
        const lower = (raw.has_document as string).toLowerCase();
        if (lower === "false" || lower === "0") raw.has_document = false;
        else if (lower === "true" || lower === "1") raw.has_document = true;
      }
      const query = parseOrThrow(ListTransactionsQuery, raw);
      const result = await listTransactions(req.ctx.workspaceId, query);
      emitNextLink(req, res, result.next_cursor);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/transactions:bulk (aliased /v1/transactions/bulk) ─────────
//
// Epic #28 specifies the Google AEIP-style colon-verb form
// `/v1/transactions:bulk`. Express 5 mounts at a segment boundary, so
// `/v1/transactions:bulk` is not reachable via `app.use("/v1/transactions", router)`.
// We expose the feature at the equivalent `/v1/transactions/bulk` path
// (also documented in OpenAPI) so existing clients can use it today;
// once the mount is consolidated the colon form can be added as a 308
// redirect alias.

transactionsRouter.post(
  "/bulk",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOrThrow(BulkRequest, req.body);
      const results: Array<{ index: number; status: number; body: unknown }> = [];

      for (let i = 0; i < body.operations.length; i++) {
        const op = body.operations[i]!;
        try {
          const expected = parseEtag(op.if_match);
          if (expected === null) {
            throw new VersionMismatchProblem(await loadVersion(req.ctx.workspaceId, op.id), undefined);
          }
          if (op.op === "update") {
            const out = await updateTransaction(
              req.ctx.workspaceId,
              req.ctx.userId,
              op.id,
              expected,
              op.patch,
            );
            results.push({ index: i, status: 200, body: out });
          } else if (op.op === "void") {
            const out = await voidTransaction(
              req.ctx.workspaceId,
              req.ctx.userId,
              op.id,
              expected,
              op.reason,
            );
            results.push({ index: i, status: 201, body: out });
          } else if (op.op === "reconcile") {
            const out = await reconcileTransaction(
              req.ctx.workspaceId,
              req.ctx.userId,
              op.id,
              expected,
            );
            results.push({ index: i, status: 200, body: out });
          }
        } catch (err) {
          if (err instanceof HttpProblem) {
            results.push({
              index: i,
              status: err.status,
              body: err.toBody(),
            });
          } else {
            results.push({
              index: i,
              status: 500,
              body: {
                type: "https://receipts.dev/errors/internal",
                title: "Internal Server Error",
                status: 500,
                detail: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      }

      res.status(200).json({ results });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/transactions/:id ───────────────────────────────────────────

transactionsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const result = await getTransaction(req.ctx.workspaceId, id);
      if (handleIfNoneMatch(req, res, result.version)) return;
      setEtag(res, result.version);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/transactions/:id ─────────────────────────────────────────

transactionsRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const ct = req.header("Content-Type") ?? "";
      const ctBase = ct.split(";")[0]!.trim().toLowerCase();
      if (ctBase && ctBase !== "application/merge-patch+json" && ctBase !== "application/json") {
        throw new HttpProblem(
          415,
          "unsupported-media-type",
          "Unsupported Media Type",
          `Content-Type must be application/merge-patch+json or application/json; got ${ctBase}`,
        );
      }

      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);

      const patch = parseOrThrow(UpdateTransactionRequest, req.body);
      const result = await updateTransaction(
        req.ctx.workspaceId,
        req.ctx.userId,
        id,
        currentVersion,
        patch,
      );
      setEtag(res, result.version);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /v1/transactions/:id ────────────────────────────────────────
//
// Default: only `draft` / `error` may be hard-deleted; posted requires
// POST /void instead (returns 409 must-void-instead).
// `?hard=true`: caller forces a hard delete on posted/voided as well —
// rows + postings + document_links cascade. `reconciled` is the one
// status that still rejects (must unreconcile first).

const TxnDeleteQuery = z.object({
  hard: z.union([z.literal("true"), z.literal("1"), z.literal("false"), z.literal("0")]).optional(),
});

transactionsRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const q = parseOrThrow(TxnDeleteQuery, req.query);
      const force = q.hard === "true" || q.hard === "1";
      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);
      await deleteTransaction(req.ctx.workspaceId, id, currentVersion, {
        force,
        userId: req.ctx.userId,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/transactions/:id/void ─────────────────────────────────────

transactionsRouter.post(
  "/:id/void",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const body = parseOrThrow(VoidTransactionRequest, req.body ?? {});
      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);
      const result = await voidTransaction(
        req.ctx.workspaceId,
        req.ctx.userId,
        id,
        currentVersion,
        body.reason,
      );
      res.setHeader("Location", `/v1/transactions/${result.id}`);
      setEtag(res, result.version);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/transactions/:id/reconcile ────────────────────────────────

transactionsRouter.post(
  "/:id/reconcile",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);
      const result = await reconcileTransaction(
        req.ctx.workspaceId,
        req.ctx.userId,
        id,
        currentVersion,
      );
      setEtag(res, result.version);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/transactions/:id/unreconcile ──────────────────────────────

transactionsRouter.post(
  "/:id/unreconcile",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const body = parseOrThrow(UnreconcileTransactionRequest, req.body ?? {});
      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);
      const result = await unreconcileTransaction(
        req.ctx.workspaceId,
        req.ctx.userId,
        id,
        currentVersion,
        body.reason,
      );
      setEtag(res, result.version);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/transactions/:id/postings ─────────────────────────────────

transactionsRouter.post(
  "/:id/postings",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = parseOrThrow(IdParam, req.params);
      const body = parseOrThrow(NewPosting, req.body);
      const currentVersion = await loadVersion(req.ctx.workspaceId, id);
      requireIfMatch(req, currentVersion);
      const result = await addPosting(
        req.ctx.workspaceId,
        req.ctx.userId,
        id,
        currentVersion,
        body,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/transactions/:tid/postings/:pid ──────────────────────────

transactionsRouter.patch(
  "/:tid/postings/:pid",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = parseOrThrow(
        z.object({ tid: Uuid, pid: Uuid }),
        req.params,
      );
      const patch = parseOrThrow(UpdatePostingRequest, req.body);
      const currentVersion = await loadVersion(req.ctx.workspaceId, params.tid);
      requireIfMatch(req, currentVersion);
      const result = await updatePosting(
        req.ctx.workspaceId,
        req.ctx.userId,
        params.tid,
        params.pid,
        currentVersion,
        patch,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /v1/transactions/:tid/postings/:pid ─────────────────────────

transactionsRouter.delete(
  "/:tid/postings/:pid",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = parseOrThrow(
        z.object({ tid: Uuid, pid: Uuid }),
        req.params,
      );
      const currentVersion = await loadVersion(req.ctx.workspaceId, params.tid);
      requireIfMatch(req, currentVersion);
      await deletePosting(
        req.ctx.workspaceId,
        req.ctx.userId,
        params.tid,
        params.pid,
        currentVersion,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerTransactionsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Transaction", TransactionSchema);
  registry.register("Posting", PostingSchema);
  registry.register("BulkResponse", BulkResponse);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "post",
    path: "/v1/transactions",
    summary: "Create a transaction",
    tags: ["transactions"],
    request: {
      headers: z.object({ "Idempotency-Key": z.string() }),
      body: {
        content: { "application/json": { schema: CreateTransactionRequest } },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: TransactionSchema } },
      },
      409: { description: "Idempotency conflict", content: problemContent },
      422: { description: "Validation failed", content: problemContent },
      428: { description: "Idempotency-Key required", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/transactions",
    summary: "List transactions",
    tags: ["transactions"],
    request: { query: ListTransactionsQuery },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: paginated(TransactionSchema) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/transactions/{id}",
    summary: "Get a transaction",
    tags: ["transactions"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: TransactionSchema } },
      },
      304: { description: "Not Modified" },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/transactions/{id}",
    summary: "Patch transaction head fields",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateTransactionRequest },
        },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: TransactionSchema } },
      },
      412: { description: "Version mismatch", content: problemContent },
      428: { description: "If-Match required", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/transactions/{id}",
    summary: "Delete a transaction",
    description:
      "Default: only draft/error transactions may be hard-deleted; posted/voided return 409 (must-void-instead). " +
      "?hard=true forces a hard delete of any non-reconciled transaction (postings + document_links cascade). " +
      "Reconciled transactions always reject — unreconcile first.",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      query: z.object({
        hard: z.enum(["true", "false", "1", "0"]).optional().openapi({
          description:
            "Force hard delete of posted/voided transactions. Reconciled is still rejected.",
        }),
      }),
    },
    responses: {
      204: { description: "Deleted" },
      409: {
        description:
          "Must void instead (posted, no ?hard=true), or transaction is reconciled.",
        content: problemContent,
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/{id}/void",
    summary: "Void a posted transaction",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      body: {
        content: { "application/json": { schema: VoidTransactionRequest } },
      },
    },
    responses: {
      201: {
        description: "Mirror transaction created",
        content: { "application/json": { schema: TransactionSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/{id}/reconcile",
    summary: "Reconcile a posted transaction",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: TransactionSchema } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/{id}/unreconcile",
    summary: "Unreconcile a transaction (reconciled → posted)",
    description:
      "Pure state flip: `reconciled` → `posted`, with an audit event. Match-side state (e.g. bank-line associations) is intentionally NOT cleaned up here — callers compose this with their own match cleanup. Used as the escape hatch before `DELETE /v1/transactions/:id?hard=true` or `DELETE /v1/documents/:id?cascade=true&hard=true` on a reconciled row.",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      body: {
        content: { "application/json": { schema: UnreconcileTransactionRequest } },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: TransactionSchema } },
      },
      409: {
        description: "Transaction is not in reconciled state",
        content: problemContent,
      },
      412: { description: "Version mismatch", content: problemContent },
      428: { description: "If-Match required", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/bulk",
    summary: "Bulk update/void/reconcile",
    tags: ["transactions"],
    request: {
      body: { content: { "application/json": { schema: BulkRequest } } },
    },
    responses: {
      200: {
        description: "Per-op results",
        content: { "application/json": { schema: BulkResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/{id}/postings",
    summary: "Add a posting to a transaction",
    tags: ["transactions"],
    request: {
      params: z.object({ id: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      body: { content: { "application/json": { schema: NewPosting } } },
    },
    responses: {
      201: {
        description: "Posting added",
        content: { "application/json": { schema: PostingSchema } },
      },
      422: { description: "Imbalance", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/transactions/{tid}/postings/{pid}",
    summary: "Update a posting",
    tags: ["transactions"],
    request: {
      params: z.object({ tid: Uuid, pid: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
      body: {
        content: { "application/json": { schema: UpdatePostingRequest } },
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: PostingSchema } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/transactions/{tid}/postings/{pid}",
    summary: "Delete a posting",
    tags: ["transactions"],
    request: {
      params: z.object({ tid: Uuid, pid: Uuid }),
      headers: z.object({ "If-Match": z.string() }),
    },
    responses: {
      204: { description: "Deleted" },
      422: { description: "Would leave <2 postings", content: problemContent },
    },
  });
}
