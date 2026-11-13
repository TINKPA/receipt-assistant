/**
 * `/v1/batches/:id/reconcile` family — Phase 2a of issue #32.
 *
 *   POST   /v1/batches/:id/reconcile          — run or replay (idempotent)
 *   GET    /v1/batches/:id/reconcile          — latest result
 *   POST   /v1/batches/:id/reconcile/apply    — accept proposal(s)
 *   POST   /v1/batches/:id/reconcile/reject   — reject proposal(s)
 *   POST   /v1/batches/:id/reconcile/undo     — take back applied proposal(s)
 *
 * Mounted from `src/app.ts` at `/v1/batches` via a separate router. The
 * path shape `POST /v1/batches/:id/reconcile` cannot be colocated on
 * the existing `batchesRouter` without reshuffling the `/v1/batches/:id`
 * GET handler's param parsing; keeping a sibling router is simpler and
 * leaves the ingest module owned by #32 Phase 1.
 *
 * All five endpoints delegate to `src/reconcile/engine.ts`. The route
 * layer only handles HTTP details: param parsing, status-code mapping
 * (200 when idempotent replay, 201 on first-time reconcile, 202 when
 * the batch is mid-reconcile on another caller's thread), and OpenAPI
 * registration.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { parseOrThrow } from "../http/validate.js";
import { ProblemDetails, Uuid } from "../schemas/v1/common.js";
import {
  ApplyRequest,
  ApplyResult,
  ReconcileRequest,
  ReconcileResult,
  RejectRequest,
  RejectResult,
  UndoRequest,
  UndoResult,
} from "../schemas/v1/reconcile.js";
import {
  applyProposals,
  getReconcileResult,
  rejectProposals,
  runReconcile,
  undoProposals,
} from "../reconcile/engine.js";

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export const reconcileRouter: Router = Router({ mergeParams: true });

// Params arrive on the nested router under `:id` as the batch id.
const BatchIdParams = z.object({ id: Uuid });

// ── POST /v1/batches/:id/reconcile ────────────────────────────────────

reconcileRouter.post(
  "/:id/reconcile",
  asyncHandler(async (req, res) => {
    const { id: batchId } = parseOrThrow(BatchIdParams, req.params);
    const body = parseOrThrow(ReconcileRequest, req.body ?? {});

    const out = await runReconcile({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      batchId,
      options: {
        scope: body.scope,
        enable: body.enable,
        auto_apply_threshold: body.auto_apply_threshold,
      },
    });

    // Status-code mapping:
    //   reconciled  — either the run just completed (201) OR we short-
    //                 circuited an already-reconciled batch (200).
    //   reconciling — run is in-flight on another caller; hint + 202.
    //   reconcile_error — surface the failure state as 409 so clients
    //                 don't mistake it for success; body still carries
    //                 proposals-so-far for debugging.
    //   extracted   — the conditional lock didn't take hold and the
    //                 batch is still pre-reconcile; should not happen
    //                 under normal flow, return 409.
    let statusCode = 200;
    if (out.status === "reconciling") statusCode = 202;
    else if (out.status === "reconcile_error") statusCode = 409;
    else if (out.status === "extracted") statusCode = 409;
    // For `reconciled` keep 200 — 201 is reserved for created resources
    // and the proposals rows can exist from an earlier run. Clients key
    // on body.status, not the status code.

    res.status(statusCode).json(out);
  }),
);

// ── GET /v1/batches/:id/reconcile ─────────────────────────────────────

reconcileRouter.get(
  "/:id/reconcile",
  asyncHandler(async (req, res) => {
    const { id: batchId } = parseOrThrow(BatchIdParams, req.params);
    const out = await getReconcileResult(req.ctx.workspaceId, batchId);
    res.json(out);
  }),
);

// ── POST /v1/batches/:id/reconcile/apply ──────────────────────────────

reconcileRouter.post(
  "/:id/reconcile/apply",
  asyncHandler(async (req, res) => {
    const { id: batchId } = parseOrThrow(BatchIdParams, req.params);
    const body = parseOrThrow(ApplyRequest, req.body ?? {});
    const out = await applyProposals({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      batchId,
      proposalIds: body.proposal_ids,
    });
    res.json(out);
  }),
);

// ── POST /v1/batches/:id/reconcile/reject ─────────────────────────────

reconcileRouter.post(
  "/:id/reconcile/reject",
  asyncHandler(async (req, res) => {
    const { id: batchId } = parseOrThrow(BatchIdParams, req.params);
    const body = parseOrThrow(RejectRequest, req.body ?? {});
    const out = await rejectProposals({
      workspaceId: req.ctx.workspaceId,
      batchId,
      proposalIds: body.proposal_ids,
      reason: body.reason,
    });
    res.json(out);
  }),
);

// ── POST /v1/batches/:id/reconcile/undo ───────────────────────────────
//
// The inverse of apply, for a proposal in `auto_applied` / `user_applied`:
// the duplicate is restored and the documents the apply moved to the
// surviving transaction go back to it, in one database transaction. The
// proposal ends `reverted` and the pair is not proposed again.

reconcileRouter.post(
  "/:id/reconcile/undo",
  asyncHandler(async (req, res) => {
    const { id: batchId } = parseOrThrow(BatchIdParams, req.params);
    const body = parseOrThrow(UndoRequest, req.body ?? {});
    const out = await undoProposals({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      batchId,
      proposalIds: body.proposal_ids,
    });
    res.json(out);
  }),
);

// ── OpenAPI registration ──────────────────────────────────────────────

export function registerReconcileOpenApi(registry: OpenAPIRegistry): void {
  registry.register("ReconcileRequest", ReconcileRequest);
  registry.register("ReconcileResult", ReconcileResult);
  registry.register("ApplyRequest", ApplyRequest);
  registry.register("ApplyResult", ApplyResult);
  registry.register("RejectRequest", RejectRequest);
  registry.register("RejectResult", RejectResult);
  registry.register("UndoRequest", UndoRequest);
  registry.register("UndoResult", UndoResult);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "post",
    path: "/v1/batches/{id}/reconcile",
    summary:
      "Run the reconcile pipeline over an extracted batch. Idempotent: a second call on a reconciled batch returns the stored result.",
    tags: ["reconcile"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        required: false,
        content: { "application/json": { schema: ReconcileRequest } },
      },
    },
    responses: {
      200: {
        description: "Reconcile completed (or replayed)",
        content: { "application/json": { schema: ReconcileResult } },
      },
      202: {
        description:
          "Batch is already mid-reconcile on another caller; response carries a `poll` URL to fetch the final result.",
        content: { "application/json": { schema: ReconcileResult } },
      },
      404: { description: "Batch not found", content: problemContent },
      409: {
        description:
          "Batch is not in a reconcilable state (still extracting, or entered reconcile_error).",
        content: { "application/json": { schema: ReconcileResult } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/batches/{id}/reconcile",
    summary: "Fetch the latest reconcile result for a batch.",
    tags: ["reconcile"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Reconcile snapshot",
        content: { "application/json": { schema: ReconcileResult } },
      },
      404: { description: "Batch not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/batches/{id}/reconcile/apply",
    summary:
      "Apply one or more reconcile proposals. For a dedup proposal this moves the duplicate's document links to the surviving transaction and soft-deletes the duplicate, in one database transaction, and records which links moved so the apply can be undone. Refused (listed under `skipped`) when either transaction is no longer live, when the duplicate is reconciled, or when the two moved money in opposite directions.",
    tags: ["reconcile"],
    request: {
      params: z.object({ id: Uuid }),
      body: { content: { "application/json": { schema: ApplyRequest } } },
    },
    responses: {
      200: {
        description: "Per-id apply/skip outcomes",
        content: { "application/json": { schema: ApplyResult } },
      },
      404: { description: "Batch not found", content: problemContent },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/batches/{id}/reconcile/reject",
    summary:
      "Reject one or more reconcile proposals. Marks proposals as rejected with no ledger mutation.",
    tags: ["reconcile"],
    request: {
      params: z.object({ id: Uuid }),
      body: { content: { "application/json": { schema: RejectRequest } } },
    },
    responses: {
      200: {
        description: "Per-id reject/skip outcomes",
        content: { "application/json": { schema: RejectResult } },
      },
      404: { description: "Batch not found", content: problemContent },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/batches/{id}/reconcile/undo",
    summary:
      "Undo one or more applied dedup proposals. Restores the duplicate transaction and moves the document links the apply took back to it, in one database transaction; the proposal becomes `reverted`. Skipped, with nothing changed, when the proposal was never applied, when the transaction was deleted again for another reason, or when an old proposal left no trace of which documents moved.",
    tags: ["reconcile"],
    request: {
      params: z.object({ id: Uuid }),
      body: { content: { "application/json": { schema: UndoRequest } } },
    },
    responses: {
      200: {
        description: "Per-id undo/skip outcomes",
        content: { "application/json": { schema: UndoResult } },
      },
      404: { description: "Batch not found", content: problemContent },
      422: { description: "Validation failed", content: problemContent },
    },
  });
}
