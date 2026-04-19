/**
 * `/v1/reports/*` — read-only aggregate endpoints on top of the ledger.
 *
 * All rollups query `postings` ⨝ `transactions` ⨝ `accounts`. No new
 * tables; no migrations. Voided transactions (`status='voided'`) are
 * excluded from every report.
 *
 * The aggregates are small relative to raw ledger size (bounded by
 * user-supplied date range and the number of accounts), so these
 * endpoints return full arrays without keyset pagination.
 *
 * Service functions are exported so the MCP tools in `src/mcp/reports.ts`
 * can invoke them directly without doing HTTP self-calls.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { db } from "../db/client.js";
import { parseOrThrow } from "../http/validate.js";
import { NotFoundProblem } from "../http/problem.js";
import {
  SummaryQuery,
  SummaryReport,
  TrendsQuery,
  TrendsReport,
  NetWorthQuery,
  NetWorthReport,
  CashflowQuery,
  CashflowReport,
} from "../schemas/v1/report.js";
import { ProblemDetails } from "../schemas/v1/common.js";

// ── Helpers ────────────────────────────────────────────────────────────

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

async function fetchWorkspaceBaseCurrency(workspaceId: string): Promise<string> {
  const res = await db.execute(
    sql`SELECT base_currency FROM workspaces WHERE id = ${workspaceId}::uuid`,
  );
  if (res.rows.length === 0) {
    throw new NotFoundProblem("Workspace", workspaceId);
  }
  return (res.rows[0] as { base_currency: string }).base_currency;
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

// ── Service: summary ───────────────────────────────────────────────────

export interface SummaryArgs {
  workspaceId: string;
  from?: string;
  to?: string;
  groupBy?: "category" | "account" | "payee";
  currency?: string;
}

/**
 * Aggregate spend on the expense side of each transaction.
 *
 * - `category` groups by the expense account's name (the first-level
 *   child of Expenses is treated as the category label; siblings further
 *   down collapse to their own name). We use the account name directly —
 *   keeps the query simple and mirrors the register UX.
 * - `account` groups by account id (surfacing account_id as the `key`).
 * - `payee` groups by `transactions.payee` (NULL → "(unspecified)").
 *
 * Only postings on expense-type accounts with positive `amount_base_minor`
 * are counted — this matches the double-entry convention where buying
 * groceries debits Expenses:Groceries (positive) and credits Cash
 * (negative), so summing only the positive expense leg gives the spend
 * amount per transaction without double-counting the settlement side.
 */
export async function getSummaryReport(
  args: SummaryArgs,
): Promise<z.infer<typeof SummaryReport>> {
  const currency =
    args.currency ?? (await fetchWorkspaceBaseCurrency(args.workspaceId));
  const groupBy = args.groupBy ?? "category";

  const fromFilter = args.from
    ? sql`AND t.occurred_on >= ${args.from}::date`
    : sql``;
  const toFilter = args.to
    ? sql`AND t.occurred_on <= ${args.to}::date`
    : sql``;

  // The grouping key (both the returned `key` string and the GROUP BY
  // column) differs per mode. We pre-select it as `group_key` in a CTE
  // so the outer aggregate is uniform.
  let keyExpr;
  if (groupBy === "account") {
    keyExpr = sql`a.id::text`;
  } else if (groupBy === "payee") {
    keyExpr = sql`COALESCE(NULLIF(t.payee, ''), '(unspecified)')`;
  } else {
    // category
    keyExpr = sql`a.name`;
  }

  const result = await db.execute(sql`
    WITH filtered AS (
      SELECT
        ${keyExpr} AS group_key,
        p.transaction_id,
        p.amount_base_minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE p.workspace_id = ${args.workspaceId}::uuid
        AND t.status <> 'voided'
        AND a.type = 'expense'
        AND p.amount_base_minor > 0
        ${fromFilter}
        ${toFilter}
    )
    SELECT
      group_key,
      COUNT(DISTINCT transaction_id)::int AS txn_count,
      COALESCE(SUM(amount_base_minor), 0)::bigint AS total_minor
    FROM filtered
    GROUP BY group_key
    ORDER BY total_minor DESC, group_key ASC
  `);

  const items = (
    result.rows as Array<{
      group_key: string;
      txn_count: number;
      total_minor: string | number | bigint;
    }>
  ).map((r) => {
    const total = toInt(r.total_minor);
    const count = toInt(r.txn_count);
    return {
      key: r.group_key,
      count,
      total_minor: total,
      avg_per_txn_minor: count > 0 ? Math.round(total / count) : 0,
    };
  });

  const grandTotal = items.reduce((acc, it) => acc + it.total_minor, 0);

  return {
    from: args.from ?? null,
    to: args.to ?? null,
    group_by: groupBy,
    currency,
    items,
    grand_total_minor: grandTotal,
  };
}

// ── Service: trends ────────────────────────────────────────────────────

export interface TrendsArgs {
  workspaceId: string;
  period?: "month" | "year";
  from?: string;
  to?: string;
  groupBy?: "category" | "total";
  currency?: string;
}

export async function getTrendsReport(
  args: TrendsArgs,
): Promise<z.infer<typeof TrendsReport>> {
  const currency =
    args.currency ?? (await fetchWorkspaceBaseCurrency(args.workspaceId));
  const period = args.period ?? "month";
  const groupBy = args.groupBy ?? "total";

  const fromFilter = args.from
    ? sql`AND t.occurred_on >= ${args.from}::date`
    : sql``;
  const toFilter = args.to
    ? sql`AND t.occurred_on <= ${args.to}::date`
    : sql``;

  // Bucket label: 'YYYY-MM' for month, 'YYYY' for year.
  const bucketExpr =
    period === "year"
      ? sql`TO_CHAR(date_trunc('year', t.occurred_on), 'YYYY')`
      : sql`TO_CHAR(date_trunc('month', t.occurred_on), 'YYYY-MM')`;

  const keyExpr =
    groupBy === "category" ? sql`a.name` : sql`'__total__'::text`;

  const result = await db.execute(sql`
    WITH filtered AS (
      SELECT
        ${bucketExpr} AS bucket,
        ${keyExpr} AS group_key,
        p.transaction_id,
        p.amount_base_minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE p.workspace_id = ${args.workspaceId}::uuid
        AND t.status <> 'voided'
        AND a.type = 'expense'
        AND p.amount_base_minor > 0
        ${fromFilter}
        ${toFilter}
    )
    SELECT
      bucket,
      group_key,
      COUNT(DISTINCT transaction_id)::int AS txn_count,
      COALESCE(SUM(amount_base_minor), 0)::bigint AS total_minor
    FROM filtered
    GROUP BY bucket, group_key
    ORDER BY bucket ASC, total_minor DESC, group_key ASC
  `);

  const rows = result.rows as Array<{
    bucket: string;
    group_key: string;
    txn_count: number;
    total_minor: string | number | bigint;
  }>;

  const bucketMap = new Map<
    string,
    { items: Array<{ key: string; total_minor: number; count: number }>; total_minor: number }
  >();
  for (const r of rows) {
    const slot = bucketMap.get(r.bucket) ?? { items: [], total_minor: 0 };
    const total = toInt(r.total_minor);
    const count = toInt(r.txn_count);
    slot.items.push({
      key: groupBy === "total" ? "total" : r.group_key,
      total_minor: total,
      count,
    });
    slot.total_minor += total;
    bucketMap.set(r.bucket, slot);
  }

  const buckets = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, v]) => ({
      bucket,
      items: v.items,
      total_minor: v.total_minor,
    }));

  return {
    from: args.from ?? null,
    to: args.to ?? null,
    period,
    group_by: groupBy,
    currency,
    buckets,
  };
}

// ── Service: net worth ─────────────────────────────────────────────────

export interface NetWorthArgs {
  workspaceId: string;
  asOf?: string;
  currency?: string;
}

/**
 * Balance every non-closed account at `as_of`, then roll up by type.
 *
 * Sign conventions (same as account balances in the ledger):
 *  - asset accounts → positive balances typically.
 *  - liability accounts → negative balances (amounts you owe).
 *  - equity accounts → often near zero / opening balance.
 *
 * `net_worth_minor = assets_minor + liabilities_minor + equity_minor`.
 * Because liabilities are already negative, the addition yields the
 * intuitive "what I own minus what I owe" figure.
 */
export async function getNetWorthReport(
  args: NetWorthArgs,
): Promise<z.infer<typeof NetWorthReport>> {
  const currency =
    args.currency ?? (await fetchWorkspaceBaseCurrency(args.workspaceId));
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);

  const result = await db.execute(sql`
    SELECT
      a.id::text      AS account_id,
      a.name          AS name,
      a.type::text    AS type,
      COALESCE(SUM(p.amount_base_minor) FILTER (
        WHERE t.status = 'posted' AND t.occurred_on <= ${asOf}::date
      ), 0)::bigint AS balance_minor
    FROM accounts a
    LEFT JOIN postings p ON p.account_id = a.id AND p.workspace_id = a.workspace_id
    LEFT JOIN transactions t ON t.id = p.transaction_id
    WHERE a.workspace_id = ${args.workspaceId}::uuid
      AND a.closed_at IS NULL
      AND a.type IN ('asset', 'liability', 'equity')
    GROUP BY a.id, a.name, a.type
    ORDER BY a.type ASC, a.name ASC
  `);

  const byAccount = (
    result.rows as Array<{
      account_id: string;
      name: string;
      type: "asset" | "liability" | "equity" | "income" | "expense";
      balance_minor: string | number | bigint;
    }>
  ).map((r) => ({
    account_id: r.account_id,
    name: r.name,
    type: r.type,
    balance_minor: toInt(r.balance_minor),
  }));

  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const a of byAccount) {
    if (a.type === "asset") assets += a.balance_minor;
    else if (a.type === "liability") liabilities += a.balance_minor;
    else if (a.type === "equity") equity += a.balance_minor;
  }

  return {
    as_of: asOf,
    currency,
    assets_minor: assets,
    liabilities_minor: liabilities,
    equity_minor: equity,
    net_worth_minor: assets + liabilities + equity,
    by_account: byAccount,
  };
}

// ── Service: cashflow ──────────────────────────────────────────────────

export interface CashflowArgs {
  workspaceId: string;
  from?: string;
  to?: string;
  currency?: string;
}

/**
 * Income vs. expense over a date range, bucketed by month.
 *
 * `income_minor` sums positive postings on income-type accounts; in
 * double-entry a paycheck credits Income:Salary (negative) and debits
 * Checking (positive). To surface income as a positive cashflow figure
 * we NEGATE the income posting sum (it's naturally <= 0 on the income
 * leg), then add expenses and compute `net = income - expense`.
 */
export async function getCashflowReport(
  args: CashflowArgs,
): Promise<z.infer<typeof CashflowReport>> {
  const currency =
    args.currency ?? (await fetchWorkspaceBaseCurrency(args.workspaceId));

  const fromFilter = args.from
    ? sql`AND t.occurred_on >= ${args.from}::date`
    : sql``;
  const toFilter = args.to
    ? sql`AND t.occurred_on <= ${args.to}::date`
    : sql``;

  const result = await db.execute(sql`
    WITH filtered AS (
      SELECT
        TO_CHAR(date_trunc('month', t.occurred_on), 'YYYY-MM') AS month,
        a.type::text AS acct_type,
        p.amount_base_minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE p.workspace_id = ${args.workspaceId}::uuid
        AND t.status <> 'voided'
        AND a.type IN ('income', 'expense')
        ${fromFilter}
        ${toFilter}
    )
    SELECT
      month,
      COALESCE(-SUM(amount_base_minor) FILTER (WHERE acct_type = 'income'), 0)::bigint AS income_minor,
      COALESCE(SUM(amount_base_minor)  FILTER (WHERE acct_type = 'expense' AND amount_base_minor > 0), 0)::bigint AS expense_minor
    FROM filtered
    GROUP BY month
    ORDER BY month ASC
  `);

  const buckets = (
    result.rows as Array<{
      month: string;
      income_minor: string | number | bigint;
      expense_minor: string | number | bigint;
    }>
  ).map((r) => {
    const income = toInt(r.income_minor);
    const expense = toInt(r.expense_minor);
    return {
      month: r.month,
      income_minor: income,
      expense_minor: expense,
      net_minor: income - expense,
    };
  });

  const totalIncome = buckets.reduce((a, b) => a + b.income_minor, 0);
  const totalExpense = buckets.reduce((a, b) => a + b.expense_minor, 0);

  return {
    from: args.from ?? null,
    to: args.to ?? null,
    currency,
    income_minor: totalIncome,
    expense_minor: totalExpense,
    net_minor: totalIncome - totalExpense,
    buckets,
  };
}

// ── Router ─────────────────────────────────────────────────────────────

export const reportsRouter: Router = Router();

reportsRouter.get(
  "/summary",
  ah(async (req, res) => {
    const q = parseOrThrow(SummaryQuery, req.query);
    const out = await getSummaryReport({
      workspaceId: req.ctx.workspaceId,
      from: q.from,
      to: q.to,
      groupBy: q.group_by,
      currency: q.currency,
    });
    res.json(out);
  }),
);

reportsRouter.get(
  "/trends",
  ah(async (req, res) => {
    const q = parseOrThrow(TrendsQuery, req.query);
    const out = await getTrendsReport({
      workspaceId: req.ctx.workspaceId,
      period: q.period,
      from: q.from,
      to: q.to,
      groupBy: q.group_by,
      currency: q.currency,
    });
    res.json(out);
  }),
);

reportsRouter.get(
  "/net_worth",
  ah(async (req, res) => {
    const q = parseOrThrow(NetWorthQuery, req.query);
    const out = await getNetWorthReport({
      workspaceId: req.ctx.workspaceId,
      asOf: q.as_of,
      currency: q.currency,
    });
    res.json(out);
  }),
);

reportsRouter.get(
  "/cashflow",
  ah(async (req, res) => {
    const q = parseOrThrow(CashflowQuery, req.query);
    const out = await getCashflowReport({
      workspaceId: req.ctx.workspaceId,
      from: q.from,
      to: q.to,
      currency: q.currency,
    });
    res.json(out);
  }),
);

// ── OpenAPI registration ───────────────────────────────────────────────

const problemResponse = {
  content: { "application/problem+json": { schema: ProblemDetails } },
};

export function registerReportsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("SummaryReport", SummaryReport);
  registry.register("TrendsReport", TrendsReport);
  registry.register("NetWorthReport", NetWorthReport);
  registry.register("CashflowReport", CashflowReport);

  registry.registerPath({
    method: "get",
    path: "/v1/reports/summary",
    summary: "Spend aggregated by category / account / payee",
    tags: ["reports"],
    request: { query: SummaryQuery },
    responses: {
      200: {
        description: "Summary report",
        content: { "application/json": { schema: SummaryReport } },
      },
      404: { description: "Workspace not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/reports/trends",
    summary: "Time-series trend (MoM / YoY) of expense spend",
    tags: ["reports"],
    request: { query: TrendsQuery },
    responses: {
      200: {
        description: "Trends report",
        content: { "application/json": { schema: TrendsReport } },
      },
      404: { description: "Workspace not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/reports/net_worth",
    summary: "Assets - liabilities at a point in time",
    tags: ["reports"],
    request: { query: NetWorthQuery },
    responses: {
      200: {
        description: "Net worth report",
        content: { "application/json": { schema: NetWorthReport } },
      },
      404: { description: "Workspace not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/reports/cashflow",
    summary: "Inflows vs outflows over a range, bucketed by month",
    tags: ["reports"],
    request: { query: CashflowQuery },
    responses: {
      200: {
        description: "Cashflow report",
        content: { "application/json": { schema: CashflowReport } },
      },
      404: { description: "Workspace not found", ...problemResponse },
    },
  });
}
