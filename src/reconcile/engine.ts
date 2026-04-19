/**
 * Reconcile pipeline orchestrator (#32 Phase 2a).
 *
 * Runs enabled detector steps against a batch that has reached
 * `status='extracted'`, writes findings as `reconcile_proposals` rows,
 * and flips the batch's status through the reconcile state machine:
 *
 *     extracted → reconciling → reconciled       (success)
 *     extracted → reconciling → reconcile_error  (uncaught failure)
 *
 * Idempotency:
 *   - A batch already in `reconciled` returns its stored proposals
 *     without re-running the steps.
 *   - A batch in `reconciling` is a concurrent run; the caller gets a
 *     `{status:"reconciling", poll}` hint and the existing run finishes
 *     on its own thread.
 *
 * Apply / reject:
 *   - `applyProposals` handles each proposal kind. For `dedup` it voids
 *     the duplicate transaction via the existing v1 service (so the
 *     balance trigger + audit log still fire) and stamps the proposal
 *     `status='user_applied'`.
 *   - `rejectProposals` just flips `status='rejected'` — no ledger
 *     mutation, proposal is frozen for future audit.
 *
 * Apply and auto-apply share the same action function so a dedup
 * voided above the auto-apply threshold and one applied by a human
 * produce identical ledger effects (one void + one voided-by link).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { batches, reconcileProposals, transactions } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import { NotFoundProblem } from "../http/problem.js";
import { voidTransaction } from "../routes/transactions.service.js";
import { detectDuplicates } from "./dedup.js";
import {
  paymentLinkStub,
  inventoryStub,
  tripGroupStub,
  type StepResult,
} from "./stubs.js";

// ── Types ─────────────────────────────────────────────────────────────

export type ReconcileKind = "dedup" | "payment_link" | "trip_group" | "inventory";
export type ReconcileProposalStatus =
  | "proposed"
  | "auto_applied"
  | "user_applied"
  | "rejected";

export interface ProposalRow {
  id: string;
  batch_id: string;
  kind: ReconcileKind;
  payload: Record<string, unknown>;
  score: number | null;
  status: ReconcileProposalStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface AppliedSummary {
  duplicates: Array<{ receiptId: string; duplicateOf: string }>;
  payment_links: unknown[];
  inventory: unknown[];
  proposals_total: number;
}

export interface ReconcileResultShape {
  batchId: string;
  status: "reconciling" | "reconciled" | "reconcile_error" | "extracted";
  applied: AppliedSummary;
  proposals: ProposalRow[];
  poll?: string;
}

export interface ReconcileOptions {
  scope?: "batch" | "batch_plus_recent_90d";
  enable?: ReconcileKind[];
  auto_apply_threshold?: number;
}

const DEFAULT_ENABLED: ReconcileKind[] = [
  "dedup",
  "payment_link",
  "trip_group",
  "inventory",
];
const DEFAULT_AUTO_APPLY_THRESHOLD = 0.95;

// ── Mappers ───────────────────────────────────────────────────────────

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return new Date(v).toISOString();
}

function mapProposal(r: typeof reconcileProposals.$inferSelect): ProposalRow {
  return {
    id: r.id,
    batch_id: r.batchId,
    kind: r.kind as ReconcileKind,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    status: r.status as ReconcileProposalStatus,
    created_at: toIso(r.createdAt)!,
    resolved_at: toIso(r.resolvedAt),
  };
}

// ── Load ──────────────────────────────────────────────────────────────

async function loadBatchStrict(
  workspaceId: string,
  batchId: string,
): Promise<typeof batches.$inferSelect> {
  const rows = await db
    .select()
    .from(batches)
    .where(and(eq(batches.id, batchId), eq(batches.workspaceId, workspaceId)));
  if (rows.length === 0) throw new NotFoundProblem("Batch", batchId);
  return rows[0]!;
}

async function loadProposals(batchId: string): Promise<ProposalRow[]> {
  const rows = await db
    .select()
    .from(reconcileProposals)
    .where(eq(reconcileProposals.batchId, batchId))
    .orderBy(reconcileProposals.createdAt);
  return rows.map(mapProposal);
}

function summarizeApplied(proposals: ProposalRow[]): AppliedSummary {
  const duplicates: AppliedSummary["duplicates"] = [];
  const payment_links: unknown[] = [];
  const inventory: unknown[] = [];
  for (const p of proposals) {
    if (p.status !== "auto_applied" && p.status !== "user_applied") continue;
    if (p.kind === "dedup") {
      const payload = p.payload as {
        duplicate?: string;
        duplicate_of?: string;
      };
      if (payload.duplicate && payload.duplicate_of) {
        duplicates.push({
          receiptId: payload.duplicate,
          duplicateOf: payload.duplicate_of,
        });
      }
    } else if (p.kind === "payment_link") {
      payment_links.push(p.payload);
    } else if (p.kind === "inventory") {
      inventory.push(p.payload);
    }
  }
  return {
    duplicates,
    payment_links,
    inventory,
    proposals_total: proposals.length,
  };
}

// ── Public read ───────────────────────────────────────────────────────

export async function getReconcileResult(
  workspaceId: string,
  batchId: string,
): Promise<ReconcileResultShape> {
  const batch = await loadBatchStrict(workspaceId, batchId);
  const proposals = await loadProposals(batchId);
  const status = batch.status as ReconcileResultShape["status"];
  return {
    batchId,
    status,
    applied: summarizeApplied(proposals),
    proposals,
    ...(status === "reconciling"
      ? { poll: `/v1/batches/${batchId}/reconcile` }
      : {}),
  };
}

// ── Dedup application (shared by auto-apply + user apply) ─────────────

/**
 * Void the duplicate transaction via the ledger service. Returns true
 * if the void happened; false if the row was already voided (idempotent
 * replay).
 */
async function voidDuplicate(params: {
  workspaceId: string;
  userId: string;
  duplicateId: string;
  canonicalId: string;
}): Promise<boolean> {
  const { workspaceId, userId, duplicateId, canonicalId } = params;
  const rows = await db
    .select({ version: transactions.version, status: transactions.status })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, duplicateId),
        eq(transactions.workspaceId, workspaceId),
      ),
    );
  if (rows.length === 0) return false;
  const cur = rows[0]!;
  if (cur.status === "voided" || cur.status === "draft" || cur.status === "error") {
    return false;
  }
  await voidTransaction(
    workspaceId,
    userId,
    duplicateId,
    Number(cur.version),
    `reconcile: duplicate of ${canonicalId}`,
  );
  return true;
}

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * Run the reconcile pipeline on a batch.
 *
 * Returns the final result synchronously. The HTTP route fires
 * this in-process: for Phase 2a batches with a handful of files the
 * dedup query dominates and completes in a few milliseconds. The
 * worker-triggered auto-reconcile path wraps the call in a fire-and-
 * forget promise so extraction's success isn't gated on reconcile.
 */
export async function runReconcile(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  options?: ReconcileOptions;
}): Promise<ReconcileResultShape> {
  const { workspaceId, userId, batchId, options = {} } = params;
  const enable = options.enable ?? DEFAULT_ENABLED;
  const threshold = options.auto_apply_threshold ?? DEFAULT_AUTO_APPLY_THRESHOLD;

  // Idempotency: take a conditional lock on the batch's status. Only a
  // batch currently `extracted` transitions to `reconciling`; anything
  // else short-circuits to a no-op read.
  const lock = await db.execute(
    sql`UPDATE batches
         SET status = 'reconciling'
       WHERE id = ${batchId}::uuid
         AND workspace_id = ${workspaceId}::uuid
         AND status = 'extracted'
      RETURNING id`,
  );
  if (lock.rows.length === 0) {
    // Not transitioning — either not-extracted, already reconciled, or
    // mid-reconcile by another caller. Return the authoritative view.
    return await getReconcileResult(workspaceId, batchId);
  }

  try {
    const newProposals: Array<{
      id: string;
      kind: ReconcileKind;
      payload: Record<string, unknown>;
      score: number;
      status: ReconcileProposalStatus;
      resolvedAt: Date | null;
    }> = [];

    // ── Step 1: dedup ────────────────────────────────────────────────
    if (enable.includes("dedup")) {
      const groups = await detectDuplicates({ workspaceId, batchId });
      for (const g of groups) {
        for (const dupId of g.duplicate_ids) {
          newProposals.push({
            id: newId(),
            kind: "dedup",
            payload: {
              duplicate: dupId,
              duplicate_of: g.canonical_id,
              key: {
                occurred_on: g.occurred_on,
                payee: g.payee,
                total_base_minor: g.total_base_minor,
              },
            },
            // Dedup is an exact match on four keys → always 1.0.
            score: 1.0,
            // Auto-apply later if threshold allows.
            status: "proposed",
            resolvedAt: null,
          });
        }
      }
    }

    // ── Step 2-4: stubs ──────────────────────────────────────────────
    const stubSteps: Array<{ kind: ReconcileKind; run: () => Promise<StepResult> }> = [];
    if (enable.includes("payment_link")) {
      stubSteps.push({
        kind: "payment_link",
        run: () => paymentLinkStub({ workspaceId, batchId }),
      });
    }
    if (enable.includes("inventory")) {
      stubSteps.push({
        kind: "inventory",
        run: () => inventoryStub({ workspaceId, batchId }),
      });
    }
    if (enable.includes("trip_group")) {
      stubSteps.push({
        kind: "trip_group",
        run: () => tripGroupStub({ workspaceId, batchId }),
      });
    }

    for (const step of stubSteps) {
      const r = await step.run();
      if (r.reason) {
        // eslint-disable-next-line no-console
        console.info(
          `[reconcile] batch=${batchId} step=${step.kind} skipped: ${r.reason}`,
        );
      }
      for (const p of r.proposals) {
        newProposals.push({
          id: newId(),
          kind: step.kind,
          payload: p.payload,
          score: p.score,
          status: "proposed",
          resolvedAt: null,
        });
      }
    }

    // ── Insert proposals row-by-row so we have IDs for auto-apply ────
    if (newProposals.length > 0) {
      await db.insert(reconcileProposals).values(
        newProposals.map((p) => ({
          id: p.id,
          batchId,
          kind: p.kind,
          payload: p.payload,
          score: p.score,
          status: p.status,
          resolvedAt: p.resolvedAt,
        })),
      );
    }

    // ── Auto-apply above threshold ───────────────────────────────────
    // Only dedup has a real action today; the stubs never produce
    // proposals so their auto-apply paths never fire.
    for (const p of newProposals) {
      if (p.score < threshold) continue;
      if (p.kind !== "dedup") continue;
      const payload = p.payload as {
        duplicate: string;
        duplicate_of: string;
      };
      try {
        const voided = await voidDuplicate({
          workspaceId,
          userId,
          duplicateId: payload.duplicate,
          canonicalId: payload.duplicate_of,
        });
        if (voided) {
          await db
            .update(reconcileProposals)
            .set({ status: "auto_applied", resolvedAt: new Date() })
            .where(eq(reconcileProposals.id, p.id));
        } else {
          // Row was already voided — mark the proposal resolved as
          // user_applied-retroactive so we don't leave a stuck
          // `proposed` row pointing at a void.
          await db
            .update(reconcileProposals)
            .set({ status: "auto_applied", resolvedAt: new Date() })
            .where(eq(reconcileProposals.id, p.id));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[reconcile] auto-apply failed for proposal ${p.id}:`,
          err,
        );
        // Leave proposal as `proposed` so a human can retry via apply.
      }
    }

    // ── Flip batch to reconciled ─────────────────────────────────────
    await db
      .update(batches)
      .set({ status: "reconciled", reconciledAt: new Date() })
      .where(
        and(eq(batches.id, batchId), eq(batches.workspaceId, workspaceId)),
      );

    return await getReconcileResult(workspaceId, batchId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[reconcile] batch=${batchId} failed:`, err);
    await db
      .update(batches)
      .set({ status: "reconcile_error" })
      .where(
        and(eq(batches.id, batchId), eq(batches.workspaceId, workspaceId)),
      );
    // Still return the current view so callers see the failure state.
    return await getReconcileResult(workspaceId, batchId);
  }
}

// ── Apply / reject ────────────────────────────────────────────────────

export interface ApplyOutcome {
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export async function applyProposals(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  proposalIds: string[];
}): Promise<ApplyOutcome> {
  const { workspaceId, userId, batchId, proposalIds } = params;
  // Sanity-check batch ownership.
  await loadBatchStrict(workspaceId, batchId);

  if (proposalIds.length === 0) return { applied: [], skipped: [] };

  const rows = await db
    .select()
    .from(reconcileProposals)
    .where(
      and(
        eq(reconcileProposals.batchId, batchId),
        inArray(reconcileProposals.id, proposalIds),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const applied: string[] = [];
  const skipped: ApplyOutcome["skipped"] = [];

  for (const pid of proposalIds) {
    const row = byId.get(pid);
    if (!row) {
      skipped.push({ id: pid, reason: "not_found" });
      continue;
    }
    if (row.status === "user_applied" || row.status === "auto_applied") {
      // Already applied — idempotent success.
      applied.push(pid);
      continue;
    }
    if (row.status === "rejected") {
      skipped.push({ id: pid, reason: "rejected" });
      continue;
    }

    if (row.kind === "dedup") {
      const payload = (row.payload ?? {}) as {
        duplicate?: string;
        duplicate_of?: string;
      };
      if (!payload.duplicate || !payload.duplicate_of) {
        skipped.push({ id: pid, reason: "malformed_payload" });
        continue;
      }
      try {
        await voidDuplicate({
          workspaceId,
          userId,
          duplicateId: payload.duplicate,
          canonicalId: payload.duplicate_of,
        });
        await db
          .update(reconcileProposals)
          .set({ status: "user_applied", resolvedAt: new Date() })
          .where(eq(reconcileProposals.id, pid));
        applied.push(pid);
      } catch (err) {
        skipped.push({
          id: pid,
          reason:
            err instanceof Error ? `void_failed: ${err.message}` : "void_failed",
        });
      }
    } else {
      // Stubbed kinds have no backing action yet.
      skipped.push({
        id: pid,
        reason: `kind=${row.kind} not applicable in Phase 2a`,
      });
    }
  }

  return { applied, skipped };
}

export interface RejectOutcome {
  rejected: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export async function rejectProposals(params: {
  workspaceId: string;
  batchId: string;
  proposalIds: string[];
  // `reason` is accepted by the API but not persisted — the
  // reconcile_proposals schema has no reason column, and a free-text
  // audit note fits better in the future audit_events table. We accept
  // it for forward-compat without writing anywhere.
  reason?: string;
}): Promise<RejectOutcome> {
  const { workspaceId, batchId, proposalIds } = params;
  await loadBatchStrict(workspaceId, batchId);

  if (proposalIds.length === 0) return { rejected: [], skipped: [] };

  const rows = await db
    .select()
    .from(reconcileProposals)
    .where(
      and(
        eq(reconcileProposals.batchId, batchId),
        inArray(reconcileProposals.id, proposalIds),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const rejected: string[] = [];
  const skipped: RejectOutcome["skipped"] = [];

  for (const pid of proposalIds) {
    const row = byId.get(pid);
    if (!row) {
      skipped.push({ id: pid, reason: "not_found" });
      continue;
    }
    if (row.status === "rejected") {
      rejected.push(pid);
      continue;
    }
    if (row.status === "user_applied" || row.status === "auto_applied") {
      skipped.push({ id: pid, reason: "already_applied" });
      continue;
    }

    await db
      .update(reconcileProposals)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(eq(reconcileProposals.id, pid));
    rejected.push(pid);
  }

  return { rejected, skipped };
}
