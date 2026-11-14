/**
 * Duplicate candidates for one receipt record (wave 1; docs/server-writer.md,
 * "Candidates"): the live transactions `decide()` compares the record
 * with. Read-only.
 *
 * Run it INSIDE the apply transaction, AFTER `takeWorkspaceApplyLock`.
 * The lock is what makes "look for a duplicate, then insert" atomic: two
 * copies of one receipt applied at once are serialised, and the second
 * one's candidates include the first one's transaction (the `race` case of
 * `eval-dedup`). Read outside the lock, the answer can be stale by the
 * time the insert runs.
 *
 * Three ways in, all from `ledger_live_transactions` (a soft-deleted row
 * is never an attach target):
 *
 *   (a) amount       the signed P&L-leg sum (expense +, income −) in the
 *                    record's own currency and minor units equals the
 *                    record's signed total, `occurred_on` within ±3 days.
 *                    Skipped when the total is 0: a zero total says
 *                    nothing (#205).
 *   (b) identifier   any of the record's contract identifier values equals
 *                    any of the five keys on the row (cross-key, so an
 *                    invoice number filed as an order number is still
 *                    found; `decide()` decides what counts), within ±30
 *                    days.
 *   (c) phash        the live transactions behind the perceptually near
 *                    documents (pHash distance ≤ 2) the worker found
 *                    before the run.
 *
 * At most 25, nearest `occurred_on` first (then oldest), each with what
 * `decide()` needs: the direction (`directionLateral`, shared with
 * reconcile), the native total in the record's currency, the identifiers,
 * card last-4, time, merchant brand and canonical name, and the live line
 * totals.
 */
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";
import { liveTransactions } from "../../db/live.js";
import { IDENTIFIER_KEYS, directionLateral } from "../../reconcile/dedup.js";
import { identifiersOf } from "../contract/validate.js";
import type { ExtractionV1 } from "../contract/v1.js";
import type { ApplyCandidate, CandidateSource } from "./decide.js";

/** Days either side of the record's date for an amount match (a). */
export const AMOUNT_WINDOW_DAYS = 3;
/** Days either side for an identifier match (b): an order number survives
 *  a re-issued or partly refunded document, so it is looked for wider. */
export const IDENTIFIER_WINDOW_DAYS = 30;
export const MAX_CANDIDATES = 25;

type Executor = Pick<typeof db, "execute">;

/**
 * The workspace's apply lock, held to the end of the caller's
 * transaction (docs/server-writer.md, "Prologue and run fence"). Every server
 * apply in a workspace takes it first, so
 * candidates are computed and the ledger written with no other apply in
 * between. It is an advisory lock, outside the row lock order.
 */
export async function takeWorkspaceApplyLock(executor: Executor, workspaceId: string): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ingest-apply:${workspaceId}`}, 0))`,
  );
}

const identifierColumns = sql.raw(
  IDENTIFIER_KEYS.map((k) => `NULLIF(btrim(t.metadata->>'${k}'), '') AS ${k}`).join(",\n           "),
);
const identifierAny = (valuesJson: string) =>
  sql.join(
    IDENTIFIER_KEYS.map(
      (k) =>
        sql`btrim(t.metadata->>${k}) IN (SELECT jsonb_array_elements_text(${valuesJson}::jsonb))`,
    ),
    sql` OR `,
  );

interface CandidateRow {
  id: string;
  occurred_on: string;
  occurred_at: string | null;
  payee: string | null;
  merchant_id: string | null;
  merchant_brand_id: string | null;
  merchant_canonical_name: string | null;
  status: string;
  payment: string | null;
  card_last4: string | null;
  flow: string | null;
  refund_of: string | null;
  near_dup_check: unknown;
  order_number: string | null;
  confirmation_number: string | null;
  invoice_number: string | null;
  payment_id: string | null;
  approval_code: string | null;
  pl_class: string;
  total: string | number;
  native_total: string | number | null;
  item_totals: (string | number)[] | null;
  matched_on: CandidateSource[];
  date_distance: number;
}

/**
 * The candidates for a valid receipt record. `phashTransactionIds` are the
 * transactions behind its pHash neighbours (the worker's scan); pass []
 * when there are none.
 */
export async function findCandidates(
  executor: Executor,
  params: { workspaceId: string; record: ExtractionV1; phashTransactionIds: readonly string[] },
): Promise<ApplyCandidate[]> {
  const facts = params.record.facts;
  if (!facts) throw new Error("findCandidates: only a receipt record has candidates");
  const ws = params.workspaceId;
  const on = facts.occurred_on;
  const values = [...new Set(Object.values(identifiersOf(params.record)))];
  const valuesJson = JSON.stringify(values);
  const phashJson = JSON.stringify([...new Set(params.phashTransactionIds)]);

  const res = await executor.execute(sql`
    WITH found AS (
      -- (a) amount: the signed P&L legs in the record's currency
      SELECT t.id, 'amount' AS source
        FROM ${liveTransactions} t
        JOIN postings p ON p.transaction_id = t.id
        JOIN accounts a ON a.id = p.account_id AND a.type IN ('expense', 'income')
       WHERE t.workspace_id = ${ws}::uuid
         AND ${facts.total_minor}::bigint <> 0
         AND p.currency = ${facts.currency}
         AND t.occurred_on BETWEEN ${on}::date - ${AMOUNT_WINDOW_DAYS}::int
                               AND ${on}::date + ${AMOUNT_WINDOW_DAYS}::int
       GROUP BY t.id
      HAVING SUM(CASE WHEN a.type = 'income' THEN -p.amount_minor ELSE p.amount_minor END)
             = ${facts.total_minor}::bigint
      UNION ALL
      -- (b) identifier, any key against any key
      SELECT t.id, 'identifier'
        FROM ${liveTransactions} t
       WHERE t.workspace_id = ${ws}::uuid
         AND jsonb_array_length(${valuesJson}::jsonb) > 0
         AND t.occurred_on BETWEEN ${on}::date - ${IDENTIFIER_WINDOW_DAYS}::int
                               AND ${on}::date + ${IDENTIFIER_WINDOW_DAYS}::int
         AND (${identifierAny(valuesJson)})
      UNION ALL
      -- (c) the transactions behind the pHash neighbours
      SELECT t.id, 'phash'
        FROM ${liveTransactions} t
       WHERE t.workspace_id = ${ws}::uuid
         AND t.id IN (SELECT (jsonb_array_elements_text(${phashJson}::jsonb))::uuid)
    ),
    ids AS (
      SELECT id, array_agg(DISTINCT source ORDER BY source) AS matched_on FROM found GROUP BY id
    )
    SELECT t.id,
           t.occurred_on::text AS occurred_on,
           to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           t.payee, t.merchant_id,
           m.brand_id AS merchant_brand_id,
           t.metadata->'merchant'->>'canonical_name' AS merchant_canonical_name,
           t.status::text AS status,
           t.metadata->>'payment'       AS payment,
           t.metadata->>'card_last4'    AS card_last4,
           t.metadata->>'flow'          AS flow,
           t.metadata->>'refund_of'     AS refund_of,
           t.metadata->'near_dup_check' AS near_dup_check,
           ${identifierColumns},
           s.pl_class, s.total,
           (SELECT SUM(CASE WHEN a.type = 'income' THEN -p.amount_minor ELSE p.amount_minor END)
              FROM postings p JOIN accounts a ON a.id = p.account_id
             WHERE p.transaction_id = t.id
               AND a.type IN ('expense', 'income')
               AND p.currency = ${facts.currency}) AS native_total,
           (SELECT array_agg(ti.line_total_minor ORDER BY ti.line_no)
              FROM transaction_items ti
             WHERE ti.transaction_id = t.id AND ti.retired_at IS NULL) AS item_totals,
           ids.matched_on,
           abs(t.occurred_on - ${on}::date) AS date_distance
      FROM ids
      JOIN ${liveTransactions} t ON t.id = ids.id
      LEFT JOIN merchants m ON m.id = t.merchant_id
     CROSS JOIN LATERAL (
           ${directionLateral("t")}
           ) s
     ORDER BY date_distance ASC, t.created_at ASC, t.id ASC
     LIMIT ${MAX_CANDIDATES}::int`);

  return (res.rows as unknown as CandidateRow[]).map((r) => ({
    id: r.id,
    occurred_on: r.occurred_on,
    occurred_at: r.occurred_at,
    payee: r.payee,
    merchant_id: r.merchant_id,
    merchant_brand_id: r.merchant_brand_id,
    merchant_canonical_name: r.merchant_canonical_name,
    status: r.status,
    payment: r.payment,
    card_last4: r.card_last4,
    flow: r.flow,
    refund_of: r.refund_of,
    near_dup_check: r.near_dup_check,
    identifiers: Object.fromEntries(IDENTIFIER_KEYS.map((k) => [k, r[k]])),
    pl_class: r.pl_class,
    total: Number(r.total),
    native_total: r.native_total === null ? null : Number(r.native_total),
    item_totals: (r.item_totals ?? []).map(Number),
    matched_on: r.matched_on,
    date_distance: Number(r.date_distance),
  }));
}
