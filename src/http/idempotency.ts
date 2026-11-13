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
 *   - Key never seen, or its row has expired → this request CLAIMS the
 *     key before the handler runs, then stores the handler's response.
 *   - Key claimed by a request that is still running → 409
 *     `errors/idempotency-in-progress` with `Retry-After`.
 *   - Key completed, same body hash → the stored response is replayed
 *     verbatim (status + body).
 *   - Key completed or claimed, different body hash → 409
 *     `errors/idempotency-conflict`.
 *
 * The claim is what makes the key mean anything under concurrency. The
 * first version looked the key up, ran the handler, and inserted the
 * response afterwards: two requests racing on one key both found
 * nothing and both ran. It also read only unexpired rows while its
 * insert was `ON CONFLICT DO NOTHING`, so once a key's row had expired
 * the row could be neither used nor replaced — every later retry under
 * that key ran the handler again, for good.
 *
 * Both are closed by one atomic statement (`claim` below): insert the
 * key, or take over the row when it has expired, and learn from
 * `RETURNING` whether we won. The unique index on (workspace_id, key)
 * is the lock; no extra table or column is involved.
 *
 * A claim is a row with `response_status = 0` and a short lease in
 * `expires_at`. Completing the request rewrites it with the real
 * response and the 24 h TTL; a non-2xx outcome deletes it, so a failed
 * request can be retried under the same key. If the process dies
 * mid-request the lease simply runs out and the next retry takes the
 * row over.
 *
 * The middleware wraps `res.json()` so capture happens transparently.
 * Only JSON responses are cached; streaming/binary endpoints
 * (documents/:id/content) should opt out by not mounting this
 * middleware.
 */
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  IdempotencyConflictProblem,
  IdempotencyInProgressProblem,
} from "./problem.js";

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — how long a stored response replays

/**
 * How long an unfinished claim blocks retries before it may be taken
 * over. Longer than any handler this guards should run; short enough
 * that a crash mid-request does not lock a key for the full TTL.
 */
const LEASE_MS = 2 * 60 * 1000;

/** `response_status` of a claim whose handler has not finished. Not a
 *  real HTTP status, so it can never collide with a stored response. */
const IN_PROGRESS = 0;

/** Expired rows are swept at most this often, piggybacked on a claim. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

function hashBody(body: unknown): string {
  const canonical = body === undefined ? "" : JSON.stringify(body);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Claim `key` for this request. Returns true when we now own the row:
 * either it did not exist, or it had expired (a finished response past
 * its TTL, or an abandoned claim past its lease) and we replaced it.
 */
async function claim(
  claimId: string,
  workspaceId: string,
  key: string,
  requestHash: string,
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  const res = await db.execute(
    sql`INSERT INTO idempotency_keys
          (id, workspace_id, key, request_hash, response_status, response_body, expires_at)
        VALUES (
          ${claimId}::uuid,
          ${workspaceId}::uuid,
          ${key},
          ${requestHash},
          ${IN_PROGRESS},
          'null'::jsonb,
          ${leaseUntil}::timestamptz
        )
        ON CONFLICT (workspace_id, key) DO UPDATE
          SET id = EXCLUDED.id,
              request_hash = EXCLUDED.request_hash,
              response_status = EXCLUDED.response_status,
              response_body = EXCLUDED.response_body,
              expires_at = EXCLUDED.expires_at,
              created_at = NOW()
          WHERE idempotency_keys.expires_at <= NOW()
        RETURNING id`,
  );
  return res.rows.length > 0;
}

/** Drop rows nothing can replay any more. Best-effort, never awaited. */
function sweepExpired(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  db.execute(sql`DELETE FROM idempotency_keys WHERE expires_at <= NOW()`).catch(
    (err) => {
      console.error("[idempotency] sweep failed:", err);
    },
  );
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
    const claimId = randomUUID();

    try {
      // Two rounds: a row can expire between a lost claim and the
      // lookup that follows it, in which case the second claim wins.
      let owned = false;
      for (let round = 0; round < 2 && !owned; round++) {
        owned = await claim(claimId, workspaceId, key, requestHash);
        if (owned) break;

        const existing = await db.execute(
          sql`SELECT response_status, response_body, request_hash
              FROM idempotency_keys
              WHERE workspace_id = ${workspaceId}::uuid AND key = ${key}
                AND expires_at > NOW()
              LIMIT 1`,
        );
        const row = existing.rows[0] as
          | { response_status: number; response_body: unknown; request_hash: string }
          | undefined;
        if (!row) continue;

        if (row.request_hash !== requestHash) {
          return next(new IdempotencyConflictProblem());
        }
        if (Number(row.response_status) === IN_PROGRESS) {
          res.setHeader("Retry-After", "1");
          return next(new IdempotencyInProgressProblem());
        }
        res
          .status(row.response_status)
          .type("application/json")
          .json(row.response_body);
        return;
      }
      if (!owned) {
        res.setHeader("Retry-After", "1");
        return next(new IdempotencyInProgressProblem());
      }
    } catch (err) {
      return next(err);
    }

    sweepExpired();

    // We hold the claim. Settle it the moment the handler produces its
    // response — not on the socket's `finish`, which never fires when
    // the client has gone away, and the retry that follows a dropped
    // connection is the very request this exists to answer.
    let settled = false;
    const settle = (status: number, body: unknown): void => {
      if (settled) return;
      settled = true;
      const memoize = status >= 200 && status < 300;
      const write = memoize
        ? db.execute(
            sql`UPDATE idempotency_keys
                SET response_status = ${status},
                    response_body = ${JSON.stringify(body ?? null)}::jsonb,
                    expires_at = ${new Date(Date.now() + TTL_MS).toISOString()}::timestamptz
                WHERE id = ${claimId}::uuid`,
          )
        : // Errors are not memoized: release the key so the caller can
          // fix the request (or just retry) under the same key.
          db.execute(
            sql`DELETE FROM idempotency_keys
                WHERE id = ${claimId}::uuid AND response_status = ${IN_PROGRESS}`,
          );
      write.catch((err) => {
        console.error("[idempotency] settle failed:", err);
      });
    };

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      settle(res.statusCode, body);
      return originalJson(body);
    }) as typeof res.json;

    // A response that ended without `res.json` (204, a stream) has
    // nothing to replay; release the claim rather than hold the lease.
    res.on("finish", () => settle(0, null));

    next();
  };
}
