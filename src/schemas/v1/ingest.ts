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
  .enum(["queued", "processing", "done", "error", "unsupported"])
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
  status: IngestStatus.optional(),
});
