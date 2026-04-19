/**
 * Keyset pagination helpers.
 *
 * Cursors are opaque base64url-encoded JSON of the tuple that the
 * caller's SQL ORDER BY sorts on — typically `(occurred_on, id)` for
 * transactions, `(created_at, posting_id)` for postings/register, etc.
 *
 * Callers never expose the cursor shape in docs; clients only echo the
 * `next` link from the previous response. This lets us change the
 * underlying sort tuple without breaking API consumers.
 */
import type { Request, Response } from "express";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : (raw as number);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(n, MAX_PAGE_LIMIT);
}

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T = Record<string, unknown>>(
  cursor: string | undefined,
): T | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Emit `Link: <...>; rel="next"` with the cursor baked into the current
 * request URL's query string.
 */
export function emitNextLink(
  req: Request,
  res: Response,
  nextCursor: string | null,
): void {
  if (!nextCursor) return;
  // Build absolute URL from the request
  const proto = (req.header("x-forwarded-proto") ?? req.protocol) || "http";
  const host = req.header("host") ?? "localhost";
  const url = new URL(`${proto}://${host}${req.originalUrl}`);
  url.searchParams.set("cursor", nextCursor);
  res.setHeader("Link", `<${url.toString()}>; rel="next"`);
}
