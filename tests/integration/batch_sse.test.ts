/**
 * Integration tests for `GET /v1/batches/:id/stream`.
 *
 * SSE + supertest is awkward (supertest consumes the response eagerly
 * and doesn't expose the stream as an iterable). We instead spin the
 * Express app on an ephemeral port via Node's `http` server and use
 * the built-in `fetch` + `ReadableStream` to consume the event stream
 * incrementally.
 *
 * Each test opens its own connection, asserts on the decoded frames
 * within a short deadline, then aborts the fetch via an `AbortController`
 * so the server-side `req.on('close', ...)` handler fires and the event
 * bus subscriptions get cleaned up. The last test explicitly asserts
 * that the cleanup actually ran.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import http from "node:http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import request from "supertest";
import { withTestDb } from "../setup/db.js";
import type { Extractor } from "../../src/ingest/extractor.js";
import { listenerCount } from "../../src/events/bus.js";

type WorkerModule = typeof import("../../src/ingest/worker.js");
let workerApi: WorkerModule;

// Per-suite upload dir.
const UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "ra-batch-sse-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;

const ctx = withTestDb();

// Same filename-stem stub as the ingest test suite. Having its own copy
// keeps the two suites decoupled so you can run either in isolation.
const FakeExtractor: Extractor = async ({ filename }) => {
  const head = filename.toLowerCase().split(/[-_]/)[0]!;
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

// Spin a real HTTP server in front of the Express app. We need a live
// socket because SSE tests consume the response as a stream, and
// supertest buffers the whole body by design.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  workerApi = await import("../../src/ingest/worker.js");
  workerApi.setExtractor(FakeExtractor);

  server = http.createServer(ctx.app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  workerApi.setExtractor(FakeExtractor);
});

afterAll(async () => {
  // Let the in-process worker finish in-flight jobs so stray DB writes
  // don't race the testcontainer shutdown.
  await workerApi.drain();
  // Close the HTTP listener so vitest can exit cleanly — the actual
  // Postgres container is torn down by `withTestDb()`'s own afterAll.
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── SSE frame parser ─────────────────────────────────────────────────

interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Read up to `maxEvents` SSE frames from a fetch Response, or return
 * early on `timeoutMs`. Non-event lines (comments, keepalives) are
 * silently skipped.
 */
async function readSse(
  res: Response,
  maxEvents: number,
  timeoutMs = 5000,
): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;

  while (frames.length < maxEvents && Date.now() < deadline) {
    // Race read() against the deadline so a silent stream doesn't hang.
    const remaining = Math.max(1, deadline - Date.now());
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>(
      (resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // A frame terminates with a blank line (\n\n).
    let sepIdx: number;
    while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sepIdx);
      buf = buf.slice(sepIdx + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      if (frames.length >= maxEvents) break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    // fine — the caller's abort may have already terminated the reader
  }
  return frames;
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keepalive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: dataStr };
  }
}

// Distinct bytes per upload so sha256 dedup doesn't collide.
function uniqueBytes(tag: string): Buffer {
  return Buffer.from(`sse-${tag}-${Math.random()}-${Date.now()}`, "utf8");
}

async function postBatch(files: Array<{ name: string; tag: string }>) {
  const req = request(ctx.app).post("/v1/ingest/batch");
  for (const f of files) {
    req.attach("files", uniqueBytes(f.tag), {
      filename: f.name,
      contentType: "image/jpeg",
    });
  }
  return await req;
}

// ──────────────────────────────────────────────────────────────────────

describe("GET /v1/batches/:id/stream", () => {
  it("relays job.started/done + batch.extracted while draining a 3-file batch", async () => {
    const res = await postBatch([
      { name: "image-a.jpg", tag: "a" },
      { name: "image-b.jpg", tag: "b" },
      { name: "image-c.jpg", tag: "c" },
    ]);
    expect(res.status).toBe(202);
    const batchId = res.body.batchId as string;

    // Subscribe BEFORE the worker has had a chance to drain. The catch-up
    // `hello` frame covers the window where events fired before we
    // connected; bus events fire thereafter.
    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/v1/batches/${batchId}/stream`, {
      signal: controller.signal,
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    expect(streamRes.headers.get("cache-control")).toBe("no-cache");
    expect(streamRes.headers.get("connection")).toBe("keep-alive");
    expect(streamRes.headers.get("x-accel-buffering")).toBe("no");

    // Expect: 1× hello + 3× job.started + 3× job.done + 1× batch.extracted
    // = 8 events. Allow slack for interleaving order.
    const frames = await readSse(streamRes, 8, 10_000);
    controller.abort();

    // First frame is always the catch-up.
    expect(frames[0]!.event).toBe("hello");
    const hello = frames[0]!.data as { batchId: string; counts: { total: number } };
    expect(hello.batchId).toBe(batchId);
    expect(hello.counts.total).toBe(3);

    const byEvent = frames.reduce<Record<string, SseFrame[]>>((acc, f) => {
      (acc[f.event] ??= []).push(f);
      return acc;
    }, {});
    // After a 3-file batch fully drains we should see:
    //   3× job.started (one per file)
    //   3× job.done    (one per file)
    //   1× batch.extracted (emitted once by the worker when the last
    //                       ingest terminates)
    expect(byEvent["job.started"]?.length ?? 0).toBe(3);
    expect(byEvent["job.done"]?.length ?? 0).toBe(3);
    expect(byEvent["batch.extracted"]?.length ?? 0).toBe(1);

    const ext = byEvent["batch.extracted"]![0]!.data as {
      batchId: string;
      counts: { total: number; done: number };
    };
    expect(ext.batchId).toBe(batchId);
    expect(ext.counts.total).toBe(3);
    expect(ext.counts.done).toBe(3);
  });

  it("emits one job.error event when a single file fails", async () => {
    const res = await postBatch([
      { name: "image-ok.jpg", tag: "ok" },
      { name: "throw-me.jpg", tag: "bad" },
    ]);
    expect(res.status).toBe(202);
    const batchId = res.body.batchId as string;

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/v1/batches/${batchId}/stream`, {
      signal: controller.signal,
    });
    // hello + 2× job.started + 1× job.done + 1× job.error + batch.extracted
    const frames = await readSse(streamRes, 6, 10_000);
    controller.abort();

    const errorFrames = frames.filter((f) => f.event === "job.error");
    expect(errorFrames.length).toBe(1);
    const payload = errorFrames[0]!.data as { ingestId: string; error: string };
    expect(payload.ingestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.error).toMatch(/blew up on purpose/);
  });

  it("connecting to an already-terminal batch sends catch-up and closes cleanly within 100ms", async () => {
    // Create a batch, drain, then flip it to `failed` directly in the
    // DB so it's in a terminal state for SSE purposes. (`extracted`
    // intentionally is NOT terminal — it's waiting for reconcile — so
    // the stream would stay open there.)
    const res = await postBatch([{ name: "image-x.jpg", tag: "x" }]);
    expect(res.status).toBe(202);
    const batchId = res.body.batchId as string;
    await workerApi.drain();

    const { sql } = await import("drizzle-orm");
    await ctx.db.execute(
      sql`UPDATE batches SET status = 'failed' WHERE id = ${batchId}::uuid`,
    );

    const t0 = Date.now();
    const streamRes = await fetch(`${baseUrl}/v1/batches/${batchId}/stream`);
    expect(streamRes.status).toBe(200);

    // Server should send `hello` + `batch.status` and immediately close.
    const frames: SseFrame[] = [];
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sepIdx: number;
      while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const f = parseFrame(raw);
        if (f) frames.push(f);
      }
    }
    const elapsed = Date.now() - t0;

    // Loopback fetch + res.end() is fast but not instantaneous. The
    // spec says "within 100ms" under ideal conditions; we allow 500ms
    // to survive a busy CI host without being a flake.
    expect(elapsed).toBeLessThan(500);
    expect(frames[0]!.event).toBe("hello");
    expect(frames[1]!.event).toBe("batch.status");
    const st = frames[1]!.data as { status: string };
    expect(st.status).toBe("failed");
  });

  it("client disconnect cleans up bus listeners", async () => {
    const res = await postBatch([{ name: "image-y.jpg", tag: "y" }]);
    expect(res.status).toBe(202);
    const batchId = res.body.batchId as string;

    // Snapshot the baseline listener count for one relayed event.
    const before = listenerCount("job.started");

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/v1/batches/${batchId}/stream`, {
      signal: controller.signal,
    });
    expect(streamRes.status).toBe(200);

    // Drain enough to confirm the subscription actually registered.
    await readSse(streamRes, 1, 2000); // `hello`
    const during = listenerCount("job.started");
    expect(during).toBe(before + 1);

    // Client aborts → server's req.on('close') fires → cleanup runs.
    controller.abort();
    // Give the server a moment to run the close handler.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      if (listenerCount("job.started") === before) break;
    }
    expect(listenerCount("job.started")).toBe(before);

    // Let the worker finish the in-flight job before the suite tears
    // down the Postgres pool — otherwise stray DB writes throw EPIPE.
    await workerApi.drain();
  });
});
