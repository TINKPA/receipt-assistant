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
 *   - A dedup pair is proposed ONCE per workspace, not once per batch
 *     that happens to see it (see `filterAlreadyProposed`).
 *
 * Proposal lifecycle (dedup):
 *
 *     proposed ──apply──▶ auto_applied | user_applied ──undo──▶ reverted
 *        │
 *        ├──reject──▶ rejected
 *        └──(a named row stopped being live)──▶ stale
 *
 *   - APPLY removes the duplicate: in ONE database transaction it moves
 *     the duplicate's document links to the surviving row, soft-deletes
 *     the duplicate, writes an event on both rows and stores on the
 *     proposal exactly which links moved (`payload.applied`). It refuses
 *     unless both rows are live and the money moved the same way.
 *   - UNDO is the inverse, driven by that record: restore the duplicate,
 *     move its links back, mark the proposal `reverted`.
 *   - REJECT and STALE never touch the ledger.
 *
 * Auto-apply and a person's apply run the same function, so a duplicate
 * removed above the threshold and one applied by hand leave identical
 * ledger effects and can be undone the same way.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import { batches, reconcileProposals } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import { NotFoundProblem } from "../http/problem.js";
import { detectDedupPairs } from "./dedup.js";
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
  | "rejected"
  | "reverted"
  | "stale";

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

/** A link the apply step took off the duplicate. `canonical_had_link`
 *  says whether the surviving row already carried the same document, in
 *  which case nothing was added there and undo must not remove it. */
export interface MovedLink {
  document_id: string;
  linked_at: string | null;
  canonical_had_link: boolean;
}

/** `payload.applied` — what applying a dedup proposal did. */
export interface AppliedRecord {
  at: string;
  by: string;
  via: "auto_applied" | "user_applied";
  duplicate_prior_status: string;
  links: MovedLink[];
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ── Dedup: apply (shared by auto-apply + user apply) ──────────────────

export type DedupApplyResult =
  | { outcome: "applied"; record: AppliedRecord }
  | { outcome: "already_applied" }
  /** A named row is not live any more. The proposal was closed as
   *  `stale`; nothing in the ledger changed. */
  | { outcome: "stale"; reason: "duplicate_not_live" | "canonical_not_live" }
  /** Nothing changed and the proposal keeps its status. */
  | { outcome: "refused"; reason: string };

/**
 * Money direction of each named transaction, read inside the apply
 * transaction. Same leg selection as the detector (`dedup.ts`): the
 * expense/income leg by ACCOUNT TYPE, signed, so a refund is negative.
 */
async function loadDirections(
  tx: DbTx,
  ids: string[],
): Promise<
  Map<string, { hasPl: boolean; total: number; flow: string | null; refundOf: string | null }>
> {
  const res = await tx.execute(sql`
    SELECT t.id,
           t.metadata->>'flow'      AS flow,
           t.metadata->>'refund_of' AS refund_of,
           s.has_pl, s.total
      FROM transactions t
     CROSS JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE a.type IN ('expense', 'income')) > 0 AS has_pl,
                  COALESCE(SUM(CASE a.type
                                 WHEN 'income'  THEN -p.amount_base_minor
                                 WHEN 'expense' THEN  p.amount_base_minor
                               END), 0) AS total
             FROM postings p
             JOIN accounts a ON a.id = p.account_id
            WHERE p.transaction_id = t.id
           ) s
     WHERE t.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})`);
  const out = new Map<
    string,
    { hasPl: boolean; total: number; flow: string | null; refundOf: string | null }
  >();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    out.set(String(r.id), {
      hasPl: r.has_pl === true,
      total: Number(r.total),
      flow: typeof r.flow === "string" && r.flow !== "" ? r.flow : null,
      refundOf:
        typeof r.refund_of === "string" && r.refund_of !== "" ? r.refund_of : null,
    });
  }
  return out;
}

/**
 * Apply one dedup proposal: fold the duplicate into the surviving row.
 *
 * ONE database transaction, with the proposal and both ledger rows
 * locked for its duration. Either every effect below is committed or
 * none is:
 *
 *   1. the duplicate's document links are added to the surviving row
 *      (documents are evidence and never casualties of ledger repair);
 *   2. the duplicate loses those links and is soft-deleted (#171: the
 *      bank line is ground truth, so a duplicate is removed reversibly,
 *      not reversed with a negated mirror);
 *   3. an event is written on BOTH rows;
 *   4. the proposal records exactly which links moved, so `undo` can put
 *      them back.
 *
 * The previous version ran these as separate autocommit statements with
 * the delete last, recorded nothing, and never looked at the surviving
 * row — so a duplicate that could not be deleted kept living without its
 * evidence, a restore returned a transaction with no documents, and the
 * survivor could itself be a deleted row.
 */
async function applyDedupProposal(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  proposalId: string;
  via: "auto_applied" | "user_applied";
}): Promise<DedupApplyResult> {
  const { workspaceId, userId, batchId, proposalId, via } = params;
  return await db.transaction(async (tx): Promise<DedupApplyResult> => {
    const pr = await tx.execute(sql`
      SELECT rp.status, rp.payload
        FROM reconcile_proposals rp
        JOIN batches b ON b.id = rp.batch_id
       WHERE rp.id = ${proposalId}::uuid
         AND rp.batch_id = ${batchId}::uuid
         AND b.workspace_id = ${workspaceId}::uuid
         AND rp.kind = 'dedup'
       FOR UPDATE OF rp`);
    const prop = pr.rows[0] as
      | { status: string; payload: Record<string, unknown> | null }
      | undefined;
    if (!prop) return { outcome: "refused", reason: "not_found" };
    if (prop.status === "auto_applied" || prop.status === "user_applied") {
      return { outcome: "already_applied" };
    }
    if (prop.status !== "proposed") {
      return { outcome: "refused", reason: prop.status };
    }
    const payload = prop.payload ?? {};
    const duplicateId = String(payload.duplicate ?? "");
    const canonicalId = String(payload.duplicate_of ?? "");
    if (
      !UUID_RE.test(duplicateId) ||
      !UUID_RE.test(canonicalId) ||
      duplicateId === canonicalId
    ) {
      return { outcome: "refused", reason: "malformed_payload" };
    }

    // Lock both ledger rows (id order, so two applies cannot deadlock).
    // Base table on purpose: this has to tell "missing" from "deleted".
    const locked = await tx.execute(sql`
      SELECT id, status
        FROM transactions
       WHERE workspace_id = ${workspaceId}::uuid
         AND id IN (${duplicateId}::uuid, ${canonicalId}::uuid)
       ORDER BY id
         FOR UPDATE`);
    const statusOf = new Map(
      (locked.rows as Array<{ id: string; status: string }>).map((r) => [
        r.id,
        r.status,
      ]),
    );
    // ...and ask the one definition of live about both.
    const liveRes = await tx.execute(sql`
      SELECT id FROM ${liveTransactions}
       WHERE workspace_id = ${workspaceId}::uuid
         AND id IN (${duplicateId}::uuid, ${canonicalId}::uuid)`);
    const live = new Set((liveRes.rows as Array<{ id: string }>).map((r) => r.id));

    const closeStale = async (
      reason: "duplicate_not_live" | "canonical_not_live",
    ): Promise<DedupApplyResult> => {
      await tx.execute(sql`
        UPDATE reconcile_proposals
           SET status = 'stale',
               resolved_at = NOW(),
               payload = payload || jsonb_build_object(
                 'stale', jsonb_build_object('reason', ${reason}::text, 'at', NOW()))
         WHERE id = ${proposalId}::uuid`);
      return { outcome: "stale", reason };
    };
    if (!live.has(duplicateId)) return await closeStale("duplicate_not_live");
    // The survivor must itself be live. Moving evidence onto a deleted
    // row and then deleting the only live copy leaves the purchase
    // nowhere in the ledger.
    if (!live.has(canonicalId)) return await closeStale("canonical_not_live");

    const priorStatus = statusOf.get(duplicateId)!;
    if (priorStatus === "reconciled") {
      // Matched to a bank line: same guard as DELETE /v1/transactions/:id.
      return { outcome: "refused", reason: "duplicate_reconciled" };
    }

    // Direction gate, enforced again at the point of deletion. Detection
    // already applies it, but proposals written before it existed are
    // still on file, and rows can be edited between detection and apply.
    const dirs = await loadDirections(tx, [duplicateId, canonicalId]);
    const d = dirs.get(duplicateId);
    const c = dirs.get(canonicalId);
    if (
      !d ||
      !c ||
      d.hasPl !== c.hasPl ||
      Math.sign(d.total) !== Math.sign(c.total) ||
      (d.flow !== null && c.flow !== null && d.flow !== c.flow) ||
      d.refundOf === canonicalId ||
      c.refundOf === duplicateId
    ) {
      return { outcome: "refused", reason: "direction_mismatch" };
    }

    // 1+2. Move the evidence, remembering exactly what moved.
    const linkRes = await tx.execute(sql`
      SELECT dl.document_id,
             dl.created_at AS linked_at,
             EXISTS (SELECT 1 FROM document_links k
                      WHERE k.document_id = dl.document_id
                        AND k.transaction_id = ${canonicalId}::uuid) AS canonical_had_link
        FROM document_links dl
       WHERE dl.transaction_id = ${duplicateId}::uuid
       ORDER BY dl.document_id
         FOR UPDATE OF dl`);
    const links: MovedLink[] = (
      linkRes.rows as Array<{
        document_id: string;
        linked_at: Date | string | null;
        canonical_had_link: boolean;
      }>
    ).map((r) => ({
      document_id: r.document_id,
      linked_at: toIso(r.linked_at),
      canonical_had_link: r.canonical_had_link === true,
    }));
    await tx.execute(sql`
      INSERT INTO document_links (document_id, transaction_id)
      SELECT dl.document_id, ${canonicalId}::uuid
        FROM document_links dl
       WHERE dl.transaction_id = ${duplicateId}::uuid
      ON CONFLICT DO NOTHING`);
    await tx.execute(
      sql`DELETE FROM document_links WHERE transaction_id = ${duplicateId}::uuid`,
    );

    // 2. Soft delete — same effect and event type as
    // `softDeleteTransaction`, inlined because that function opens its
    // own transaction and this delete must commit or roll back with the
    // link move above.
    await tx.execute(
      sql`UPDATE transactions SET deleted_at = NOW() WHERE id = ${duplicateId}::uuid`,
    );

    // 3. Both rows get an event.
    const addedToCanonical = links
      .filter((l) => !l.canonical_had_link)
      .map((l) => l.document_id);
    await tx.execute(sql`
      INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
      VALUES
        (${newId()}::uuid, ${workspaceId}::uuid, ${duplicateId}::uuid, 'deleted', ${userId}::uuid,
         ${JSON.stringify({
           reason: `reconcile: duplicate of ${canonicalId}`,
           prior_status: priorStatus,
           proposal_id: proposalId,
           canonical_id: canonicalId,
           moved_links: links,
         })}::jsonb),
        (${newId()}::uuid, ${workspaceId}::uuid, ${canonicalId}::uuid, 'dedup_absorbed', ${userId}::uuid,
         ${JSON.stringify({
           proposal_id: proposalId,
           duplicate_id: duplicateId,
           documents_added: addedToCanonical,
         })}::jsonb)`);

    // 4. The record `undo` reads.
    const record: AppliedRecord = {
      at: new Date().toISOString(),
      by: userId,
      via,
      duplicate_prior_status: priorStatus,
      links,
    };
    await tx.execute(sql`
      UPDATE reconcile_proposals
         SET status = ${via}::text,
             resolved_at = NOW(),
             payload = payload || jsonb_build_object('applied', ${JSON.stringify(record)}::jsonb)
       WHERE id = ${proposalId}::uuid`);
    return { outcome: "applied", record };
  });
}

// ── Dedup: undo ───────────────────────────────────────────────────────

export interface UndoneProposal {
  id: string;
  transaction_id: string;
  canonical_id: string;
  /** False when the duplicate had already been restored by other means. */
  restored: boolean;
  /** Documents linked to the restored transaction again. */
  documents_relinked: string[];
  /** Documents taken back off the surviving row. */
  documents_removed_from_canonical: string[];
  /** `recorded`: read from `payload.applied`. `inferred`: the proposal
   *  predates that record, so the links were rebuilt from ingest history
   *  and link timestamps. */
  links_source: "recorded" | "inferred";
}

type DedupUndoResult =
  | { outcome: "reverted"; detail: UndoneProposal }
  | { outcome: "already_reverted" }
  | { outcome: "refused"; reason: string };

/**
 * Which links did applying this proposal take off the duplicate?
 *
 * Proposals applied by this version carry the answer in
 * `payload.applied.links`. Older ones recorded nothing, so it is rebuilt
 * from two facts that survived:
 *
 *   - a document "belonged" to the duplicate if an ingest of that file
 *     named the duplicate in `produced.transaction_ids` (its source
 *     ingest, or a later near-dup attach);
 *   - the old apply INSERTed the surviving row's copy of the link
 *     between the proposal's `created_at` and `resolved_at`, so a link
 *     on the surviving row stamped inside that window was moved there,
 *     while one stamped outside it was the survivor's own.
 */
async function resolveMovedLinks(
  tx: DbTx,
  args: {
    workspaceId: string;
    proposalId: string;
    payload: Record<string, unknown>;
    duplicateId: string;
    canonicalId: string;
  },
): Promise<{ links: MovedLink[]; source: "recorded" | "inferred" }> {
  const applied = args.payload.applied as Partial<AppliedRecord> | undefined;
  if (applied && Array.isArray(applied.links)) {
    const links = applied.links.filter(
      (l): l is MovedLink =>
        !!l && typeof l.document_id === "string" && UUID_RE.test(l.document_id),
    );
    return { links, source: "recorded" };
  }
  const res = await tx.execute(sql`
    WITH prop AS (
      SELECT created_at - INTERVAL '5 seconds' AS lo,
             COALESCE(resolved_at, created_at) + INTERVAL '5 seconds' AS hi
        FROM reconcile_proposals WHERE id = ${args.proposalId}::uuid
    ),
    owned AS (
      SELECT DISTINCT d.id AS document_id
        FROM ingests i
        JOIN documents d
          ON d.workspace_id = i.workspace_id AND d.file_path = i.file_path
       WHERE i.workspace_id = ${args.workspaceId}::uuid
         AND (jsonb_exists(COALESCE(i.produced->'transaction_ids', '[]'::jsonb), ${args.duplicateId}::text)
              OR i.id = (SELECT source_ingest_id FROM transactions WHERE id = ${args.duplicateId}::uuid))
    )
    SELECT o.document_id,
           k.created_at AS canonical_linked_at,
           (k.document_id IS NOT NULL
             AND NOT (k.created_at BETWEEN (SELECT lo FROM prop) AND (SELECT hi FROM prop))
           ) AS canonical_had_link
      FROM owned o
      LEFT JOIN document_links k
        ON k.document_id = o.document_id
       AND k.transaction_id = ${args.canonicalId}::uuid
     ORDER BY o.document_id`);
  const links: MovedLink[] = (
    res.rows as Array<{ document_id: string; canonical_had_link: boolean }>
  ).map((r) => ({
    document_id: r.document_id,
    linked_at: null,
    canonical_had_link: r.canonical_had_link === true,
  }));
  return { links, source: "inferred" };
}

/**
 * Undo one applied dedup proposal: restore the duplicate and give it its
 * documents back. One database transaction, like apply.
 *
 * Refuses, changing nothing, when the duplicate's current deletion is
 * not this proposal's doing (it was restored and then removed again for
 * another reason), and when a proposal applied before links were
 * recorded leaves no trace of which documents moved — restoring a
 * transaction without its evidence is the failure this function exists
 * to end.
 */
async function undoDedupProposal(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  proposalId: string;
}): Promise<DedupUndoResult> {
  const { workspaceId, userId, batchId, proposalId } = params;
  return await db.transaction(async (tx): Promise<DedupUndoResult> => {
    const pr = await tx.execute(sql`
      SELECT rp.status, rp.payload
        FROM reconcile_proposals rp
        JOIN batches b ON b.id = rp.batch_id
       WHERE rp.id = ${proposalId}::uuid
         AND rp.batch_id = ${batchId}::uuid
         AND b.workspace_id = ${workspaceId}::uuid
         AND rp.kind = 'dedup'
       FOR UPDATE OF rp`);
    const prop = pr.rows[0] as
      | { status: string; payload: Record<string, unknown> | null }
      | undefined;
    if (!prop) return { outcome: "refused", reason: "not_found" };
    if (prop.status === "reverted") return { outcome: "already_reverted" };
    if (prop.status !== "auto_applied" && prop.status !== "user_applied") {
      return { outcome: "refused", reason: `not_applied (${prop.status})` };
    }
    const payload = prop.payload ?? {};
    const duplicateId = String(payload.duplicate ?? "");
    const canonicalId = String(payload.duplicate_of ?? "");
    if (!UUID_RE.test(duplicateId) || !UUID_RE.test(canonicalId)) {
      return { outcome: "refused", reason: "malformed_payload" };
    }

    // Base table on purpose: the row we are looking for is deleted.
    const locked = await tx.execute(sql`
      SELECT id, deleted_at
        FROM transactions
       WHERE workspace_id = ${workspaceId}::uuid
         AND id IN (${duplicateId}::uuid, ${canonicalId}::uuid)
       ORDER BY id
         FOR UPDATE`);
    const rows = new Map(
      (locked.rows as Array<{ id: string; deleted_at: Date | string | null }>).map(
        (r) => [r.id, r],
      ),
    );
    const dup = rows.get(duplicateId);
    if (!dup) return { outcome: "refused", reason: "duplicate_missing" };
    const wasDeleted = dup.deleted_at !== null;

    if (wasDeleted) {
      // Only undo a deletion this proposal performed. The newest removal
      // event on the row must be the engine's, for this surviving row
      // (`voided` is what the pre-#171 engine wrote).
      const ev = await tx.execute(sql`
        SELECT payload
          FROM transaction_events
         WHERE transaction_id = ${duplicateId}::uuid
           AND event_type IN ('deleted', 'voided')
         ORDER BY created_at DESC, id DESC
         LIMIT 1`);
      const last = (ev.rows[0] as { payload: Record<string, unknown> } | undefined)
        ?.payload;
      const mine =
        !!last &&
        (last.proposal_id === proposalId ||
          last.reason === `reconcile: duplicate of ${canonicalId}`);
      if (!mine) {
        return { outcome: "refused", reason: "not_deleted_by_this_proposal" };
      }
    }

    const { links, source } = await resolveMovedLinks(tx, {
      workspaceId,
      proposalId,
      payload,
      duplicateId,
      canonicalId,
    });
    if (source === "inferred" && links.length === 0) {
      return { outcome: "refused", reason: "no_link_record" };
    }

    // Put the evidence back. A document deleted outright since the apply
    // has no row to link and is skipped.
    const relinked: string[] = [];
    const removed: string[] = [];
    for (const l of links) {
      const ins = await tx.execute(sql`
        INSERT INTO document_links (document_id, transaction_id, created_at)
        SELECT d.id, ${duplicateId}::uuid, COALESCE(${l.linked_at}::timestamptz, NOW())
          FROM documents d
         WHERE d.id = ${l.document_id}::uuid
           AND d.workspace_id = ${workspaceId}::uuid
        ON CONFLICT DO NOTHING
        RETURNING document_id`);
      if (ins.rows.length > 0) relinked.push(l.document_id);
      if (!l.canonical_had_link) {
        const del = await tx.execute(sql`
          DELETE FROM document_links
           WHERE document_id = ${l.document_id}::uuid
             AND transaction_id = ${canonicalId}::uuid
          RETURNING document_id`);
        if (del.rows.length > 0) removed.push(l.document_id);
      }
    }

    if (wasDeleted) {
      // Same effect and event type as `restoreTransaction`, inlined for
      // the same reason as the delete in apply.
      await tx.execute(
        sql`UPDATE transactions SET deleted_at = NULL WHERE id = ${duplicateId}::uuid`,
      );
      await tx.execute(sql`
        INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
        VALUES (${newId()}::uuid, ${workspaceId}::uuid, ${duplicateId}::uuid, 'restored', ${userId}::uuid,
                ${JSON.stringify({
                  reason: "reconcile: undo",
                  proposal_id: proposalId,
                  canonical_id: canonicalId,
                  documents_relinked: relinked,
                  links_source: source,
                })}::jsonb)`);
    }
    if (rows.has(canonicalId)) {
      await tx.execute(sql`
        INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
        VALUES (${newId()}::uuid, ${workspaceId}::uuid, ${canonicalId}::uuid, 'dedup_reverted', ${userId}::uuid,
                ${JSON.stringify({
                  proposal_id: proposalId,
                  duplicate_id: duplicateId,
                  documents_removed: removed,
                })}::jsonb)`);
    }

    const detail: UndoneProposal = {
      id: proposalId,
      transaction_id: duplicateId,
      canonical_id: canonicalId,
      restored: wasDeleted,
      documents_relinked: relinked,
      documents_removed_from_canonical: removed,
      links_source: source,
    };
    await tx.execute(sql`
      UPDATE reconcile_proposals
         SET status = 'reverted',
             resolved_at = NOW(),
             payload = payload || jsonb_build_object('reverted', ${JSON.stringify({
               at: new Date().toISOString(),
               by: userId,
               restored: wasDeleted,
               documents_relinked: relinked,
               documents_removed_from_canonical: removed,
               links_source: source,
             })}::jsonb)
       WHERE id = ${proposalId}::uuid`);
    return { outcome: "reverted", detail };
  });
}

// ── Dedup: housekeeping ───────────────────────────────────────────────

/**
 * Close open dedup proposals that name a transaction which is no longer
 * live (soft-deleted, hard-deleted, or no longer posted). Such a
 * proposal cannot be applied and must not sit in a review queue asking a
 * person to fold a receipt into a deleted row. `stale` is terminal but
 * does not block the pair from being proposed again if both rows are
 * live at some later reconcile. Ledger rows are not touched.
 */
export async function closeStaleProposals(workspaceId: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE reconcile_proposals rp
       SET status = 'stale',
           resolved_at = NOW(),
           payload = rp.payload || jsonb_build_object(
             'stale', jsonb_build_object(
               'reason',
               CASE WHEN NOT EXISTS (SELECT 1 FROM ${liveTransactions} t
                                      WHERE t.workspace_id = b.workspace_id
                                        AND t.id::text = rp.payload->>'duplicate')
                    THEN 'duplicate_not_live' ELSE 'canonical_not_live' END,
               'at', NOW()))
      FROM batches b
     WHERE b.id = rp.batch_id
       AND b.workspace_id = ${workspaceId}::uuid
       AND rp.kind = 'dedup'
       AND rp.status = 'proposed'
       AND (NOT EXISTS (SELECT 1 FROM ${liveTransactions} t
                         WHERE t.workspace_id = b.workspace_id
                           AND t.id::text = rp.payload->>'duplicate')
         OR NOT EXISTS (SELECT 1 FROM ${liveTransactions} t
                         WHERE t.workspace_id = b.workspace_id
                           AND t.id::text = rp.payload->>'duplicate_of'))
    RETURNING rp.id`);
  return res.rows.length;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Drop pairs that already have a proposal anywhere in the workspace.
 *
 * The key is the UNORDERED pair, across every batch and every status
 * except `stale`: a pair that is waiting, was applied, was rejected or
 * was reverted has had its one proposal. The old key was scoped to the
 * batch, so each later batch that saw the same two rows proposed them
 * again, and a person's "no" lasted until the next upload.
 */
async function filterAlreadyProposed<T extends { payload: Record<string, unknown> }>(
  workspaceId: string,
  candidates: T[],
): Promise<T[]> {
  const ids = new Set<string>();
  for (const c of candidates) {
    ids.add(String(c.payload.duplicate));
    ids.add(String(c.payload.duplicate_of));
  }
  if (ids.size === 0) return candidates;
  const idList = sql.join(
    [...ids].map((id) => sql`${id}`),
    sql`, `,
  );
  const prior = await db.execute(sql`
    SELECT rp.payload->>'duplicate' AS a, rp.payload->>'duplicate_of' AS b
      FROM reconcile_proposals rp
      JOIN batches bt ON bt.id = rp.batch_id
     WHERE bt.workspace_id = ${workspaceId}::uuid
       AND rp.kind = 'dedup'
       AND rp.status <> 'stale'
       AND (rp.payload->>'duplicate' IN (${idList})
         OR rp.payload->>'duplicate_of' IN (${idList}))`);
  const seen = new Set(
    (prior.rows as Array<{ a: string | null; b: string | null }>).map((r) =>
      pairKey(String(r.a ?? ""), String(r.b ?? "")),
    ),
  );
  const out: T[] = [];
  for (const c of candidates) {
    const k = pairKey(String(c.payload.duplicate), String(c.payload.duplicate_of));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * One reconcile at a time per workspace.
 *
 * Auto-reconcile is fire-and-forget, so two batches that finish close
 * together reconcile concurrently. Each would read "no proposal for this
 * pair yet", and both would write one. Detection, the already-proposed
 * check, the insert and auto-apply therefore run as one critical
 * section. An in-process chain is enough because the ingest queue that
 * triggers reconcile lives in this same process (see `worker.ts`); the
 * apply itself is additionally protected by row locks.
 */
const reconcileChains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = reconcileChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  reconcileChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

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

  return await serialized(workspaceId, () =>
    reconcileLockedBatch({ workspaceId, userId, batchId, enable, threshold }),
  );
}

/** The body of `runReconcile`, for a batch already flipped to
 *  `reconciling`. Runs inside the per-workspace critical section. */
async function reconcileLockedBatch(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  enable: ReconcileKind[];
  threshold: number;
}): Promise<ReconcileResultShape> {
  const { workspaceId, userId, batchId, enable, threshold } = params;
  try {
    let newProposals: Array<{
      id: string;
      kind: ReconcileKind;
      payload: Record<string, unknown>;
      score: number;
      status: ReconcileProposalStatus;
      resolvedAt: Date | null;
    }> = [];

    // ── Step 1: dedup ────────────────────────────────────────────────
    if (enable.includes("dedup")) {
      // Open proposals whose rows are gone cannot be acted on any more.
      const closed = await closeStaleProposals(workspaceId);
      if (closed > 0) {
        // eslint-disable-next-line no-console
        console.info(
          `[reconcile] batch=${batchId} closed ${closed} stale dedup proposal(s) naming a non-live transaction`,
        );
      }

      // Both passes (in-batch exact key, cross-batch ±3 days), scored
      // and reduced to one proposal per row. See `dedup.ts` for the
      // rules; 1.0 needs an identifier match, everything else is capped
      // at 0.9 and waits for a person.
      const pairs = await detectDedupPairs({ workspaceId, batchId });
      for (const p of pairs) {
        newProposals.push({
          id: newId(),
          kind: "dedup",
          payload: {
            duplicate: p.duplicate_id,
            duplicate_of: p.canonical_id,
            pass: p.pass,
            // `near` predates `pass` and is kept for readers of older rows.
            ...(p.pass === "cross_batch" ? { near: true } : {}),
            key: {
              occurred_on: p.occurred_on,
              canonical_occurred_on: p.canonical_occurred_on,
              payee: p.payee,
              canonical_payee: p.canonical_payee,
              total_base_minor: p.total_base_minor,
            },
            reasons: p.reasons,
          },
          score: p.score,
          status: "proposed",
          resolvedAt: null,
        });
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

    // ── One proposal per pair, ever (#135 hardening, widened) ────────
    {
      const dedup = newProposals.filter((p) => p.kind === "dedup");
      const kept = new Set(
        (await filterAlreadyProposed(workspaceId, dedup)).map((p) => p.id),
      );
      newProposals = newProposals.filter(
        (p) => p.kind !== "dedup" || kept.has(p.id),
      );
    }

    // ── Insert proposals so they have IDs for auto-apply ─────────────
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
      try {
        const r = await applyDedupProposal({
          workspaceId,
          userId,
          batchId,
          proposalId: p.id,
          via: "auto_applied",
        });
        if (r.outcome === "refused" || r.outcome === "stale") {
          // eslint-disable-next-line no-console
          console.warn(
            `[reconcile] auto-apply of proposal ${p.id} did not run: ${r.outcome} (${r.reason})`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[reconcile] auto-apply failed for proposal ${p.id}:`,
          err,
        );
        // The apply transaction rolled back as a whole; the proposal is
        // still `proposed` and a person can retry via apply.
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

// ── Apply / reject / undo ─────────────────────────────────────────────

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
    .select({ id: reconcileProposals.id, kind: reconcileProposals.kind })
    .from(reconcileProposals)
    .where(
      and(
        eq(reconcileProposals.batchId, batchId),
        inArray(reconcileProposals.id, proposalIds),
      ),
    );
  const kindById = new Map(rows.map((r) => [r.id, r.kind]));

  const applied: string[] = [];
  const skipped: ApplyOutcome["skipped"] = [];

  for (const pid of proposalIds) {
    const kind = kindById.get(pid);
    if (!kind) {
      skipped.push({ id: pid, reason: "not_found" });
      continue;
    }
    if (kind !== "dedup") {
      // Stubbed kinds have no backing action yet.
      skipped.push({
        id: pid,
        reason: `kind=${kind} not applicable in Phase 2a`,
      });
      continue;
    }
    try {
      const r = await applyDedupProposal({
        workspaceId,
        userId,
        batchId,
        proposalId: pid,
        via: "user_applied",
      });
      if (r.outcome === "applied" || r.outcome === "already_applied") {
        // Already applied — idempotent success.
        applied.push(pid);
      } else if (r.outcome === "stale") {
        skipped.push({ id: pid, reason: `stale: ${r.reason}` });
      } else {
        skipped.push({ id: pid, reason: r.reason });
      }
    } catch (err) {
      skipped.push({
        id: pid,
        reason:
          err instanceof Error ? `apply_failed: ${err.message}` : "apply_failed",
      });
    }
  }

  return { applied, skipped };
}

export interface UndoOutcome {
  reverted: UndoneProposal[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Undo applied dedup proposals: restore each duplicate and move its
 * document links back. Calling it again on a reverted proposal is a
 * no-op success (it is not listed twice in `reverted`; it appears in
 * `skipped` with reason `already_reverted`).
 */
export async function undoProposals(params: {
  workspaceId: string;
  userId: string;
  batchId: string;
  proposalIds: string[];
}): Promise<UndoOutcome> {
  const { workspaceId, userId, batchId, proposalIds } = params;
  await loadBatchStrict(workspaceId, batchId);

  const reverted: UndoneProposal[] = [];
  const skipped: UndoOutcome["skipped"] = [];
  for (const pid of proposalIds) {
    try {
      const r = await undoDedupProposal({
        workspaceId,
        userId,
        batchId,
        proposalId: pid,
      });
      if (r.outcome === "reverted") reverted.push(r.detail);
      else if (r.outcome === "already_reverted") {
        skipped.push({ id: pid, reason: "already_reverted" });
      } else skipped.push({ id: pid, reason: r.reason });
    } catch (err) {
      skipped.push({
        id: pid,
        reason:
          err instanceof Error ? `undo_failed: ${err.message}` : "undo_failed",
      });
    }
  }
  return { reverted, skipped };
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
      // An applied proposal changed the ledger; take it back with undo.
      skipped.push({ id: pid, reason: "already_applied" });
      continue;
    }
    if (row.status !== "proposed") {
      skipped.push({ id: pid, reason: row.status });
      continue;
    }

    await db
      .update(reconcileProposals)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(
        and(
          eq(reconcileProposals.id, pid),
          eq(reconcileProposals.status, "proposed"),
        ),
      );
    rejected.push(pid);
  }

  return { rejected, skipped };
}
