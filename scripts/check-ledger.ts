/**
 * check-ledger.ts — read-only invariant sweep over a ledger database.
 *
 * Usage:
 *   npx tsx scripts/check-ledger.ts postgresql://user:pass@host:port/receipts [--verbose] [--allow=<check>,<check>]
 *   npx tsx scripts/check-ledger.ts --pg=postgresql://... [--verbose]
 *
 * Exit code: 0 when every invariant holds, 1 when any is violated, 2 when
 * the sweep itself could not run.
 *
 * `--allow=<check>[,<check>]` still runs and prints the named checks but
 * leaves them out of the exit code. It is for a backlog that has been
 * looked at and accepted, so that the checks that should be clean can
 * gate a deploy; it is never applied by default.
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
 *                           have been live when the ingest closed, or the
 *                           file's purchase was nowhere.
 *   proposal-open-live      an open dedup proposal names two live rows.
 *   proposal-survivor-live  an applied dedup proposal's surviving row was
 *                           live when the duplicate's evidence was moved
 *                           onto it.
 *   applied-duplicate-gone  an applied dedup proposal's duplicate is still
 *                           deleted. A live one was brought back with a
 *                           plain restore: its documents are still on the
 *                           surviving row, and `/reconcile/undo` for that
 *                           proposal moves them back.
 *   document-has-live-txn   a live document that is linked at all is linked
 *                           to at least one live transaction.
 *   txn-has-live-document   the mirror image: a live transaction that has,
 *                           or provably had, a document still has one that
 *                           is not deleted. "Had" is read from what a
 *                           document leaves behind: a link to a deleted
 *                           document, an ingest that produced the row, a
 *                           `document_unlinked` event, or a dedup apply
 *                           that moved documents off it. A manual entry
 *                           has none of these and is not looked at.
 *   refund-not-deduped      no row sits deleted as the "duplicate" of a row
 *                           whose money moved the other way: a refund
 *                           folded into the purchase it reverses. Direction
 *                           is the detector's: the class of the P&L legs
 *                           (expense / income / both / neither) and the
 *                           sign of their total.
 *   items-under-live-txn    no un-retired line item hangs under a deleted
 *                           transaction (it would still count in product
 *                           statistics).
 *
 * What is NOT a violation: a transaction deleted AFTER an ingest or an
 * applied proposal pointed at it. That is somebody's later decision (or
 * a later fold into another row), and the ledger was consistent when the
 * pointer was written. For a soft delete `deleted_at` proves the order.
 * For a hard delete ("Delete forever", a cascade with `hard=true`) the
 * row is gone and its `hard_deleted` event proves it: the event carries
 * the transaction id, the status and the earlier soft-delete time in its
 * payload. A missing target with no such event — deleted by a version
 * that did not write the id, or by hand in SQL — cannot be dated and is
 * still reported.
 *
 * Three checks describe states that ordinary use still produces, so they
 * stay red until the code path behind them changes or the rows are
 * dealt with; `--allow` exists for them:
 *   - document-has-live-txn fires for a receipt whose transaction was
 *     soft-deleted while the document was kept. Either the purchase is
 *     missing from the ledger (re-upload the file: it extracts again) or
 *     the document is not wanted (delete it).
 *   - txn-has-live-document fires for a transaction whose document was
 *     deleted on its own (`DELETE /v1/documents/:id` without `cascade`),
 *     and for one restored after a cascade took it and its document
 *     together. Both are a person's choice. What it is for is the same
 *     state reached with nobody choosing it; `/reconcile/undo` refuses
 *     to create it from either side (`no_live_document` for the row it
 *     would restore, `survivor_no_live_document` for the survivor it
 *     would take documents off; the survivor test reads "had a document"
 *     the way this check does) and the cascade delete removes the
 *     transaction with its last live document.
 *   - items-under-live-txn fires for every soft-deleted transaction that
 *     has line items: neither a person's delete nor a dedup apply
 *     retires them, and the item and product reads do not look at the
 *     parent's `deleted_at`.
 */
import pg from "pg";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const ALLOW = new Set(
  (args.find((a) => a.startsWith("--allow="))?.slice("--allow=".length) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== ""),
);
const url =
  args.find((a) => a.startsWith("--pg="))?.slice("--pg=".length) ??
  args.find((a) => /^postgres(ql)?:\/\//.test(a));

if (!url) {
  console.error(
    "usage: npx tsx scripts/check-ledger.ts <postgres-url> [--verbose] [--allow=<check>,<check>]",
  );
  process.exit(2);
}

const LIVE = (alias: string): string =>
  `(${alias}.status IN ('posted', 'reconciled') AND ${alias}.deleted_at IS NULL)`;

/** Soft-deleted, and provably AFTER the moment `at`: a later decision,
 *  not a pointer written at a row that was already gone. */
const DELETED_AFTER = (alias: string, at: string): string =>
  `(${alias}.status IN ('posted', 'reconciled') AND ${alias}.deleted_at IS NOT NULL AND ${alias}.deleted_at > ${at})`;

/**
 * Hard-deleted, and provably AFTER the moment `at`, having been live
 * until then. The row is gone, so the proof is its `hard_deleted` event:
 * every delete path writes one and copies into the payload what the
 * foreign key and the DELETE are about to erase — the transaction id
 * (the FK nulls the event's own `transaction_id` column), the status,
 * and `prior_deleted_at`, the soft-delete time if the row was already a
 * tombstone. `idText` is a SQL expression for the missing id, as text.
 *
 * A row that was soft-deleted BEFORE `at` and purged afterwards is still
 * a violation: the pointer was written at a deleted row, and removing
 * the row for good does not make the file's purchase reappear. That is
 * what the `prior_deleted_at` clause is for. An event without the key
 * (none is written without it any more) is taken at its word.
 */
const HARD_DELETED_AFTER = (idText: string, at: string): string =>
  `EXISTS (SELECT 1 FROM transaction_events hd
            WHERE hd.event_type = 'hard_deleted'
              AND hd.payload->>'transaction_id' = ${idText}
              AND hd.payload->>'prior_status' IN ('posted', 'reconciled')
              AND hd.created_at > ${at}
              AND COALESCE((hd.payload->>'prior_deleted_at')::timestamptz > ${at}, true))`;

/**
 * Money direction, the way the dedup detector reads it
 * (`directionLateral` in src/reconcile/dedup.ts, re-typed here because
 * this script checks the ledger from the outside): the class of the
 * row's P&L legs and the sign of their total. Expense as booked, income
 * negated, so a refund booked as a negative expense reads `expense:-1`
 * and money back booked through an income account reads `income:1` —
 * neither equals a purchase's `expense:1`.
 */
const DIRECTION = (alias: string): string => `(
  SELECT CASE WHEN bool_or(a.type = 'expense') AND bool_or(a.type = 'income') THEN 'mixed'
              WHEN bool_or(a.type = 'expense') THEN 'expense'
              WHEN bool_or(a.type = 'income')  THEN 'income'
              ELSE 'none' END
         || ':' ||
         sign(CASE WHEN bool_or(a.type IN ('expense', 'income'))
                   THEN COALESCE(SUM(CASE a.type WHEN 'income'  THEN -p.amount_base_minor
                                                 WHEN 'expense' THEN  p.amount_base_minor END), 0)
                   ELSE COALESCE(SUM(GREATEST(p.amount_base_minor, 0)), 0) END)::int
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
    what: "dedup / near_dup ingests pointing at a transaction that was not live",
    sql: `
      SELECT i.id::text AS id,
             i.status || ' → ' || x.tid || ' (' ||
               CASE WHEN t.id IS NULL THEN 'missing'
                    WHEN t.deleted_at IS NOT NULL THEN 'soft-deleted before the ingest closed'
                    ELSE 'status ' || t.status END || ')' AS detail
        FROM ingests i
       CROSS JOIN LATERAL jsonb_array_elements_text(
               COALESCE(i.produced->'transaction_ids', '[]'::jsonb)) AS x(tid)
        LEFT JOIN transactions t ON t.id::text = x.tid
       WHERE i.status IN ('dedup', 'near_dup')
         AND (t.id IS NULL OR NOT ${LIVE("t")})
         AND NOT COALESCE(${DELETED_AFTER("t", "COALESCE(i.completed_at, i.created_at)")}, false)
         AND NOT (t.id IS NULL AND ${HARD_DELETED_AFTER("x.tid", "COALESCE(i.completed_at, i.created_at)")})
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
    what: "applied dedup proposals whose surviving transaction was not live",
    sql: `
      SELECT rp.id::text AS id,
             'batch ' || rp.batch_id || ': survivor ' ||
               COALESCE(rp.payload->>'duplicate_of', '?') ||
               CASE WHEN c.id IS NULL THEN ' missing'
                    WHEN c.deleted_at IS NOT NULL THEN ' already deleted when the proposal was applied'
                    ELSE ' not live' END AS detail
        FROM reconcile_proposals rp
        LEFT JOIN transactions c ON c.id::text = rp.payload->>'duplicate_of'
       WHERE rp.kind = 'dedup'
         AND rp.status IN ('auto_applied', 'user_applied')
         AND (c.id IS NULL OR NOT ${LIVE("c")})
         AND NOT COALESCE(${DELETED_AFTER("c", "COALESCE(rp.resolved_at, rp.created_at)")}, false)
         AND NOT (c.id IS NULL AND ${HARD_DELETED_AFTER("rp.payload->>'duplicate_of'", "COALESCE(rp.resolved_at, rp.created_at)")})
       ORDER BY rp.created_at`,
  },
  {
    name: "applied-duplicate-gone",
    what: "applied dedup proposals whose duplicate is live again (restored without undo)",
    sql: `
      SELECT rp.id::text AS id,
             'batch ' || rp.batch_id || ': duplicate ' || d.id ||
               ' is not deleted; its documents are still on ' ||
               COALESCE(rp.payload->>'duplicate_of', '?') ||
               ' — undo this proposal to move them back' AS detail
        FROM reconcile_proposals rp
        JOIN transactions d ON d.id::text = rp.payload->>'duplicate'
       WHERE rp.kind = 'dedup'
         AND rp.status IN ('auto_applied', 'user_applied')
         AND d.deleted_at IS NULL
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
    name: "txn-has-live-document",
    what: "live transactions that have, or had, a document and have no live one left",
    sql: `
      SELECT t.id::text AS id,
             CASE WHEN x.links > 0
                  THEN x.links || ' linked document(s), all deleted'
                  ELSE 'no document linked any more; it had one (' ||
                       CASE WHEN x.unlinked_by_delete THEN 'a document delete unlinked it'
                            WHEN x.from_ingest THEN 'an ingest produced it'
                            ELSE 'a dedup apply moved its documents' END || ')'
             END AS detail
        FROM transactions t
       CROSS JOIN LATERAL (
         SELECT (SELECT count(*) FROM document_links dl WHERE dl.transaction_id = t.id) AS links,
                EXISTS (SELECT 1 FROM transaction_events e
                         WHERE e.transaction_id = t.id
                           AND e.event_type = 'document_unlinked') AS unlinked_by_delete,
                (t.source_ingest_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM ingests i
                             WHERE jsonb_exists(COALESCE(i.produced->'transaction_ids', '[]'::jsonb), t.id::text))
                ) AS from_ingest,
                EXISTS (SELECT 1 FROM reconcile_proposals rp
                         WHERE rp.kind = 'dedup'
                           AND rp.payload->>'duplicate' = t.id::text
                           AND jsonb_typeof(rp.payload->'applied'->'links') = 'array'
                           AND jsonb_array_length(rp.payload->'applied'->'links') > 0) AS folded_with_documents
       ) x
       WHERE ${LIVE("t")}
         AND NOT EXISTS (
               SELECT 1 FROM document_links dl
                 JOIN documents d ON d.id = dl.document_id
                WHERE dl.transaction_id = t.id AND d.deleted_at IS NULL)
         -- A manual entry never had a document: no link, and none of the
         -- three traces a document leaves behind. It is not looked at.
         AND (x.links > 0 OR x.unlinked_by_delete OR x.from_ingest OR x.folded_with_documents)
       ORDER BY t.created_at`,
  },
  {
    name: "refund-not-deduped",
    what: "rows deleted as the duplicate of a row whose money moved the other way (a refund folded into its purchase)",
    sql: `
      SELECT x.id, x.detail
        FROM (
          SELECT d.id::text AS id, rp.created_at,
                 ${DIRECTION("d")} AS d_dir,
                 ${DIRECTION("c")} AS c_dir,
                 'proposal ' || rp.id || ' (batch ' || rp.batch_id || ', ' || rp.status ||
                   '): deleted row folded into ' || c.id AS detail
            FROM reconcile_proposals rp
            JOIN transactions d ON d.id::text = rp.payload->>'duplicate'
            JOIN transactions c ON c.id::text = rp.payload->>'duplicate_of'
           WHERE rp.kind = 'dedup'
             AND rp.status IN ('auto_applied', 'user_applied')
             AND d.deleted_at IS NOT NULL
        ) x
       WHERE x.d_dir IS DISTINCT FROM x.c_dir
       ORDER BY x.created_at`,
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
  const unknown = [...ALLOW].filter((n) => !CHECKS.some((c) => c.name === n));
  if (unknown.length > 0) {
    console.error(
      `--allow names no such check: ${unknown.join(", ")} (checks: ${CHECKS.map((c) => c.name).join(", ")})`,
    );
    process.exit(2);
  }
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
  let allowed = 0;
  console.log("# check-ledger (read-only)\n");
  for (const c of CHECKS) {
    const res = await client.query(c.sql);
    const n = res.rows.length;
    const waived = n > 0 && ALLOW.has(c.name);
    if (waived) allowed++;
    else if (n > 0) violated++;
    const mark = n === 0 ? "ok  " : waived ? "seen" : "FAIL";
    console.log(`${mark}  ${c.name.padEnd(24)} ${String(n).padStart(4)}  ${c.what}`);
    if (VERBOSE) {
      for (const r of res.rows as Array<{ id: string; detail: string | null }>) {
        console.log(`        ${r.id}  ${r.detail ?? ""}`);
      }
    }
  }
  await client.end();
  const waivedNote =
    allowed > 0 ? `; ${allowed} more violated but allowed by --allow` : "";
  console.log(
    violated === 0
      ? `\n${allowed > 0 ? "no unallowed violation" : "all invariants hold"}${waivedNote}`
      : `\n${violated} of ${CHECKS.length} invariants violated${waivedNote}${VERBOSE ? "" : " (re-run with --verbose for ids)"}`,
  );
  process.exit(violated === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("check-ledger could not run:", err instanceof Error ? err.message : err);
  process.exit(2);
});
