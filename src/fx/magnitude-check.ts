/**
 * Finds postings booked at the wrong power of ten, and says so at boot.
 *
 * ## What it looks for
 *
 * `postings.fx_rate` is the multiplier on MINOR units
 * (`src/ledger/money.ts`). For two currencies with different decimals it
 * can never equal the rate a source publishes: JPY→USD published at
 * 0.00645 is stored as 0.645. So a posting in such a currency whose
 * `fx_rate` IS the published rate for its date was converted by
 * multiplying a minor amount straight by the quoted rate, and its base
 * amount is off by `10^(difference in decimals)`: a yen receipt at a
 * hundredth of its value, a dinar one at ten times.
 *
 * Two things write a row like that:
 *
 *  - the FX pass as it was before it respected exponents. Rows it wrote
 *    stay wrong until `scripts/backfill-fx.ts --exponent-mismatch` is run
 *    once after deploying the fix. There is no migration for it (the
 *    repair needs the exponent table and the rounding-residual logic,
 *    which live in TypeScript), so nothing but this check notices if
 *    that step is forgotten;
 *  - an API client that sends the quoted rate as `fx_rate` on a JPY
 *    posting. The service stores a client-supplied pair as sent.
 *
 * "The published rate for its date" is read from the two places that
 * record it: the `fx_rates` cache row for (date, currency, base), and
 * the `rate` in the transaction's own `metadata.fx.rates[]`.
 *
 * ## What it does about it
 *
 * Nothing but a warning in the boot log, naming the repair command. It
 * is read-only, it never blocks startup, and a failure of the check
 * itself is logged and swallowed: an observability aid must not become
 * an outage.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { POINTS_CURRENCY_SQL_RE } from "../points/codes.js";
import { currencyExponent } from "../ledger/money.js";

export interface MisScaledGroup {
  currency: string;
  baseCurrency: string;
  postings: number;
  transactions: number;
}

/**
 * Postings whose `fx_rate` equals the published whole-unit rate although
 * their currency and the workspace base currency differ in decimals,
 * grouped by currency pair. Empty when the ledger is clean.
 */
export async function findMisScaledPostings(): Promise<MisScaledGroup[]> {
  const res = await db.execute(sql`
    SELECT p.currency                    AS currency,
           w.base_currency               AS base_currency,
           COUNT(*)::int                 AS postings,
           COUNT(DISTINCT t.id)::int     AS transactions
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN workspaces  w ON w.id = t.workspace_id
     WHERE p.currency <> w.base_currency
       AND p.currency !~ ${POINTS_CURRENCY_SQL_RE}
       AND p.fx_rate IS NOT NULL
       AND p.amount_minor <> 0
       AND (
         EXISTS (
           SELECT 1 FROM fx_rates r
            WHERE r.as_of = t.occurred_on
              AND r.base = p.currency
              AND r.quote = w.base_currency
              AND r.rate = p.fx_rate
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(t.metadata->'fx'->'rates') = 'array'
                         THEN t.metadata->'fx'->'rates'
                         ELSE '[]'::jsonb END
                  ) e
            WHERE e->>'currency' = p.currency
              AND CASE WHEN jsonb_typeof(e->'rate') = 'number'
                       THEN ROUND((e->>'rate')::numeric, 10) = p.fx_rate
                       ELSE FALSE END
         )
       )
     GROUP BY p.currency, w.base_currency
     ORDER BY p.currency, w.base_currency
  `);
  const rows = res.rows as Array<{
    currency: string;
    base_currency: string;
    postings: number;
    transactions: number;
  }>;
  // For currencies with the same number of decimals the published rate
  // IS the multiplier, so only the pairs that differ are a finding. The
  // exponent table lives in TypeScript, hence the filter here.
  return rows
    .filter(
      (r) => currencyExponent(r.currency) !== currencyExponent(r.base_currency),
    )
    .map((r) => ({
      currency: r.currency,
      baseCurrency: r.base_currency,
      postings: Number(r.postings),
      transactions: Number(r.transactions),
    }));
}

/** Boot-log wrapper around `findMisScaledPostings`. Never throws. */
export async function warnAboutMisScaledPostings(): Promise<void> {
  try {
    const groups = await findMisScaledPostings();
    if (groups.length === 0) return;
    const postings = groups.reduce((n, g) => n + g.postings, 0);
    const transactions = groups.reduce((n, g) => n + g.transactions, 0);
    const pairs = groups
      .map((g) => `${g.currency}→${g.baseCurrency}`)
      .join(", ");
    console.warn(
      `⚠️  [fx] ${postings} posting(s) in ${transactions} transaction(s) ` +
        `(${pairs}) are booked at the wrong power of ten: their fx_rate ` +
        `is the published whole-unit rate although the two currencies ` +
        `differ in decimals, so every total that includes them is off. ` +
        `Repair (preview with --dry-run first): docker exec -i ` +
        `receipt-assistant npx tsx scripts/backfill-fx.ts --exponent-mismatch`,
    );
  } catch (err) {
    console.warn(
      "⚠️  [fx] could not check for postings at the wrong magnitude:",
      (err as Error).message,
    );
  }
}
