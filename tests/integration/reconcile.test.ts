/**
 * Integration tests for the reconcile pipeline (#32 Phase 2a).
 *
 * Strategy: drive the full batch pipeline through HTTP + the injectable
 * extractor stub, then exercise the four reconcile endpoints. The stub
 * returns identical `ExtractorResult` payloads for two uploads so the
 * worker produces two transactions with matching (payee, occurred_on,
 * total) — the exact dedup trigger.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { sql } from "drizzle-orm";
import { withTestDb } from "../setup/db.js";
import type { Extractor } from "../../src/ingest/extractor.js";
import { buildFakeExtractor } from "../setup/fake-extractor.js";

type WorkerModule = typeof import("../../src/ingest/worker.js");
let workerApi: WorkerModule;

const UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "ra-reconcile-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;

const ctx = withTestDb();

// Each key slot fed into `setDuplicateExtractor` forces all files whose
// filename starts with that key to produce the same extraction output.
// Keeps tests deterministic without depending on filename content
// beyond the dispatch prefix.
type DuplicateKey = {
  prefix: string;
  payee: string;
  occurred_on: string;
  total_minor: number;
};

const DEFAULT_DUPLICATE: DuplicateKey = {
  prefix: "dup",
  payee: "Costco",
  occurred_on: "2026-04-10",
  total_minor: 8421,
};

function makeExtractor(keys: DuplicateKey[]): Extractor {
  const byPrefix: Record<string, Parameters<typeof buildFakeExtractor>[0]["byPrefix"][string]> = {};
  for (const k of keys) {
    byPrefix[k.prefix] = {
      kind: "receipt_image",
      fields: {
        payee: k.payee,
        occurred_on: k.occurred_on,
        total_minor: k.total_minor,
        currency: "USD",
        category_hint: "groceries",
      },
    };
  }
  // Fallback must produce per-file unique fields so non-duplicate
  // uploads stay distinct. Use a function-form fallback so each call
  // derives payee/total from the filename itself (matches the
  // pre-Phase-2 extractor's `Unique ${filename}` / `100 + filename.length`
  // pattern).
  return buildFakeExtractor({
    byPrefix,
    fallback: (filename) => ({
      kind: "receipt_image",
      fields: {
        payee: `Unique ${filename}`,
        occurred_on: "2026-04-01",
        total_minor: 100 + filename.length,
        currency: "USD",
        category_hint: "groceries",
      },
    }),
  });
}

beforeAll(async () => {
  workerApi = await import("../../src/ingest/worker.js");
  workerApi.setExtractor(makeExtractor([DEFAULT_DUPLICATE]));
});

afterEach(() => {
  workerApi.setExtractor(makeExtractor([DEFAULT_DUPLICATE]));
});

function uniqueBytes(tag: string): Buffer {
  return Buffer.from(`reconcile-${tag}-${Math.random()}-${Date.now()}`, "utf8");
}

async function waitForBatchStatus(
  batchId: string,
  targets: string[],
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await workerApi.drain();
  while (Date.now() < deadline) {
    const res = await ctx.db.execute(
      sql`SELECT status FROM batches WHERE id = ${batchId}::uuid`,
    );
    const s = (res.rows[0] as { status: string } | undefined)?.status;
    if (s && targets.includes(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `batch ${batchId} did not reach any of [${targets.join(", ")}] in ${timeoutMs}ms`,
  );
}

interface UploadOpts {
  autoReconcile?: boolean;
  duplicatePrefix?: string;
  count?: number;
}

async function uploadDuplicateBatch(
  opts: UploadOpts = {},
): Promise<{ batchId: string; ingestIds: string[] }> {
  const autoReconcile = opts.autoReconcile ?? false;
  const prefix = opts.duplicatePrefix ?? DEFAULT_DUPLICATE.prefix;
  const count = opts.count ?? 2;
  const req = request(ctx.app).post("/v1/ingest/batch");
  for (let i = 0; i < count; i++) {
    req.attach("files", uniqueBytes(`${prefix}-${i}`), {
      filename: `${prefix}-${i}.jpg`,
      contentType: "image/jpeg",
    });
  }
  req.field("auto_reconcile", String(autoReconcile));
  const res = await req;
  if (res.status !== 202) {
    throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    batchId: res.body.batchId,
    ingestIds: (res.body.items as Array<{ ingestId: string }>).map(
      (i) => i.ingestId,
    ),
  };
}

// ──────────────────────────────────────────────────────────────────────

describe("POST /v1/batches/:id/reconcile — dedup detection + auto-apply", () => {
  it("detects duplicate transactions, flips batch to reconciled, auto-applies above threshold", async () => {
    const { batchId } = await uploadDuplicateBatch({ autoReconcile: false });
    await waitForBatchStatus(batchId, ["extracted"]);

    const res = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.batchId).toBe(batchId);
    expect(res.body.status).toBe("reconciled");
    // Two uploads → one dedup proposal pointing at the canonical.
    expect(res.body.proposals).toHaveLength(1);
    const p = res.body.proposals[0];
    expect(p.kind).toBe("dedup");
    expect(p.score).toBeCloseTo(1.0);
    // Default threshold = 0.95, so the exact-match proposal auto-applies.
    expect(p.status).toBe("auto_applied");
    expect(p.payload.duplicate).toBeDefined();
    expect(p.payload.duplicate_of).toBeDefined();
    expect(p.payload.duplicate).not.toBe(p.payload.duplicate_of);

    expect(res.body.applied.proposals_total).toBe(1);
    expect(res.body.applied.duplicates).toHaveLength(1);
    expect(res.body.applied.duplicates[0].receiptId).toBe(p.payload.duplicate);
    expect(res.body.applied.duplicates[0].duplicateOf).toBe(
      p.payload.duplicate_of,
    );

    // Ledger side-effect: duplicate transaction must now be voided.
    const txRes = await request(ctx.app).get(
      `/v1/transactions/${p.payload.duplicate}`,
    );
    expect(txRes.status).toBe(200);
    expect(txRes.body.status).toBe("voided");
    expect(txRes.body.voided_by_id).toBeDefined();

    // Canonical transaction remains posted.
    const canonicalRes = await request(ctx.app).get(
      `/v1/transactions/${p.payload.duplicate_of}`,
    );
    expect(canonicalRes.body.status).toBe("posted");
  });

  it("is idempotent: a second POST on a reconciled batch returns the stored result", async () => {
    // Register the extractor BEFORE upload — on fast CI runners the
    // worker can start processing files as soon as the POST completes,
    // racing past `setExtractor` and falling back to the unique-per-file
    // extractor, which produces no duplicates for dedup to find.
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "idem", payee: "IdemShop", occurred_on: "2026-03-03", total_minor: 1200 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: false,
      duplicatePrefix: "idem",
    });
    await waitForBatchStatus(batchId, ["extracted"]);

    const first = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({});
    expect(first.status).toBe(200);
    const firstIds = (first.body.proposals as Array<{ id: string }>)
      .map((p) => p.id)
      .sort();
    expect(firstIds.length).toBe(1);

    const second = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("reconciled");
    const secondIds = (second.body.proposals as Array<{ id: string }>)
      .map((p) => p.id)
      .sort();
    // Same IDs on replay — no new rows were written.
    expect(secondIds).toEqual(firstIds);
  });

  it("GET /v1/batches/:id/reconcile returns the stored result", async () => {
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "getread", payee: "ReadBack", occurred_on: "2026-02-14", total_minor: 399 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: false,
      duplicatePrefix: "getread",
    });
    await waitForBatchStatus(batchId, ["extracted"]);

    // Pre-reconcile GET: batch still extracted, no proposals yet.
    const pre = await request(ctx.app).get(
      `/v1/batches/${batchId}/reconcile`,
    );
    expect(pre.status).toBe(200);
    expect(pre.body.status).toBe("extracted");
    expect(pre.body.proposals).toHaveLength(0);

    await request(ctx.app).post(`/v1/batches/${batchId}/reconcile`).send({});
    const post = await request(ctx.app).get(
      `/v1/batches/${batchId}/reconcile`,
    );
    expect(post.status).toBe(200);
    expect(post.body.status).toBe("reconciled");
    expect(post.body.proposals).toHaveLength(1);
  });
});

describe("auto-reconcile hook from worker", () => {
  it("auto_reconcile=true triggers reconcile without an explicit POST", async () => {
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "auto", payee: "AutoShop", occurred_on: "2026-01-05", total_minor: 4200 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: true,
      duplicatePrefix: "auto",
    });
    // Auto-reconcile is chained inside the worker so drain() waits for it.
    await waitForBatchStatus(batchId, ["reconciled", "reconcile_error"]);

    const view = await request(ctx.app).get(
      `/v1/batches/${batchId}/reconcile`,
    );
    expect(view.status).toBe(200);
    expect(view.body.status).toBe("reconciled");
    expect(view.body.proposals).toHaveLength(1);
    expect(view.body.proposals[0].status).toBe("auto_applied");
    // The duplicate transaction voided automatically via the hook.
    const dup = view.body.proposals[0].payload.duplicate as string;
    const dupRes = await request(ctx.app).get(`/v1/transactions/${dup}`);
    expect(dupRes.body.status).toBe("voided");
  });
});

describe("apply / reject", () => {
  it("apply on a proposed dedup proposal voids the duplicate and marks user_applied", async () => {
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "manual", payee: "ManualCo", occurred_on: "2026-03-15", total_minor: 9900 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: false,
      duplicatePrefix: "manual",
    });
    await waitForBatchStatus(batchId, ["extracted"]);

    // Run reconcile with threshold=1.01 so no proposal auto-applies.
    const rec = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({ auto_apply_threshold: 1.01 });
    expect(rec.status).toBe(200);
    const [prop] = rec.body.proposals;
    expect(prop.status).toBe("proposed");
    const dupId = prop.payload.duplicate as string;

    // Duplicate still posted (not auto-applied).
    let dupView = await request(ctx.app).get(`/v1/transactions/${dupId}`);
    expect(dupView.body.status).toBe("posted");

    const applyRes = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile/apply`)
      .send({ proposal_ids: [prop.id] });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toContain(prop.id);
    expect(applyRes.body.skipped).toHaveLength(0);

    // Duplicate now voided; proposal status user_applied.
    dupView = await request(ctx.app).get(`/v1/transactions/${dupId}`);
    expect(dupView.body.status).toBe("voided");

    const view = await request(ctx.app).get(
      `/v1/batches/${batchId}/reconcile`,
    );
    const stored = (view.body.proposals as Array<{ id: string; status: string }>).find(
      (p) => p.id === prop.id,
    );
    expect(stored?.status).toBe("user_applied");
  });

  it("reject marks the proposal rejected without mutating the ledger", async () => {
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "reject", payee: "RejectCo", occurred_on: "2026-03-20", total_minor: 5555 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: false,
      duplicatePrefix: "reject",
    });
    await waitForBatchStatus(batchId, ["extracted"]);

    const rec = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({ auto_apply_threshold: 1.01 });
    const [prop] = rec.body.proposals;
    expect(prop.status).toBe("proposed");
    const dupId = prop.payload.duplicate as string;

    const rej = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile/reject`)
      .send({ proposal_ids: [prop.id], reason: "not actually dup" });
    expect(rej.status).toBe(200);
    expect(rej.body.rejected).toContain(prop.id);

    // Duplicate transaction remains posted (no ledger mutation).
    const dupView = await request(ctx.app).get(`/v1/transactions/${dupId}`);
    expect(dupView.body.status).toBe("posted");

    const view = await request(ctx.app).get(
      `/v1/batches/${batchId}/reconcile`,
    );
    const stored = (view.body.proposals as Array<{ id: string; status: string }>).find(
      (p) => p.id === prop.id,
    );
    expect(stored?.status).toBe("rejected");
  });
});

describe("no-false-positives: unique batches", () => {
  it("a batch with three distinct payees produces zero proposals", async () => {
    // The default extractor makes each non-prefixed file unique by name,
    // so three uploads yield three unique (payee, total) tuples.
    workerApi.setExtractor(makeExtractor([]));
    const r = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("u1"), { filename: "unique-one.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("u2"), { filename: "unique-two.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("u3"), { filename: "unique-three.jpg", contentType: "image/jpeg" });
    expect(r.status).toBe(202);
    const batchId = r.body.batchId as string;
    await waitForBatchStatus(batchId, ["extracted"]);

    const rec = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({});
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe("reconciled");
    expect(rec.body.proposals).toHaveLength(0);
    expect(rec.body.applied.proposals_total).toBe(0);
  });
});

describe("stubs remain no-ops in Phase 2a", () => {
  it("enable=[payment_link,inventory,trip_group] produces zero proposals", async () => {
    workerApi.setExtractor(
      makeExtractor([
        { prefix: "stub", payee: "StubCo", occurred_on: "2026-04-02", total_minor: 333 },
        DEFAULT_DUPLICATE,
      ]),
    );
    const { batchId } = await uploadDuplicateBatch({
      autoReconcile: false,
      duplicatePrefix: "stub",
    });
    await waitForBatchStatus(batchId, ["extracted"]);

    const rec = await request(ctx.app)
      .post(`/v1/batches/${batchId}/reconcile`)
      .send({ enable: ["payment_link", "inventory", "trip_group"] });
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe("reconciled");
    // dedup was NOT enabled → stubs wrote nothing.
    expect(rec.body.proposals).toHaveLength(0);
  });
});
