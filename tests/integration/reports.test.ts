/**
 * Integration tests for /v1/reports/* — summary, trends, net_worth, cashflow.
 *
 * Exercises the full Express app via supertest against the per-suite
 * testcontainers Postgres. A small fixture set (see `beforeAll`) covers
 * multiple months, categories, accounts, and a voided transaction to
 * verify aggregation correctness and voided exclusion.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { withTestDb } from "../setup/db.js";
import {
  accounts,
  transactions,
  postings,
} from "../../src/schema/index.js";

const ctx = withTestDb();

async function acctId(name: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = ${name}`,
    );
  if (rows.length === 0) throw new Error(`Account not found: ${name}`);
  return rows[0]!.id;
}

/**
 * Insert a double-entry transaction with two postings that sum to zero.
 * debit  → +amount on debitAccountId
 * credit → -amount on creditAccountId
 * Both use USD and populate amount_base_minor = amount_minor.
 */
async function insertTxn(opts: {
  occurredOn: string;
  debitAccountId: string;
  creditAccountId: string;
  amountMinor: bigint;
  payee?: string;
  status?: "posted" | "voided";
}): Promise<string> {
  const txId = uuidv7();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(transactions).values({
      id: txId,
      workspaceId: ctx.workspaceId,
      occurredOn: opts.occurredOn,
      payee: opts.payee ?? "Test Payee",
      status: opts.status ?? "posted",
    });
    await tx.insert(postings).values([
      {
        id: uuidv7(),
        workspaceId: ctx.workspaceId,
        transactionId: txId,
        accountId: opts.debitAccountId,
        amountMinor: opts.amountMinor,
        currency: "USD",
        amountBaseMinor: opts.amountMinor,
      },
      {
        id: uuidv7(),
        workspaceId: ctx.workspaceId,
        transactionId: txId,
        accountId: opts.creditAccountId,
        amountMinor: -opts.amountMinor,
        currency: "USD",
        amountBaseMinor: -opts.amountMinor,
      },
    ]);
  });
  return txId;
}

// ── Fixture seed ────────────────────────────────────────────────────────
//
// 8 posted transactions across Jan / Feb / Mar 2026, plus one voided
// March transaction that must NOT appear in any aggregate.
//
//   Jan 2026:  Groceries 3000 (Checking), Groceries 2000 (Credit Card)
//              Dining    5000 (Checking)
//              Salary inflow: +200000 to Checking from Salary income
//   Feb 2026:  Groceries 4000 (Checking)
//              Dining    6000 (Credit Card)
//   Mar 2026:  Groceries 1500 (Checking)
//              Dining    3500 (Checking)
//              Salary inflow: +250000 to Checking from Salary income
//              VOIDED    Dining 9999 (Checking)    ← must be excluded

let groceries: string;
let dining: string;
let checking: string;
let visa: string;
let salary: string;

beforeAll(async () => {
  groceries = await acctId("Groceries");
  dining = await acctId("Dining");
  checking = await acctId("Checking");
  visa = await acctId("Credit Card");
  salary = await acctId("Salary");

  // Jan 2026
  await insertTxn({
    occurredOn: "2026-01-05",
    debitAccountId: groceries,
    creditAccountId: checking,
    amountMinor: 3000n,
    payee: "Whole Foods",
  });
  await insertTxn({
    occurredOn: "2026-01-12",
    debitAccountId: groceries,
    creditAccountId: visa,
    amountMinor: 2000n,
    payee: "Trader Joes",
  });
  await insertTxn({
    occurredOn: "2026-01-20",
    debitAccountId: dining,
    creditAccountId: checking,
    amountMinor: 5000n,
    payee: "Bistro",
  });
  // Income: Checking ← Salary. In double-entry, income is the CREDIT
  // (negative on Salary); Checking receives the positive debit.
  await insertTxn({
    occurredOn: "2026-01-31",
    debitAccountId: checking,
    creditAccountId: salary,
    amountMinor: 200000n,
    payee: "Paycheck Jan",
  });

  // Feb 2026
  await insertTxn({
    occurredOn: "2026-02-08",
    debitAccountId: groceries,
    creditAccountId: checking,
    amountMinor: 4000n,
    payee: "Whole Foods",
  });
  await insertTxn({
    occurredOn: "2026-02-18",
    debitAccountId: dining,
    creditAccountId: visa,
    amountMinor: 6000n,
    payee: "Bistro",
  });

  // Mar 2026
  await insertTxn({
    occurredOn: "2026-03-03",
    debitAccountId: groceries,
    creditAccountId: checking,
    amountMinor: 1500n,
    payee: "Corner Store",
  });
  await insertTxn({
    occurredOn: "2026-03-14",
    debitAccountId: dining,
    creditAccountId: checking,
    amountMinor: 3500n,
    payee: "Bistro",
  });
  await insertTxn({
    occurredOn: "2026-03-28",
    debitAccountId: checking,
    creditAccountId: salary,
    amountMinor: 250000n,
    payee: "Paycheck Mar",
  });

  // Voided dining spend — must be excluded.
  // Trick: insert as 'posted' first (trigger requires balance), then flip.
  const voidedId = await insertTxn({
    occurredOn: "2026-03-20",
    debitAccountId: dining,
    creditAccountId: checking,
    amountMinor: 9999n,
    payee: "Voided Bistro",
  });
  await ctx.db.execute(
    sql`UPDATE transactions SET status = 'voided' WHERE id = ${voidedId}::uuid`,
  );
});

// ── /v1/reports/summary ────────────────────────────────────────────────

describe("GET /v1/reports/summary", () => {
  it("groups by category (default) and returns per-category totals", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2026-01-01", to: "2026-03-31" });

    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe("category");
    expect(res.body.currency).toBe("USD");
    expect(res.body.from).toBe("2026-01-01");
    expect(res.body.to).toBe("2026-03-31");

    const byKey = new Map<string, { count: number; total_minor: number; avg_per_txn_minor: number }>();
    for (const it of res.body.items) byKey.set(it.key, it);

    // Groceries: 3000 + 2000 + 4000 + 1500 = 10500, 4 txns
    expect(byKey.get("Groceries")).toMatchObject({ count: 4, total_minor: 10500 });
    // Dining: 5000 + 6000 + 3500 = 14500, 3 txns (voided 9999 excluded)
    expect(byKey.get("Dining")).toMatchObject({ count: 3, total_minor: 14500 });
    // Avg check for Groceries = 10500/4 = 2625
    expect(byKey.get("Groceries")!.avg_per_txn_minor).toBe(2625);

    expect(res.body.grand_total_minor).toBe(10500 + 14500);

    // Voided txn must not bleed in
    const hasVoidKey = res.body.items.some((it: any) =>
      String(it.key).toLowerCase().includes("void"),
    );
    expect(hasVoidKey).toBe(false);
  });

  it("groups by account when group_by=account", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2026-01-01", to: "2026-03-31", group_by: "account" });

    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe("account");
    // The expense side is what we aggregate, and the expense accounts
    // in the fixture are Groceries + Dining — so exactly 2 keys.
    expect(res.body.items).toHaveLength(2);
    const ids = res.body.items.map((i: any) => i.key).sort();
    expect(ids).toEqual([groceries, dining].sort());
  });

  it("groups by payee when group_by=payee", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2026-01-01", to: "2026-03-31", group_by: "payee" });

    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe("payee");
    const keys = new Set(res.body.items.map((i: any) => i.key));
    // Whole Foods appears twice (Jan + Feb), Trader Joes once, Bistro 3x,
    // Corner Store once. Payees for the two Paycheck txns are income-
    // side so they DO NOT contribute — summary counts expense side only.
    expect(keys.has("Whole Foods")).toBe(true);
    expect(keys.has("Trader Joes")).toBe(true);
    expect(keys.has("Bistro")).toBe(true);
    expect(keys.has("Corner Store")).toBe(true);
    expect(keys.has("Voided Bistro")).toBe(false);
    expect(keys.has("Paycheck Jan")).toBe(false);

    const bistro = res.body.items.find((i: any) => i.key === "Bistro");
    // Bistro expense total = 5000 (Jan Dining) + 6000 (Feb Dining) + 3500
    //   (Mar Dining) = 14500. The voided 9999 is excluded.
    expect(bistro.total_minor).toBe(14500);
    expect(bistro.count).toBe(3);
  });

  it("filters by from/to (Feb only slice)", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2026-02-01", to: "2026-02-28" });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe("2026-02-01");
    expect(res.body.to).toBe("2026-02-28");
    // Feb: Groceries 4000 + Dining 6000 = 10000
    expect(res.body.grand_total_minor).toBe(10000);
    const byKey = new Map<string, any>(
      res.body.items.map((it: any) => [it.key, it]),
    );
    expect(byKey.get("Groceries").total_minor).toBe(4000);
    expect(byKey.get("Dining").total_minor).toBe(6000);
  });
});

// ── /v1/reports/trends ─────────────────────────────────────────────────

describe("GET /v1/reports/trends", () => {
  it("buckets by month and shows MoM change", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/trends")
      .query({ period: "month", from: "2026-01-01", to: "2026-03-31" });

    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
    expect(res.body.buckets).toHaveLength(3);
    const byBucket = new Map<string, any>(
      res.body.buckets.map((b: any) => [b.bucket, b]),
    );

    // Jan expense total: 3000 + 2000 + 5000 = 10000
    // Feb expense total: 4000 + 6000 = 10000
    // Mar expense total: 1500 + 3500 = 5000 (voided 9999 excluded)
    expect(byBucket.get("2026-01").total_minor).toBe(10000);
    expect(byBucket.get("2026-02").total_minor).toBe(10000);
    expect(byBucket.get("2026-03").total_minor).toBe(5000);

    // Buckets arrive in ascending order.
    expect(res.body.buckets.map((b: any) => b.bucket)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });
});

// ── /v1/reports/net_worth ──────────────────────────────────────────────

describe("GET /v1/reports/net_worth", () => {
  it("computes assets + liabilities + equity = net_worth at as_of", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/net_worth")
      .query({ as_of: "2026-03-31" });

    expect(res.status).toBe(200);
    expect(res.body.as_of).toBe("2026-03-31");
    expect(res.body.currency).toBe("USD");

    const { assets_minor, liabilities_minor, equity_minor, net_worth_minor } =
      res.body;

    // Equation invariant: assets + liabilities + equity = net_worth.
    expect(assets_minor + liabilities_minor + equity_minor).toBe(
      net_worth_minor,
    );

    // Sanity: the fixture has two paychecks landing in Checking
    // (+200000, +250000) minus grocery/dining spent from Checking
    // (3000 + 5000 + 4000 + 1500 + 3500 = 17000) = +433000 on assets
    // from Checking. Credit Card (liability) has -2000 -6000 = -8000
    // (negative on liability → amounts owed).
    expect(assets_minor).toBe(433000);
    expect(liabilities_minor).toBe(-8000);
    // Equity accounts untouched by fixture → 0.
    expect(equity_minor).toBe(0);
    expect(net_worth_minor).toBe(433000 + -8000 + 0);

    // by_account sanity: every asset/liability/equity account present.
    const types = new Set(res.body.by_account.map((a: any) => a.type));
    expect(types.has("asset")).toBe(true);
    expect(types.has("liability")).toBe(true);
    expect(types.has("equity")).toBe(true);

    const checkingRow = res.body.by_account.find(
      (a: any) => a.account_id === checking,
    );
    expect(checkingRow.balance_minor).toBe(433000);
  });
});

// ── /v1/reports/cashflow ───────────────────────────────────────────────

describe("GET /v1/reports/cashflow", () => {
  it("computes income - expense = net over range", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/cashflow")
      .query({ from: "2026-01-01", to: "2026-03-31" });

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");

    // Income: Jan 200000 + Mar 250000 = 450000
    // Expense: Jan 10000 + Feb 10000 + Mar 5000 = 25000
    expect(res.body.income_minor).toBe(450000);
    expect(res.body.expense_minor).toBe(25000);
    expect(res.body.net_minor).toBe(450000 - 25000);
    expect(res.body.income_minor - res.body.expense_minor).toBe(
      res.body.net_minor,
    );

    // Per-month buckets
    const byMonth = new Map<string, any>(
      res.body.buckets.map((b: any) => [b.month, b]),
    );
    expect(byMonth.get("2026-01").income_minor).toBe(200000);
    expect(byMonth.get("2026-01").expense_minor).toBe(10000);
    expect(byMonth.get("2026-01").net_minor).toBe(190000);
    expect(byMonth.get("2026-02").income_minor).toBe(0);
    expect(byMonth.get("2026-02").expense_minor).toBe(10000);
    expect(byMonth.get("2026-03").income_minor).toBe(250000);
    expect(byMonth.get("2026-03").expense_minor).toBe(5000);
  });
});

// ── Voided exclusion ──────────────────────────────────────────────────

describe("voided transactions are excluded from every report", () => {
  it("the 9999 voided Dining row is not present in any aggregate", async () => {
    // Summary: Dining total must NOT include the 9999 voided row.
    const s = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2026-01-01", to: "2026-03-31" });
    const diningRow = s.body.items.find((i: any) => i.key === "Dining");
    expect(diningRow.total_minor).toBe(14500);
    expect(diningRow.total_minor).not.toBe(14500 + 9999);

    // Trends: March total must exclude the voided 9999.
    const t = await request(ctx.app)
      .get("/v1/reports/trends")
      .query({ period: "month", from: "2026-03-01", to: "2026-03-31" });
    const marchBucket = t.body.buckets.find((b: any) => b.bucket === "2026-03");
    expect(marchBucket.total_minor).toBe(5000);

    // Cashflow: March expense must exclude the voided 9999.
    const c = await request(ctx.app)
      .get("/v1/reports/cashflow")
      .query({ from: "2026-03-01", to: "2026-03-31" });
    const marchCash = c.body.buckets.find((b: any) => b.month === "2026-03");
    expect(marchCash.expense_minor).toBe(5000);
  });
});

// ── Empty-range fallbacks ─────────────────────────────────────────────

describe("empty ranges / no matches return zeros, not 500", () => {
  it("summary over a date range with no txns returns empty items and grand_total=0", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/summary")
      .query({ from: "2027-01-01", to: "2027-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.grand_total_minor).toBe(0);
    expect(res.body.currency).toBe("USD");
  });

  it("cashflow over an empty range returns zero totals", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/cashflow")
      .query({ from: "2027-01-01", to: "2027-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.income_minor).toBe(0);
    expect(res.body.expense_minor).toBe(0);
    expect(res.body.net_minor).toBe(0);
    expect(res.body.buckets).toEqual([]);
  });

  it("net_worth at a date before any activity returns zero balances", async () => {
    const res = await request(ctx.app)
      .get("/v1/reports/net_worth")
      .query({ as_of: "2025-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.assets_minor).toBe(0);
    expect(res.body.liabilities_minor).toBe(0);
    expect(res.body.equity_minor).toBe(0);
    expect(res.body.net_worth_minor).toBe(0);
    // But the account rows should still enumerate (just with zero balances)
    expect(res.body.by_account.length).toBeGreaterThan(0);
    for (const a of res.body.by_account) {
      expect(a.balance_minor).toBe(0);
    }
  });
});
