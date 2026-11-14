/**
 * RFC 7807 Problem Details for HTTP APIs.
 *
 * All error responses serialize as `application/problem+json`. Clients
 * branch on the machine-readable `type` URI, not on the human-readable
 * `title` / `detail`.
 *
 * Usage in handlers — throw:
 *     throw new NotFoundProblem("Account", id);
 *     throw new VersionMismatchProblem(currentVersion);
 *     throw new ValidationProblem(zodIssues);
 *
 * The final Express middleware (`problemHandler`) catches all errors
 * and emits the correct status + headers. What it does with an error
 * that is not an `HttpProblem` is `renderProblem` below: a request the
 * framework or Postgres rejected as malformed becomes a 4xx, and
 * anything else a 500 `errors/internal` whose body is a fixed sentence
 * plus the `trace_id` the full error was logged under.
 */
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { STATUS_CODES } from "http";
import { ZodError } from "zod";
import {
  CONCURRENT_UPDATE_RETRY_AFTER_SECONDS,
  classifyPgError,
  findPgError,
} from "./pg-error.js";

const TYPE_BASE = "https://receipts.dev/errors";

export interface Violation {
  path: string;
  code: string;
  message?: string;
  [key: string]: unknown;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  trace_id?: string;
  violations?: Violation[];
  [key: string]: unknown;
}

export class HttpProblem extends Error {
  /** Response headers this problem asks `problemHandler` to send with
   *  it, e.g. `Retry-After`. Empty for almost every problem. */
  public headers: Record<string, string> = {};

  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extras: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }

  toBody(instance?: string, traceId?: string): ProblemBody {
    return {
      type: `${TYPE_BASE}/${this.type}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...(traceId ? { trace_id: traceId } : {}),
      ...this.extras,
    };
  }
}

export class ValidationProblem extends HttpProblem {
  constructor(violations: Violation[], detail = "Request failed validation") {
    super(422, "validation", "Validation failed", detail, { violations });
  }

  static fromZod(err: ZodError): ValidationProblem {
    const violations: Violation[] = err.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    }));
    return new ValidationProblem(violations);
  }
}

export class NotFoundProblem extends HttpProblem {
  constructor(resource: string, id?: string) {
    super(
      404,
      "not-found",
      `${resource} not found`,
      id ? `No ${resource} with id=${id}` : undefined,
    );
  }
}

export class VersionMismatchProblem extends HttpProblem {
  /** `detail` replaces the default sentence when the version matched
   *  and something else the tag covers did not (a transaction's
   *  documents, see `transactionEtag`). */
  constructor(current: number, supplied?: number, detail?: string) {
    super(
      412,
      "version-mismatch",
      "Resource version mismatch",
      detail ?? `If-Match supplied version=${supplied ?? "?"}, current=${current}. Re-fetch and retry.`,
      { current_version: current, supplied_version: supplied ?? null },
    );
  }
}

export class PreconditionRequiredProblem extends HttpProblem {
  constructor(header: string) {
    super(
      428,
      "precondition-required",
      `${header} header required`,
      `This endpoint requires ${header} for safe concurrent modification`,
    );
  }
}

export class IdempotencyConflictProblem extends HttpProblem {
  constructor() {
    super(
      409,
      "idempotency-conflict",
      "Idempotency-Key replayed with different body",
      "This Idempotency-Key was previously used for a different request payload",
    );
  }
}

export class AccountInUseProblem extends HttpProblem {
  constructor(accountId: string, postingCount: number) {
    super(
      409,
      "account-in-use",
      "Account has postings",
      `Account ${accountId} cannot be deleted — ${postingCount} posting(s) reference it. Close the account via PATCH { closed_at } instead.`,
      { account_id: accountId, posting_count: postingCount },
    );
  }
}

export class PostingsImbalanceProblem extends HttpProblem {
  constructor(detail: string, violations: Violation[]) {
    super(422, "postings-imbalance", "Postings do not balance", detail, {
      violations,
    });
  }
}

export class NoRawResponseProblem extends HttpProblem {
  constructor(placeId: string) {
    super(
      422,
      "place-no-raw-response",
      "Cannot re-derive",
      `Place ${placeId} has no raw_response; re-derive needs cached Google data to project from. Refresh the place via the (Phase 4) re-fetch path before re-deriving.`,
      { place_id: placeId },
    );
  }
}

/**
 * Returned by `POST /v1/places/:id/refresh` when the server has no
 * `GOOGLE_MAPS_API_KEY` configured. 503 because the fault is the
 * deployment's, not the caller's — retry once the key is set.
 */
export class GooglePlacesUnavailableProblem extends HttpProblem {
  constructor() {
    super(
      503,
      "google-places-unavailable",
      "Google Places fetch unavailable",
      "Server has no GOOGLE_MAPS_API_KEY configured; refresh cannot fetch new place data.",
    );
  }
}

/**
 * Returned by `POST /v1/places/:id/refresh` when the upstream
 * Google v1 call returns non-2xx. Surfaces the upstream status
 * so the caller can distinguish "bad place_id" (404 from Google)
 * from "Google having a bad day" (5xx).
 */
export class GooglePlacesUpstreamProblem extends HttpProblem {
  constructor(upstreamStatus: number, placeId: string, languageCode: string) {
    super(
      502,
      "google-places-upstream",
      "Google Places upstream error",
      `Google v1 returned ${upstreamStatus} for ${placeId} (${languageCode}).`,
      {
        upstream_status: upstreamStatus,
        google_place_id: placeId,
        language_code: languageCode,
      },
    );
  }
}

/**
 * Returned by `POST /v1/ingests/:id/retry` when the ingest is in a state
 * that cannot be re-run. Retry is for failures on our side, so only the
 * `transient_actionable` / `infrastructure_fault` categories qualify —
 * `ok` already succeeded, `in_progress` is still in flight, `input_problem`
 * would fail identically on identical bytes, and `informational`
 * (`dedup`/`near_dup`) has a canonical transaction reachable via `dedup_of`
 * that retrying would only re-suppress.
 *
 * `category` mirrors the field on the ingest resource, so a client that hid
 * the retry control can explain the 409 without a second lookup (#199).
 */
export class IngestNotRetryableProblem extends HttpProblem {
  constructor(ingestId: string, status: string, category: string) {
    super(
      409,
      "ingest-not-retryable",
      "Ingest is not retryable",
      `Ingest ${ingestId} has status='${status}' (category='${category}'). ` +
        `Only 'transient_actionable' and 'infrastructure_fault' ingests can be retried.`,
      { ingest_id: ingestId, status, category },
    );
  }
}

/**
 * Returned by `POST /v1/ingests/:id/retry` when the stored bytes for the
 * ingest can no longer be read from disk (evicted, or the uploads volume
 * was reset). Retry re-runs the original bytes, so a missing file is a
 * hard stop — the caller must re-upload the source document.
 */
export class IngestFileMissingProblem extends HttpProblem {
  constructor(ingestId: string, filePath: string) {
    super(
      422,
      "ingest-file-missing",
      "Ingest source file missing",
      `Ingest ${ingestId} references stored bytes at '${filePath}' that could not be read. Re-upload the document instead.`,
      { ingest_id: ingestId, file_path: filePath },
    );
  }
}

export class DocumentHasLinksProblem extends HttpProblem {
  constructor(documentId: string, linkCount: number) {
    super(
      409,
      "document-has-links",
      "Document is linked to transactions",
      `Document ${documentId} is linked to ${linkCount} transaction(s). Unlink first, then DELETE.`,
      { document_id: documentId, link_count: linkCount },
    );
  }
}

/**
 * 409 for a request that lost to a concurrent one over the same rows and
 * changed nothing: retry it. `renderProblem` answers a Postgres deadlock
 * or serialization failure (SQLSTATE 40P01 / 40001) with the same type
 * and `Retry-After`; code that gives up on its own retry loop throws
 * this, so a client sees one contract for "collided, send it again".
 */
export class ConcurrentUpdateProblem extends HttpProblem {
  constructor(detail?: string) {
    super(
      409,
      "concurrent-update",
      "Concurrent update",
      detail ??
        "Another request was changing the same records at the same moment, and this one was stopped. Nothing was changed. Retry the request.",
      { retry_after_seconds: CONCURRENT_UPDATE_RETRY_AFTER_SECONDS },
    );
    this.headers = { "Retry-After": String(CONCURRENT_UPDATE_RETRY_AFTER_SECONDS) };
  }
}

/**
 * 400 for an id that is not a UUID, in the path or the query string.
 * Raised before any handler runs by `http/params.ts`. The `violations`
 * entry has the shape zod produced when these were per-route 422s, so a
 * client that reads `violations[0].path` keeps working.
 */
export class MalformedIdProblem extends HttpProblem {
  constructor(where: "path" | "query", name: string) {
    super(
      400,
      "invalid-id",
      "Malformed identifier",
      `${where === "path" ? "Path" : "Query"} parameter '${name}' must be a UUID.`,
      {
        violations: [
          { path: name, code: "invalid_string", message: "Invalid uuid", in: where },
        ],
      },
    );
  }
}

/** 400 for a `cursor` that is not one this API issued. */
export class InvalidCursorProblem extends HttpProblem {
  constructor() {
    super(
      400,
      "invalid-cursor",
      "Invalid pagination cursor",
      "The cursor is not one this endpoint issued. Omit it to start from the first page.",
    );
  }
}

/**
 * 404 for a URL no router claims. Its own `type` so a client can tell
 * "wrong URL or method" from "that record does not exist" (`not-found`).
 */
export class RouteNotFoundProblem extends HttpProblem {
  constructor(method: string, path: string) {
    super(
      404,
      "route-not-found",
      "No such endpoint",
      `${method} ${path.slice(0, 200)} is not part of this API. See /openapi.json.`,
    );
  }
}

/**
 * 409 for a request that arrives while an earlier one carrying the same
 * `Idempotency-Key` is still running. Retrying once the first settles
 * replays its stored response.
 */
export class IdempotencyInProgressProblem extends HttpProblem {
  constructor() {
    super(
      409,
      "idempotency-in-progress",
      "A request with this Idempotency-Key is still in progress",
      "Retry shortly; the first request's response is replayed once it completes.",
    );
  }
}

/** 400 for an `Idempotency-Key` that cannot be stored as one. */
export class InvalidIdempotencyKeyProblem extends HttpProblem {
  constructor(maxLength: number) {
    super(
      400,
      "invalid-idempotency-key",
      "Invalid Idempotency-Key",
      `Idempotency-Key must be at most ${maxLength} characters. A UUID is the usual choice.`,
      { max_length: maxLength },
    );
  }
}

// ── Translating errors we did not throw ────────────────────────────────

/**
 * Errors raised by the framework rather than by our code, which carry
 * their own verdict that the request was at fault:
 *
 *   - body-parser (`express.json`), built on `http-errors`: a 4xx
 *     `status`, `expose === true`, and a `type` such as
 *     `entity.parse.failed` or `entity.too.large`;
 *   - Express decoding a path parameter: a `URIError` with `status = 400`;
 *   - multer: a `MulterError` with a `LIMIT_*` code, and busboy's bare
 *     `Error`s for a multipart body it cannot parse.
 *
 * `status` is honoured from those sources only. An error that merely
 * has a `.status` — a failed upstream fetch, say — is not the caller's
 * 4xx.
 */
function frameworkProblem(err: unknown, req: Request): HttpProblem | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    name?: unknown;
    code?: unknown;
    type?: unknown;
    field?: unknown;
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    message?: unknown;
  };

  if (e.name === "MulterError" && typeof e.code === "string") {
    if (e.code === "LIMIT_UNEXPECTED_FILE" || e.code === "MISSING_FIELD_NAME") {
      const field = typeof e.field === "string" ? e.field.slice(0, 80) : undefined;
      return new HttpProblem(
        400,
        "malformed-upload",
        "Malformed multipart upload",
        field
          ? `Unexpected multipart field '${field}'.`
          : "The multipart body has a field this endpoint does not accept.",
        { code: e.code },
      );
    }
    return new HttpProblem(
      413,
      "payload-too-large",
      "Payload Too Large",
      "The upload exceeds this endpoint's size or part-count limit.",
      { code: e.code },
    );
  }

  // busboy and multer report an unparseable or cut-off multipart body
  // as a bare Error, recognisable only by its text. Believe that text
  // only on a request that actually was multipart.
  if (
    e.name === "Error" &&
    typeof e.message === "string" &&
    /^multipart\//i.test(req.header("content-type") ?? "") &&
    /^(Multipart: |Malformed part header|Malformed content type|Unexpected end of (form|file)|Request (aborted|closed))/.test(
      e.message,
    )
  ) {
    return new HttpProblem(
      400,
      "malformed-upload",
      "Malformed multipart upload",
      "The multipart body could not be parsed.",
    );
  }

  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined;
  const fromFramework = e.expose === true || err instanceof URIError;
  if (status === undefined || status < 400 || status > 499 || !fromFramework) {
    return null;
  }

  if (e.type === "entity.parse.failed") {
    return new HttpProblem(
      400,
      "malformed-body",
      "Malformed request body",
      "The request body is not valid JSON.",
    );
  }
  if (err instanceof URIError) {
    return new HttpProblem(
      400,
      "bad-request",
      "Bad Request",
      "The request URL contains an invalid percent-encoding.",
    );
  }
  // Anything else the framework rejects (413 too large, 415 unsupported
  // charset or encoding, …): its status, the standard phrase for it, and
  // none of its message.
  const title = STATUS_CODES[status] ?? "Bad Request";
  return new HttpProblem(
    status,
    title.toLowerCase().replace(/[^a-z]+/g, "-"),
    title,
    status === 413
      ? "The request body exceeds this endpoint's size limit."
      : undefined,
  );
}

/**
 * Last line of defence for an `HttpProblem` whose text was built from a
 * caught error's message. Drizzle's message is
 * `Failed query: <sql>\nparams: <values>`, and code that joins a cause
 * chain into `detail` carries it straight out. Cut it, keeping only what
 * follows the final ` | ` separator (the driver's own sentence) when
 * there is one.
 */
function scrubText(text: string): string {
  const at = text.indexOf("Failed query:");
  if (at === -1) return text;
  const sep = text.lastIndexOf(" | ");
  const tail = sep > at ? text.slice(sep + 3).trim() : "";
  const head = text.slice(0, at).replace(/[\s|]+$/, "");
  return (
    [head, tail].filter(Boolean).join(" | ") ||
    "Details withheld; see the server log."
  );
}

function scrub<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out as T;
  }
  return value;
}

export interface RenderedProblem {
  status: number;
  body: ProblemBody;
  /** Headers to send with it (`Retry-After` on a retryable 409). */
  headers: Record<string, string>;
}

/**
 * Turn anything thrown into the problem document a client may see, and
 * log what it may not.
 *
 * This is the one mapping behind `problemHandler`. It is exported for
 * the single handler that reports per-item failures inside a 200 (bulk).
 *
 *   HttpProblem / ZodError  → as thrown
 *   framework 4xx           → 400 / 413 / 415 (malformed JSON, oversize, …)
 *   Postgres client faults  → 400 / 409 / 422 (see `pg-error.ts`)
 *   Postgres deadlock or serialization failure
 *                           → 409 `concurrent-update` + `Retry-After`
 *   everything else         → 500, a fixed sentence and the trace id
 *
 * A 500 body never carries `err.message`: for a failed query that is the
 * SQL text and its parameters. The full error, with its stack and cause
 * chain, goes to the server log under the `trace_id` the body returns.
 */
export function renderProblem(err: unknown, req: Request): RenderedProblem {
  const traceId: string = req.traceId ?? randomUUID();
  const instance = req.originalUrl;
  const where = `${req.method} ${req.originalUrl}`;

  let problem: HttpProblem | null = null;
  if (err instanceof HttpProblem) {
    problem = err;
  } else if (err instanceof ZodError) {
    problem = ValidationProblem.fromZod(err);
  } else {
    problem = frameworkProblem(err, req);
    if (!problem) {
      const pg = findPgError(err);
      const spec = pg ? classifyPgError(pg) : null;
      if (pg && spec) {
        problem = new HttpProblem(
          spec.status,
          spec.type,
          spec.title,
          spec.detail,
          spec.extras,
        );
        if (spec.retryAfterSeconds !== undefined) {
          problem.headers = { "Retry-After": String(spec.retryAfterSeconds) };
        }
        // One line, not a stack: this is the caller's mistake (or a
        // validation we have yet to write), and the SQLSTATE plus the
        // driver's sentence is all it takes to find it.
        console.warn(
          `[http] trace_id=${traceId} ${where} → ${spec.status} ${spec.type} ` +
            `sqlstate=${pg.code}` +
            (pg.constraint ? ` constraint=${pg.constraint}` : "") +
            (pg.table ? ` table=${pg.table}` : "") +
            ` pg=${JSON.stringify(pg.message)}`,
        );
      }
    }
  }

  if (problem) {
    return {
      status: problem.status,
      body: scrub(problem.toBody(instance, traceId)),
      headers: problem.headers,
    };
  }

  console.error(`[http] trace_id=${traceId} ${where} → 500 unhandled:`, err);
  return {
    status: 500,
    headers: {},
    body: {
      type: `${TYPE_BASE}/internal`,
      title: "Internal Server Error",
      status: 500,
      detail:
        "Unexpected server error. The cause is in the server log under this trace_id.",
      ...(instance ? { instance } : {}),
      trace_id: traceId,
    },
  };
}

/**
 * What may be said about `err` in a place `renderProblem` does not reach:
 * a per-item `message` inside a 200 body, a status column a later GET
 * returns. Use it wherever the temptation is `err.message`.
 *
 * It follows the same rules as `renderProblem`, minus the request: a
 * problem we threw speaks for itself, a Postgres error the caller caused
 * gets its mapped sentence, and anything else gets a fixed one — for a
 * failed query `err.message` is the statement and its bound values. It
 * does not log; the caller logs the full error next to whatever
 * identifies the item, so the sentence can point at the log.
 */
export function publicErrorMessage(err: unknown): string {
  if (err instanceof HttpProblem) return scrubText(err.detail ?? err.title);
  if (err instanceof ZodError) return "Failed validation.";
  const pg = findPgError(err);
  if (pg) {
    return (
      classifyPgError(pg)?.detail ??
      `Database error (SQLSTATE ${pg.code}). The cause is in the server log.`
    );
  }
  return "Unexpected error. The cause is in the server log.";
}

/**
 * Terminal handler for a request no router claimed. Register it after
 * every router and before `problemHandler`; without it Express answers
 * with its own HTML page.
 */
export function routeNotFoundHandler(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new RouteNotFoundProblem(req.method, req.path));
}

/** Headers that belong to a successful representation, never to the
 *  error that replaced it. (`Retry-After`, set on purpose for a 409, is
 *  not one of them.) */
const SUCCESS_ONLY_HEADERS = [
  "Cache-Control",
  "ETag",
  "Last-Modified",
  "Expires",
  "Content-Disposition",
  "X-Cache",
] as const;

/**
 * Final Express error handler — must be registered AFTER all routes.
 */
export function problemHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // A stream failed mid-response. The status line has gone out; all
    // that is left is to log it and let Express tear the connection down.
    console.error(
      `[http] trace_id=${req.traceId ?? "-"} ${req.method} ${req.originalUrl} failed after headers were sent:`,
      err,
    );
    next(err);
    return;
  }
  // A handler can fail after staging headers for the success it
  // expected (a file route sets its cache lifetime and ETag, then the
  // file will not open). They describe a representation that is not
  // being sent; left in place, a browser would cache this error for as
  // long as the image was meant to live.
  for (const name of SUCCESS_ONLY_HEADERS) res.removeHeader(name);
  const { status, body, headers } = renderProblem(err, req);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).type("application/problem+json").json(body);
}
