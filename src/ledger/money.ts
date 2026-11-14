/**
 * Money arithmetic for the ledger: how many decimals a currency has, and
 * the one conversion from a posting's own units into base-currency minor
 * units.
 *
 * ## The rule every amount in the ledger follows
 *
 * `postings.amount_minor` is an integer count of the currency's **own**
 * minor unit: cents for USD, fen for CNY, whole yen for JPY (the yen has
 * no subunit), fils for KWD (a dinar is 1000 of them), whole points for a
 * loyalty programme. `AmountMinor` in `src/schemas/v1/common.ts` and the
 * extraction prompt both say so.
 *
 * `postings.fx_rate` is the **minor-to-minor** multiplier that takes that
 * count to base-currency minor units, and one equation holds for every
 * converted posting, cash or points:
 *
 *     amount_base_minor = round(amount_minor × fx_rate)
 *
 * (`toBaseMinor` below; the leg that absorbs a transaction's rounding
 * residual is the only exception, by one or two minor units.)
 *
 * ## Why the published rate is not that multiplier
 *
 * A rate source quotes whole units: "1 JPY = 0.0065 USD". Multiplying a
 * minor amount by it is right only when both currencies have the same
 * number of decimals, which is true of USD, CNY and EUR and was silently
 * assumed everywhere. For 5,000 yen it gives 33 cents, where the answer
 * is 3,250: the yen amount is already in whole units and the cents are
 * not. The multiplier has to carry the difference in exponents:
 *
 *     fx_rate = published rate × 10^(exponent(base) − exponent(currency))
 *
 * JPY to USD at 0.0065 is 0.65 cents per yen. KWD to USD at 3.25 is
 * 0.325 cents per fils. CNY to USD at 0.14658 is still 0.14658. That
 * derivation lives in `postingFxRate` and nowhere else; anything that
 * multiplies a minor amount by a number it read off a rate feed is the
 * bug this module exists to stop.
 *
 * The published rate itself is not lost: `fx_rates.rate` and
 * `transactions.metadata.fx.rates[].rate` keep it as quoted, which is the
 * number to show a person.
 *
 * ## Exact arithmetic
 *
 * The conversion runs in integers, on the rate as the `numeric(20,10)`
 * column will hold it, and rounds half away from zero. So a +X leg and a
 * −X leg always convert to opposite numbers, the stored row reproduces
 * the stored amount in SQL (`round(amount_minor * fx_rate)`, which rounds
 * the same way), and no result depends on how a float happened to
 * represent 0.14581.
 */
import { isPointsCurrency } from "../points/codes.js";

/** Decimal places of `postings.fx_rate` and `points_valuations.minor_per_point`. */
export const FX_RATE_SCALE = 10;

/** ISO 4217 minor-unit exponent for every currency not listed below. */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * ISO 4217 minor-unit exponents that are not 2.
 *
 * Kept as the list of exceptions because that is how the standard is
 * shaped: of roughly 160 active codes all but these use two decimals, so
 * an unlisted code is far more likely to be an ordinary currency this
 * table has not met than a new zero-decimal one. Codes ISO lists with no
 * minor unit at all (XAU, XDR, XXX and the other X-codes that are not
 * money) are not here and would default to 2; none can appear on a
 * receipt.
 */
const ISO_4217_EXPONENTS: Readonly<Record<string, number>> = {
  // No subunit in use.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Thousandths.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Ten-thousandths (units of account).
  CLF: 4,
  UYW: 4,
};

/**
 * How many decimal places separate a currency's minor unit from its
 * whole unit. A points programme has no subunit, so its exponent is 0.
 */
export function currencyExponent(code: string): number {
  if (isPointsCurrency(code)) return 0;
  return ISO_4217_EXPONENTS[code] ?? DEFAULT_CURRENCY_EXPONENT;
}

/**
 * The ISO codes listed above with `exponent`, for text that has to name
 * them (the Ask prompt tells the model which amounts not to divide by
 * 100). Empty for the default, which covers every unlisted code.
 */
export function currenciesWithExponent(exponent: number): string[] {
  return Object.keys(ISO_4217_EXPONENTS).filter(
    (code) => ISO_4217_EXPONENTS[code] === exponent,
  );
}

// ── Decimal helpers (integers only, no floats past the parse) ──────────

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** n / d, rounded half away from zero. `d` must be positive. */
function divRound(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const magnitude = negative ? -n : n;
  const q = (magnitude * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/**
 * A decimal as an integer count of 10^-scale, rounded half away from
 * zero when it carries more digits than `scale`.
 *
 * A JS number goes through `toFixed`, which expands the double exactly;
 * at the scales used here that puts any representation noise a dozen
 * digits below the last one kept. A string is what `pg` returns for a
 * `numeric` column and is read digit for digit.
 */
function toScaled(value: number | string, scale: number, what: string): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${what} must be a finite number, got ${value}`);
    }
    text = value.toFixed(scale);
  } else {
    text = value.trim();
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`${what} must be a plain decimal, got "${text}"`);
  const fraction = m[3] ?? "";
  let n = BigInt(m[2]! + fraction.slice(0, scale).padEnd(scale, "0"));
  if (fraction.length > scale && fraction.charCodeAt(scale) >= 53 /* "5" */) {
    n += 1n;
  }
  return m[1] === "-" ? -n : n;
}

function fromScaled(n: bigint, scale: number): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// ── The conversion ─────────────────────────────────────────────────────

/**
 * The value `postings.fx_rate` must hold for a cash posting in `currency`
 * when one whole unit of it is worth `unitRate` whole units of
 * `baseCurrency` — i.e. the published rate, moved by the difference in
 * the two currencies' exponents so that it multiplies minor units.
 *
 * Returned as a decimal string of at most `FX_RATE_SCALE` places, exactly
 * what the column stores, so `toBaseMinor` and the database see the same
 * number.
 *
 * Throws on a points code: a programme has no published rate, and its
 * valuation (`points_valuations.minor_per_point`) is already quoted per
 * minor unit. See `src/points/valuation.ts`.
 */
export function postingFxRate(
  currency: string,
  baseCurrency: string,
  unitRate: number | string,
): string {
  for (const code of [currency, baseCurrency]) {
    if (isPointsCurrency(code)) {
      throw new Error(
        `postingFxRate is for cash currencies; ${code} is a points code ` +
          `and is valued per programme, not from a published rate`,
      );
    }
  }
  // Twice the column scale while shifting, so the single rounding below
  // is the only one.
  const work = FX_RATE_SCALE * 2;
  const scaled = toScaled(unitRate, work, "FX rate");
  if (scaled <= 0n) {
    throw new Error(`FX rate must be positive, got ${String(unitRate)}`);
  }
  const shift = currencyExponent(baseCurrency) - currencyExponent(currency);
  const drop = work - FX_RATE_SCALE - shift;
  const rate = drop >= 0 ? divRound(scaled, pow10(drop)) : scaled * pow10(-drop);
  if (rate <= 0n) {
    throw new Error(
      `FX rate ${String(unitRate)} for ${currency}→${baseCurrency} is too ` +
        `small to store in ${FX_RATE_SCALE} decimal places`,
    );
  }
  return fromScaled(rate, FX_RATE_SCALE);
}

/**
 * `amount_base_minor` for a posting of `amountMinor` at `fxRate`, where
 * `fxRate` is what `postings.fx_rate` holds: the minor-to-minor
 * multiplier from `postingFxRate` for cash, or a programme's
 * `minor_per_point` for points. A rate of 0 is allowed and yields 0 (an
 * unvalued points leg).
 *
 * This is the only place in the codebase that turns a native amount into
 * a base amount. If you are about to write `amount * rate` somewhere
 * else, call this instead.
 */
export function toBaseMinor(
  amountMinor: bigint | number | string,
  fxRate: number | string,
): bigint {
  const amount =
    typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  const rate = toScaled(fxRate, FX_RATE_SCALE, "fx_rate");
  if (rate < 0n) {
    throw new Error(`fx_rate must not be negative, got ${String(fxRate)}`);
  }
  return divRound(amount * rate, pow10(FX_RATE_SCALE));
}

/**
 * Whether two `fx_rate` values are the same number at the column's
 * scale: `"0.645"` and the `"0.6450000000"` Postgres hands back are.
 */
export function fxRatesEqual(a: number | string, b: number | string): boolean {
  return (
    toScaled(a, FX_RATE_SCALE, "fx_rate") === toScaled(b, FX_RATE_SCALE, "fx_rate")
  );
}

/**
 * A minor-unit amount as a plain decimal in the currency's whole units,
 * with thousands separators: `formatMinor(5000, "JPY")` is `"5,000"`,
 * `formatMinor(1234550, "CNY")` is `"12,345.50"`. For logs and script
 * output; the frontend has its own formatter.
 */
export function formatMinor(
  amountMinor: bigint | number | string,
  currency: string,
): string {
  const amount =
    typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  const exponent = currencyExponent(currency);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits
    .slice(0, digits.length - exponent)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
