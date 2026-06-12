/**
 * `/v1/insights` — discovered cards + natural-language ask (v2 P5, #149).
 *
 * GET /            active (undismissed) cards, newest first
 * POST /refresh    run the discovery rules (idempotent upserts)
 * POST /:id/dismiss
 * POST /ask        synchronous NL Q&A via the claude worker (~10-60s;
 *                  single-user deployment, the UI shows a thinking state)
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql, eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { insights } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Insight,
  AskRequest,
  AskResponse,
  RefreshInsightsResponse,
} from "../schemas/v1/insight.js";
import { ProblemDetails, Uuid } from "../schemas/v1/common.js";
import { NotFoundProblem } from "../http/problem.js";
import { discoverInsights } from "../insights/discover.js";
import { askLedger } from "../insights/ask.js";

export const insightsRouter: Router = Router();

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToDto(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspaceId ?? row.workspace_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    dedupe_key: row.dedupeKey ?? row.dedupe_key,
    payload: row.payload ?? {},
    dismissed_at:
      (row.dismissedAt ?? row.dismissed_at) == null
        ? null
        : toIsoString(row.dismissedAt ?? row.dismissed_at),
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

insightsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select()
      .from(insights)
      .where(and(eq(insights.workspaceId, req.ctx.workspaceId), isNull(insights.dismissedAt)))
      .orderBy(desc(insights.updatedAt))
      .limit(50);
    res.json({ items: rows.map(rowToDto) });
  } catch (err) {
    next(err);
  }
});

insightsRouter.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generated = await discoverInsights(req.ctx.workspaceId);
      res.json({ generated });
    } catch (err) {
      next(err);
    }
  },
);

insightsRouter.post(
  "/:id/dismiss",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const updated = await db
        .update(insights)
        .set({ dismissedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(insights.id, id), eq(insights.workspaceId, req.ctx.workspaceId)))
        .returning();
      if (updated.length === 0) throw new NotFoundProblem("Insight", id);
      res.json(rowToDto(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

insightsRouter.post(
  "/ask",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOrThrow(AskRequest, req.body);
      const started = Date.now();
      const { answer, sessionId } = await askLedger(req.ctx.workspaceId, body.question);
      res.json({
        answer,
        session_id: sessionId,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerInsightsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Insight", Insight);
  registry.register("AskRequest", AskRequest);
  registry.register("AskResponse", AskResponse);
  registry.register("RefreshInsightsResponse", RefreshInsightsResponse);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/insights",
    summary: "List active (undismissed) insight cards",
    tags: ["insights"],
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: z.object({ items: z.array(Insight) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/insights/refresh",
    summary: "Run the discovery rules (idempotent upserts)",
    tags: ["insights"],
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: RefreshInsightsResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/insights/{id}/dismiss",
    summary: "Dismiss a card (stays dismissed across refreshes)",
    tags: ["insights"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: Insight } } },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/insights/ask",
    summary: "Ask a natural-language question against the whole ledger",
    description:
      "Synchronous; the claude worker answers in ~10-60s with a read-only SQL session. The session_id is the Langfuse trace key.",
    tags: ["insights"],
    request: {
      body: { content: { "application/json": { schema: AskRequest } } },
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: AskResponse } } },
      422: { description: "Validation failed", content: problemContent },
    },
  });
}
