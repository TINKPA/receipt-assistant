/**
 * Malformed ids are rejected here, once, before any handler runs.
 *
 * Until this module existed each route chose for itself: some parsed
 * `req.params` with zod (422), some passed the raw string to Postgres
 * (22P02 → 500 with the query in the body), some checked a regex and
 * answered 404. A caller could not tell which it would get.
 *
 * Now a UUID-typed id that is not a UUID is a 400 `errors/invalid-id`
 * wherever it appears:
 *
 *   - in the path: `buildApp()` declares, per router, which path
 *     parameters are UUIDs and calls `requireUuidParams`;
 *   - in the query string: `rejectMalformedQueryIds`, mounted on `/v1`,
 *     checks the parameter names in `UUID_QUERY_PARAMS`.
 *
 * `problemHandler` is the backstop for whatever this misses — an id in a
 * JSON body that no schema checked, the contents of a cursor — because
 * Postgres' own complaint (22P02) is mapped to 400 there.
 *
 * Per-route `parseOrThrow(IdParam, req.params)` calls are now redundant
 * for the UUID check and can go when the route files are next reworked.
 */
import type { NextFunction, Request, Response, Router } from "express";
import { MalformedIdProblem } from "./problem.js";

/** The canonical 8-4-4-4-12 form — what zod's `.uuid()` (`Uuid` in
 *  `schemas/v1/common.ts`) and the OpenAPI `format: uuid` promise. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Declare that these path parameters of `router` are UUIDs. A request
 * whose value is not one never reaches the route's handler.
 *
 * Express keeps param callbacks per router, so this is called once per
 * router, from `buildApp()`. Leave out any parameter that is not a UUID
 * (`:brandId` is a slug; `/v1/merchants/:id` accepts a slug or a UUID).
 */
export function requireUuidParams(
  router: Router,
  names: readonly string[],
): Router {
  for (const name of names) {
    router.param(
      name,
      (_req: Request, _res: Response, next: NextFunction, value: unknown) => {
        next(isUuid(value) ? undefined : new MalformedIdProblem("path", name));
      },
    );
  }
  return router;
}

/**
 * Query-string parameters that are UUIDs on every endpoint that accepts
 * them. A name belongs here only if it never means anything else:
 * `brand_id` is a slug and `cursor` is opaque, so neither is listed.
 * Add a new UUID filter here when you add it to a `*Query` schema.
 */
export const UUID_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "account_id",
  "batch_id",
  "merchant_id",
  "product_id",
  "source_ingest_id",
  "transaction_id",
  "trip_id",
]);

/** Middleware for `/v1`: 400 on a malformed id in the query string. */
export function rejectMalformedQueryIds(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const query = req.query as Record<string, unknown>;
  for (const name of Object.keys(query)) {
    if (!UUID_QUERY_PARAMS.has(name)) continue;
    // A repeated parameter arrives as an array; every occurrence must
    // be well-formed, and anything that is not a string never is.
    const raw = query[name];
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.every(isUuid)) {
      next(new MalformedIdProblem("query", name));
      return;
    }
  }
  next();
}
