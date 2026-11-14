/**
 * The one definition of an **unconverted** posting: a foreign cash leg
 * the FX pass (`./normalize.ts`) never converted.
 *
 * Such a leg has `fx_rate` NULL and still holds the placeholder the
 * extraction agent wrote, `amount_base_minor = amount_minor`. Every sum
 * of `amount_base_minor` therefore counts it at face value: 5,000 yen as
 * 5,000 cents. Nothing downstream can fix that, so every endpoint that
 * sums base amounts says how many such legs its figure contains: the
 * reports in their `fx` block, the merchant and brand KPIs in
 * `unconverted_transaction_count`. `scripts/backfill-fx.ts --unconverted`
 * selects the same legs to retry them.
 *
 * Kept in one place because the four parts of the predicate are easy to
 * get subtly different:
 *
 *  - not the base currency (a base leg has no rate by design);
 *  - not a points code (points are valued by `src/points/valuation.ts`,
 *    and "no valuation" is the points block's `unvalued`, at base 0);
 *  - no `fx_rate`;
 *  - a non-zero amount. Zero converts to zero at any rate, so it distorts
 *    nothing, and old rows have a few zero legs no pass ever visited.
 */
import { sql, type SQL } from "drizzle-orm";
import { POINTS_CURRENCY_SQL_RE } from "../points/codes.js";

/**
 * SQL boolean: the posting aliased `postingAlias` is an unconverted
 * foreign cash leg, given an expression for the workspace base currency
 * (a bound value, or a column such as `w.base_currency`).
 *
 * `postingAlias` is spliced in raw; pass a literal alias, never input.
 */
export function unconvertedLegSql(postingAlias: string, baseCurrency: SQL): SQL {
  const p = sql.raw(postingAlias);
  return sql`(${p}.currency <> ${baseCurrency}
    AND ${p}.currency !~ ${POINTS_CURRENCY_SQL_RE}
    AND ${p}.fx_rate IS NULL
    AND ${p}.amount_minor <> 0)`;
}
