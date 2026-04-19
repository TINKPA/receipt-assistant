/**
 * Dedup detection — pure SQL, deterministic.
 *
 * Goal: within a batch, if two or more transactions share the same
 * (workspace_id, occurred_on, payee, sum-of-expense-side amount_base_minor)
 * they are almost certainly the same real-world purchase uploaded twice.
 *
 * We pick the earliest `created_at` as the canonical transaction and
 * propose voiding the later ones. Each proposal scores 1.0 (exact-match
 * on all four keys) so the engine's `auto_apply_threshold` treats them
 * as auto-appliable when the operator allows it.
 *
 * Scope
 * -----
 * Phase 2a compares transactions *within the same batch*. The broader
 * `batch_plus_recent_90d` scope (compare against the prior 90d window)
 * will land alongside payment-link because it shares the same SQL shape.
 *
 * Why expense side?
 * -----------------
 * Every receipt-kind extraction produces two postings: the expense
 * debit and the credit-card credit. Summing the expense-side postings
 * gives us a positive total that's stable regardless of which expense
 * category the agent picked. Summing both sides would be zero (it's a
 * balanced transaction — that's the whole point of double-entry).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * One detected duplicate group.
 *
 * `canonical_id` is the transaction we keep (earliest created_at in the
 * batch). `duplicate_ids` are the later siblings the engine will flag
 * with a dedup proposal each.
 */
export interface DuplicateGroup {
  canonical_id: string;
  duplicate_ids: string[];
  occurred_on: string;
  payee: string;
  total_base_minor: number;
}

/**
 * Run the dedup detection query and return duplicate groups.
 *
 * Only considers transactions with status IN ('posted','reconciled') —
 * a transaction already voided by a human pre-reconcile must not be
 * re-flagged. `source_ingest_id` must point inside the target batch.
 */
export async function detectDuplicates(params: {
  workspaceId: string;
  batchId: string;
}): Promise<DuplicateGroup[]> {
  const { workspaceId, batchId } = params;

  // Per-transaction expense-side total. Exclude NULL payees (can't key
  // on them reliably) and NULL occurred_on (should never happen — date
  // is NOT NULL in schema — but belt-and-braces).
  //
  // amount_base_minor is signed: positive on the expense debit, negative
  // on the credit-card credit. Summing only positive values keeps us on
  // the expense side without hard-coding account IDs.
  const res = await db.execute(sql`
    WITH batch_txns AS (
      SELECT t.id,
             t.occurred_on,
             t.payee,
             t.created_at,
             t.status,
             COALESCE(SUM(GREATEST(p.amount_base_minor, 0)), 0) AS total_expense_base_minor
        FROM transactions t
        JOIN postings p ON p.transaction_id = t.id
       WHERE t.workspace_id = ${workspaceId}::uuid
         AND t.status IN ('posted', 'reconciled')
         AND t.source_ingest_id IN (
           SELECT id FROM ingests WHERE batch_id = ${batchId}::uuid
         )
       GROUP BY t.id, t.occurred_on, t.payee, t.created_at, t.status
    ),
    grouped AS (
      SELECT occurred_on,
             payee,
             total_expense_base_minor,
             ARRAY_AGG(id ORDER BY created_at ASC, id ASC) AS ids
        FROM batch_txns
       WHERE payee IS NOT NULL
         AND total_expense_base_minor > 0
       GROUP BY occurred_on, payee, total_expense_base_minor
      HAVING COUNT(*) >= 2
    )
    SELECT occurred_on,
           payee,
           total_expense_base_minor,
           ids
      FROM grouped
  `);

  const rows = res.rows as Array<{
    occurred_on: string | Date;
    payee: string;
    total_expense_base_minor: number | string;
    ids: string[];
  }>;

  const groups: DuplicateGroup[] = [];
  for (const r of rows) {
    const ids = Array.isArray(r.ids) ? r.ids : [];
    if (ids.length < 2) continue;
    const canonical = ids[0]!;
    const duplicates = ids.slice(1);
    const occurredOn =
      r.occurred_on instanceof Date
        ? r.occurred_on.toISOString().slice(0, 10)
        : String(r.occurred_on).slice(0, 10);
    groups.push({
      canonical_id: canonical,
      duplicate_ids: duplicates,
      occurred_on: occurredOn,
      payee: r.payee,
      total_base_minor: Number(r.total_expense_base_minor),
    });
  }
  return groups;
}
