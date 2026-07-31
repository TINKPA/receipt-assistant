/**
 * The points-currency namespace (#206).
 *
 * The owner's decision — "積分也是另外一種貨幣", points are just another
 * currency — means a loyalty programme's unit has to be a first-class
 * currency code in the ledger, not a $0 charge. This module owns the one
 * question everything else asks: **is this code cash or points?**
 *
 * ## Why a `_PT` suffix rather than an ISO-style 3-letter code
 *
 * The two namespaces must be *provably* disjoint, because a collision
 * would either send a points posting into the FX converter (see
 * `src/fx/rates.ts`, which now refuses points codes outright) or convert
 * a real currency at a made-up valuation. Shape does that with no lookup
 * table and no possibility of drift:
 *
 *   cash   `^[A-Z]{3}$`                ISO 4217, exactly three letters
 *   points `^[A-Z][A-Z0-9]{1,12}_PT$`  an underscore, which ISO cannot use
 *
 * ISO 4217 codes are three letters and contain no underscore, so no
 * present or future ISO code can ever match the points pattern. The
 * alternative — squatting on the X-prefixed range (`XHY` for Hyatt) —
 * looks free but is not: `XCD`, `XOF`, `XAF`, `XPF` are real circulating
 * currencies and `XAU`/`XAG`/`XDR` are real ISO allocations, so the range
 * is already occupied and would need a hand-maintained deny-list. It also
 * reads as noise in a report.
 *
 * ## Why per-programme and not one generic `POINTS`
 *
 * A currency code asserts fungibility: any two units of it are
 * interchangeable and may be added together. 40,500 Hyatt points and
 * 12,000 AA miles are not interchangeable and must never net against each
 * other, which is exactly what a shared `POINTS` code would let every
 * per-currency sum do. One code per programme keeps every currency-scoped
 * aggregate honest by construction.
 *
 * Codes are capped at 16 characters so `postings.currency` /
 * `accounts.currency` stay narrow (`varchar(16)`, widened from `char(3)`
 * in `drizzle/0038_points_as_currency.sql`).
 */

/** Points/miles unit, e.g. `HYATT_PT`, `AA_PT`, `BONVOY_PT`. */
export const POINTS_CURRENCY_RE = /^[A-Z][A-Z0-9]{1,12}_PT$/;

/** Cash currency, ISO 4217. */
export const CASH_CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * The points pattern as a POSIX regex string, for use as a **bound
 * parameter** in SQL (`WHERE currency ~ ${POINTS_CURRENCY_SQL_RE}`).
 * Passing it as a parameter rather than inlining it avoids the
 * backslash-escaping trap that `LIKE '%\_PT'` invites.
 */
export const POINTS_CURRENCY_SQL_RE = "^[A-Z][A-Z0-9]{1,12}_PT$";

export function isPointsCurrency(code: string): boolean {
  return POINTS_CURRENCY_RE.test(code);
}

export function isCashCurrency(code: string): boolean {
  return CASH_CURRENCY_RE.test(code);
}
