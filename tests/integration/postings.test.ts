/**
 * Integration tests for `/v1/postings` (read-only flat list + single-id
 * fetch). The postings are created by POSTing to `/v1/transactions`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { withTestDb } from "../setup/db.js";
import { accounts } from "../../src/schema/index.js";

const ctx = withTestDb();

async function acctId(name: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = ${name}`);
  if (rows.length === 0) throw new Error(`Account not found: ${name}`);
  return rows[0]!.id;
}

describe("GET /v1/postings", () => {
  let txId: string;
  let postingIds: string[];

  beforeAll(async () => {
    const groceries = await acctId("Groceries");
    const visa = await acctId("Credit Card");

    const res = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", "postings-seed-1")
      .send({
        occurred_on: "2026-04-15",
        payee: "Seed txn for postings test",
        postings: [
          { account_id: groceries, amount_minor: 5000 },
          { account_id: visa, amount_minor: -5000 },
        ],
      });
    expect(res.status).toBe(201);
    txId = res.body.id;
    postingIds = res.body.postings.map((p: any) => p.id);
  });

  it("lists postings filtered by transaction_id", async () => {
    const res = await request(ctx.app).get(`/v1/postings?transaction_id=${txId}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const ids = (res.body.items as any[]).map((p) => p.id).sort();
    expect(ids).toEqual([...postingIds].sort());
  });

  it("lists postings filtered by account_id", async () => {
    const groceries = await acctId("Groceries");
    const res = await request(ctx.app).get(`/v1/postings?account_id=${groceries}`);
    expect(res.status).toBe(200);
    // At least the one from this test's seed.
    expect((res.body.items as any[]).some((p) => p.transaction_id === txId)).toBe(true);
  });

  it("fetches a single posting by id", async () => {
    const pid = postingIds[0]!;
    const res = await request(ctx.app).get(`/v1/postings/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(pid);
    expect(res.body.transaction_id).toBe(txId);
    expect(typeof res.body.amount_minor).toBe("number");
  });

  it("returns 404 for unknown posting id", async () => {
    const res = await request(ctx.app).get(
      "/v1/postings/00000000-0000-7000-8000-0000deadbeef",
    );
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/problem\+json/);
    expect(res.body.type).toMatch(/not-found/);
  });
});
