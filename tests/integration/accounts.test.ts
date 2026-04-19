/**
 * Integration tests for /v1/accounts — CRUD + balance + register.
 *
 * Exercises the full Express app via supertest against the per-suite
 * testcontainers Postgres. The ledger invariants (balance trigger,
 * version/updated_at bump) are covered in schema.test.ts; this file
 * focuses on the HTTP contract: headers, status codes, problem+json,
 * tree/flat list, keyset pagination, register reconciliation.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { Router } from "express";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

// ── Concurrent-agent insulation ─────────────────────────────────────────
// The `transactions` and `documents` routers are being written by
// other agents under sister sub-issues. At the time this file runs,
// those modules may contain Express-4 path-to-regexp syntax that
// crashes Express 5 at route-registration time, which would prevent
// `buildApp()` (invoked by withTestDb) from ever returning. We stub
// them out at the module-resolution layer so our test suite can start.
vi.mock("../../src/routes/transactions.js", () => ({
  transactionsRouter: Router(),
  registerTransactionsOpenApi: () => {},
}));
vi.mock("../../src/routes/documents.js", () => ({
  documentsRouter: Router(),
  registerDocumentsOpenApi: () => {},
}));
vi.mock("../../src/routes/postings.js", () => ({
  postingsRouter: Router(),
  registerPostingsOpenApi: () => {},
}));

import { withTestDb } from "../setup/db.js";
import {
  accounts,
  transactions,
  postings,
} from "../../src/schema/index.js";

const ctx = withTestDb();

async function accountIdByName(name: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = ${name}`);
  if (rows.length === 0) throw new Error(`Account not found: ${name}`);
  return rows[0]!.id;
}

async function insertBalancedTxn(opts: {
  occurredOn: string;
  debitAccountId: string;
  creditAccountId: string;
  amountMinor: bigint;
  payee?: string;
}): Promise<string> {
  const txId = uuidv7();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(transactions).values({
      id: txId,
      workspaceId: ctx.workspaceId,
      occurredOn: opts.occurredOn,
      payee: opts.payee ?? "Test Payee",
      status: "posted",
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

describe("GET /v1/accounts (list)", () => {
  it("returns the 5-branch tree by default", async () => {
    const res = await request(ctx.app).get("/v1/accounts");
    expect(res.status).toBe(200);
    const roots = res.body as Array<{ name: string; children: unknown[] }>;
    expect(Array.isArray(roots)).toBe(true);
    expect(roots).toHaveLength(5);
    const rootNames = roots.map((r) => r.name).sort();
    expect(rootNames).toEqual([
      "Assets",
      "Equity",
      "Expenses",
      "Income",
      "Liabilities",
    ]);
    // Total-across-tree count should equal 18 (seed).
    const countAll = (nodes: any[]): number =>
      nodes.reduce((acc, n) => acc + 1 + countAll(n.children ?? []), 0);
    expect(countAll(roots)).toBe(18);
  });

  it("returns a flat list when ?flat=true", async () => {
    const res = await request(ctx.app).get("/v1/accounts?flat=true");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(18);
    for (const a of res.body as any[]) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.name).toBe("string");
      expect(a.children).toBeUndefined();
    }
  });
});

describe("POST /v1/accounts (create)", () => {
  it("creates a new expense sub-account under Expenses", async () => {
    const expensesRoot = await accountIdByName("Expenses");
    const res = await request(ctx.app)
      .post("/v1/accounts")
      .send({
        parent_id: expensesRoot,
        name: "Coffee",
        type: "expense",
      });
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/^\/v1\/accounts\/[0-9a-f-]{36}$/);
    expect(res.headers.etag).toBe('W/"1"');
    const body = res.body;
    expect(body).toMatchObject({
      parent_id: expensesRoot,
      name: "Coffee",
      type: "expense",
      currency: "USD", // inherited from parent
      version: 1,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.created_at).toBe("string");
  });

  it("rejects a child whose type does not match its parent (422)", async () => {
    const assets = await accountIdByName("Assets");
    const res = await request(ctx.app)
      .post("/v1/accounts")
      .send({
        parent_id: assets,
        name: "Misplaced",
        type: "expense", // parent is asset
      });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/\/errors\/validation$/);
    const paths = (res.body.violations ?? []).map((v: any) => v.path);
    expect(paths).toContain("type");
  });

  it("inherits currency from workspace base when no parent given", async () => {
    const res = await request(ctx.app)
      .post("/v1/accounts")
      .send({ name: "Floating Root", type: "asset" });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe("USD");
    expect(res.body.parent_id).toBeNull();
  });
});

describe("GET /v1/accounts/:id + If-None-Match", () => {
  it("returns a single account with ETag", async () => {
    const id = await accountIdByName("Dining");
    const res = await request(ctx.app).get(`/v1/accounts/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.body.id).toBe(id);
  });

  it("returns 304 when If-None-Match matches", async () => {
    const id = await accountIdByName("Dining");
    const r1 = await request(ctx.app).get(`/v1/accounts/${id}`);
    const etag = r1.headers.etag as string;
    const r2 = await request(ctx.app)
      .get(`/v1/accounts/${id}`)
      .set("If-None-Match", etag);
    expect(r2.status).toBe(304);
  });
});

describe("PATCH /v1/accounts/:id (If-Match semantics)", () => {
  it("updates when If-Match is correct, bumps version", async () => {
    const id = await accountIdByName("Transport");
    const r1 = await request(ctx.app).get(`/v1/accounts/${id}`);
    const etag = r1.headers.etag as string;
    const beforeVersion = r1.body.version as number;

    const r2 = await request(ctx.app)
      .patch(`/v1/accounts/${id}`)
      .set("If-Match", etag)
      .send({ name: "Transportation" });
    expect(r2.status).toBe(200);
    expect(r2.body.name).toBe("Transportation");
    expect(r2.body.version).toBe(beforeVersion + 1);
    expect(r2.headers.etag).toBe(`W/"${beforeVersion + 1}"`);
  });

  it("rejects missing If-Match with 428", async () => {
    const id = await accountIdByName("Utilities");
    const res = await request(ctx.app)
      .patch(`/v1/accounts/${id}`)
      .send({ name: "Utilities & Bills" });
    expect(res.status).toBe(428);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/\/errors\/precondition-required$/);
  });

  it("rejects wrong If-Match with 412 + current_version", async () => {
    const id = await accountIdByName("Entertainment");
    const res = await request(ctx.app)
      .patch(`/v1/accounts/${id}`)
      .set("If-Match", 'W/"999"')
      .send({ name: "Fun" });
    expect(res.status).toBe(412);
    expect(res.body.type).toMatch(/\/errors\/version-mismatch$/);
    expect(res.body.current_version).toBeGreaterThanOrEqual(1);
    expect(res.body.supplied_version).toBe(999);
  });
});

describe("DELETE /v1/accounts/:id", () => {
  it("hard-deletes an unused account; then returns 404", async () => {
    // Create a disposable leaf.
    const expenses = await accountIdByName("Expenses");
    const r1 = await request(ctx.app)
      .post("/v1/accounts")
      .send({ parent_id: expenses, name: "Disposable", type: "expense" });
    expect(r1.status).toBe(201);
    const id = r1.body.id;
    const etag = r1.headers.etag as string;

    const r2 = await request(ctx.app)
      .delete(`/v1/accounts/${id}`)
      .set("If-Match", etag);
    expect(r2.status).toBe(204);

    const r3 = await request(ctx.app).get(`/v1/accounts/${id}`);
    expect(r3.status).toBe(404);
    expect(r3.body.type).toMatch(/\/errors\/not-found$/);

    const r4 = await request(ctx.app)
      .delete(`/v1/accounts/${id}`)
      .set("If-Match", etag);
    expect(r4.status).toBe(404);
  });

  it("refuses to delete an account with postings (409 account-in-use)", async () => {
    const groceries = await accountIdByName("Groceries");
    const visa = await accountIdByName("Credit Card");

    await insertBalancedTxn({
      occurredOn: "2026-02-10",
      debitAccountId: groceries,
      creditAccountId: visa,
      amountMinor: 500n,
      payee: "Bodega",
    });

    const r1 = await request(ctx.app).get(`/v1/accounts/${groceries}`);
    const etag = r1.headers.etag as string;
    const r2 = await request(ctx.app)
      .delete(`/v1/accounts/${groceries}`)
      .set("If-Match", etag);
    expect(r2.status).toBe(409);
    expect(r2.body.type).toMatch(/\/errors\/account-in-use$/);
    expect(r2.body.account_id).toBe(groceries);
    expect(r2.body.posting_count).toBeGreaterThan(0);
  });
});

describe("GET /v1/accounts/:id/balance", () => {
  it("returns 0 for a fresh leaf with no postings", async () => {
    // Use a fresh child we create here; Transport/Dining may have been
    // touched by earlier suites via PATCH but should still have zero
    // postings unless another suite wrote.
    const expenses = await accountIdByName("Expenses");
    const r = await request(ctx.app)
      .post("/v1/accounts")
      .send({ parent_id: expenses, name: "BalanceTestLeaf", type: "expense" });
    expect(r.status).toBe(201);
    const id = r.body.id as string;

    const res = await request(ctx.app).get(
      `/v1/accounts/${id}/balance?as_of=2026-12-31`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      account_id: id,
      as_of: "2026-12-31",
      balance_minor: 0,
      currency: "USD",
      posting_count: 0,
      includes_children: false,
    });
  });

  it("sums postings up to as_of", async () => {
    const dining = await accountIdByName("Dining");
    const cash = await accountIdByName("Cash");

    await insertBalancedTxn({
      occurredOn: "2026-02-14",
      debitAccountId: dining,
      creditAccountId: cash,
      amountMinor: 2500n,
      payee: "Valentine",
    });
    await insertBalancedTxn({
      occurredOn: "2026-03-01",
      debitAccountId: dining,
      creditAccountId: cash,
      amountMinor: 1200n,
      payee: "Brunch",
    });

    const r1 = await request(ctx.app).get(
      `/v1/accounts/${dining}/balance?as_of=2026-02-20`,
    );
    expect(r1.status).toBe(200);
    expect(r1.body.balance_minor).toBe(2500);
    expect(r1.body.posting_count).toBe(1);

    const r2 = await request(ctx.app).get(
      `/v1/accounts/${dining}/balance?as_of=2026-12-31`,
    );
    expect(r2.body.balance_minor).toBe(3700);
    expect(r2.body.posting_count).toBe(2);
  });

  it("include_children sums the whole subtree", async () => {
    const expenses = await accountIdByName("Expenses");
    const cash = await accountIdByName("Cash");
    const transport = await accountIdByName("Transportation"); // renamed earlier
    // Add a posting to Transportation
    await insertBalancedTxn({
      occurredOn: "2026-04-01",
      debitAccountId: transport,
      creditAccountId: cash,
      amountMinor: 4321n,
      payee: "Uber",
    });

    const withoutChildren = await request(ctx.app).get(
      `/v1/accounts/${expenses}/balance?as_of=2026-12-31`,
    );
    expect(withoutChildren.body.balance_minor).toBe(0); // root itself has no postings

    const withChildren = await request(ctx.app).get(
      `/v1/accounts/${expenses}/balance?as_of=2026-12-31&include_children=true`,
    );
    expect(withChildren.body.includes_children).toBe(true);
    expect(withChildren.body.balance_minor).toBeGreaterThan(0);
    // Must include the Uber + Dining + Bodega rows.
    expect(withChildren.body.balance_minor).toBeGreaterThanOrEqual(
      500 + 2500 + 1200 + 4321,
    );
  });
});

describe("GET /v1/accounts/:id/register", () => {
  it("returns items with monotonic running balance + counter_postings", async () => {
    // Use a fresh asset account so we control the full posting sequence.
    const ws = ctx.workspaceId;
    const createRes = await request(ctx.app)
      .post("/v1/accounts")
      .send({ name: "RegTestChecking", type: "asset" });
    expect(createRes.status).toBe(201);
    const checking = createRes.body.id as string;
    void ws;

    const coffeeRes = await request(ctx.app)
      .post("/v1/accounts")
      .send({ name: "RegTestCoffee", type: "expense" });
    const coffee = coffeeRes.body.id as string;

    // 3 txns (chronological)
    await insertBalancedTxn({
      occurredOn: "2026-03-10",
      debitAccountId: checking,
      creditAccountId: coffee, // we'll put coffee as "income side" even though it's expense — flipped sign, just for a balanced test txn
      amountMinor: 1000n,
      payee: "Opening Deposit",
    });
    await insertBalancedTxn({
      occurredOn: "2026-03-11",
      debitAccountId: coffee,
      creditAccountId: checking,
      amountMinor: 500n,
      payee: "Coffee Shop",
    });
    await insertBalancedTxn({
      occurredOn: "2026-03-12",
      debitAccountId: coffee,
      creditAccountId: checking,
      amountMinor: 300n,
      payee: "Espresso Bar",
    });

    const res = await request(ctx.app).get(
      `/v1/accounts/${checking}/register`,
    );
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      occurred_on: string;
      amount_minor: number;
      running_balance_after_minor: number;
      counter_postings: Array<{ name: string; amount_minor: number }>;
    }>;
    expect(items).toHaveLength(3);
    // Most-recent first
    expect(items.map((i) => i.occurred_on)).toEqual([
      "2026-03-12",
      "2026-03-11",
      "2026-03-10",
    ]);
    // Running balance: chronological prefix sums (oldest first):
    //   day 10: +1000 → 1000
    //   day 11: -500 → 500
    //   day 12: -300 → 200
    // But rows are *displayed* most-recent first, so the top row should
    // show the last cumulative value.
    expect(items[0]!.running_balance_after_minor).toBe(200);
    expect(items[1]!.running_balance_after_minor).toBe(500);
    expect(items[2]!.running_balance_after_minor).toBe(1000);

    // Every item should have exactly 1 counter posting (the other leg).
    for (const it of items) {
      expect(it.counter_postings).toHaveLength(1);
      expect(typeof it.counter_postings[0]!.name).toBe("string");
      expect(typeof it.counter_postings[0]!.amount_minor).toBe("number");
    }
    expect(res.body.next_cursor).toBeNull();
  });

  it("paginates via cursor (limit=2 → next → 3rd)", async () => {
    // Reuse the RegTestChecking account with 3 postings.
    const id = (
      await ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = 'RegTestChecking'`)
    )[0]!.id;

    const page1 = await request(ctx.app).get(
      `/v1/accounts/${id}/register?limit=2`,
    );
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.next_cursor).toBeTruthy();
    expect(page1.headers.link).toMatch(/rel="next"/);

    const cursor = page1.body.next_cursor as string;
    const page2 = await request(ctx.app).get(
      `/v1/accounts/${id}/register?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.next_cursor).toBeNull();

    // Combined should match the non-paginated listing.
    const all = [
      ...(page1.body.items as any[]),
      ...(page2.body.items as any[]),
    ];
    expect(all.map((i) => i.occurred_on)).toEqual([
      "2026-03-12",
      "2026-03-11",
      "2026-03-10",
    ]);
  });

  it("register last-row running_balance equals balance.balance_minor for same as_of", async () => {
    const id = (
      await ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = 'RegTestChecking'`)
    )[0]!.id;

    const reg = await request(ctx.app).get(
      `/v1/accounts/${id}/register?to=2026-12-31`,
    );
    const items = reg.body.items as any[];
    // Oldest row is at the end of the descending list.
    const oldestRunning =
      items[items.length - 1].running_balance_after_minor;
    void oldestRunning;
    // The top (most recent) row's running balance is the cumulative
    // total as of that row, which — when no later rows exist — equals
    // the as-of balance for the full set.
    const mostRecentRunning = items[0].running_balance_after_minor;

    const bal = await request(ctx.app).get(
      `/v1/accounts/${id}/balance?as_of=2026-12-31`,
    );
    expect(bal.status).toBe(200);
    expect(mostRecentRunning).toBe(bal.body.balance_minor);
  });
});
