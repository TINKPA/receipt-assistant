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
  })
  .openapi("CashflowReport");
