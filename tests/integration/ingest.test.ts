/**
 * Integration tests for `/v1/ingest/batch`, `/v1/batches`, `/v1/ingests`.
 *
 * Uses a deterministic stub extractor so CI never shells out to
 * `claude -p`. The stub classifies based on filename suffix, which
 * keeps the pipeline exercised end-to-end (upload → ingest → extract
 * → createTransaction → link document → write produced{}) while
 * staying free of network/model dependencies.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { sql } from "drizzle-orm";
import { withTestDb } from "../setup/db.js";
import type { Extractor } from "../../src/ingest/extractor.js";
import type { LangfuseIngestor } from "../../src/ingest/worker.js";

// Worker module touches the drizzle pool at import-time. Defer the load
// until beforeAll() has set DATABASE_URL via `withTestDb()` — otherwise
// the static `new Pool(...)` in src/db/client.ts binds to localhost:5432
// and every query blows up with ECONNREFUSED.
type WorkerModule = typeof import("../../src/ingest/worker.js");
let workerApi: WorkerModule;

// Per-suite upload dir so the documents service has a writable path.
const UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "ra-ingest-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;

const ctx = withTestDb();

// Filename-stem → ExtractorResult mapping. The stub keys off the
// filename's LEADING token (before the first dash/underscore) so
// callers can compose names like "image-a.jpg", "unsupported-W2.pdf",
// "statement-april.pdf" without collisions.
//
// Note: the worker passes the CLIENT filename (from multipart), not the
// on-disk sha256-derived path, so the mapping survives dedup renaming.
const FakeExtractor: Extractor = async ({ filename }) => {
  const stem = filename.toLowerCase();
  const head = stem.split(/[-_]/)[0]!;

  if (head === "throw") {
    throw new Error("stub extractor blew up on purpose");
  }
  if (head === "unsupported") {
    return {
      classification: "unsupported",
      reason: "test fixture flagged unsupported",
      sessionId: "stub-session-unsupported",
    };
  }
  if (head === "statement") {
    return {
      classification: "statement_pdf",
      extracted: { rows: [] },
      sessionId: "stub-session-statement",
    };
  }
  if (head === "email") {
    return {
      classification: "receipt_email",
      extracted: {
        payee: "Amazon.com",
        occurred_on: "2026-04-18",
        total_minor: 4999,
        currency: "USD",
        category_hint: "retail",
      },
      sessionId: "stub-session-email",
    };
  }
  if (head === "pdf") {
    return {
      classification: "receipt_pdf",
      extracted: {
        payee: "PDF Coffee Co",
        occurred_on: "2026-04-17",
        total_minor: 725,
        currency: "USD",
        category_hint: "cafe",
      },
      sessionId: "stub-session-pdf",
    };
  }
  // Default: treat as a receipt_image.
  return {
    classification: "receipt_image",
    extracted: {
      payee: "FakeMart",
      occurred_on: "2026-04-19",
      total_minor: 1234,
      currency: "USD",
      category_hint: "groceries",
    },
    sessionId: "stub-session-image",
  };
};

// Langfuse spy — captures (sessionId, tags) per extraction without
// touching the real ingestion HTTP path. See worker.ts::trackLangfuse.
const langfuseCalls: Array<{ sessionId: string; tags: string[] }> = [];
const SpyLangfuseIngestor: LangfuseIngestor = async (sessionId, tags) => {
  langfuseCalls.push({ sessionId, tags });
};

beforeAll(async () => {
  workerApi = await import("../../src/ingest/worker.js");
  workerApi.setExtractor(FakeExtractor);
  workerApi.setLangfuseIngestor(SpyLangfuseIngestor);
});

afterEach(() => {
  // Tests may override, but default back to the deterministic stubs so
  // the suite ordering doesn't matter.
  workerApi.setExtractor(FakeExtractor);
  workerApi.setLangfuseIngestor(SpyLangfuseIngestor);
  langfuseCalls.length = 0;
});

// Distinct bytes per file so sha256 dedup doesn't collapse them.
function uniqueBytes(tag: string): Buffer {
  return Buffer.from(`receipt-${tag}-${Math.random()}-${Date.now()}`, "utf8");
}

async function waitForBatchExtracted(
  batchId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Let the worker drain first; this is deterministic under the stub.
  await workerApi.drain();
  while (Date.now() < deadline) {
    const res = await ctx.db.execute(
      sql`SELECT status FROM batches WHERE id = ${batchId}::uuid`,
    );
    const s = (res.rows[0] as { status: string } | undefined)?.status;
    if (s === "extracted" || s === "failed") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`batch ${batchId} did not reach extracted within ${timeoutMs}ms`);
}

// ──────────────────────────────────────────────────────────────────────

describe("POST /v1/ingest/batch", () => {
  it("returns 202 with batchId + per-file ingestIds; worker drains to extracted", async () => {
    // auto_reconcile=false so the batch stops at `extracted` and the
    // Phase 2a reconcile hook (introduced in #32 Phase 2a) doesn't
    // advance the state machine to `reconciled` before our assertions.
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("a"), { filename: "image-a.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("b"), { filename: "email-b.eml", contentType: "message/rfc822" })
      .attach("files", uniqueBytes("c"), { filename: "pdf-c.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(202);
    expect(res.body.batchId).toMatch(/^[0-9a-f-]{36}$/i);
    // Worker can flip 'pending' → 'processing' between POST commit and
    // response flush (observed on fast CI runners). Both are valid
    // non-terminal states at the moment of POST return.
    expect(["pending", "processing"]).toContain(res.body.status);
    expect(res.body.items).toHaveLength(3);
    for (const it of res.body.items) {
      expect(it.ingestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(typeof it.filename).toBe("string");
    }
    expect(res.body.poll).toBe(`/v1/batches/${res.body.batchId}`);
    expect(res.headers["location"]).toBe(`/v1/batches/${res.body.batchId}`);

    await waitForBatchExtracted(res.body.batchId);

    const view = await request(ctx.app).get(`/v1/batches/${res.body.batchId}`);
    expect(view.status).toBe(200);
    expect(view.body.status).toBe("extracted");
    expect(view.body.counts.total).toBe(3);
    expect(view.body.counts.done).toBe(3);
    expect(view.body.counts.error).toBe(0);
    expect(view.body.counts.unsupported).toBe(0);
    expect(view.body.items).toHaveLength(3);
  });

  it("rejects a batch with zero files (422)", async () => {
    const res = await request(ctx.app).post("/v1/ingest/batch");
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/validation/);
  });

  it("invokes Langfuse ingestor with sessionId + tags after extraction (#43)", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("lf"), {
        filename: "image-lf.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(202);
    const ingestId = res.body.items[0].ingestId;
    await waitForBatchExtracted(res.body.batchId);

    expect(langfuseCalls).toHaveLength(1);
    const call = langfuseCalls[0]!;
    expect(call.sessionId).toBe("stub-session-image");
    expect(call.tags).toContain(res.body.batchId);
    expect(call.tags).toContain(ingestId);
    expect(call.tags).toContain("receipt_image");
  });
});

describe("GET /v1/ingests/:id — produced reverse-lookup", () => {
  it("populates transaction_ids + document_ids for each successful extraction", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("d"), { filename: "image-d.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("e"), { filename: "email-e.eml", contentType: "message/rfc822" });
    expect(res.status).toBe(202);
    await waitForBatchExtracted(res.body.batchId);

    for (const item of res.body.items as Array<{ ingestId: string }>) {
      const ing = await request(ctx.app).get(`/v1/ingests/${item.ingestId}`);
      expect(ing.status).toBe(200);
      expect(ing.body.status).toBe("done");
      expect(ing.body.produced.transaction_ids).toHaveLength(1);
      expect(ing.body.produced.document_ids).toHaveLength(1);
      // classification echoes what the extractor reported
      expect(["receipt_image", "receipt_email"]).toContain(
        ing.body.classification,
      );
    }
  });

  it("GET /v1/transactions?source_ingest_id=<x> returns the produced txn", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("src-ingest"), {
        filename: "image-source-link.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(202);
    await waitForBatchExtracted(res.body.batchId);

    const ingestId = (res.body.items as Array<{ ingestId: string }>)[0]!
      .ingestId;
    const ing = await request(ctx.app).get(`/v1/ingests/${ingestId}`);
    const [txId] = ing.body.produced.transaction_ids as string[];
    expect(txId).toBeDefined();

    const lookup = await request(ctx.app).get(
      `/v1/transactions?source_ingest_id=${ingestId}`,
    );
    expect(lookup.status).toBe(200);
    const items = lookup.body.items as Array<{ id: string; source_ingest_id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(txId);
    expect(items[0]!.source_ingest_id).toBe(ingestId);
  });
});

describe("failure isolation", () => {
  it("one file failing does not fail the batch (ingest=error, others done, batch=extracted)", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("ok1"), { filename: "image-ok1.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("bad"), { filename: "throw-me.jpg", contentType: "image/jpeg" })
      .attach("files", uniqueBytes("ok2"), { filename: "image-ok2.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(202);
    await waitForBatchExtracted(res.body.batchId);

    const view = await request(ctx.app).get(`/v1/batches/${res.body.batchId}`);
    expect(view.status).toBe(200);
    expect(view.body.status).toBe("extracted");
    expect(view.body.counts.done).toBe(2);
    expect(view.body.counts.error).toBe(1);
    expect(view.body.counts.unsupported).toBe(0);

    const errored = (view.body.items as Array<{ status: string; error: string | null }>).find(
      (i) => i.status === "error",
    )!;
    expect(errored).toBeDefined();
    expect(errored.error).toMatch(/blew up on purpose/);
  });

  it("unsupported classification produces no transaction/document and ingest.status='unsupported'", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("unsup"), {
        filename: "unsupported-W2.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(202);
    await waitForBatchExtracted(res.body.batchId);

    const ingestId = (res.body.items as Array<{ ingestId: string }>)[0]!
      .ingestId;
    const ing = await request(ctx.app).get(`/v1/ingests/${ingestId}`);
    expect(ing.status).toBe(200);
    expect(ing.body.status).toBe("unsupported");
    expect(ing.body.classification).toBe("unsupported");
    expect(ing.body.produced.transaction_ids).toHaveLength(0);
    expect(ing.body.produced.document_ids).toHaveLength(0);

    const view = await request(ctx.app).get(`/v1/batches/${res.body.batchId}`);
    expect(view.body.counts.unsupported).toBe(1);
    expect(view.body.counts.done).toBe(0);
    expect(view.body.status).toBe("extracted");
  });

  it("statement_pdf is deferred → marked unsupported with a clear note", async () => {
    const res = await request(ctx.app)
      .post("/v1/ingest/batch")
      .field("auto_reconcile", "false")
      .attach("files", uniqueBytes("stmt"), {
        filename: "statement-april.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(202);
    await waitForBatchExtracted(res.body.batchId);

    const ingestId = (res.body.items as Array<{ ingestId: string }>)[0]!
      .ingestId;
    const ing = await request(ctx.app).get(`/v1/ingests/${ingestId}`);
    expect(ing.body.status).toBe("unsupported");
    expect(ing.body.error).toMatch(/statement pipeline not yet implemented/);
  });
});

describe("GET /v1/batches (list)", () => {
  it("returns previously-created batches", async () => {
    const res = await request(ctx.app).get("/v1/batches?limit=50");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // At least one batch exists from prior test cases.
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const b of res.body.items) {
      expect(b.counts).toBeDefined();
      expect(typeof b.counts.total).toBe("number");
    }
  });
});
