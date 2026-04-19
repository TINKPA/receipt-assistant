/**
 * Zod schemas for `/v1/batches/:id/reconcile*` (Phase 2 of #32).
 *
 * The reconcile pipeline runs four steps over the extracted outputs of a
 * batch. Only the dedup step writes proposals today; `payment_link`,
 * `inventory`, and `trip_group` are registered as no-op stubs so the
 * payload shape + wiring is stable before backing data exists.
 *
 * Proposal shape is intentionally permissive — `payload` is a JSONB blob
 * whose schema varies by `kind`. Clients branch on `kind` and read
 * kind-specific fields from `payload`.
 */
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.js";

// ── Enumerations ──────────────────────────────────────────────────────

export const ReconcileKind = z
  .enum(["dedup", "payment_link", "trip_group", "inventory"])
  .openapi("ReconcileKind");

export const ReconcileProposalStatus = z
  .enum(["proposed", "auto_applied", "user_applied", "rejected"])
  .openapi("ReconcileProposalStatus");

export const ReconcileScope = z
  .enum(["batch", "batch_plus_recent_90d"])
  .openapi("ReconcileScope");

// ── Proposal ──────────────────────────────────────────────────────────

/**
 * A single reconcile finding.
 *
 * `payload` shape by kind:
 *   dedup         → { duplicate_of: <txn_id>, duplicate: <txn_id>, key: {...} }
 *   payment_link  → (stubbed) never emitted in Phase 2a
 *   inventory     → (stubbed) never emitted in Phase 2a
 *   trip_group    → (stubbed) never emitted in Phase 2a
 */
export const ReconcileProposal = z
  .object({
    id: Uuid,
    batch_id: Uuid,
    kind: ReconcileKind,
    payload: z.record(z.string(), z.unknown()),
    score: z.number().nullable(),
    status: ReconcileProposalStatus,
    created_at: IsoDateTime,
    resolved_at: IsoDateTime.nullable(),
  })
  .openapi("ReconcileProposal");

// ── Applied summary (read-model) ──────────────────────────────────────

export const ReconcileApplied = z
  .object({
    duplicates: z
      .array(
        z.object({
          receiptId: Uuid,
          duplicateOf: Uuid,
        }),
      )
      .default([]),
    payment_links: z.array(z.unknown()).default([]),
    inventory: z.array(z.unknown()).default([]),
    proposals_total: z.number().int(),
  })
  .openapi("ReconcileApplied");

// ── Request shapes ────────────────────────────────────────────────────

/**
 * Default behavior: enable all four steps, scope=batch, threshold=0.95.
 * Body is optional — `POST /v1/batches/:id/reconcile` with no body uses
 * the defaults above.
 */
export const ReconcileRequest = z
  .object({
    scope: ReconcileScope.optional().default("batch"),
    enable: z.array(ReconcileKind).optional(),
    // Scores are in [0, 1], so any value ≤ 1 *can* auto-apply, and any
    // value > 1 effectively disables auto-apply. We allow up to 2 so
    // callers can pass a sentinel like `1.01` to mean "propose only".
    auto_apply_threshold: z.number().min(0).max(2).optional().default(0.95),
  })
  .openapi("ReconcileRequest");

export const ApplyRequest = z
  .object({
    proposal_ids: z.array(Uuid).min(1),
  })
  .openapi("ApplyRequest");

export const RejectRequest = z
  .object({
    proposal_ids: z.array(Uuid).min(1),
    reason: z.string().optional(),
  })
  .openapi("RejectRequest");

// ── Response shapes ───────────────────────────────────────────────────

export const ReconcileBatchStatus = z
  .enum([
    "extracted",
    "reconciling",
    "reconciled",
    "reconcile_error",
  ])
  .openapi("ReconcileBatchStatus");

export const ReconcileResult = z
  .object({
    batchId: Uuid,
    status: ReconcileBatchStatus,
    applied: ReconcileApplied,
    proposals: z.array(ReconcileProposal),
    /** Present only when the batch is mid-reconcile (status=reconciling). */
    poll: z.string().optional(),
  })
  .openapi("ReconcileResult");

export const ApplyResult = z
  .object({
    applied: z.array(Uuid),
    skipped: z.array(
      z.object({
        id: Uuid,
        reason: z.string(),
      }),
    ),
  })
  .openapi("ApplyResult");

export const RejectResult = z
  .object({
    rejected: z.array(Uuid),
    skipped: z.array(
      z.object({
        id: Uuid,
        reason: z.string(),
      }),
    ),
  })
  .openapi("RejectResult");
