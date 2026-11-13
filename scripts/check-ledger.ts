/**
 * check-ledger.ts — read-only invariant sweep over a ledger database.
 *
 * Usage:
 *   npx tsx scripts/check-ledger.ts postgresql://user:pass@host:port/receipts [--verbose]
 *   npx tsx scripts/check-ledger.ts --pg=postgresql://... [--verbose]
 *
 * Exit code: 0 when every invariant holds, 1 when any is violated, 2 when
 * the sweep itself could not run.
 *
 * SELECT only, and enforced rather than promised: the session is opened
 * with `default_transaction_read_only = on`, so a write would be refused
 * by the server. It is safe to point at production.
 *
 * "Live" is spelled out here against the base table on purpose
 * (status posted or reconciled, deleted_at IS NULL) instead of reading
 * `ledger_live_transactions`: this script checks the ledger from the
 * outside, and it also has to run against a database that migration 0040
 * has not reached yet.
 *
 * Invariants:
 *   ingest-target-live      a `dedup` / `near_dup` ingest says "this file is
 *                           already in the ledger as transaction X". X must
 *                           be live, or the file's purchase is nowhere.
 *   proposal-open-live      an open dedup proposal names two live rows.
 *   proposal-survivor-live  an applied dedup proposal's surviving row is
 *                           live: the duplicate's evidence was moved there.
 *   document-has-live-txn   a live document that is linked at all is linked
 *                           to at least one live transaction.
 *   refund-not-deduped      no refund sits deleted as the "duplicate" of a
 *                           purchase (opposite money direction, by the
 *                           expense/income leg picked by account type).
 *   items-under-live-txn    no un-retired line item hangs under a deleted
 *                           transaction (it would still count in product
 *                           statistics).
 */
import pg from "pg";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const url =
  args.find((a) => a.startsWith("--pg="))?.slice("--pg=".length) ??
  args.find((a) => /^postgres(ql)?:\/\//.test(a));

if (!url) {
  console.error(
    "usage: npx tsx scripts/check-ledger.ts <postgres-url> [--verbose]",
  );
  process.exit(2);
}

const LIVE = (alias: string): string =>
  `(${alias}.status IN ('posted', 'reconciled') AND ${alias}.deleted_at IS NULL)`;

/** Expense/income leg by ACCOUNT TYPE, signed: a refund is negative. */
const SIGNED_TOTAL = (alias: string): string => `(
  SELECT COALESCE(SUM(CASE a.type WHEN 'income' THEN -p.amount_base_minor
                                  WHEN 'expense' THEN p.amount_base_minor END), 0)
    FROM postings p JOIN accounts a ON a.id = p.account_id
   WHERE p.transaction_id = ${alias}.id)`;

interface Check {
  name: string;
  what: string;
  /** Returns one row per violation; `id` identifies it, `detail` explains. */
  sql: string;
}

const CHECKS: Check[] = [
  {
    name: "ingest-target-live",
    what: "dedup / near_dup ingests pointing at a transaction that is not live",
    sql: `
      SELECT i.id::text AS id,
             i.status || ' → ' || x.tid || ' (' ||
               CASE WHEN t.id IS NULL THEN 'missing'
                    WHEN t.deleted_at IS NOT NULL THEN 'soft-deleted'
                    ELSE 'status ' || t.status END || ')' AS detail
        FROM ingests i
       CROSS JOIN LATERAL jsonb_array_elements_text(
               COALESCE(i.produced->'transaction_ids', '[]'::jsonb)) AS x(tid)
        LEFT JOIN transactions t ON t.id::text = x.tid
       WHERE i.status IN ('dedup', 'near_dup')
         AND (t.id IS NULL OR NOT ${LIVE("t")})
       ORDER BY i.created_at`,
  },
  {
    name: "proposal-open-live",
    what: "open dedup proposals naming a transaction that is not live",
    sql: `
      SELECT rp.id::text AS id,
             'batch ' || rp.batch_id || ': ' ||
               CASE WHEN d.id IS NULL THEN 'duplicate missing'
                    WHEN NOT ${LIVE("d")} THEN 'duplicate not live'
                    WHEN c.id IS NULL THEN 'survivor missing'
                    ELSE 'survivor not live' END AS detail
        FROM reconcile_proposals rp
        LEFT JOIN transactions d ON d.id::text = rp.payload->>'duplicate'
        LEFT JOIN transactions c ON c.id::text = rp.payload->>'duplicate_of'
       WHERE rp.kind = 'dedup'
         AND rp.status = 'proposed'
         AND (d.id IS NULL OR NOT ${LIVE("d")} OR c.id IS NULL OR NOT ${LIVE("c")})
       ORDER BY rp.created_at`,
  },
  {
    name: "proposal-survivor-live",
    what: "applied dedup proposals whose surviving transaction is not live",
    sql: `
      SELECT rp.id::text AS id,
             'batch ' || rp.batch_id || ': survivor ' ||
               COALESCE(rp.payload->>'duplicate_of', '?') ||
               CASE WHEN c.id IS NULL THEN ' missing' ELSE ' not live' END AS detail
        FROM reconcile_proposals rp
        LEFT JOIN transactions c ON c.id::text = rp.payload->>'duplicate_of'
       WHERE rp.kind = 'dedup'
         AND rp.status IN ('auto_applied', 'user_applied')
         AND (c.id IS NULL OR NOT ${LIVE("c")})
       ORDER BY rp.created_at`,
  },
  {
    name: "document-has-live-txn",
    what: "live documents whose only links are to transactions that are not live",
    sql: `
      SELECT d.id::text AS id,
             (SELECT string_agg(dl.transaction_id::text, ', ')
                FROM document_links dl WHERE dl.document_id = d.id) AS detail
        FROM documents d
       WHERE d.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM document_links dl WHERE dl.document_id = d.id)
         AND NOT EXISTS (
               SELECT 1 FROM document_links dl
                 JOIN transactions t ON t.id = dl.transaction_id
                WHERE dl.document_id = d.id AND ${LIVE("t")})
       ORDER BY d.created_at`,
  },
  {
    name: "refund-not-deduped",
    what: "refunds deleted as the duplicate of a purchase",
    sql: `
      SELECT d.id::text AS id,
             'proposal ' || rp.id || ' (batch ' || rp.batch_id || ', ' || rp.status ||
               '): deleted refund folded into purchase ' || c.id AS detail
        FROM reconcile_proposals rp
        JOIN transactions d ON d.id::text = rp.payload->>'duplicate'
        JOIN transactions c ON c.id::text = rp.payload->>'duplicate_of'
       WHERE rp.kind = 'dedup'
         AND rp.status IN ('auto_applied', 'user_applied')
         AND d.deleted_at IS NOT NULL
         AND ${SIGNED_TOTAL("d")} < 0
         AND ${SIGNED_TOTAL("c")} > 0
       ORDER BY rp.created_at`,
  },
  {
    name: "items-under-live-txn",
    what: "un-retired line items under a deleted transaction",
    sql: `
      SELECT t.id::text AS id,
             count(*) || ' live item(s)' AS detail
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.retired_at IS NULL
         AND t.deleted_at IS NOT NULL
       GROUP BY t.id
       ORDER BY t.id`,
  },
];

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: url,
    // Refuse writes at the server for the whole session.
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  const ro = await client.query("SHOW default_transaction_read_only");
  if (ro.rows[0]?.default_transaction_read_only !== "on") {
    throw new Error("could not open a read-only session; refusing to continue");
  }

  let violated = 0;
  console.log("# check-ledger (read-only)\n");
  for (const c of CHECKS) {
    const res = await client.query(c.sql);
    const n = res.rows.length;
    if (n > 0) violated++;
    console.log(`${n === 0 ? "ok  " : "FAIL"}  ${c.name.padEnd(24)} ${String(n).padStart(4)}  ${c.what}`);
    if (VERBOSE) {
      for (const r of res.rows as Array<{ id: string; detail: string | null }>) {
        console.log(`        ${r.id}  ${r.detail ?? ""}`);
      }
    }
  }
  await client.end();
  console.log(
    violated === 0
      ? "\nall invariants hold"
      : `\n${violated} of ${CHECKS.length} invariants violated${VERBOSE ? "" : " (re-run with --verbose for ids)"}`,
  );
  process.exit(violated === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("check-ledger could not run:", err instanceof Error ? err.message : err);
  process.exit(2);
});
