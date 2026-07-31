/**
 * Zod schemas for `/v1/reports/*` — read-only aggregate endpoints.
 *
 * All aggregates roll up `postings` + `transactions` + `accounts`; no
 * new tables. Money is always returned as integer minor units via
 * `AmountMinor` (safe as JS `number` up to 2^53).
 *
 * Voided transactions are excluded from every report at the service
 * layer — the schema does not model `status`.
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

// ── Summary ────────────────────────────────────────────────────────────

export const SummaryQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  group_by: SummaryGroupBy.optional(),
  currency: CurrencyCode.optional(),
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
    currency: CurrencyCode,
    items: z.array(SummaryItem),
    grand_total_minor: AmountMinor,
    points: PointsDisclosure,
  })
  .openapi("SummaryReport");

// ── Trends ─────────────────────────────────────────────────────────────

export const TrendsQuery = z.object({
  period: TrendsPeriod.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  group_by: TrendsGroupBy.optional(),
  currency: CurrencyCode.optional(),
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
    currency: CurrencyCode,
    buckets: z.array(TrendsBucket),
    points: PointsDisclosure,
  })
  .openapi("TrendsReport");

// ── Net worth ──────────────────────────────────────────────────────────

export const NetWorthQuery = z.object({
  as_of: IsoDate.optional(),
  currency: CurrencyCode.optional(),
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
    currency: CurrencyCode,
    assets_minor: AmountMinor,
    liabilities_minor: AmountMinor,
    equity_minor: AmountMinor,
    net_worth_minor: AmountMinor,
    by_account: z.array(NetWorthAccount),
    points: PointsDisclosure,
  })
  .openapi("NetWorthReport");

// ── Cashflow ───────────────────────────────────────────────────────────

export const CashflowQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  currency: CurrencyCode.optional(),
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
    currency: CurrencyCode,
    income_minor: AmountMinor,
    expense_minor: AmountMinor,
    net_minor: AmountMinor,
    buckets: z.array(CashflowBucket),
    points: PointsDisclosure,
  })
  .openapi("CashflowReport");
