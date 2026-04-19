/**
 * Integration tests for `/v1/transactions` + nested postings.
 *
 * Covers: create (+idempotency, imbalance), patch (+If-Match semantics),
 * delete rules, void mirror, reconcile, bulk dispatch, document filter,
 * and If-None-Match 304.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { withTestDb } from "../setup/db.js";
import { accounts, documents } from "../../src/schema/index.js";

const ctx = withTestDb();

async function acctId(name: string): Promise<string> {
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(sql`${accounts.workspaceId} = ${ctx.workspaceId} AND ${accounts.name} = ${name}`);
  if (rows.length === 0) throw new Error(`Account not found: ${name}`);
  return rows[0]!.id;
}

async function waitForIdempotencyKey(key: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.db.execute(
      sql`SELECT 1 FROM idempotency_keys WHERE workspace_id = ${ctx.workspaceId}::uuid AND key = ${key}`,
    );
    if (res.rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Idempotency key ${key} not persisted within ${timeoutMs}ms`);
}

let groceries: string;
let visa: string;
let cash: string;

beforeAll(async () => {
  groceries = await acctId("Groceries");
  visa = await acctId("Credit Card");
  cash = await acctId("Cash");
});

function balancedBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    occurred_on: "2026-04-19",
    payee: "Walmart",
    postings: [
      { account_id: groceries, amount_minor: 14723 },
      { account_id: visa, amount_minor: -14723 },
    ],
    ...overrides,
  };
}

describe("POST /v1/transactions", () => {
  it("creates a balanced transaction (201 + ETag + Location + postings)", async () => {
    const res = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Create Test 1" }));
    expect(res.status).toBe(201);
    expect(res.headers["etag"]).toMatch(/^W\/"\d+"$/);
    expect(res.headers["location"]).toMatch(/^\/v1\/transactions\//);
    expect(res.body.status).toBe("posted");
    expect(res.body.postings).toHaveLength(2);
    expect(res.body.postings[0].amount_minor).toBe(14723);
    expect(res.body.version).toBe(1);
  });

  it("requires Idempotency-Key header (428)", async () => {
    const res = await request(ctx.app)
      .post("/v1/transactions")
      .send(balancedBody({ payee: "No key" }));
    expect(res.status).toBe(428);
    expect(res.headers["content-type"]).toMatch(/problem\+json/);
    expect(res.body.type).toMatch(/precondition-required/);
  });

  it("replays the same idempotency key byte-for-byte", async () => {
    const key = uuidv7();
    const body = balancedBody({ payee: "Replay" });
    const a = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", key)
      .send(body);
    expect(a.status).toBe(201);
    // The middleware persists the memoized response on the response
    // `finish` event (fire-and-forget), so the write may race a second
    // request issued back-to-back. Wait for the row to land before the
    // replay attempt.
    await waitForIdempotencyKey(key);
    const b = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", key)
      .send(body);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("rejects same key with different body (409 idempotency-conflict)", async () => {
    const key = uuidv7();
    const a = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", key)
      .send(balancedBody({ payee: "First" }));
    expect(a.status).toBe(201);
    await waitForIdempotencyKey(key);
    const b = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", key)
      .send(balancedBody({ payee: "Second" }));
    expect(b.status).toBe(409);
    expect(b.body.type).toMatch(/idempotency-conflict/);
  });

  it("rejects imbalanced postings (422 postings-imbalance)", async () => {
    const res = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send({
        occurred_on: "2026-04-19",
        payee: "Imbalanced",
        postings: [
          { account_id: groceries, amount_minor: 1000 },
          { account_id: visa, amount_minor: -999 },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/postings-imbalance/);
  });

  it("rejects unknown account_id (422 validation)", async () => {
    const res = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send({
        occurred_on: "2026-04-19",
        payee: "Bad acct",
        postings: [
          { account_id: "00000000-0000-7000-8000-000000000099", amount_minor: 100 },
          { account_id: visa, amount_minor: -100 },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/validation/);
  });
});

describe("PATCH /v1/transactions/:id", () => {
  it("applies a valid If-Match patch, bumps version + updated_at", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Before" }));
    expect(created.status).toBe(201);
    const id = created.body.id;
    const etag = created.headers["etag"]!;
    const updatedAtBefore = created.body.updated_at;

    await new Promise((r) => setTimeout(r, 20));

    const patch = await request(ctx.app)
      .patch(`/v1/transactions/${id}`)
      .set("If-Match", etag)
      .set("Content-Type", "application/merge-patch+json")
      .send({ payee: "After", narration: "note" });
    expect(patch.status).toBe(200);
    expect(patch.body.payee).toBe("After");
    expect(patch.body.narration).toBe("note");
    expect(patch.body.version).toBe(created.body.version + 1);
    expect(new Date(patch.body.updated_at).getTime()).toBeGreaterThan(
      new Date(updatedAtBefore).getTime(),
    );
    expect(patch.headers["etag"]).toBe(`W/"${patch.body.version}"`);
  });

  it("returns 428 when If-Match is missing", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "No-IfMatch" }));
    const res = await request(ctx.app)
      .patch(`/v1/transactions/${created.body.id}`)
      .send({ payee: "Nope" });
    expect(res.status).toBe(428);
    expect(res.body.type).toMatch(/precondition-required/);
  });

  it("returns 412 when If-Match does not match current version", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Wrong-IfMatch" }));
    const res = await request(ctx.app)
      .patch(`/v1/transactions/${created.body.id}`)
      .set("If-Match", 'W/"999"')
      .send({ payee: "Nope" });
    expect(res.status).toBe(412);
    expect(res.body.type).toMatch(/version-mismatch/);
  });
});

describe("DELETE /v1/transactions/:id", () => {
  it("rejects DELETE on a posted transaction (409 must-void-instead)", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Posted-no-delete" }));
    expect(created.status).toBe(201);
    const res = await request(ctx.app)
      .delete(`/v1/transactions/${created.body.id}`)
      .set("If-Match", created.headers["etag"]!);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/must-void-instead/);
  });

  it("allows DELETE on a draft transaction (204)", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send({
        occurred_on: "2026-04-19",
        payee: "Draft-delete",
        status: "draft",
        postings: [
          { account_id: groceries, amount_minor: 500 },
          { account_id: visa, amount_minor: -500 },
        ],
      });
    expect(created.status).toBe(201);
    const res = await request(ctx.app)
      .delete(`/v1/transactions/${created.body.id}`)
      .set("If-Match", created.headers["etag"]!);
    expect(res.status).toBe(204);

    const after = await request(ctx.app).get(`/v1/transactions/${created.body.id}`);
    expect(after.status).toBe(404);
  });
});

describe("POST /v1/transactions/:id/void", () => {
  it("creates a mirror with negated postings and flips original status", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Void-target" }));
    expect(created.status).toBe(201);
    const origId = created.body.id;

    const voided = await request(ctx.app)
      .post(`/v1/transactions/${origId}/void`)
      .set("If-Match", created.headers["etag"]!)
      .send({ reason: "wrong amount" });
    expect(voided.status).toBe(201);
    const mirror = voided.body;
    expect(mirror.status).toBe("posted");
    expect(mirror.payee).toMatch(/^VOID:/);
    expect(mirror.postings).toHaveLength(2);

    // Sum of mirror postings (by base-minor) cancels original: each posting's
    // sign flipped.
    const origPostings = created.body.postings;
    for (const mp of mirror.postings) {
      const match = origPostings.find((op: any) => op.account_id === mp.account_id);
      expect(match).toBeDefined();
      expect(mp.amount_minor).toBe(-match.amount_minor);
    }

    // Net for the affected accounts (orig + mirror) sums to 0.
    const netByAcct = new Map<string, number>();
    for (const p of [...origPostings, ...mirror.postings]) {
      netByAcct.set(p.account_id, (netByAcct.get(p.account_id) ?? 0) + p.amount_minor);
    }
    for (const [, net] of netByAcct) expect(net).toBe(0);

    // Original is now voided.
    const origAfter = await request(ctx.app).get(`/v1/transactions/${origId}`);
    expect(origAfter.status).toBe(200);
    expect(origAfter.body.status).toBe("voided");
    expect(origAfter.body.voided_by_id).toBe(mirror.id);
  });
});

describe("POST /v1/transactions/:id/reconcile", () => {
  it("flips posted → reconciled", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Reconcile-target" }));
    const res = await request(ctx.app)
      .post(`/v1/transactions/${created.body.id}/reconcile`)
      .set("If-Match", created.headers["etag"]!);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reconciled");
  });
});

describe("POST /v1/transactions:bulk", () => {
  it("runs each op independently; failures don't block successes", async () => {
    const t1 = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Bulk-1" }));
    const t2 = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Bulk-2" }));
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201);

    const res = await request(ctx.app)
      .post("/v1/transactions/bulk")
      .send({
        operations: [
          // Valid update
          {
            op: "update",
            id: t1.body.id,
            if_match: t1.headers["etag"]!,
            patch: { payee: "Bulk-1-updated" },
          },
          // Invalid: wrong if_match on t2
          {
            op: "update",
            id: t2.body.id,
            if_match: 'W/"999"',
            patch: { payee: "bad" },
          },
          // Valid reconcile on t2
          {
            op: "reconcile",
            id: t2.body.id,
            if_match: t2.headers["etag"]!,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].status).toBe(200);
    expect(res.body.results[0].body.payee).toBe("Bulk-1-updated");
    expect(res.body.results[1].status).toBe(412);
    expect(res.body.results[2].status).toBe(200);
    expect(res.body.results[2].body.status).toBe("reconciled");
  });
});

describe("POST /v1/transactions/:id/postings (nested)", () => {
  it("rejects a posting that makes the transaction imbalanced (422)", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "Add-posting-bad" }));
    expect(created.status).toBe(201);

    const res = await request(ctx.app)
      .post(`/v1/transactions/${created.body.id}/postings`)
      .set("If-Match", created.headers["etag"]!)
      .send({ account_id: cash, amount_minor: 999 });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/postings-imbalance/);
  });

  it("accepts balanced add/delete pair on a draft", async () => {
    // On a posted txn you can't add a third posting without another offsetting
    // one — balance re-checks on every mutation. Use draft to exercise the
    // add + update path.
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send({
        occurred_on: "2026-04-19",
        payee: "Draft-nested",
        status: "draft",
        postings: [
          { account_id: groceries, amount_minor: 1000 },
          { account_id: visa, amount_minor: -1000 },
        ],
      });
    expect(created.status).toBe(201);

    const added = await request(ctx.app)
      .post(`/v1/transactions/${created.body.id}/postings`)
      .set("If-Match", created.headers["etag"]!)
      .send({ account_id: cash, amount_minor: 200 });
    // Draft txns bypass balance trigger — accept 201.
    expect(added.status).toBe(201);

    // Now refresh and try to delete it.
    const refreshed = await request(ctx.app).get(`/v1/transactions/${created.body.id}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.postings).toHaveLength(3);

    const del = await request(ctx.app)
      .delete(`/v1/transactions/${refreshed.body.id}/postings/${added.body.id}`)
      .set("If-Match", refreshed.headers["etag"]!);
    expect(del.status).toBe(204);
  });
});

describe("GET /v1/transactions (list filters)", () => {
  it("has_document filter works (both directions)", async () => {
    // Create a transaction with a linked document.
    const docId = uuidv7();
    await ctx.db.insert(documents).values({
      id: docId,
      workspaceId: ctx.workspaceId,
      kind: "receipt_image",
      sha256: `sha-${docId}`,
    });

    const withDoc = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "WithDoc", document_ids: [docId] }));
    expect(withDoc.status).toBe(201);
    expect(withDoc.body.documents).toHaveLength(1);

    // Fetch with has_document=true
    const yes = await request(ctx.app).get(
      "/v1/transactions?has_document=true&payee_contains=WithDoc",
    );
    expect(yes.status).toBe(200);
    expect((yes.body.items as any[]).some((i) => i.id === withDoc.body.id)).toBe(true);

    // Create another without a doc, verify it's excluded.
    const sansDoc = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "SansDoc" }));
    expect(sansDoc.status).toBe(201);

    const no = await request(ctx.app).get(
      "/v1/transactions?has_document=false&payee_contains=SansDoc",
    );
    expect(no.status).toBe(200);
    expect((no.body.items as any[]).some((i) => i.id === sansDoc.body.id)).toBe(true);
    expect((no.body.items as any[]).some((i) => i.id === withDoc.body.id)).toBe(false);
  });

  it("payee_contains + q filters match", async () => {
    await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "UniqueCostco123", narration: "gas trip" }));

    const byPayee = await request(ctx.app).get("/v1/transactions?payee_contains=UniqueCostco");
    expect(byPayee.status).toBe(200);
    expect((byPayee.body.items as any[]).length).toBeGreaterThanOrEqual(1);

    const byQ = await request(ctx.app).get("/v1/transactions?q=gas+trip");
    expect(byQ.status).toBe(200);
    expect((byQ.body.items as any[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /v1/transactions/:id — If-None-Match", () => {
  it("returns 304 when the current ETag matches If-None-Match", async () => {
    const created = await request(ctx.app)
      .post("/v1/transactions")
      .set("Idempotency-Key", uuidv7())
      .send(balancedBody({ payee: "INM test" }));
    expect(created.status).toBe(201);
    const etag = created.headers["etag"]!;

    const res = await request(ctx.app)
      .get(`/v1/transactions/${created.body.id}`)
      .set("If-None-Match", etag);
    expect(res.status).toBe(304);
  });
});
