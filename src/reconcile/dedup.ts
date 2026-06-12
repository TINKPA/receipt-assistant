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

// ── Near-duplicate detection across batches (#135, L3b) ────────────────
//
// The exact pass above only compares transactions WITHIN one batch — a
// cross-batch duplicate (the same charge ingested weeks apart, or a
// statement row duplicating a receipt with a settlement-date offset and
// a processor-mangled payee string) is invisible to it. This fuzzy pass
// compares the batch's transactions against the prior 90 days OUTSIDE
// the batch, weighted-scores each candidate pair, and lets the engine
// propose them. Conservative by design: the score is CAPPED below the
// auto-apply threshold unless an order/payment identifier matches
// exactly — same-day same-amount same-merchant can legitimately be two
// purchases (the "two coffees" case), so cross-batch matches default to
// human review.

/** Extract a card last-4 from the agent's metadata.payment string
 *  (e.g. "Visa ****7846 (Contactless)" / "Visa xxxxxxxx7846"). */
function cardLast4(payment: string | null): string | null {
  if (!payment) return null;
  const m = payment.match(/(\d{4})(?!.*\d)/);
  return m ? m[1]! : null;
}

export interface NearDuplicatePair {
  /** The batch-side (newer) transaction proposed for voiding. */
  duplicate_id: string;
  /** The pre-existing transaction outside the batch. */
  canonical_id: string;
  score: number;
  reasons: string[];
  occurred_on: string;
  canonical_occurred_on: string;
  payee: string | null;
  canonical_payee: string | null;
  total_base_minor: number;
}

export async function detectNearDuplicates(params: {
  workspaceId: string;
  batchId: string;
}): Promise<NearDuplicatePair[]> {
  const { workspaceId, batchId } = params;
  const res = await db.execute(sql`
    WITH batch_txns AS (
      SELECT t.id, t.occurred_on, t.payee, t.merchant_id, t.created_at,
             t.metadata->>'order_number' AS order_number,
             t.metadata->>'payment_id'   AS payment_id,
             t.metadata->>'payment'      AS payment,
             COALESCE(SUM(GREATEST(p.amount_base_minor, 0)), 0) AS total
        FROM transactions t
        JOIN postings p ON p.transaction_id = t.id
       WHERE t.workspace_id = ${workspaceId}::uuid
         AND t.status IN ('posted', 'reconciled')
         AND t.source_ingest_id IN (
           SELECT id FROM ingests WHERE batch_id = ${batchId}::uuid
         )
       GROUP BY t.id
    ),
    outside AS (
      SELECT t.id, t.occurred_on, t.payee, t.merchant_id, t.created_at,
             t.metadata->>'order_number' AS order_number,
             t.metadata->>'payment_id'   AS payment_id,
             t.metadata->>'payment'      AS payment,
             COALESCE(SUM(GREATEST(p.amount_base_minor, 0)), 0) AS total
        FROM transactions t
        JOIN postings p ON p.transaction_id = t.id
       WHERE t.workspace_id = ${workspaceId}::uuid
         AND t.status IN ('posted', 'reconciled')
         AND (t.source_ingest_id IS NULL OR t.source_ingest_id NOT IN (
           SELECT id FROM ingests WHERE batch_id = ${batchId}::uuid
         ))
       GROUP BY t.id
    )
    SELECT b.id  AS b_id, b.occurred_on AS b_date, b.payee AS b_payee,
           b.merchant_id AS b_merchant, b.order_number AS b_order,
           b.payment_id AS b_payment_id, b.payment AS b_payment,
           b.created_at AS b_created, b.total AS total,
           o.id  AS o_id, o.occurred_on AS o_date, o.payee AS o_payee,
           o.merchant_id AS o_merchant, o.order_number AS o_order,
           o.payment_id AS o_payment_id, o.payment AS o_payment,
           o.created_at AS o_created
      FROM batch_txns b
      JOIN outside o
        ON o.total = b.total
       AND o.occurred_on BETWEEN b.occurred_on - 3 AND b.occurred_on + 3
       AND o.occurred_on >= b.occurred_on - 90
     WHERE b.total > 0
     LIMIT 50
  `);

  const pairs: NearDuplicatePair[] = [];
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const reasons: string[] = ["amount equal within ±3-day window"];
    let score = 0.5;
    const bDate = String(r.b_date).slice(0, 10);
    const oDate = String(r.o_date).slice(0, 10);
    if (bDate === oDate) {
      score += 0.25;
      reasons.push("same occurred_on");
    }
    const bPayee = (r.b_payee as string | null)?.trim().toLowerCase() ?? null;
    const oPayee = (r.o_payee as string | null)?.trim().toLowerCase() ?? null;
    if (
      (bPayee && oPayee && bPayee === oPayee) ||
      (r.b_merchant && r.b_merchant === r.o_merchant)
    ) {
      score += 0.15;
      reasons.push("same payee/merchant");
    }
    const b4 = cardLast4(r.b_payment as string | null);
    const o4 = cardLast4(r.o_payment as string | null);
    if (b4 && o4) {
      if (b4 === o4) {
        score += 0.1;
        reasons.push(`same card last-4 ${b4}`);
      } else {
        score -= 1.0;
        reasons.push("card last-4 differs");
      }
    }
    const bOrder = (r.b_order as string | null) ?? null;
    const oOrder = (r.o_order as string | null) ?? null;
    const bPid = (r.b_payment_id as string | null) ?? null;
    const oPid = (r.o_payment_id as string | null) ?? null;
    const strongIdMatch =
      (bOrder && oOrder && bOrder === oOrder) || (bPid && oPid && bPid === oPid);
    if (bOrder && oOrder && bOrder !== oOrder) {
      score -= 1.0;
      reasons.push("order numbers differ");
    }
    if (bPid && oPid && bPid !== oPid) {
      score -= 1.0;
      reasons.push("payment ids differ");
    }
    if (strongIdMatch) {
      // Exact order/payment identifier — true identity, eligible for
      // auto-apply.
      score = 1.0;
      reasons.push("order/payment identifier matches exactly");
    } else {
      // No strong identifier → cap below the auto-apply threshold so a
      // cross-batch match is always a human-review proposal ("two
      // coffees" false-positive class).
      score = Math.min(score, 0.9);
    }
    if (score < 0.5) continue;
    // Canonical = the EARLIER transaction, matching the exact pass's
    // earliest-created_at rule. Without this, two near-simultaneous
    // batches race: whichever batch reconciles first sees the OTHER
    // side as "outside" and voids its own (earlier) txn — observed in
    // the eval-dedup r1 case. Converges either way, but the survivor
    // should be deterministic.
    const bNewer =
      new Date(String(r.b_created)).getTime() >=
      new Date(String(r.o_created)).getTime();
    pairs.push({
      duplicate_id: String(bNewer ? r.b_id : r.o_id),
      canonical_id: String(bNewer ? r.o_id : r.b_id),
      score: Math.max(0, Math.min(1, score)),
      reasons,
      occurred_on: bDate,
      canonical_occurred_on: oDate,
      payee: (r.b_payee as string | null) ?? null,
      canonical_payee: (r.o_payee as string | null) ?? null,
      total_base_minor: Number(r.total),
    });
  }
  return pairs;
}
