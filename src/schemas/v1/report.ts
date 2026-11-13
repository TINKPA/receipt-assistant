/**
 * Zod schemas for `/v1/reports/*` — read-only aggregate endpoints.
 *
 * All aggregates roll up `postings` + `transactions` + `accounts`; no
 * new tables. Money is always returned as integer minor units via
 * `AmountMinor` (safe as JS `number` up to 2^53).
 *
 * Voided transactions are excluded from every report at the service
 * layer — the schema does not model `status`.
 *
 * Every amount is in the workspace base currency, and the `currency`
 * field of each response names it. None of the four queries takes a
 * `currency` parameter. One was declared here until the money-exponents
 * fix, and it did the worst thing a parameter can do: `?currency=CNY`
 * returned the same base-currency sums with "CNY" written next to them.
 * Converting a report for real means re-pricing every posting at its own
 * date into a third currency, which nothing needs yet; until something
 * does, the contract does not offer it.
 */
import { z } from "zod";
import {
  AmountMinor,
  CurrencyCode,
  IsoDate,
  Uuid,
} from "./common.js";

// ── Shared query primitives ────────────────────────────────────────────

export const SummaryGroupBy = z.enum(["category", "account", "payee"]);
export const TrendsPeriod = z.enum(["month", "year"]);
export const TrendsGroupBy = z.enum(["category", "total"]);

// ── Points disclosure (#206) ───────────────────────────────────────────

/**
 * How loyalty points contributed to the numbers alongside it.
 *
 * Every report carries one of these because a base-currency total that
 * silently mixes cash with a valuation of Hyatt points is not a number
 * anyone can act on. It answers three questions the total cannot:
 * how much of it is points rather than cash, how much of it rests on a
 * valuation the owner has not confirmed, and how many points
 * transactions were left out entirely for want of a valuation.
 */
export const PointsProgrammeTotal = z
  .object({
    currency: z.string().openapi({ example: "HYATT_PT" }),
    /** Points/miles, in the programme's own units. */
    points_minor: AmountMinor,
    /** Their value in the report's base currency. */
    base_minor: AmountMinor,
    /** A valuation is configured for this programme. */
    valuation_exists: z.boolean(),
    /** The owner has signed off on that valuation. */
    valuation_confirmed: z.boolean(),
  })
  .openapi("PointsProgrammeTotal");

export const PointsDisclosure = z
  .object({
    /** One sentence stating how points combine with cash in this report. */
    policy: z.string(),
    /** Whether `base_minor` is inside the report's own totals. */
    included_in_totals: z.boolean(),
    /** Points-derived base-currency amount in scope. */
    base_minor: AmountMinor,
    /** Of `base_minor`, how much rests on an unconfirmed valuation. */
    unconfirmed_base_minor: AmountMinor,
    /** Transactions whose points could not be valued at all. */
    unvalued_transaction_count: z.number().int(),
    programmes: z.array(PointsProgrammeTotal),
  })
  .openapi("PointsDisclosure");

// ── Unconverted foreign currency ───────────────────────────────────────

/**
 * Foreign-currency legs in the report's scope that were never converted
 * to the base currency, one row per currency.
 */
export const FxUnconvertedCurrency = z
  .object({
    currency: CurrencyCode.openapi({ example: "TWD" }),
    amount_minor: AmountMinor.openapi({
      description:
        "The unconverted legs, summed in that currency's own minor units " +
        "(yen, fen, fils).",
    }),
    // The placeholder an unconverted leg holds is its native amount, so
    // this is the same digits as `amount_minor` wearing the base
    // currency's label.
    counted_base_minor: AmountMinor.openapi({
      description:
        "What the report's totals contain for those legs today: their " +
        "native amount read as base-currency minor units. The totals are " +
        "wrong by the difference between this and the real converted value.",
    }),
    transaction_count: z.number().int(),
  })
  .openapi("FxUnconvertedCurrency");

/**
 * The cash counterpart of `PointsDisclosure.unvalued_transaction_count`.
 *
 * A foreign-currency posting is converted after extraction, at the
 * receipt's date. When no rate could be resolved (the source was down, or
 * it does not publish that currency or date) the posting is left with no
 * `fx_rate` and a base amount equal to its native amount, and it is
 * still summed into every total. A report cannot fix that, but it must
 * not hide it: an empty `unconverted` list is what makes the totals
 * trustworthy as base-currency amounts.
 */
export const FxDisclosure = z
  .object({
    /** States what an unconverted leg does to the totals. */
    policy: z.string(),
    unconverted_transaction_count: z.number().int().openapi({
      description:
        "Transactions in the report's scope with at least one " +
        "foreign-currency posting that was never converted. 0 means every " +
        "amount in the report is a true base-currency amount.",
    }),
    unconverted: z.array(FxUnconvertedCurrency),
  })
  .openapi("FxDisclosure");

/** The `currency` field every report returns. */
const ReportCurrency = CurrencyCode.openapi({
  description:
    "The workspace base currency. Every amount in the report is in it; " +
    "there is no parameter to ask for another.",
});

// ── Summary ────────────────────────────────────────────────────────────

export const SummaryQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  group_by: SummaryGroupBy.optional(),
});

export const SummaryItem = z
  .object({
    key: z.string(),
    count: z.number().int(),
    total_minor: AmountMinor,
    avg_per_txn_minor: AmountMinor,
  })
  .openapi("SummaryItem");

export const SummaryReport = z
  .object({
    from: IsoDate.nullable(),
    to: IsoDate.nullable(),
    group_by: SummaryGroupBy,
    currency: ReportCurrency,
    items: z.array(SummaryItem),
    grand_total_minor: AmountMinor,
    points: PointsDisclosure,
    fx: FxDisclosure,
  })
  .openapi("SummaryReport");

// ── Trends ─────────────────────────────────────────────────────────────

export const TrendsQuery = z.object({
  period: TrendsPeriod.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  group_by: TrendsGroupBy.optional(),
});

export const TrendsItem = z
  .object({
    key: z.string(),
    total_minor: AmountMinor,
    count: z.number().int(),
  })
  .openapi("TrendsItem");

export const TrendsBucket = z
  .object({
    bucket: z.string(),
    items: z.array(TrendsItem),
    total_minor: AmountMinor,
  })
  .openapi("TrendsBucket");

export const TrendsReport = z
  .object({
    from: IsoDate.nullable(),
    to: IsoDate.nullable(),
    period: TrendsPeriod,
    group_by: TrendsGroupBy,
    currency: ReportCurrency,
    buckets: z.array(TrendsBucket),
    points: PointsDisclosure,
    fx: FxDisclosure,
  })
  .openapi("TrendsReport");

// ── Net worth ──────────────────────────────────────────────────────────

export const NetWorthQuery = z.object({
  as_of: IsoDate.optional(),
});

export const NetWorthAccount = z
  .object({
    account_id: Uuid,
    name: z.string(),
    type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    balance_minor: AmountMinor,
  })
  .openapi("NetWorthAccount");

export const NetWorthReport = z
  .object({
    as_of: IsoDate,
    currency: ReportCurrency,
    assets_minor: AmountMinor,
    liabilities_minor: AmountMinor,
    equity_minor: AmountMinor,
    net_worth_minor: AmountMinor,
    by_account: z.array(NetWorthAccount),
    points: PointsDisclosure,
    fx: FxDisclosure,
  })
  .openapi("NetWorthReport");

// ── Cashflow ───────────────────────────────────────────────────────────

export const CashflowQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const CashflowBucket = z
  .object({
    month: z.string(),
    income_minor: AmountMinor,
    expense_minor: AmountMinor,
    net_minor: AmountMinor,
  })
  .openapi("CashflowBucket");

export const CashflowReport = z
  .object({
    from: IsoDate.nullable(),
    to: IsoDate.nullable(),
    currency: ReportCurrency,
    income_minor: AmountMinor,
    expense_minor: AmountMinor,
    net_minor: AmountMinor,
    buckets: z.array(CashflowBucket),
    points: PointsDisclosure,
    fx: FxDisclosure,
  })
  .openapi("CashflowReport");
