/**
 * Zod schemas for `/v1/ingest/batch`, `/v1/batches`, `/v1/ingests`.
 *
 * Phase 1 of issue #32 — the reconcile endpoints and SSE stream are
 * deferred to Phase 2. The `reconcile_proposals` table is defined but
 * no schema here covers proposal payloads yet; keep this file minimal.
 */
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.js";

// ── Enums (serialized as bare lowercase strings) ──────────────────────

export const BatchStatus = z
  .enum([
    "pending",
    "processing",
    "extracted",
    "reconciling",
    "reconciled",
    "failed",
    "reconcile_error",
  ])
  .openapi("BatchStatus");

export const IngestStatus = z
  .enum(["queued", "processing", "done", "error", "unsupported", "dedup", "near_dup"])
  .openapi("IngestStatus");

export const IngestClassification = z
  .enum([
    "receipt_image",
    "receipt_email",
    "receipt_pdf",
    "statement_pdf",
    "unsupported",
  ])
  .openapi("IngestClassification");

// Derived reason bucket (#158) so a client can pick the right affordance
// without string-parsing `error`:
//   ok                  → reached `done`, produced a transaction.
//   in_progress         → still `queued` / `processing`.
//   transient_actionable→ `error` from auth/timeout/rate-limit/upstream 5xx;
//                          retrying the same bytes is likely to succeed.
//   input_problem       → `unsupported`, or an `error` that looks like a
//                          bad/unreadable input; user should replace/correct.
//   informational       → `dedup` / `near_dup`; not an error. See `dedup_of`.
export const IngestCategory = z
  .enum([
    "ok",
    "in_progress",
    "transient_actionable",
    "input_problem",
    "informational",
  ])
  .openapi("IngestCategory");

// ── produced provenance ───────────────────────────────────────────────

export const IngestProduced = z
  .object({
    receipt_ids: z.array(Uuid).default([]),
    transaction_ids: z.array(Uuid).default([]),
    document_ids: z.array(Uuid).default([]),
  })
  .openapi("IngestProduced");

// ── Ingest resource ───────────────────────────────────────────────────

export const Ingest = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    batch_id: Uuid.nullable(),
    filename: z.string(),
    mime_type: z.string().nullable(),
    file_path: z.string(),
    status: IngestStatus,
    classification: IngestClassification.nullable(),
    produced: IngestProduced.nullable(),
    error: z.string().nullable(),
    // #158 — derived reason bucket + affordance hints. `category` and
    // `retryable` are computed from (status, error); `dedup_of` surfaces
    // the pre-existing transaction for a `dedup`/`near_dup` row so the
    // client can deep-link "already in your ledger → view it".
    category: IngestCategory,
    retryable: z.boolean(),
    dedup_of: Uuid.nullable(),
    created_at: IsoDateTime,
    completed_at: IsoDateTime.nullable(),
  })
  .openapi("Ingest");

// ── Batch resource ────────────────────────────────────────────────────

export const BatchCounts = z
  .object({
    total: z.number().int(),
    queued: z.number().int(),
    processing: z.number().int(),
    done: z.number().int(),
    error: z.number().int(),
    unsupported: z.number().int(),
    // L1 short-circuit hits (#124): files skipped before extraction
    // because they were byte-identical to an already-ingested receipt.
    dedup: z.number().int(),
    near_dup: z.number().int(),
  })
  .openapi("BatchCounts");

export const Batch = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    status: BatchStatus,
    file_count: z.number().int(),
    auto_reconcile: z.boolean(),
    counts: BatchCounts,
    items: z.array(Ingest),
    created_at: IsoDateTime,
    completed_at: IsoDateTime.nullable(),
    reconciled_at: IsoDateTime.nullable(),
  })
  .openapi("Batch");

// List shape omits the (potentially large) `items[]` — clients drill in
// with `GET /v1/batches/:id` when they want the per-file breakdown.
export const BatchSummary = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    status: BatchStatus,
    file_count: z.number().int(),
    auto_reconcile: z.boolean(),
    counts: BatchCounts,
    created_at: IsoDateTime,
    completed_at: IsoDateTime.nullable(),
    reconciled_at: IsoDateTime.nullable(),
  })
  .openapi("BatchSummary");

// ── Request shapes ────────────────────────────────────────────────────

// Multipart form: one or more `files` fields + optional `auto_reconcile`.
// zod-to-openapi can't fully model multipart; we register the shape so
// the spec documents the expected fields.
export const CreateBatchForm = z
  .object({
    files: z.any().openapi({ type: "array", items: { type: "string", format: "binary" } }),
    auto_reconcile: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .optional(),
  })
  .openapi("CreateBatchForm");

export const CreateBatchResponse = z
  .object({
    batchId: Uuid,
    status: BatchStatus,
    items: z.array(
      z.object({
        ingestId: Uuid,
        filename: z.string(),
        mime_type: z.string().nullable(),
      }),
    ),
    poll: z.string(),
  })
  .openapi("CreateBatchResponse");

// ── Query shapes ──────────────────────────────────────────────────────

export const ListBatchesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  status: BatchStatus.optional(),
});

export const ListIngestsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  batch_id: Uuid.optional(),
  // Single status OR a comma-separated set, e.g.
  // `status=error,unsupported,dedup,near_dup` (#158). Unknown tokens are
  // rejected 422 by the service.
  status: z
    .string()
    .optional()
    .openapi({
      description:
        "Filter by ingest status. Single value or comma-separated set, " +
        "e.g. `error,unsupported,dedup,near_dup`.",
      example: "error,unsupported",
    }),
});

// `GET /v1/ingests/problems` — same shape minus `batch_id`. When `status`
// is omitted the service defaults to the non-`done`, non-in-flight set
// (`error,unsupported,dedup,near_dup`).
export const IngestProblemsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  status: z
    .string()
    .optional()
    .openapi({
      description:
        "Override the default problem set. Comma-separated ingest " +
        "statuses; defaults to `error,unsupported,dedup,near_dup`.",
      example: "error",
    }),
});

// ── Retry ─────────────────────────────────────────────────────────────

// `POST /v1/ingests/:id/retry` re-runs the original stored bytes through
// the normal batch pipeline. The genuine-restore branch of L1 dedup means
// the byte-known input is NOT suppressed (the errored ingest produced no
// live transaction). Returns the freshly-created ingest so the caller can
// poll it; `ingest.status` is `queued` normally, or `dedup` if in the
// meantime the same purchase was ingested another way.
export const RetryIngestResponse = z
  .object({
    retried_ingest_id: Uuid,
    batch_id: Uuid,
    ingest: Ingest,
    poll: z.string(),
  })
  .openapi("RetryIngestResponse");
