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
import { InvalidCursorProblem } from "./problem.js";

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

/**
 * Decode a cursor a client echoed back. Returns `null` when none was
 * sent (first page); throws `InvalidCursorProblem` (400) for anything
 * that is not a cursor this API could have issued.
 *
 * It used to return `null` for undecodable input too, which silently
 * restarted the caller at page one, and to hand back whatever JSON
 * decoded — so `e30` (`{}`) reached the SQL as `(a, b) < (, )` and came
 * back as a 500 quoting the query.
 *
 * Every cursor `encodeCursor` writes is a flat object of scalars, so
 * that much is checked for every caller. `requiredKeys` adds the part
 * only the caller knows: the fields its SQL reads. Pass it, or a cursor
 * from a different endpoint still decodes and still breaks the query
 * (as a 500 that no longer quotes it). What the values *contain* is
 * left to Postgres, whose rejection `problemHandler` maps to a 400.
 */
export function decodeCursor<T = Record<string, unknown>>(
  cursor: string | undefined,
  requiredKeys: readonly (keyof T & string)[] = [],
): T | null {
  if (!cursor) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorProblem();
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new InvalidCursorProblem();
  }
  const fields = decoded as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new InvalidCursorProblem();
  for (const key of keys) {
    const v = fields[key];
    if (v !== null && typeof v === "object") throw new InvalidCursorProblem();
  }
  for (const key of requiredKeys) {
    if (fields[key] === undefined || fields[key] === null) {
      throw new InvalidCursorProblem();
    }
  }
  return decoded as T;
}

/**
 * The same check for a route whose *service* decodes the cursor: call
 * this in the handler, before the service, with the key set(s) that
 * endpoint's cursors can have. Passes when the cursor is absent or has
 * every key of at least one shape; otherwise 400.
 *
 * It exists so the handler can reject a foreign cursor without the
 * service files changing. Once a service passes `requiredKeys` to
 * `decodeCursor` itself, drop the call in its route.
 */
export function assertCursorShape(
  cursor: string | null | undefined,
  ...shapes: readonly (readonly string[])[]
): void {
  const fields = decodeCursor<Record<string, unknown>>(cursor ?? undefined);
  if (!fields) return;
  const fits = shapes.some((keys) =>
    keys.every((k) => fields[k] !== undefined && fields[k] !== null),
  );
  if (!fits) throw new InvalidCursorProblem();
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
