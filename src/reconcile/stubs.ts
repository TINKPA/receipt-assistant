/**
 * Stub implementations for the three reconcile steps whose backing data
 * does not exist yet in the Phase 2a schema.
 *
 * Each stub returns `{ proposals: [], reason }` synchronously so the
 * engine can still emit a complete audit trail (which steps ran, which
 * skipped, why) to operators.
 *
 * Lifecycle
 *   payment_link  — unblocks when `statement_pdf` ingestion lands
 *                   (Phase 2b of #32 + #28's bank-statement consumer).
 *   inventory     — unblocks when the `inventory_items` +
 *                   `receipt_items` tables land (separate feature).
 *   trip_group    — unblocks when the `trips` table lands and the
 *                   geo/cluster proposal call is wired.
 *
 * When one of these steps ships, replace the corresponding stub with a
 * real detector module under `src/reconcile/<kind>.ts` and keep the
 * same return contract (`StubResult` → `{ proposals, reason? }`).
 */

/**
 * Return shape shared by every step detector (real or stubbed).
 *
 * `proposals` is a list of proto-proposal payloads; the engine wraps
 * each one in a `reconcile_proposals` row. `reason` is a free-text log
 * entry included in the step's skip note when `proposals.length === 0`.
 */
export interface StepResult {
  proposals: Array<{
    payload: Record<string, unknown>;
    score: number;
  }>;
  reason?: string;
}

/**
 * TODO(#32 Phase 2b): statement-line ↔ receipt payment linking.
 *
 * Requires `statement_pdf` ingestion to write N transactions per
 * statement row with a distinguishable source classification, so this
 * step can match them to receipt-sourced transactions by
 * fuzzy(merchant) + date±1 + amount. Blocked until statement ingestion
 * lands — Phase 1 explicitly maps statements to `unsupported` in the
 * worker.
 */
export async function paymentLinkStub(_params: {
  workspaceId: string;
  batchId: string;
}): Promise<StepResult> {
  return {
    proposals: [],
    reason:
      "payment_link step is stubbed until statement_pdf ingestion lands (Phase 2b of #32).",
  };
}

/**
 * TODO(separate feature): inventory aggregation.
 *
 * Needs `receipt_items` + `inventory_items` tables. Current schema
 * carries neither — transactions are headline-level only. When the
 * inventory feature lands, this stub is replaced by a detector that
 * upserts inventory rows from `receipt_items` and proposes consumption
 * stats updates.
 */
export async function inventoryStub(_params: {
  workspaceId: string;
  batchId: string;
}): Promise<StepResult> {
  return {
    proposals: [],
    reason:
      "inventory step is stubbed; receipt_items + inventory_items tables do not exist yet.",
  };
}

/**
 * TODO(separate feature): trip proposal from date/geo clustering.
 *
 * Requires a `trips` table + a `claude -p` clustering call. Deliberately
 * a stub in Phase 2a because the per-batch reconcile pipeline ships
 * before the trip module. Once trips exist, replace with a small
 * classifier that groups transactions by proximity and proposes a
 * trip_id assignment.
 */
export async function tripGroupStub(_params: {
  workspaceId: string;
  batchId: string;
}): Promise<StepResult> {
  return {
    proposals: [],
    reason:
      "trip_group step is stubbed until the trips table + clustering call ship.",
  };
}
