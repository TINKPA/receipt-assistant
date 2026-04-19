/**
 * Per-request context: workspace_id, user_id, trace_id.
 *
 * Until the auth epic lands, every request is pinned to the seeded
 * workspace + owner user. Once auth ships, this middleware will:
 *   1. Resolve the bearer token / session cookie to a user.
 *   2. Resolve the target workspace (header `X-Workspace-Id` or path).
 *   3. Run `SET LOCAL app.current_workspace = '...'` on the connection
 *      so the RLS policies in the schema become authoritative.
 *
 * For now we only attach `req.ctx` so downstream handlers can pretend
 * auth already works — the interface is stable.
 */
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { SEED_USER_ID, SEED_WORKSPACE_ID } from "../db/seed.js";

export interface RequestContext {
  workspaceId: string;
  userId: string;
  traceId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx: RequestContext;
    traceId: string;
  }
}

export function contextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const traceId = req.header("x-trace-id") ?? randomUUID();
  req.traceId = traceId;
  req.ctx = {
    workspaceId: SEED_WORKSPACE_ID,
    userId: SEED_USER_ID,
    traceId,
  };
  next();
}
