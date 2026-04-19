/**
 * Stripe-style `Idempotency-Key` middleware.
 *
 * Scope: workspace_id + key (keys are unique per workspace).
 * Body fingerprint: sha256 of the canonicalized request body.
 *
 * Behavior:
 *   - Missing `Idempotency-Key` header → route handler runs unchanged.
 *     (Enforcement — "POST must carry the header" — is route-specific;
 *     add `throw new PreconditionRequiredProblem("Idempotency-Key")` to
 *     handlers that mandate it.)
 *   - Header present, key+hash match existing row and unexpired → serve
 *     the cached response verbatim (status + body).
 *   - Header present, key matches but hash differs → 409
 *     `errors/idempotency-conflict`.
 *   - Header present, key new → capture the eventual response and
 *     persist on successful completion.
 *
 * The middleware wraps `res.status().json()` so capture happens
 * transparently. Only JSON responses are cached; streaming/binary
 * endpoints (documents/:id/content) should opt out by not mounting
 * this middleware.
 */
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { IdempotencyConflictProblem } from "./problem.js";

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function hashBody(body: unknown): string {
  const canonical = body === undefined ? "" : JSON.stringify(body);
  return createHash("sha256").update(canonical).digest("hex");
}

export function idempotencyMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void> {
  return async (req, res, next) => {
    const key = req.header("Idempotency-Key");
    if (!key) return next();

    const workspaceId = req.ctx.workspaceId;
    const requestHash = hashBody(req.body);

    // Look up prior response
    const existing = await db.execute(
      sql`SELECT response_status, response_body, request_hash, expires_at
          FROM idempotency_keys
          WHERE workspace_id = ${workspaceId}::uuid AND key = ${key}
            AND expires_at > NOW()
          LIMIT 1`,
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as {
        response_status: number;
        response_body: unknown;
        request_hash: string;
      };
      if (row.request_hash !== requestHash) {
        return next(new IdempotencyConflictProblem());
      }
      res
        .status(row.response_status)
        .type("application/json")
        .json(row.response_body);
      return;
    }

    // Capture the eventual response so we can persist it.
    const originalJson = res.json.bind(res);
    let captured: { status: number; body: unknown } | null = null;
    res.json = ((body: unknown) => {
      captured = { status: res.statusCode, body };
      return originalJson(body);
    }) as typeof res.json;

    res.on("finish", () => {
      if (!captured) return;
      // Only persist successful responses (2xx); don't memoize errors.
      if (captured.status < 200 || captured.status >= 300) return;
      const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
      db.execute(
        sql`INSERT INTO idempotency_keys
            (id, workspace_id, key, request_hash, response_status, response_body, expires_at)
            VALUES (
              ${randomUUID()}::uuid,
              ${workspaceId}::uuid,
              ${key},
              ${requestHash},
              ${captured.status},
              ${JSON.stringify(captured.body)}::jsonb,
              ${expiresAt}::timestamptz
            )
            ON CONFLICT (workspace_id, key) DO NOTHING`,
      ).catch((err) => {
        console.error("[idempotency] persist failed:", err);
      });
    });

    next();
  };
}
