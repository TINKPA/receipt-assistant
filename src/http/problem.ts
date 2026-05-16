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
 * and emits the correct status + headers. Uncaught / non-problem
 * errors surface as 500 with `type=errors/internal`.
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

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
  constructor(current: number, supplied?: number) {
    super(
      412,
      "version-mismatch",
      "Resource version mismatch",
      `If-Match supplied version=${supplied ?? "?"}, current=${current}. Re-fetch and retry.`,
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

export class MustVoidInsteadProblem extends HttpProblem {
  constructor(txId: string, status: string) {
    super(
      409,
      "must-void-instead",
      "Use POST /void instead of DELETE",
      `Transaction ${txId} is in status=${status}. Only draft/error transactions can be hard-deleted; posted/reconciled transactions must be voided.`,
      { transaction_id: txId, status },
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
 * Final Express error handler — must be registered AFTER all routes.
 */
export function problemHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = (req as any).traceId as string | undefined;
  const instance = req.originalUrl;

  if (err instanceof HttpProblem) {
    res
      .status(err.status)
      .type("application/problem+json")
      .json(err.toBody(instance, traceId));
    return;
  }

  if (err instanceof ZodError) {
    const p = ValidationProblem.fromZod(err);
    res
      .status(p.status)
      .type("application/problem+json")
      .json(p.toBody(instance, traceId));
    return;
  }

  // Unknown error — log and return generic 500. Never leak internals.
  console.error("[problemHandler] unhandled:", err);
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).type("application/problem+json").json({
    type: `${TYPE_BASE}/internal`,
    title: "Internal Server Error",
    status: 500,
    detail: message,
    ...(instance ? { instance } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  });
}
