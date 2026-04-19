/**
 * Integration tests for `/v1/documents` and its links sub-resource.
 *
 * Covers:
 *   1. Upload + sha256 content-dedup + mutation produces new doc
 *   2. GET metadata + ETag / If-None-Match
 *   3. GET /content streams the bytes with Content-Type
 *   4. POST /links + idempotent replay
 *   5. DELETE /links + 404 on re-delete
 *   6. DELETE /documents with no links
 *   7. DELETE /documents with a link → 409 document-has-links
 *
 * Note on test isolation: this suite builds its own minimal Express app
 * with only the documents router mounted, rather than calling the
 * project-wide `buildApp()`. That keeps the suite green even while
 * sibling agents (transactions / accounts) are mid-implementation.
 */
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import type { Express } from "express";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import * as schema from "../../src/schema/index.js";
import { transactions, postings, accounts } from "../../src/schema/index.js";

interface Ctx {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  app: Express;
  workspaceId: string;
}

const ctx = {} as Ctx;
let UPLOAD_DIR: string;

beforeAll(async () => {
  UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "ra-uploads-"));
  process.env.UPLOAD_DIR = UPLOAD_DIR;

  ctx.container = await new PostgreSqlContainer("postgres:17").start();
  process.env.DATABASE_URL = ctx.container.getConnectionUri();

  // Dynamic imports AFTER DATABASE_URL is set — otherwise the default
  // `db/client.ts` pool binds to localhost:5432 at module-load time and
  // the whole suite races Postgres.
  const { runMigrations } = await import("../../src/db/migrate.js");
  await runMigrations();

  const { seed, SEED_WORKSPACE_ID } = await import("../../src/db/seed.js");
  const r = await seed();
  if (!r.created) throw new Error("Seed must run clean on empty container");

  ctx.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  ctx.db = drizzle(ctx.pool, { schema });
  ctx.workspaceId = SEED_WORKSPACE_ID;

  const { default: express } = await import("express");
  const { contextMiddleware } = await import("../../src/http/context.js");
  const { problemHandler } = await import("../../src/http/problem.js");
  const { documentsRouter } = await import("../../src/routes/documents.js");

  // Minimal app — only `/v1/documents` is mounted, so sibling agents
  // working on `/v1/transactions` can't break this suite.
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "25mb" }));
  app.use(contextMiddleware);
  app.use("/v1/documents", documentsRouter);
  app.use(problemHandler);
  ctx.app = app;
}, 120_000);

afterAll(async () => {
  if (ctx.pool) await ctx.pool.end();
  const { pool: seedPool } = await import("../../src/db/client.js");
  await seedPool.end().catch(() => {});
  if (ctx.container) await ctx.container.stop();
  try {
    rmSync(UPLOAD_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}, 120_000);

let payloadCounter = 0;
function makeBytes(tag: string): Buffer {
  payloadCounter += 1;
  return Buffer.from(
    `fake-jpeg-${tag}-${payloadCounter}-${Date.now()}-${Math.random()}`,
  );
}

async function accountIdByName(name: string): Promise<string> {
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
 * Seed a balanced, posted transaction so tests have a real target for
 * document_links. Uses the DB layer directly — the Transactions API is
 * being built in a sibling agent and is not a dependency.
 */
async function seedTransaction(): Promise<string> {
  const groceries = await accountIdByName("Groceries");
  const visa = await accountIdByName("Credit Card");
  const txId = uuidv7();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(transactions).values({
      id: txId,
      workspaceId: ctx.workspaceId,
      occurredOn: "2026-04-19",
      payee: "Test Vendor",
    });
    await tx.insert(postings).values([
      {
        id: uuidv7(),
        workspaceId: ctx.workspaceId,
        transactionId: txId,
        accountId: groceries,
        amountMinor: 1000n,
        currency: "USD",
        amountBaseMinor: 1000n,
      },
      {
        id: uuidv7(),
        workspaceId: ctx.workspaceId,
        transactionId: txId,
        accountId: visa,
        amountMinor: -1000n,
        currency: "USD",
        amountBaseMinor: -1000n,
      },
    ]);
  });
  return txId;
}

describe("POST /v1/documents — upload + content-dedup", () => {
  it("creates a new document on first upload, returns 201 + Location + ETag", async () => {
    const bytes = makeBytes("upload-create");
    const res = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "r1.jpg", contentType: "image/jpeg" })
      .field("kind", "receipt_image");

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/documents/${res.body.id}`);
    expect(res.headers.etag).toBe('W/"1"');
    expect(res.body).toMatchObject({
      kind: "receipt_image",
      mime_type: "image/jpeg",
      workspace_id: ctx.workspaceId,
    });
    expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.file_path).toContain(UPLOAD_DIR);
  });

  it("returns the existing row with 200 when the same bytes are re-uploaded", async () => {
    const bytes = makeBytes("upload-dedup");

    const first = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "r2.jpg", contentType: "image/jpeg" })
      .field("kind", "receipt_image");
    expect(first.status).toBe(201);
    const originalId = first.body.id;

    const second = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, {
        filename: "r2-again.jpg",
        contentType: "image/jpeg",
      });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(originalId);
    expect(second.body.sha256).toBe(first.body.sha256);
  });

  it("creates a distinct document when a single byte changes", async () => {
    const bytesA = makeBytes("upload-mutate-A");
    const bytesB = Buffer.concat([bytesA, Buffer.from("X")]);

    const a = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytesA, { filename: "a.jpg", contentType: "image/jpeg" });
    const b = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytesB, { filename: "b.jpg", contentType: "image/jpeg" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.sha256).not.toBe(b.body.sha256);
  });

  it("defaults kind to `other` when the form field is omitted", async () => {
    const bytes = makeBytes("default-kind");
    const res = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, {
        filename: "x.bin",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("other");
  });

  it("rejects a request with no `file` field", async () => {
    const res = await request(ctx.app)
      .post("/v1/documents")
      .field("kind", "other");
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });
});

describe("GET /v1/documents/:id", () => {
  it("returns 200 + ETag on hit, and 304 when If-None-Match matches", async () => {
    const bytes = makeBytes("get-meta");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "g.jpg", contentType: "image/jpeg" });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const hit = await request(ctx.app).get(`/v1/documents/${id}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.etag).toBe('W/"1"');
    expect(hit.body.id).toBe(id);

    const notModified = await request(ctx.app)
      .get(`/v1/documents/${id}`)
      .set("If-None-Match", 'W/"1"');
    expect(notModified.status).toBe(304);
  });

  it("404s for an unknown id", async () => {
    const res = await request(ctx.app).get(`/v1/documents/${uuidv7()}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });
});

describe("GET /v1/documents/:id/content", () => {
  it("streams the bytes with the right Content-Type", async () => {
    const bytes = makeBytes("content-stream");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "c.jpg", contentType: "image/jpeg" });
    const id = created.body.id;

    const res = await request(ctx.app)
      .get(`/v1/documents/${id}/content`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["content-disposition"]).toContain(
      `inline; filename="${id}.jpg"`,
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(bytes)).toBe(true);
  });

  it("404s for unknown id", async () => {
    const res = await request(ctx.app).get(
      `/v1/documents/${uuidv7()}/content`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/documents/:id/links — link + idempotent replay", () => {
  let txId: string;
  let docId: string;

  beforeEach(async () => {
    txId = await seedTransaction();
    const bytes = makeBytes("link");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "l.jpg", contentType: "image/jpeg" });
    docId = created.body.id;
  });

  it("returns 204 on first link and on idempotent replay", async () => {
    const first = await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({ transaction_id: txId });
    expect(first.status).toBe(204);

    const replay = await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({ transaction_id: txId });
    expect(replay.status).toBe(204);
  });

  it("404s when the transaction does not exist in this workspace", async () => {
    const res = await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({ transaction_id: uuidv7() });
    expect(res.status).toBe(404);
  });

  it("404s when the document does not exist", async () => {
    const res = await request(ctx.app)
      .post(`/v1/documents/${uuidv7()}/links`)
      .send({ transaction_id: txId });
    expect(res.status).toBe(404);
  });

  it("422s when body is missing transaction_id", async () => {
    const res = await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({});
    expect(res.status).toBe(422);
  });
});

describe("DELETE /v1/documents/:id/links/:txn_id", () => {
  it("returns 204 when removing an existing link; 404 on second attempt", async () => {
    const txId = await seedTransaction();
    const bytes = makeBytes("unlink");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "u.jpg", contentType: "image/jpeg" });
    const docId = created.body.id;

    const link = await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({ transaction_id: txId });
    expect(link.status).toBe(204);

    const unlink = await request(ctx.app).delete(
      `/v1/documents/${docId}/links/${txId}`,
    );
    expect(unlink.status).toBe(204);

    const again = await request(ctx.app).delete(
      `/v1/documents/${docId}/links/${txId}`,
    );
    expect(again.status).toBe(404);
  });
});

describe("DELETE /v1/documents/:id", () => {
  it("204s when the doc has no links; 404 on re-delete", async () => {
    const bytes = makeBytes("delete-clean");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "d.jpg", contentType: "image/jpeg" });
    const docId = created.body.id;

    const first = await request(ctx.app).delete(`/v1/documents/${docId}`);
    expect(first.status).toBe(204);

    const second = await request(ctx.app).delete(`/v1/documents/${docId}`);
    expect(second.status).toBe(404);
  });

  it("409s with errors/document-has-links when a link exists", async () => {
    const txId = await seedTransaction();
    const bytes = makeBytes("delete-linked");
    const created = await request(ctx.app)
      .post("/v1/documents")
      .attach("file", bytes, { filename: "dl.jpg", contentType: "image/jpeg" });
    const docId = created.body.id;

    await request(ctx.app)
      .post(`/v1/documents/${docId}/links`)
      .send({ transaction_id: txId })
      .expect(204);

    const res = await request(ctx.app).delete(`/v1/documents/${docId}`);
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(res.body.type).toContain("errors/document-has-links");
    expect(res.body.document_id).toBe(docId);
    expect(res.body.link_count).toBe(1);
  });
});
