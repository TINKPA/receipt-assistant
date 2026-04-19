/**
 * FastMCP tools for the reconcile pipeline (#32 Phase 2a).
 *
 * Mirrors the `/v1/batches/:id/reconcile*` HTTP surface. Thin adapters
 * that call the engine directly so the MCP and HTTP paths share all
 * idempotency + ledger-mutation logic.
 */
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { SEED_USER_ID, SEED_WORKSPACE_ID } from "../db/seed.js";
import {
  applyProposals,
  getReconcileResult,
  rejectProposals,
  runReconcile,
  type ReconcileKind,
} from "../reconcile/engine.js";

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const KindSchema = z.enum([
  "dedup",
  "payment_link",
  "trip_group",
  "inventory",
]);

export function registerReconcileMcpTools(mcp: FastMCP): void {
  mcp.addTool({
    name: "reconcile_batch",
    description:
      "Run the reconcile pipeline on a batch. Idempotent: a second call on an already-reconciled batch returns the stored result without re-running the detectors.",
    parameters: z.object({
      batch_id: z.string().uuid(),
      scope: z.enum(["batch", "batch_plus_recent_90d"]).optional(),
      enable: z.array(KindSchema).optional(),
      auto_apply_threshold: z.number().min(0).max(1).optional(),
    }),
    execute: async (args) => {
      const out = await runReconcile({
        workspaceId: SEED_WORKSPACE_ID,
        userId: SEED_USER_ID,
        batchId: args.batch_id,
        options: {
          scope: args.scope,
          enable: args.enable as ReconcileKind[] | undefined,
          auto_apply_threshold: args.auto_apply_threshold,
        },
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "list_reconcile_proposals",
    description:
      "Return all reconcile proposals for a batch (including auto-applied and rejected) with the same payload shape the HTTP endpoint emits.",
    parameters: z.object({ batch_id: z.string().uuid() }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getReconcileResult(SEED_WORKSPACE_ID, args.batch_id);
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "apply_reconcile_proposal",
    description:
      "Apply one or more proposals by id. For dedup proposals this voids the duplicate transaction via the ledger service and marks the proposal `user_applied`.",
    parameters: z.object({
      batch_id: z.string().uuid(),
      proposal_ids: z.array(z.string().uuid()).min(1),
    }),
    execute: async (args) => {
      const out = await applyProposals({
        workspaceId: SEED_WORKSPACE_ID,
        userId: SEED_USER_ID,
        batchId: args.batch_id,
        proposalIds: args.proposal_ids,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "reject_reconcile_proposal",
    description:
      "Reject one or more proposals by id without mutating the ledger.",
    parameters: z.object({
      batch_id: z.string().uuid(),
      proposal_ids: z.array(z.string().uuid()).min(1),
      reason: z.string().optional(),
    }),
    execute: async (args) => {
      const out = await rejectProposals({
        workspaceId: SEED_WORKSPACE_ID,
        batchId: args.batch_id,
        proposalIds: args.proposal_ids,
        reason: args.reason,
      });
      return toJson(out);
    },
  });
}
