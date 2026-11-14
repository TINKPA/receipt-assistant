/**
 * check-http-errors.ts — the HTTP error contract, asserted over real HTTP.
 *
 * Boots the Express app in-process against a DISPOSABLE database, sends
 * the requests a confused or hostile client would, and checks what comes
 * back: status, content type, problem `type`, and that no error body
 * carries SQL, bound parameters or a stack trace.
 *
 * What it covers (the shared layer in `src/http/` plus `src/app.ts`):
 *   id    malformed UUIDs in the path and query string → 400, everywhere
 *         — and ids that are not UUIDs by design (a Google place id, a
 *         brand slug) still reach their handler
 *   route unknown URLs and methods → problem+json 404, not Express HTML
 *   body  malformed JSON, oversized bodies, broken multipart → 400 / 413
 *   bool  `?flag=false` means false
 *   cur   pagination cursors that this API did not issue → 400
 *   pg    Postgres constraint and data errors → 400 / 409 / 422; a
 *         deadlock or serialization failure → 409 `concurrent-update`
 *         with Retry-After, also when a real route hits one
 *   500   an unexpected error → fixed sentence + trace id; the detail
 *         goes to the server log under that id, never to the client —
 *         including per-item errors reported inside a 200
 *   idem  Idempotency-Key: replay, conflict, concurrent duplicates,
 *         a key reused after its row expired, a key too long to store
 *   etag  document metadata ETag moves when the document does, and a
 *         transaction's ETag moves when its documents do (soft delete,
 *         restore, unlink, link, a cascade that keeps the transaction)
 *         while If-Match still lets an edit through
 *   state a request the resource is in the wrong state for, where
 *         cascade delete and dedup apply / undo meet: undo of a proposal
 *         that was never applied, already reverted, or whose documents
 *         were deleted since; what the cascade report says for a kept,
 *         a deleted and an already-deleted transaction; the 409s and the
 *         422 the delete route can answer
 *   file  asset and document endpoints refuse a stored path outside
 *         their directory, never serve SVG / HTML able to run script on
 *         our origin (a 304 included), and survive a file that cannot
 *         be opened
 *
 * It WRITES to the database it is given — products, transactions,
 * documents, a batch with dedup proposals, brand / asset / place rows —
 * and never cleans them up. Two cases add a trigger for a moment and
 * drop it (on `derivation_events`, and on `documents`).
 * Point it only at a throwaway Postgres (or the sandbox), never at the
 * ledger:
 *
 *   docker run -d --name ra-check -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=receipts -p 127.0.0.1::5432 postgres:17
 *   npx tsx scripts/check-http-errors.ts --disposable \
 *     --db=postgresql://postgres:postgres@127.0.0.1:<port>/receipts
 *
 * It applies pending migrations and the idempotent seed first, exactly
 * as server boot does, so an empty database works. It starts no ingest
 * worker and calls no endpoint that could spawn `claude`.
 *
 * Flags:
 *   --db=<url>        required. Deliberately not read from DATABASE_URL
 *                     or .env, so a stray production URL cannot be used.
 *   --disposable      required. You are confirming the database is one.
 *   --only=a,b        run only the groups named (id,route,body,…).
 *   --report=<file>   also write the observations as JSON.
 *   --verbose         let the server's own error/warn log lines through
 *                     (they are captured and hidden by default).
 *
 * Exit status is 0 when every expectation holds, 1 otherwise.
 */
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import pg from "pg";

// ── CLI ────────────────────────────────────────────────────────────────
function argOf(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const DB_URL = argOf("db");
const ONLY = argOf("only")?.split(",") ?? null;
const REPORT = argOf("report");
if (!DB_URL || !process.argv.includes("--disposable")) {
  console.error(
    "Refusing to run. This script writes test rows and never removes them.\n" +
      "Pass --db=<postgres url of a throwaway database> and --disposable.",
  );
  process.exit(2);
}

// ── Observations ───────────────────────────────────────────────────────
interface Obs {
  status: number;
  contentType: string;
  headers: Headers;
  text: string;
  json: any;
}
interface Row {
  group: string;
  request: string;
  status: number;
  shape: string;
  expect: string;
  ok: boolean;
  why?: string;
}
const rows: Row[] = [];

/** Things no error body may contain. */
const LEAK_RE =
  /Failed query|params:|\bselect\b[\s\S]*\bfrom\b|insert into|\$1\b|node_modules|\n\s+at \S+ \(|\.ts:\d+/i;

function leak(o: Obs): boolean {
  return o.status >= 400 && LEAK_RE.test(o.text);
}

/** One-phrase description of a response body, for the table. */
function shape(o: Obs): string {
  const ct = o.contentType.split(";")[0]!.trim();
  if (o.status === 304) return "(no body)";
  if (ct === "application/problem+json" && o.json) {
    const type = String(o.json.type ?? "").split("/").pop();
    return (
      `problem:${type}` +
      (o.json.trace_id ? " +trace_id" : " NO-trace_id") +
      (Array.isArray(o.json.violations) ? " +violations" : "") +
      (leak(o) ? " LEAKS-SQL" : "")
    );
  }
  if (ct === "application/json" && o.json && typeof o.json === "object") {
    return `json{${Object.keys(o.json).slice(0, 4).join(",")}}`;
  }
  if (ct === "text/html") return "html page";
  const flags = [
    o.headers.get("x-content-type-options") === "nosniff" ? "nosniff" : null,
    /sandbox/.test(o.headers.get("content-security-policy") ?? "") ? "csp-sandbox" : null,
    /attachment/.test(o.headers.get("content-disposition") ?? "") ? "attachment" : null,
  ].filter(Boolean);
  return `${ct || "(none)"}${flags.length ? " [" + flags.join(",") + "]" : ""}`;
}

interface Expect {
  status: number | number[];
  /** Problem `type` suffix. */
  type?: string;
  /** Extra check; return a reason string on failure. */
  also?: (o: Obs) => string | null | undefined;
}

function record(group: string, request: string, o: Obs, e: Expect): Obs {
  const wantStatus = Array.isArray(e.status) ? e.status : [e.status];
  const reasons: string[] = [];
  if (!wantStatus.includes(o.status)) reasons.push(`status ${o.status}`);
  if (o.status >= 400) {
    if (!o.contentType.startsWith("application/problem+json")) {
      reasons.push(`content-type ${o.contentType || "(none)"}`);
    } else if (!o.json?.trace_id) {
      reasons.push("no trace_id");
    }
    if (leak(o)) reasons.push("body leaks SQL / stack");
  }
  if (e.type) {
    const got = String(o.json?.type ?? "").split("/").pop();
    if (got !== e.type) reasons.push(`type ${got || "(none)"}`);
  }
  const extra = e.also?.(o);
  if (extra) reasons.push(extra);
  rows.push({
    group,
    request,
    status: o.status,
    shape: shape(o),
    expect: `${wantStatus.join("|")}${e.type ? " " + e.type : ""}`,
    ok: reasons.length === 0,
    why: reasons.join("; ") || undefined,
  });
  return o;
}

// ── Boot ───────────────────────────────────────────────────────────────
const tmp = await mkdtemp(path.join(tmpdir(), "check-http-errors-"));
const UPLOADS = path.join(tmp, "uploads");
const BRAND_ROOT = path.join(tmp, "brand-assets");
const PRODUCT_ROOT = path.join(tmp, "product-assets");
const OUTSIDE = path.join(tmp, "outside");
for (const d of [UPLOADS, BRAND_ROOT, PRODUCT_ROOT, OUTSIDE]) await mkdir(d, { recursive: true });

// The route modules read these at import time — set them first.
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = UPLOADS;
process.env.BRAND_ASSETS_ROOT = BRAND_ROOT;
process.env.PRODUCT_ASSETS_ROOT = PRODUCT_ROOT;
delete process.env.GOOGLE_MAPS_API_KEY; // nothing here may call out

// Capture what the server logs, so the 500 case can assert the detail
// went to the log (and only there).
const logged: string[] = [];
for (const level of ["error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(
      args
        .map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" "),
    );
    if (process.argv.includes("--verbose")) original(...args);
  };
}

// `src/generated/build-info.ts` is gitignored and written by the build;
// the app imports it, so make sure it exists in a fresh checkout.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate-build-info.mjs")], {
  cwd: repoRoot,
  stdio: "ignore",
});

const { runMigrations } = await import("../src/db/migrate.js");
const { seed, SEED_WORKSPACE_ID } = await import("../src/db/seed.js");
await runMigrations(DB_URL);
await seed();
const { buildApp } = await import("../src/app.js");
const { pool } = await import("../src/db/client.js");
const express = (await import("express")).default;
const problemModule: any = await import("../src/http/problem.js");
const contextModule: any = await import("../src/http/context.js");
const filesModule: any = await import("../src/http/files.js");

const server = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(text, params)).rows as T[];
}

async function call(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; body?: BodyInit; json?: unknown; base?: string } = {},
): Promise<Obs> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${init.base ?? BASE}${url}`, { method, headers, body, redirect: "manual" });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", headers: res.headers, text, json };
}

const NONCE = randomUUID().slice(0, 8);
const BAD = "not-a-uuid";
const NOBODY = "018f0000-0000-7000-8000-00000000dead"; // well-formed, matches nothing
const wants = (g: string): boolean => !ONLY || ONLY.includes(g);

// ── id: malformed UUIDs ────────────────────────────────────────────────
if (wants("id")) {
  const G = "id";
  const U = NOBODY;
  const paths: Array<[string, string]> = [
    ["GET", `/v1/accounts/${BAD}`],
    ["PATCH", `/v1/accounts/${BAD}`],
    ["DELETE", `/v1/accounts/${BAD}`],
    ["GET", `/v1/accounts/${BAD}/balance`],
    ["GET", `/v1/accounts/${BAD}/register`],
    ["GET", `/v1/transactions/${BAD}`],
    ["PATCH", `/v1/transactions/${BAD}`],
    ["DELETE", `/v1/transactions/${BAD}`],
    ["POST", `/v1/transactions/${BAD}/restore`],
    ["POST", `/v1/transactions/${BAD}/reconcile`],
    ["POST", `/v1/transactions/${BAD}/unreconcile`],
    ["POST", `/v1/transactions/${BAD}/postings`],
    ["POST", `/v1/transactions/${BAD}/items`],
    ["POST", `/v1/transactions/${BAD}/near-dup-review`],
    ["PATCH", `/v1/transactions/${U}/postings/${BAD}`],
    ["DELETE", `/v1/transactions/${BAD}/postings/${U}`],
    ["GET", `/v1/transactions/${BAD}/parties`],
    ["GET", `/v1/postings/${BAD}`],
    ["GET", `/v1/products/${BAD}`],
    ["PATCH", `/v1/products/${BAD}`],
    ["GET", `/v1/products/${BAD}/image`],
    ["GET", `/v1/products/${BAD}/assets`],
    ["POST", `/v1/products/${BAD}/assets`],
    ["GET", `/v1/products/${U}/assets/${BAD}/image`],
    ["POST", `/v1/products/${BAD}/merge_into`],
    ["POST", `/v1/products/${BAD}/recompute`],
    ["GET", `/v1/owned-items/${BAD}`],
    ["PATCH", `/v1/owned-items/${BAD}`],
    ["DELETE", `/v1/owned-items/${BAD}`],
    ["GET", `/v1/wish-items/${BAD}`],
    ["PATCH", `/v1/wish-items/${BAD}`],
    ["DELETE", `/v1/wish-items/${BAD}`],
    ["POST", `/v1/insights/${BAD}/dismiss`],
    ["GET", `/v1/brands/some-brand/assets/${BAD}/icon`],
    ["GET", `/v1/documents/${BAD}`],
    ["GET", `/v1/documents/${BAD}/content`],
    ["GET", `/v1/documents/${BAD}/rendered`],
    ["POST", `/v1/documents/${BAD}/links`],
    ["DELETE", `/v1/documents/${U}/links/${BAD}`],
    ["DELETE", `/v1/documents/${BAD}`],
    ["POST", `/v1/documents/${BAD}/restore`],
    ["POST", `/v1/documents/${BAD}/re-extract`],
    ["GET", `/v1/batches/${BAD}`],
    ["GET", `/v1/batches/${BAD}/stream`],
    ["GET", `/v1/batches/${BAD}/reconcile`],
    ["POST", `/v1/batches/${BAD}/reconcile`],
    ["POST", `/v1/batches/${BAD}/reconcile/apply`],
    ["POST", `/v1/batches/${BAD}/reconcile/reject`],
    ["POST", `/v1/batches/${BAD}/reconcile/undo`],
    ["GET", `/v1/ingests/${BAD}`],
    ["POST", `/v1/ingests/${BAD}/retry`],
  ];
  for (const [method, p] of paths) {
    const init = method === "GET" || method === "DELETE" ? {} : { json: {} };
    record(G, `${method} ${p}`, await call(method, p, init), { status: 400, type: "invalid-id" });
  }

  const queries = [
    `/v1/transactions?account_id=${BAD}`,
    `/v1/transactions?trip_id=${BAD}`,
    `/v1/transactions?source_ingest_id=${BAD}`,
    `/v1/postings?account_id=${BAD}`,
    `/v1/postings?transaction_id=${BAD}`,
    `/v1/items?transaction_id=${BAD}`,
    `/v1/ingests?batch_id=${BAD}`,
    `/v1/products?merchant_id=${BAD}`,
    `/v1/owned-items?product_id=${BAD}`,
    `/v1/owned-items?product_id=`,
  ];
  for (const p of queries) {
    record(G, `GET ${p}`, await call("GET", p), { status: 400, type: "invalid-id" });
  }

  // The check must not over-reach: a well-formed id that matches nothing
  // is a 404, and ids that are not UUIDs by design still work.
  for (const p of [`/v1/products/${U}`, `/v1/transactions/${U}`, `/v1/documents/${U}`, `/v1/places/${U}`]) {
    record(G, `GET ${p} (well-formed, unknown)`, await call("GET", p), { status: 404, type: "not-found" });
  }
  record(G, `GET /v1/accounts/${U.toUpperCase()} (upper case)`, await call("GET", `/v1/accounts/${U.toUpperCase()}`), {
    status: 404,
    type: "not-found",
  });
  record(G, "GET /v1/merchants/no-such-slug (slug id)", await call("GET", "/v1/merchants/no-such-slug"), {
    status: 404,
    type: "not-found",
  });
  record(G, "GET /v1/brands/no-such-slug (slug id)", await call("GET", "/v1/brands/no-such-slug"), {
    status: 404,
    type: "not-found",
  });
  record(G, "GET /v1/products?brand_id=some-slug (slug filter)", await call("GET", "/v1/products?brand_id=some-slug&limit=1"), {
    status: 200,
  });
  record(G, "GET /v1/brands/%00 (NUL byte in a text id)", await call("GET", "/v1/brands/%00"), {
    status: 400,
    type: "invalid-parameter",
  });

  // `/v1/places/:id` takes the place's UUID or Google's place id — the
  // value `merchants.place_id` holds and the merchant page looks a place
  // up by. Requiring a UUID there breaks that page.
  const gid = `ChIJcheck${NONCE}`;
  const placeUuid = (
    await q<{ id: string }>(
      `INSERT INTO places (google_place_id, formatted_address, lat, lng, source)
       VALUES ($1, 'nowhere', 1, 1, 'check') RETURNING id`,
      [gid],
    )
  )[0]!.id;
  record(G, "GET /v1/places/<google place id>", await call("GET", `/v1/places/${gid}`), {
    status: 200,
    also: (o) => (o.json?.id === placeUuid ? null : "did not resolve to the place row"),
  });
  record(G, "GET /v1/places/<its uuid>", await call("GET", `/v1/places/${placeUuid}`), {
    status: 200,
    also: (o) => (o.json?.google_place_id === gid ? null : "wrong place"),
  });
  record(G, "GET /v1/places/<google place id>/map (no Google key here)", await call("GET", `/v1/places/${gid}/map`), {
    status: 503,
    type: "google-places-unavailable",
  });
  record(G, "POST /v1/places/<google place id>/re-derive (no raw_response)", await call("POST", `/v1/places/${gid}/re-derive`, { json: {} }), {
    status: 422,
    type: "place-no-raw-response",
  });
  for (const [method, p] of [
    ["GET", `/v1/places/${BAD}`],
    ["GET", `/v1/places/${BAD}/map`],
    ["POST", `/v1/places/${BAD}/re-derive`],
    ["POST", `/v1/places/${BAD}/refresh`],
  ] as const) {
    record(G, `${method} ${p} (an id that matches no place)`, await call(method, p, method === "GET" ? {} : { json: {} }), {
      status: 404,
      type: "not-found",
    });
  }
  // The two place handlers that only take the UUID hand a Google id to a
  // uuid column; Postgres' complaint is the 400.
  record(G, "PATCH /v1/places/<google place id>  (UUID-only handler)", await call("PATCH", `/v1/places/${gid}`, { json: { custom_name: "x" } }), {
    status: 400,
    type: "invalid-parameter",
  });
  record(G, "GET /v1/places/<google place id>/photos/0/content  (UUID-only handler)", await call("GET", `/v1/places/${gid}/photos/0/content`), {
    status: 400,
    type: "invalid-parameter",
  });
}

// ── route: unknown URLs ────────────────────────────────────────────────
if (wants("route")) {
  const G = "route";
  for (const [method, p] of [
    ["GET", "/v1/nope"],
    ["GET", "/nope"],
    ["PUT", "/v1/accounts"],
    ["POST", "/v1/reports/summary"],
    ["GET", "/receipt/123"],
  ] as const) {
    record(G, `${method} ${p}`, await call(method, p), { status: 404, type: "route-not-found" });
  }
  record(G, "GET /health", await call("GET", "/health"), { status: 200 });
}

// ── body: malformed and oversized request bodies ───────────────────────
if (wants("body")) {
  const G = "body";
  const J = { "Content-Type": "application/json" };
  record(G, "POST /v1/transactions  body `{bad`", await call("POST", "/v1/transactions", { headers: J, body: "{bad" }), {
    status: 400,
    type: "malformed-body",
  });
  record(G, "POST /v1/products  body `[1,`", await call("POST", "/v1/products", { headers: J, body: "[1," }), {
    status: 400,
    type: "malformed-body",
  });
  record(
    G,
    "PATCH /v1/brands/x  merge-patch body `{bad`",
    await call("PATCH", "/v1/brands/x", { headers: { "Content-Type": "application/merge-patch+json" }, body: "{bad" }),
    { status: 400, type: "malformed-body" },
  );
  record(
    G,
    "PATCH /v1/brands/x  1.2 MB merge-patch body (limit 1 MB)",
    await call("PATCH", "/v1/brands/x", {
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ name: "x".repeat(1_200_000) }),
    }),
    { status: 413, type: "payload-too-large" },
  );
  record(G, "GET /v1/products/%E0%A4%A (bad percent-encoding)", await call("GET", "/v1/products/%E0%A4%A"), {
    status: 400,
    type: "bad-request",
  });

  // The three reconcile routes that take a list of proposal ids. The
  // body is checked before the batch is looked up, so a well-formed id
  // that matches no batch is enough to reach it.
  for (const verb of ["apply", "reject", "undo"]) {
    const url = `/v1/batches/${NOBODY}/reconcile/${verb}`;
    record(G, `POST /v1/batches/:id/reconcile/${verb}  body \`{bad\``, await call("POST", url, { headers: J, body: "{bad" }), {
      status: 400,
      type: "malformed-body",
    });
    for (const [label, body] of [
      ["no body", undefined],
      ["{}", {}],
      ["proposal_ids: []", { proposal_ids: [] }],
      ["proposal_ids: 'x'", { proposal_ids: "x" }],
      ["proposal_ids: ['not-a-uuid']", { proposal_ids: [BAD] }],
    ] as const) {
      record(G, `POST /v1/batches/:id/reconcile/${verb}  ${label}`, await call("POST", url, body === undefined ? {} : { json: body }), {
        status: 422,
        type: "validation",
      });
    }
  }

  const big = new FormData();
  big.append("file", new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }), "big.png");
  record(G, "POST /v1/brands/x/assets  5 MB+1 file (limit 5 MB)", await call("POST", "/v1/brands/x/assets", { body: big }), {
    status: 413,
    type: "payload-too-large",
  });
  const wrongField = new FormData();
  wrongField.append("photo", new Blob([Buffer.from("x")], { type: "image/png" }), "x.png");
  record(G, "POST /v1/brands/x/assets  file under the wrong field name", await call("POST", "/v1/brands/x/assets", { body: wrongField }), {
    status: 400,
    type: "malformed-upload",
  });
  record(
    G,
    "POST /v1/documents  multipart with no boundary",
    await call("POST", "/v1/documents", { headers: { "Content-Type": "multipart/form-data" }, body: "garbage" }),
    { status: 400, type: "malformed-upload" },
  );

  const mine = `check-${NONCE}`;
  record(G, "GET /v1/nope  with X-Trace-Id: <token>", await call("GET", "/v1/nope", { headers: { "X-Trace-Id": mine } }), {
    status: 404,
    also: (o) => (o.json?.trace_id === mine ? null : `trace_id ${o.json?.trace_id} (caller's id not echoed)`),
  });
  record(
    G,
    "GET /v1/nope  with X-Trace-Id: <400 chars + quotes>",
    await call("GET", "/v1/nope", { headers: { "X-Trace-Id": `"${"x".repeat(400)}"` } }),
    {
      status: 404,
      also: (o) => (/^[0-9a-f-]{36}$/.test(String(o.json?.trace_id)) ? null : "unsafe trace id was echoed back"),
    },
  );
}

// ── bool: boolean query flags ──────────────────────────────────────────
// `z.coerce.boolean()` read "false" as true. `flat` is the flag whose
// effect shows on the seeded chart alone: the default list is the tree's
// roots, `flat=true` is every account.
if (wants("bool")) {
  const G = "bool";
  const count = async (qs: string): Promise<{ o: Obs; n: number }> => {
    const o = await call("GET", `/v1/accounts${qs}`);
    return { o, n: Array.isArray(o.json?.items) ? o.json.items.length : Array.isArray(o.json) ? o.json.length : -1 };
  };
  const dflt = await count("");
  const on = await count("?flat=true");
  record(G, "GET /v1/accounts?flat=true", on.o, {
    status: 200,
    also: () => (on.n > dflt.n ? null : `flat list (${on.n}) is not longer than the tree roots (${dflt.n}); fixture cannot tell the two apart`),
  });
  for (const v of ["false", "0", "FALSE", ""]) {
    const off = await count(`?flat=${v}`);
    record(G, `GET /v1/accounts?flat=${v || "<empty>"}`, off.o, {
      status: 200,
      also: () => (off.n === dflt.n ? null : `returned ${off.n} rows — the flat list (${on.n}), not the default (${dflt.n})`),
    });
  }
  const one = await count("?flat=1");
  record(G, "GET /v1/accounts?flat=1", one.o, {
    status: 200,
    also: () => (one.n === on.n ? null : `returned ${one.n} rows, not the flat list (${on.n})`),
  });
  record(G, "GET /v1/accounts?flat=maybe", await call("GET", "/v1/accounts?flat=maybe"), { status: 422, type: "validation" });
  for (const p of [
    "/v1/owned-items?include_retired=false&limit=1",
    "/v1/products?include_retired=0&limit=1",
    "/v1/transactions?include_deleted=false&has_document=false&limit=1",
  ]) {
    record(G, `GET ${p}`, await call("GET", p), { status: 200 });
  }
  record(G, "GET /v1/owned-items?include_retired=nope", await call("GET", "/v1/owned-items?include_retired=nope"), {
    status: 422,
    type: "validation",
  });
}

// ── cur: pagination cursors ────────────────────────────────────────────
if (wants("cur")) {
  const G = "cur";
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const anAccount = (await q<{ id: string }>(`SELECT id FROM accounts WHERE workspace_id = $1 LIMIT 1`, [SEED_WORKSPACE_ID]))[0]!.id;
  const lists = [
    "/v1/products",
    "/v1/owned-items",
    "/v1/wish-items",
    "/v1/items",
    "/v1/transactions",
    "/v1/postings",
    "/v1/batches",
    "/v1/ingests",
    "/v1/ingests/problems",
    `/v1/accounts/${anAccount}/register`,
  ];
  for (const p of lists) {
    const label = p.replace(anAccount, ":id");
    record(G, `GET ${label}?cursor=<not base64 json>`, await call("GET", `${p}?cursor=%25%25garbage`), {
      status: 400,
      type: "invalid-cursor",
    });
    record(G, `GET ${label}?cursor=<{}>`, await call("GET", `${p}?cursor=${enc({})}`), {
      status: 400,
      type: "invalid-cursor",
    });
    // A cursor from another endpoint: right encoding, wrong fields.
    record(G, `GET ${label}?cursor=<another endpoint's fields>`, await call("GET", `${p}?cursor=${enc({ zzz: "1" })}`), {
      status: 400,
      type: "invalid-cursor",
    });
  }
  // Right fields, values Postgres cannot read.
  record(
    G,
    "GET /v1/products?cursor=<updated_at:'x', id:'x'>",
    await call("GET", `/v1/products?cursor=${enc({ updated_at: "x", id: "x" })}`),
    { status: 400, type: "invalid-parameter" },
  );
  record(
    G,
    "GET /v1/transactions?cursor=<sort:created_at, value:'x', id:'x'>",
    await call("GET", `/v1/transactions?cursor=${enc({ sort: "created_at", value: "x", id: "x" })}`),
    { status: 400, type: "invalid-parameter" },
  );
  // /v1/merchants/:id/transactions has its own "<date>|<id>" cursor.
  const curBrand = `check-cur-${NONCE}`;
  await q(`INSERT INTO brands (brand_id, name) VALUES ($1, $1)`, [curBrand]);
  const curMerchant = (
    await q<{ id: string }>(
      `INSERT INTO merchants (workspace_id, brand_id, canonical_name) VALUES ($1, $2, $2) RETURNING id`,
      [SEED_WORKSPACE_ID, curBrand],
    )
  )[0]!.id;
  const mt = `/v1/merchants/${curMerchant}/transactions`;
  for (const [label, cursor] of [
    ["<no separator>", "garbage"],
    ["<date only>", "2026-01-01|"],
    ["<three parts>", `2026-01-01|${NOBODY}|x`],
  ] as const) {
    record(G, `GET /v1/merchants/:id/transactions?cursor=${label}`, await call("GET", `${mt}?cursor=${encodeURIComponent(cursor)}`), {
      status: 400,
      type: "invalid-cursor",
    });
  }
  record(G, "GET /v1/merchants/:id/transactions?cursor=<x|y>", await call("GET", `${mt}?cursor=${encodeURIComponent("x|y")}`), {
    status: 400,
    type: "invalid-parameter",
  });
  record(G, "GET /v1/merchants/:id/transactions?cursor=<date|uuid>", await call("GET", `${mt}?cursor=${encodeURIComponent(`2026-01-01|${NOBODY}`)}`), {
    status: 200,
    also: (o) => (Array.isArray(o.json?.items) ? null : "no items array"),
  });

  // And a real cursor still pages.
  const first = await call("GET", "/v1/transactions?limit=1");
  if (first.json?.next_cursor) {
    record(G, "GET /v1/transactions?limit=1&cursor=<issued by the API>", await call("GET", `/v1/transactions?limit=1&cursor=${first.json.next_cursor}`), {
      status: 200,
      also: (o) => (Array.isArray(o.json?.items) ? null : "no items array"),
    });
  }
}

// ── 500 + pg mapping, driven by synthetic errors ───────────────────────
// A tiny app around the real `contextMiddleware` + `problemHandler`:
// each route throws what a failing query would, so every SQLSTATE branch
// is exercised without having to corrupt a database to reach it.
if (wants("500") || wants("pg")) {
  const drizzle = (cause: unknown): Error =>
    Object.assign(new Error('Failed query: select "secret_col" from "secret_table" where "id" = $1\nparams: hunter2'), {
      query: 'select "secret_col" from "secret_table" where "id" = $1',
      params: ["hunter2"],
      cause,
    });
  const pgErr = (code: string, message: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error(message), { name: "error", severity: "ERROR", code, ...extra });

  const mini = express();
  mini.use(contextModule.contextMiddleware);
  const thrown: Record<string, () => unknown> = {
    syntax: () => drizzle(pgErr("42601", 'syntax error at or near ","')),
    undefined_table: () => drizzle(pgErr("42P01", 'relation "nope" does not exist')),
    plain: () => new Error("ENOENT: no such file or directory, open '/home/node/.claude/.credentials.json'"),
    epipe: () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    upstream403: () => Object.assign(new Error("Google said no"), { status: 403 }),
    string: () => "a thrown string with select x from y",
    uuid: () => drizzle(pgErr("22P02", 'invalid input syntax for type uuid: "hunter2"', { routine: "string_to_uuid" })),
    date: () => drizzle(pgErr("22008", 'date/time field value out of range: "2026-13-45"')),
    nul_escape: () =>
      drizzle(pgErr("22P05", "unsupported Unicode escape sequence", { detail: "\\u0000 cannot be converted to text. hunter2" })),
    unique: () =>
      drizzle(pgErr("23505", 'duplicate key value violates unique constraint "owned_items_tx_item_instance_uq"', {
        constraint: "owned_items_tx_item_instance_uq",
        table: "owned_items",
        detail: "Key (transaction_item_id, instance_index)=(hunter2, 1) already exists.",
      })),
    fk_insert: () =>
      drizzle(pgErr("23503", 'insert or update on table "products" violates foreign key constraint "products_brand_id_fk"', {
        constraint: "products_brand_id_fk",
        detail: 'Key (brand_id)=(hunter2) is not present in table "brands".',
      })),
    fk_delete: () =>
      drizzle(pgErr("23503", 'update or delete on table "accounts" violates foreign key constraint "postings_account_fk" on table "postings"', {
        constraint: "postings_account_fk",
        detail: 'Key (id)=(hunter2) is still referenced from table "postings".',
      })),
    check: () =>
      drizzle(pgErr("23514", 'new row for relation "postings" violates check constraint "postings_currency_ck"', {
        constraint: "postings_currency_ck",
        detail: "Failing row contains (hunter2).",
      })),
    trigger: () => pgErr("23514", "Postings for transaction 0190 do not balance: sum=5 (must be 0)", { routine: "exec_stmt_raise" }),
    not_null: () => drizzle(pgErr("23502", 'null value in column "name" of relation "brands" violates not-null constraint', { column: "name" })),
    deadlock: () =>
      drizzle(pgErr("40P01", "deadlock detected", {
        detail: "Process 11 waits for ShareLock on transaction 22; blocked by process 33. hunter2",
        where: 'while locking tuple (0,1) in relation "secret_table"',
      })),
    serialization: () => drizzle(pgErr("40001", "could not serialize access due to concurrent update")),
    joined: () =>
      new problemModule.HttpProblem(
        422,
        "postings-imbalance",
        "Postings do not balance",
        'Failed query: insert into "postings" values ($1)\nparams: hunter2 | Postings for transaction 0190 do not balance',
      ),
  };
  for (const [name, make] of Object.entries(thrown)) {
    mini.get(`/throw/${name}`, () => {
      throw make();
    });
  }
  // A file route that staged its success headers, then found the file
  // gone (moved to .trash between the check and the read).
  mini.get("/file/vanished", (_req: any, res: any, next: any) => {
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("ETag", '"abc"');
    filesModule.sendStoredFile(res, path.join(tmp, "no-such-file.png")).catch(next);
  });
  mini.use(problemModule.problemHandler);
  const miniServer = mini.listen(0, "127.0.0.1");
  await new Promise((r) => miniServer.once("listening", r));
  const MINI = `http://127.0.0.1:${(miniServer.address() as AddressInfo).port}`;
  const hit = (name: string): Promise<Obs> => call("GET", `/throw/${name}`, { base: MINI });
  const noSecret = (o: Obs): string | null =>
    /hunter2|secret_|credentials/.test(o.text) ? "body carries the query, a parameter or a path" : null;
  const retryable = (o: Obs): string | null =>
    !/^\d+$/.test(o.headers.get("retry-after") ?? "")
      ? "no Retry-After header"
      : typeof o.json?.retry_after_seconds !== "number"
        ? "no retry_after_seconds in the body"
        : null;

  if (wants("500")) {
    const G = "500";
    for (const name of ["syntax", "undefined_table", "plain", "epipe", "upstream403", "string"]) {
      const before = logged.length;
      const o = await hit(name);
      record(G, `handler throws: ${name}`, o, {
        status: 500,
        type: "internal",
        also: (x) => {
          const secret = noSecret(x);
          if (secret) return secret;
          const lines = logged.slice(before).join("\n");
          return x.json?.trace_id && lines.includes(x.json.trace_id)
            ? null
            : "the error was not logged under the trace_id the body returned";
        },
      });
    }
    const before = logged.length;
    const o = await hit("syntax");
    const lines = logged.slice(before).join("\n");
    rows.push({
      group: G,
      request: "…and the server log line for that trace_id",
      status: o.status,
      shape: lines.includes("secret_table") && lines.includes(o.json?.trace_id ?? "\0") ? "log has trace_id + full query" : "log is missing the detail",
      expect: "log has trace_id + full query",
      ok: lines.includes("secret_table") && lines.includes(o.json?.trace_id ?? "\0"),
    });
  }
  if (wants("pg")) {
    const G = "pg";
    const cases: Array<[string, number, string, ((o: Obs) => string | null)?]> = [
      ["uuid", 400, "invalid-parameter", (o) => (o.json?.value_type === "uuid" ? null : "value_type missing")],
      ["date", 400, "invalid-parameter"],
      ["nul_escape", 400, "invalid-parameter"],
      ["unique", 409, "conflict", (o) => (o.json?.constraint === "owned_items_tx_item_instance_uq" ? null : "constraint name missing")],
      ["fk_insert", 422, "invalid-reference"],
      ["fk_delete", 409, "still-referenced"],
      ["check", 422, "constraint-violation"],
      ["trigger", 422, "constraint-violation", (o) => (/do not balance/.test(o.json?.detail ?? "") ? null : "trigger's own sentence was dropped")],
      ["not_null", 422, "constraint-violation"],
      // Postgres stopped a correct statement to let a concurrent one
      // through: nothing was written, and the answer says "send it again".
      ["deadlock", 409, "concurrent-update", retryable],
      ["serialization", 409, "concurrent-update", retryable],
      ["joined", 422, "postings-imbalance", (o) => (/do not balance/.test(o.json?.detail ?? "") ? null : "driver sentence was dropped with the SQL")],
    ];
    for (const [name, status, type, also] of cases) {
      record(G, `handler throws: pg ${name}`, await hit(name), {
        status,
        type,
        also: (o) => noSecret(o) ?? also?.(o) ?? null,
      });
    }
  }
  if (wants("500")) {
    record("500", "file route: file vanished after its headers were staged", await call("GET", "/file/vanished", { base: MINI }), {
      status: 404,
      type: "not-found",
      // (Express tags the JSON body with an ETag of its own; the one
      // that must not survive is the image's.)
      also: (o) =>
        o.headers.get("cache-control") || o.headers.get("etag") === '"abc"'
          ? "the error kept the image's Cache-Control / ETag and would be cached as the image"
          : null,
    });
  }
  // `publicErrorMessage` is the same mapping for the places a problem
  // document does not reach: a per-item message inside a 200, a stored
  // status. Whatever is thrown, the query and its values stay out.
  if (wants("500")) {
    const G = "500";
    for (const name of ["syntax", "plain", "string", "uuid", "unique", "deadlock", "joined"]) {
      const message: string = problemModule.publicErrorMessage(thrown[name]!());
      const bad = /hunter2|secret_|credentials|Failed query|params:/.test(message);
      rows.push({
        group: G,
        request: `publicErrorMessage(${name})`,
        status: 0,
        shape: JSON.stringify(message).slice(0, 56),
        expect: "a sentence, no SQL or values",
        ok: !bad && message.length > 0,
        why: bad ? "carries the query, a parameter or a path" : undefined,
      });
    }
  }
  await new Promise((r) => miniServer.close(r));
}

// ── 500 (live): per-item errors reported inside a 200 ──────────────────
// POST /v1/admin/re-derive catches each place's failure and lists it in
// the 200 body. Make every re-derive fail in the database and read what
// the list says.
if (wants("500")) {
  const G = "500";
  const gid = `ChIJrederive${NONCE}`;
  const placeId = (
    await q<{ id: string }>(
      `INSERT INTO places (google_place_id, formatted_address, lat, lng, source, raw_response)
       VALUES ($1, 'nowhere', 1, 1, 'check', '{}'::jsonb) RETURNING id`,
      [gid],
    )
  )[0]!.id;
  await q(`CREATE OR REPLACE FUNCTION check_http_errors_boom() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN RAISE EXCEPTION 'check-http-errors: forced failure'; END $$`);
  await q(`CREATE TRIGGER check_http_errors_boom BEFORE INSERT ON derivation_events
           FOR EACH ROW EXECUTE FUNCTION check_http_errors_boom()`);
  const before = logged.length;
  let o: Obs;
  try {
    o = await call("POST", "/v1/admin/re-derive?scope=places", { json: {} });
  } finally {
    await q(`DROP TRIGGER IF EXISTS check_http_errors_boom ON derivation_events`);
    await q(`DROP FUNCTION IF EXISTS check_http_errors_boom()`);
  }
  const lines = logged.slice(before).join("\n");
  record(G, "POST /v1/admin/re-derive  every place fails in the database", o, {
    status: 200,
    also: (x) => {
      const errors: Array<{ id: string; message: string }> = x.json?.errors ?? [];
      const mine = errors.find((e) => e.id === placeId);
      if (!mine) return "the failing place is not in errors[]";
      const leaking = errors.filter((e) => LEAK_RE.test(e.message) || e.message.includes(gid));
      if (leaking.length) return `${leaking.length} of ${errors.length} errors[].message carry SQL or parameters`;
      return lines.includes(placeId) && lines.includes("Failed query")
        ? null
        : "the full error was not logged next to the place id";
    },
  });
}

// ── Fixtures shared by the write groups ────────────────────────────────
async function twoAccounts(): Promise<[string, string]> {
  const rs = await q<{ id: string }>(
    `SELECT a.id FROM accounts a
      WHERE a.workspace_id = $1 AND a.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id)
      ORDER BY a.type, a.name LIMIT 2`,
    [SEED_WORKSPACE_ID],
  );
  if (rs.length < 2) throw new Error("need two leaf accounts in the seeded chart");
  return [rs[0]!.id, rs[1]!.id];
}
function txnBody(tag: string, a: string, b: string, occurredOn = "2026-01-15"): Record<string, unknown> {
  return {
    occurred_on: occurredOn,
    payee: `check-http-errors ${NONCE} ${tag}`,
    postings: [
      { account_id: a, amount_minor: 123 },
      { account_id: b, amount_minor: -123 },
    ],
  };
}
const countTxns = async (tag: string): Promise<number> =>
  Number((await q(`SELECT count(*) AS n FROM transactions WHERE payee = $1`, [`check-http-errors ${NONCE} ${tag}`]))[0]!.n);

/** Upload a small text file as a document. The bytes are unique per
 *  call: the route dedups on sha256. */
async function uploadDoc(label: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([`check-http-errors ${NONCE} ${label} ${randomUUID()}\n`], { type: "text/plain" }), `${label}.txt`);
  form.append("kind", "other");
  const up = await call("POST", "/v1/documents", { body: form });
  if (up.status !== 201) throw new Error(`fixture: upload ${label} → ${up.status}`);
  return up.json.id as string;
}

interface TxnFixture {
  id: string;
  version: number;
  etag: string;
}
/** A posted transaction evidenced by the given documents. */
async function txnWithDocs(tag: string, a: string, b: string, documentIds: string[]): Promise<TxnFixture> {
  const o = await call("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": `${tag}-${NONCE}-${randomUUID()}` },
    json: { ...txnBody(tag, a, b), document_ids: documentIds },
  });
  if (o.status !== 201) throw new Error(`fixture: transaction ${tag} → ${o.status}`);
  return { id: o.json.id, version: o.json.version, etag: o.headers.get("etag") ?? "" };
}

type ReportList = "kept" | "soft_deleted" | "hard_deleted" | "skipped";
const REPORT_LISTS: ReportList[] = ["kept", "soft_deleted", "hard_deleted", "skipped"];
/** A `CascadeDeleteReport` must carry all four lists, and exactly the
 *  ids named here (a list not named must be empty). */
function reportIs(o: Obs, want: Partial<Record<ReportList, string[]>>): string | null {
  for (const list of REPORT_LISTS) {
    const got: unknown = o.json?.[`transactions_${list}`];
    if (!Array.isArray(got)) return `no transactions_${list} list`;
    const expected = [...(want[list] ?? [])].sort();
    if ([...got].sort().join() !== expected.join()) {
      return `transactions_${list} has ${got.length} id(s), expected ${expected.length}`;
    }
  }
  return null;
}

// ── pg (live): constraint and data errors reached through the API ──────
if (wants("pg")) {
  const G = "pg";
  const [a, b] = await twoAccounts();
  const product = await call("POST", "/v1/products", {
    json: { product_key: `check-${NONCE}`, canonical_name: `Check ${NONCE}`, item_class: "other" },
  });
  const pid: string = product.json?.id;

  record(G, "PATCH /v1/products/:id  brand_id that does not exist", await call("PATCH", `/v1/products/${pid}`, {
    headers: { "Content-Type": "application/merge-patch+json" },
    json: { brand_id: `no-such-brand-${NONCE}` },
  }), { status: 422, type: "invalid-reference" });

  record(G, "POST /v1/owned-items  transaction_item_id that does not exist", await call("POST", "/v1/owned-items", {
    json: { product_id: pid, transaction_item_id: NOBODY },
  }), { status: 422, type: "invalid-reference" });

  record(G, "POST /v1/transactions  occurred_on 2026-13-45", await call("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": `date-${NONCE}` },
    json: txnBody("baddate", a, b, "2026-13-45"),
  }), { status: 400, type: "invalid-parameter" });

  // The JSON escape \u0000 parses as JSON but jsonb cannot hold it.
  const nulMeta = { ...txnBody("nulmeta", a, b), metadata: { k: "a\u0000b" } };
  record(G, "POST /v1/transactions  metadata value containing \\u0000", await call("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": `nul-${NONCE}` },
    json: nulMeta,
  }), { status: 400, type: "invalid-parameter" });

  // The ledger's own trigger: its sentence should reach the caller, the
  // `Failed query: commit` wrapper Drizzle puts around it should not.
  const lopsided = txnBody("imbalance", a, b);
  (lopsided.postings as Array<{ amount_minor: number }>)[1]!.amount_minor = -122;
  record(G, "POST /v1/transactions  postings that do not sum to zero", await call("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": `imbalance-${NONCE}` },
    json: lopsided,
  }), {
    status: 422,
    type: "postings-imbalance",
    also: (o) => (/do not balance/.test(o.json?.detail ?? "") ? null : "the trigger's sentence is missing from detail"),
  });

  const created = await call("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": `pg-${NONCE}` },
    json: txnBody("pg", a, b),
  });
  const tid: string = created.json?.id;
  const etag = created.headers.get("etag") ?? "";

  record(G, "PATCH /v1/transactions/:id  occurred_on 2026-13-45", await call("PATCH", `/v1/transactions/${tid}`, {
    headers: { "If-Match": etag, "Content-Type": "application/merge-patch+json" },
    json: { occurred_on: "2026-13-45" },
  }), { status: 400, type: "invalid-parameter" });

  record(G, "POST /v1/transactions/bulk  one op with occurred_on 2026-13-45", await call("POST", "/v1/transactions/bulk", {
    json: { operations: [{ op: "update", id: tid, if_match: etag, patch: { occurred_on: "2026-13-45" } }] },
  }), {
    status: 200,
    also: (o) => {
      const r = o.json?.results?.[0];
      if (!r) return "no per-item result";
      if (LEAK_RE.test(JSON.stringify(r))) return `per-item body (status ${r.status}) leaks SQL`;
      return r.status === 400 ? null : `per-item status ${r.status}`;
    },
  });

  // A duplicate owned item on one purchase line → unique violation.
  const items = await call("POST", `/v1/transactions/${tid}/items`, {
    json: { items: [{ raw_name: `check ${NONCE}`, quantity: 1, line_total_minor: 123, item_class: "other" }] },
  });
  // The items response carries no row id; read it back.
  const itemId: string | undefined = tid
    ? (await q<{ id: string }>(`SELECT id FROM transaction_items WHERE transaction_id = $1 LIMIT 1`, [tid]))[0]?.id
    : undefined;
  if (itemId) {
    await call("POST", "/v1/owned-items", { json: { product_id: pid, transaction_item_id: itemId } });
    record(G, "POST /v1/owned-items  same purchase line twice", await call("POST", "/v1/owned-items", {
      json: { product_id: pid, transaction_item_id: itemId },
    }), { status: 409, type: "conflict" });
  } else {
    rows.push({ group: G, request: "POST /v1/owned-items  same purchase line twice", status: items.status, shape: "(fixture: could not add a line item)", expect: "409 conflict", ok: false, why: items.text.slice(0, 120) });
  }

  // A deadlock that reaches the central handler through a real route.
  // One cannot be staged on demand, so a trigger raises the SQLSTATE
  // Postgres would, on this fixture's document only. Under test: what
  // the route answers when its DB transaction is aborted that way, and
  // that the abort left nothing behind.
  const dlDoc = await uploadDoc("deadlock");
  const dlTxn = await txnWithDocs("deadlock", a, b, [dlDoc]);
  if (!/^[0-9a-f-]{36}$/.test(dlDoc)) throw new Error("fixture: document id is not a uuid");
  await q(`CREATE OR REPLACE FUNCTION check_http_errors_deadlock() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
  await q(`CREATE TRIGGER check_http_errors_deadlock BEFORE UPDATE ON documents
           FOR EACH ROW WHEN (OLD.id = '${dlDoc}'::uuid) EXECUTE FUNCTION check_http_errors_deadlock()`);
  let aborted: Obs;
  let abortedPlain: Obs;
  try {
    aborted = await call("DELETE", `/v1/documents/${dlDoc}?cascade=true`);
    abortedPlain = await call("DELETE", `/v1/documents/${dlDoc}`);
  } finally {
    await q(`DROP TRIGGER IF EXISTS check_http_errors_deadlock ON documents`);
    await q(`DROP FUNCTION IF EXISTS check_http_errors_deadlock()`);
  }
  const untouched = await q<{ t: Date | null; d: Date | null }>(
    `SELECT (SELECT deleted_at FROM transactions WHERE id = $1) AS t,
            (SELECT deleted_at FROM documents WHERE id = $2) AS d`,
    [dlTxn.id, dlDoc],
  );
  record(G, "DELETE /v1/documents/:id?cascade=true  aborted by a deadlock (40P01)", aborted, {
    status: 409,
    type: "concurrent-update",
    also: (o) =>
      !/^\d+$/.test(o.headers.get("retry-after") ?? "")
        ? "no Retry-After header"
        : untouched[0]!.t !== null || untouched[0]!.d !== null
          ? "the aborted cascade left the transaction or the document deleted"
          : null,
  });
  record(G, "DELETE /v1/documents/:id  aborted by a deadlock (40P01)", abortedPlain, {
    status: 409,
    type: "concurrent-update",
    also: (o) => (/^\d+$/.test(o.headers.get("retry-after") ?? "") ? null : "no Retry-After header"),
  });
  record(G, "…and the same cascade, retried", await call("DELETE", `/v1/documents/${dlDoc}?cascade=true`), {
    status: 200,
    also: (o) => reportIs(o, { soft_deleted: [dlTxn.id] }),
  });
}

// ── idem: Idempotency-Key ──────────────────────────────────────────────
if (wants("idem")) {
  const G = "idem";
  const [a, b] = await twoAccounts();
  const post = (key: string | null, body: unknown): Promise<Obs> =>
    call("POST", "/v1/transactions", { headers: key ? { "Idempotency-Key": key } : {}, json: body });
  const hashOf = (body: unknown): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

  record(G, "POST /v1/transactions  no Idempotency-Key", await post(null, txnBody("nokey", a, b)), {
    status: 428,
    type: "precondition-required",
  });

  const k1 = `k1-${NONCE}`;
  const first = await post(k1, txnBody("replay", a, b));
  const second = await post(k1, txnBody("replay", a, b));
  record(G, "same key, same body, twice in a row", second, {
    status: 201,
    also: (o) =>
      first.status !== 201 ? `first call was ${first.status}` : o.json?.id !== first.json?.id ? "second call created a new transaction" : null,
  });
  record(G, "same key, different body", await post(k1, txnBody("replay-other", a, b)), {
    status: 409,
    type: "idempotency-conflict",
  });

  // Eight simultaneous requests under one key must create one row.
  const k2 = `k2-${NONCE}`;
  const burst = await Promise.all(Array.from({ length: 8 }, () => post(k2, txnBody("burst", a, b))));
  const made = await countTxns("burst");
  const tally = burst.map((o) => (o.status === 409 ? `409:${String(o.json?.type).split("/").pop()}` : String(o.status)));
  const summary = [...new Set(tally)].map((t) => `${tally.filter((x) => x === t).length}×${t}`).join(", ");
  rows.push({
    group: G,
    request: "8 concurrent requests, one key",
    status: burst[0]!.status,
    shape: `${made} transaction(s) created; ${summary}`,
    expect: "1 transaction created",
    ok: made === 1 && burst.every((o) => o.status === 201 || (o.status === 409 && /idempotency-in-progress$/.test(o.json?.type ?? ""))),
    why: made === 1 ? undefined : `${made} created`,
  });
  const settled = await post(k2, txnBody("burst", a, b));
  const madeAfter = await countTxns("burst");
  record(G, "…then the same key again once it settled", settled, {
    status: 201,
    also: () => (madeAfter === 1 ? null : `${madeAfter} transactions exist under one key`),
  });

  // A key whose stored response expired: usable again, and memoized again.
  const k3 = `k3-${NONCE}`;
  await q(
    `INSERT INTO idempotency_keys (id, workspace_id, key, request_hash, response_status, response_body, expires_at)
     VALUES (gen_random_uuid(), $1, $2, 'stale', 201, '{"id":"stale"}', NOW() - interval '1 hour')`,
    [SEED_WORKSPACE_ID, k3],
  );
  const e1 = await post(k3, txnBody("expired", a, b));
  const e2 = await post(k3, txnBody("expired", a, b));
  const madeExpired = await countTxns("expired");
  record(G, "key whose row expired, used twice", e2, {
    status: 201,
    also: (o) =>
      e1.status !== 201
        ? `first call was ${e1.status}`
        : madeExpired !== 1
          ? `${madeExpired} transactions created (the retry ran again)`
          : o.json?.id !== e1.json?.id
            ? "retry was not a replay"
            : null,
  });

  // A request still in flight holds the key; an abandoned one does not.
  const k4 = `k4-${NONCE}`;
  const held = txnBody("held", a, b);
  await q(
    `INSERT INTO idempotency_keys (id, workspace_id, key, request_hash, response_status, response_body, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 0, 'null', NOW() + interval '60 seconds')`,
    [SEED_WORKSPACE_ID, k4, hashOf(held)],
  );
  record(G, "key claimed by a request still running", await post(k4, held), {
    status: 409,
    type: "idempotency-in-progress",
    also: (o) => (o.headers.get("retry-after") ? null : "no Retry-After"),
  });
  await q(`UPDATE idempotency_keys SET expires_at = NOW() - interval '1 second' WHERE workspace_id = $1 AND key = $2`, [SEED_WORKSPACE_ID, k4]);
  record(G, "…and after that claim's lease ran out", await post(k4, held), { status: 201 });

  // A key the unique index cannot hold is the caller's 400, not a 500.
  record(G, "Idempotency-Key of 3000 characters", await post(`long-${NONCE}-${randomUUID().repeat(90)}`.slice(0, 3000), txnBody("longkey", a, b)), {
    status: 400,
    type: "invalid-idempotency-key",
    also: () => null,
  });
  const madeLong = await countTxns("longkey");
  record(G, "Idempotency-Key of 255 characters", await post(`max-${NONCE}-${randomUUID().repeat(8)}`.slice(0, 255), txnBody("maxkey", a, b)), {
    status: 201,
    also: () => (madeLong === 0 ? null : `${madeLong} transaction(s) created by the rejected request`),
  });

  // A failed request must not burn the key.
  const k5 = `k5-${NONCE}`;
  await post(k5, { occurred_on: "nope" });
  record(G, "key first used by a request that failed validation", await post(k5, txnBody("after-422", a, b)), { status: 201 });
}

// ── etag: document metadata ────────────────────────────────────────────
let uploadedDocId: string | null = null;
if (wants("etag") || wants("file")) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(`check-http-errors ${NONCE}\n`)], { type: "text/plain" }), "note.txt");
  form.append("kind", "other");
  const up = await call("POST", "/v1/documents", { body: form });
  uploadedDocId = up.json?.id ?? null;
}
if (wants("etag") && uploadedDocId) {
  const G = "etag";
  const id = uploadedDocId;
  const g1 = await call("GET", `/v1/documents/${id}`);
  const tag1 = g1.headers.get("etag") ?? "";
  record(G, "GET /v1/documents/:id", g1, {
    status: 200,
    also: () => (tag1 && tag1 !== 'W/"1"' ? null : `ETag is ${tag1 || "(missing)"}`),
  });
  record(G, "GET /v1/documents/:id  If-None-Match: <its ETag>", await call("GET", `/v1/documents/${id}`, { headers: { "If-None-Match": tag1 } }), {
    status: 304,
  });
  await call("DELETE", `/v1/documents/${id}`);
  const g2 = await call("GET", `/v1/documents/${id}?include_deleted=true`, { headers: { "If-None-Match": tag1 } });
  record(G, "…same If-None-Match after the document was soft-deleted", g2, {
    status: 200,
    also: (o) => (o.json?.deleted_at ? (o.headers.get("etag") !== tag1 ? null : "ETag did not move") : "deleted_at not set"),
  });
  const restored = await call("POST", `/v1/documents/${id}/restore`);
  record(G, "POST /v1/documents/:id/restore", restored, {
    status: 200,
    also: (o) => (o.headers.get("etag") && o.headers.get("etag") !== g2.headers.get("etag") ? null : "ETag did not move back"),
  });
  const content = await call("GET", `/v1/documents/${id}/content`);
  record(G, "GET /v1/documents/:id/content", content, {
    status: 200,
    also: (o) => (o.headers.get("etag") === `"${g1.json?.sha256}"` ? null : `ETag is ${o.headers.get("etag")}, not the sha256`),
  });
}

// ── etag: a transaction's tag covers its documents ─────────────────────
// The body of GET /v1/transactions/:id lists the linked documents, and
// nothing that changes that list touches the transaction row, so its
// `version` stays put. A tag made of the version alone answered every
// revalidation with 304 and the receipt page kept the old documents.
if (wants("etag")) {
  const G = "etag";
  const [a, b] = await twoAccounts();
  const d1 = await uploadDoc("etag-1");
  const d2 = await uploadDoc("etag-2");
  const t = await txnWithDocs("etag", a, b, [d1, d2]);
  const url = `/v1/transactions/${t.id}`;
  const first = await call("GET", url);
  let tag = first.headers.get("etag") ?? "";
  const version0: number = first.json?.version;
  const originalTag = tag;
  record(G, "GET /v1/transactions/:id  (two documents)", first, {
    status: 200,
    also: () =>
      !tag
        ? "no ETag"
        : tag !== t.etag
          ? "GET and the POST that created it disagree on the ETag"
          : tag === `W/"${version0}"`
            ? "ETag is the bare version: it cannot move when a document does"
            : null,
  });
  record(G, "…If-None-Match: <its ETag>", await call("GET", url, { headers: { "If-None-Match": tag } }), { status: 304 });

  /** Make one change to the documents, then revalidate with the tag
   *  held from before it. The answer must be a fresh 200 under a new
   *  tag, with `version` where it was. */
  const afterChange = async (label: string, change: Obs, want: number, docs: (list: any[]) => string | null): Promise<void> => {
    const o = await call("GET", url, { headers: { "If-None-Match": tag } });
    record(G, label, o, {
      status: 200,
      also: (x) => {
        if (change.status !== want) return `the change itself answered ${change.status}`;
        const now = x.headers.get("etag") ?? "";
        if (!now || now === tag) return "ETag did not move: a revalidating browser keeps the old documents";
        if (x.json?.version !== version0) return `version moved to ${x.json?.version}`;
        return docs(x.json?.documents ?? []);
      },
    });
    tag = o.headers.get("etag") ?? tag;
  };
  const docState = (list: any[], id: string): string =>
    !list.some((d) => d.id === id) ? "absent" : list.find((d) => d.id === id).deleted_at ? "deleted" : "live";
  const expectDoc = (id: string, state: string) => (list: any[]) =>
    docState(list, id) === state ? null : `document is ${docState(list, id)}, expected ${state}`;

  await afterChange("…after DELETE /v1/documents/:id (soft delete of one document)", await call("DELETE", `/v1/documents/${d1}`), 204, expectDoc(d1, "deleted"));
  await afterChange("…after POST /v1/documents/:id/restore", await call("POST", `/v1/documents/${d1}/restore`), 200, expectDoc(d1, "live"));
  await afterChange("…after DELETE /v1/documents/:id/links/:txn (unlink)", await call("DELETE", `/v1/documents/${d2}/links/${t.id}`), 204, expectDoc(d2, "absent"));
  await afterChange("…after POST /v1/documents/:id/links (link)", await call("POST", `/v1/documents/${d2}/links`, { json: { transaction_id: t.id } }), 204, expectDoc(d2, "live"));
  const kept = await call("DELETE", `/v1/documents/${d1}?cascade=true`);
  await afterChange("…after a cascade delete that kept the transaction", kept, 200, (list) => reportIs(kept, { kept: [t.id] }) ?? expectDoc(d1, "deleted")(list));

  // If-Match guards the transaction row, which none of the above wrote.
  // A client that read the transaction before them and saves an edit now
  // must not lose it: the edit is applied (a 412 would be honest too; a
  // 2xx that changed nothing would not).
  const MERGE = { "Content-Type": "application/merge-patch+json" };
  const edit = await call("PATCH", url, { headers: { ...MERGE, "If-Match": originalTag }, json: { narration: `edited ${NONCE}` } });
  record(G, "PATCH  If-Match: <ETag read before the document changes>", edit, {
    status: 200,
    also: (o) =>
      o.json?.narration !== `edited ${NONCE}`
        ? "answered 200 but the edit is not in the response"
        : o.json?.version !== version0 + 1
          ? `version is ${o.json?.version}, expected ${version0 + 1}`
          : expectDoc(d1, "deleted")(o.json?.documents ?? []) ??
            (o.headers.get("etag") && o.headers.get("etag") !== originalTag ? null : "response ETag is not the current one"),
  });
  const stored = await q<{ narration: string | null }>(`SELECT narration FROM transactions WHERE id = $1`, [t.id]);
  record(G, "…and the edit is in the database", await call("GET", url), {
    status: 200,
    also: () => (stored[0]?.narration === `edited ${NONCE}` ? null : "the row does not carry the edit"),
  });
  record(G, "PATCH  If-Match: <that same ETag again>  (its version is now behind)", await call("PATCH", url, { headers: { ...MERGE, "If-Match": originalTag }, json: { narration: "lost update" } }), {
    status: 412,
    type: "version-mismatch",
  });
  record(G, 'PATCH  If-Match: W/"<version>"  (built from the body\'s version)', await call("PATCH", url, { headers: { ...MERGE, "If-Match": `W/"${version0 + 1}"` }, json: { narration: `bare ${NONCE}` } }), {
    status: 200,
    also: (o) => (o.json?.narration === `bare ${NONCE}` ? null : "the edit is not in the response"),
  });
  const current = await call("GET", url);
  record(G, "POST /v1/transactions/bulk  if_match: <the current ETag>", await call("POST", "/v1/transactions/bulk", {
    json: { operations: [{ op: "update", id: t.id, if_match: current.headers.get("etag"), patch: { narration: `bulk ${NONCE}` } }] },
  }), {
    status: 200,
    also: (o) => (o.json?.results?.[0]?.status === 200 ? null : `per-item status ${o.json?.results?.[0]?.status}`),
  });
  record(G, "PATCH  If-Match: <not an ETag>", await call("PATCH", url, { headers: { ...MERGE, "If-Match": '"abc"' }, json: { narration: "x" } }), {
    status: 412,
    type: "version-mismatch",
  });
}

// ── state: where cascade delete and dedup apply / undo meet ────────────
// Each of these is a well-formed request the resource is in the wrong
// state for. None may be a 500, and the ones that answer 200 must say
// what they did not do.
if (wants("state")) {
  const G = "state";
  const [a, b] = await twoAccounts();
  const batchId = randomUUID();
  await q(
    `INSERT INTO batches (id, workspace_id, status, file_count, auto_reconcile) VALUES ($1, $2, 'reconciled', 0, false)`,
    [batchId, SEED_WORKSPACE_ID],
  );
  const reconcile = (verb: string, ids: string[], batch = batchId): Promise<Obs> =>
    call("POST", `/v1/batches/${batch}/reconcile/${verb}`, { json: { proposal_ids: ids } });
  /** Two transactions with one document each, and a dedup proposal on
   *  file naming the second as the duplicate of the first. */
  const pair = async (tag: string): Promise<{ A: string; B: string; docA: string; docB: string; pid: string }> => {
    const docA = await uploadDoc(`${tag}-a`);
    const docB = await uploadDoc(`${tag}-b`);
    const A = await txnWithDocs(`${tag}-a`, a, b, [docA]);
    const B = await txnWithDocs(`${tag}-b`, a, b, [docB]);
    const pid = randomUUID();
    await q(
      `INSERT INTO reconcile_proposals (id, batch_id, kind, payload, score, status)
       VALUES ($1, $2, 'dedup', $3::jsonb, 0.9, 'proposed')`,
      [pid, batchId, JSON.stringify({ duplicate: B.id, duplicate_of: A.id })],
    );
    return { A: A.id, B: B.id, docA, docB, pid };
  };
  const skippedFor = (o: Obs, prefix: string): string | null => {
    const reason = String(o.json?.skipped?.[0]?.reason ?? "");
    const acted = (o.json?.reverted ?? o.json?.applied ?? o.json?.rejected ?? []).length;
    return acted !== 0 ? "the proposal was acted on" : reason.startsWith(prefix) ? null : `skipped reason is "${reason.slice(0, 60)}"`;
  };
  const stateOf = async (txn: string): Promise<{ deleted: boolean; links: number; live_docs: number } | null> =>
    (
      await q<{ deleted: boolean; links: number; live_docs: number }>(
        `SELECT t.deleted_at IS NOT NULL AS deleted,
                (SELECT count(*)::int FROM document_links dl WHERE dl.transaction_id = t.id) AS links,
                (SELECT count(*)::int FROM document_links dl JOIN documents d ON d.id = dl.document_id
                  WHERE dl.transaction_id = t.id AND d.deleted_at IS NULL) AS live_docs
           FROM transactions t WHERE t.id = $1`,
        [txn],
      )
    )[0] ?? null;
  const proposalStatus = async (pid: string): Promise<string> =>
    (await q<{ status: string }>(`SELECT status FROM reconcile_proposals WHERE id = $1`, [pid]))[0]?.status ?? "(gone)";

  // — undo, in every state it cannot act on —
  record(G, "POST /v1/batches/<no such batch>/reconcile/undo", await reconcile("undo", [randomUUID()], NOBODY), {
    status: 404,
    type: "not-found",
  });
  record(G, "undo  a proposal id this batch does not have", await reconcile("undo", [randomUUID()]), {
    status: 200,
    also: (o) => skippedFor(o, "not_found"),
  });
  const open = await pair("open");
  record(G, "undo  a proposal that is still `proposed`", await reconcile("undo", [open.pid]), {
    status: 200,
    also: (o) => skippedFor(o, "not_applied"),
  });
  await reconcile("reject", [open.pid]);
  record(G, "undo  a proposal that was rejected", await reconcile("undo", [open.pid]), {
    status: 200,
    also: (o) => skippedFor(o, "not_applied"),
  });
  record(G, "apply  a proposal that was rejected", await reconcile("apply", [open.pid]), {
    status: 200,
    also: (o) => skippedFor(o, "rejected"),
  });

  const round = await pair("round");
  const applied = await reconcile("apply", [round.pid]);
  record(G, "reject  a proposal that was applied", await reconcile("reject", [round.pid]), {
    status: 200,
    also: (o) => (applied.json?.applied?.length === 1 ? skippedFor(o, "already_applied") : "fixture: the apply did not apply"),
  });
  const undone = await reconcile("undo", [round.pid]);
  const roundB = await stateOf(round.B);
  record(G, "undo  an applied proposal", undone, {
    status: 200,
    also: (o) => {
      const r = o.json?.reverted?.[0];
      if (!r) return "nothing reverted";
      if (r.restored !== true || r.documents_relinked?.join() !== round.docB) return "the detail does not name the restored document";
      return roundB && !roundB.deleted && roundB.live_docs === 1 ? null : "the duplicate is not live with its document";
    },
  });
  record(G, "undo  the same proposal again", await reconcile("undo", [round.pid]), {
    status: 200,
    also: (o) => skippedFor(o, "already_reverted"),
  });
  record(G, "apply  a proposal that was reverted", await reconcile("apply", [round.pid]), {
    status: 200,
    also: (o) => skippedFor(o, "reverted"),
  });

  // — apply, then the moved document is cascade-deleted, then undo —
  // The cascade keeps the survivor (it has its own document). Undo must
  // not answer by bringing the duplicate back with nothing live behind it.
  for (const hard of [false, true]) {
    const mode = hard ? "hard" : "soft";
    const s = await pair(`seam-${mode}`);
    await reconcile("apply", [s.pid]);
    const cascade = await call("DELETE", `/v1/documents/${s.docB}?cascade=true${hard ? "&hard=true" : ""}`);
    record(G, `apply, then ${mode} cascade delete of the document it moved`, cascade, {
      status: 200,
      also: (o) => (o.json?.hard === hard && o.json?.document_id === s.docB ? reportIs(o, { kept: [s.A] }) : "report does not describe this call"),
    });
    const refused = await reconcile("undo", [s.pid]);
    const dup = await stateOf(s.B);
    const status = await proposalStatus(s.pid);
    record(G, `…then undo: nothing live to give the duplicate back (${mode})`, refused, {
      status: 200,
      also: (o) =>
        skippedFor(o, "no_live_document") ??
        (!dup?.deleted
          ? "the duplicate was restored with no live document"
          : status !== "user_applied"
            ? `the proposal is ${status}, not still applied`
            : null),
    });
    if (!hard) {
      await call("POST", `/v1/documents/${s.docB}/restore`);
      const retried = await reconcile("undo", [s.pid]);
      const back = await stateOf(s.B);
      const survivor = await stateOf(s.A);
      record(G, "…restore that document, undo again", retried, {
        status: 200,
        also: (o) =>
          o.json?.reverted?.length !== 1
            ? `not reverted: "${String(o.json?.skipped?.[0]?.reason ?? "").slice(0, 60)}"`
            : back && !back.deleted && back.live_docs === 1 && survivor?.links === 1
              ? null
              : "the two transactions do not each hold their own document",
      });
    }
  }

  // — the cascade report, one linked transaction at a time —
  const r1 = await uploadDoc("report-1");
  const r2 = await uploadDoc("report-2");
  const two = await txnWithDocs("report", a, b, [r1, r2]);
  record(G, "cascade delete of one of a transaction's two documents", await call("DELETE", `/v1/documents/${r1}?cascade=true`), {
    status: 200,
    also: (o) => reportIs(o, { kept: [two.id] }),
  });
  record(G, "…of its last live document", await call("DELETE", `/v1/documents/${r2}?cascade=true`), {
    status: 200,
    also: (o) => reportIs(o, { soft_deleted: [two.id] }),
  });
  record(G, "…of that document again (transaction already deleted)", await call("DELETE", `/v1/documents/${r2}?cascade=true`), {
    status: 200,
    also: (o) => reportIs(o, { skipped: [two.id] }),
  });

  // A transaction that is ALREADY soft-deleted and still has two live
  // documents. It is not in the ledger, so it is never "kept".
  const softDelete = (t: TxnFixture): Promise<Obs> => call("DELETE", `/v1/transactions/${t.id}`, { headers: { "If-Match": t.etag } });
  const g1 = await uploadDoc("gone-1");
  const g2 = await uploadDoc("gone-2");
  const gone = await txnWithDocs("gone", a, b, [g1, g2]);
  await softDelete(gone);
  record(G, "cascade delete, linked transaction already soft-deleted (has another live document)", await call("DELETE", `/v1/documents/${g1}?cascade=true`), {
    status: 200,
    also: (o) => reportIs(o, { skipped: [gone.id] }),
  });
  const purge = await call("DELETE", `/v1/documents/${g2}?cascade=true&hard=true`);
  const purgeEvent = await q<{ prior: string | null }>(
    `SELECT payload->>'prior_deleted_at' AS prior FROM transaction_events
      WHERE event_type = 'hard_deleted' AND payload->>'transaction_id' = $1`,
    [gone.id],
  );
  record(G, "…hard cascade of its last live document (the purge)", purge, {
    status: 200,
    also: (o) =>
      reportIs(o, { hard_deleted: [gone.id] }) ??
      (purgeEvent.length === 1 && purgeEvent[0]!.prior ? null : "the hard_deleted event does not say the row was already soft-deleted, or since when"),
  });
  const h1 = await uploadDoc("gone-hard-1");
  const h2 = await uploadDoc("gone-hard-2");
  const goneHard = await txnWithDocs("gone-hard", a, b, [h1, h2]);
  await softDelete(goneHard);
  const unlinkOnly = await call("DELETE", `/v1/documents/${h1}?cascade=true&hard=true`);
  const goneHardNow = await stateOf(goneHard.id);
  record(G, "hard cascade, linked transaction already soft-deleted (has another live document)", unlinkOnly, {
    status: 200,
    also: (o) => reportIs(o, { skipped: [goneHard.id] }) ?? (goneHardNow?.deleted && goneHardNow.links === 1 ? null : "the tombstone did not simply lose this one link"),
  });

  // — refusals —
  const k1 = await uploadDoc("reconciled");
  const matched = await txnWithDocs("reconciled", a, b, [k1]);
  await call("POST", `/v1/transactions/${matched.id}/reconcile`, { headers: { "If-Match": matched.etag } });
  const blocked = await call("DELETE", `/v1/documents/${k1}?cascade=true`);
  const k1Row = await q<{ deleted_at: Date | null }>(`SELECT deleted_at FROM documents WHERE id = $1`, [k1]);
  record(G, "cascade delete, last evidence of a reconciled transaction", blocked, {
    status: 409,
    type: "cascade-blocked-reconciled",
    also: (o) =>
      o.json?.reconciled_transaction_ids?.join() !== matched.id
        ? "reconciled_transaction_ids does not name it"
        : k1Row[0]?.deleted_at
          ? "refused, but the document was deleted anyway"
          : null,
  });
  record(G, "DELETE /v1/documents/:id?hard=true  (linked, no cascade)", await call("DELETE", `/v1/documents/${k1}?hard=true`), {
    status: 409,
    type: "document-has-links",
  });
  for (const qs of ["cascade=maybe", "cascade=true&hard=yes", "hard="]) {
    record(G, `DELETE /v1/documents/:id?${qs}`, await call("DELETE", `/v1/documents/${k1}?${qs}`), { status: 422, type: "validation" });
  }
  record(G, "DELETE /v1/documents/<no such document>?cascade=true", await call("DELETE", `/v1/documents/${NOBODY}?cascade=true`), {
    status: 404,
    type: "not-found",
  });
}

// ── file: asset endpoints ──────────────────────────────────────────────
if (wants("file")) {
  const G = "file";
  const SENTINEL = `OUTSIDE-THE-ROOT-${NONCE}`;
  const secret = path.join(OUTSIDE, "secret.txt");
  await writeFile(secret, SENTINEL);
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script><rect width="1" height="1"/></svg>`;
  const brand = `check-${NONCE}`;
  await mkdir(path.join(BRAND_ROOT, brand, "t"), { recursive: true });
  await writeFile(path.join(BRAND_ROOT, brand, "t", "icon.svg"), SVG);
  await writeFile(path.join(BRAND_ROOT, brand, "t", "pixel.png"), PNG);
  await writeFile(path.join(BRAND_ROOT, brand, "t", "page.html"), "<script>alert(1)</script>");
  await symlink(secret, path.join(BRAND_ROOT, brand, "t", "link.png"));
  await q(`INSERT INTO brands (brand_id, name) VALUES ($1, $1)`, [brand]);

  const asset = async (localPath: string, contentType: string): Promise<string> =>
    (
      await q<{ id: string }>(
        `INSERT INTO brand_assets (brand_id, tier, local_path, content_hash, content_type)
         VALUES ($1, 'manual_url', $2, $3, $4) RETURNING id`,
        [brand, localPath, randomUUID(), contentType],
      )
    )[0]!.id;
  const icon = (id: string): Promise<Obs> => call("GET", `/v1/brands/${brand}/assets/${id}/icon`);
  const notServed = (o: Obs): string | null => (o.text.includes(SENTINEL) ? "served a file from outside the assets root" : null);

  record(G, "brand asset: SVG containing <script>", await icon(await asset(`${brand}/t/icon.svg`, "image/svg+xml")), {
    status: 200,
    also: (o) =>
      !o.contentType.startsWith("image/svg+xml")
        ? `content-type ${o.contentType} (an <img> needs image/svg+xml)`
        : o.headers.get("x-content-type-options") !== "nosniff"
          ? "no nosniff"
          : !/sandbox/.test(o.headers.get("content-security-policy") ?? "")
            ? "no CSP sandbox — script would run when the URL is opened directly"
            : null,
  });
  record(G, "brand asset: PNG, relative path", await icon(await asset(`${brand}/t/pixel.png`, "image/png")), {
    status: 200,
    also: (o) => (o.contentType.startsWith("image/png") ? null : `content-type ${o.contentType}`),
  });
  record(G, "brand asset: PNG, absolute path inside the root", await icon(await asset(path.join(BRAND_ROOT, brand, "t", "pixel.png"), "image/png")), {
    status: 200,
  });
  record(G, "brand asset: absolute path OUTSIDE the root", await icon(await asset(secret, "text/plain")), {
    status: 404,
    type: "not-found",
    also: notServed,
  });
  record(G, "brand asset: ../ path out of the root", await icon(await asset(`../outside/secret.txt`, "image/png")), {
    status: 404,
    type: "not-found",
    also: notServed,
  });
  record(G, "brand asset: symlink inside the root → outside", await icon(await asset(`${brand}/t/link.png`, "image/png")), {
    status: 404,
    type: "not-found",
    also: notServed,
  });
  record(G, "brand asset: row says content_type text/html", await icon(await asset(`${brand}/t/page.html`, "text/html")), {
    status: 200,
    also: (o) =>
      o.contentType.startsWith("text/html")
        ? "served as text/html on the app's origin"
        : /attachment/.test(o.headers.get("content-disposition") ?? "")
          ? null
          : "not an attachment",
  });
  record(G, "brand asset: 404 body names no server path", await icon(await asset(`${brand}/t/missing.png`, "image/png")), {
    status: 404,
    type: "not-found",
    also: (o) => (o.text.includes(BRAND_ROOT) ? "404 detail discloses the absolute path on disk" : null),
  });

  // A file that passes the containment check but cannot be opened used
  // to end the process (an unhandled stream 'error'). Root can open
  // anything, so the case only exists for an ordinary user.
  if (process.getuid?.() !== 0) {
    const locked = path.join(BRAND_ROOT, brand, "t", "locked.png");
    await writeFile(locked, PNG);
    await chmod(locked, 0o000);
    record(G, "brand asset: file exists but cannot be opened", await icon(await asset(`${brand}/t/locked.png`, "image/png")), {
      status: 500,
      type: "internal",
      also: (o) => (o.headers.get("cache-control") ? "the error kept the image's Cache-Control" : null),
    });
    await chmod(locked, 0o600);
    record(G, "…and the server is still up", await call("GET", "/health"), { status: 200 });
  }

  // The two routes that revalidate. A 304 tells the browser to keep the
  // headers it stored, so (a) the 304 itself carries the sandbox, and
  // (b) the ETag is not the bare content hash it was before the sandbox
  // existed — a copy cached back then must be fetched again, not kept.
  const sandboxed = (o: Obs): string | null =>
    o.headers.get("x-content-type-options") !== "nosniff"
      ? "no nosniff"
      : !/sandbox/.test(o.headers.get("content-security-policy") ?? "")
        ? "no CSP sandbox"
        : null;
  const iconHash = createHash("sha256").update(SVG).digest("hex");
  const iconAsset = (
    await q<{ id: string }>(
      `INSERT INTO brand_assets (brand_id, tier, local_path, content_hash, content_type)
       VALUES ($1, 'manual_url', $2, $3, 'image/svg+xml') RETURNING id`,
      [brand, `${brand}/t/icon.svg`, iconHash],
    )
  )[0]!.id;
  await q(`UPDATE brands SET preferred_asset_id = $2 WHERE brand_id = $1`, [brand, iconAsset]);
  const iconUrl = `/v1/brands/${brand}/icon`;
  const fresh = await call("GET", iconUrl);
  const iconTag = fresh.headers.get("etag") ?? "";
  record(G, "GET /v1/brands/:id/icon  (SVG)", fresh, {
    status: 200,
    also: (o) => sandboxed(o) ?? (iconTag && iconTag !== `"${iconHash}"` ? null : `ETag is ${iconTag || "(missing)"} — the bare content hash`),
  });
  record(G, "…If-None-Match: <its ETag>", await call("GET", iconUrl, { headers: { "If-None-Match": iconTag } }), {
    status: 304,
    also: sandboxed,
  });
  record(G, "…If-None-Match: W/<its ETag>  (weakened by a proxy)", await call("GET", iconUrl, { headers: { "If-None-Match": `W/${iconTag}` } }), {
    status: 304,
    also: sandboxed,
  });
  record(G, "…If-None-Match: <bare content hash>  (cached before the sandbox)", await call("GET", iconUrl, { headers: { "If-None-Match": `"${iconHash}"` } }), {
    status: 200,
    also: sandboxed,
  });

  await q(`UPDATE brands SET preferred_asset_id = $2 WHERE brand_id = $1`, [brand, await asset(secret, "image/png")]);
  record(G, "GET /v1/brands/:id/icon  preferred asset points outside", await call("GET", `/v1/brands/${brand}/icon`), {
    status: 404,
    type: "not-found",
    also: notServed,
  });

  // Product assets share the code path; one traversal case each way.
  const prod = await call("POST", "/v1/products", {
    json: { product_key: `check-file-${NONCE}`, canonical_name: `Check file ${NONCE}`, item_class: "other" },
  });
  const pid: string = prod.json?.id;
  const pHash = createHash("sha256").update(PNG).digest("hex");
  await mkdir(path.join(PRODUCT_ROOT, pid), { recursive: true });
  await writeFile(path.join(PRODUCT_ROOT, pid, "pixel.png"), PNG);
  const pGood = (
    await q<{ id: string }>(
      `INSERT INTO product_assets (product_id, tier, local_path, content_hash, content_type)
       VALUES ($1, 'manual_seed', $2, $3, 'image/png') RETURNING id`,
      [pid, `${pid}/pixel.png`, pHash],
    )
  )[0]!.id;
  await q(`UPDATE products SET preferred_asset_id = $2 WHERE id = $1`, [pid, pGood]);
  const imageUrl = `/v1/products/${pid}/image`;
  const pFresh = await call("GET", imageUrl);
  const pTag = pFresh.headers.get("etag") ?? "";
  record(G, "GET /v1/products/:id/image", pFresh, {
    status: 200,
    also: (o) => sandboxed(o) ?? (o.contentType.startsWith("image/png") ? null : `content-type ${o.contentType}`),
  });
  record(G, "…If-None-Match: <its ETag>", await call("GET", imageUrl, { headers: { "If-None-Match": pTag } }), {
    status: 304,
    also: sandboxed,
  });
  record(G, "…If-None-Match: <bare content hash>  (cached before the sandbox)", await call("GET", imageUrl, { headers: { "If-None-Match": `"${pHash}"` } }), {
    status: 200,
    also: sandboxed,
  });
  const pAsset = (
    await q<{ id: string }>(
      `INSERT INTO product_assets (product_id, tier, local_path, content_hash, content_type)
       VALUES ($1, 'manual_seed', $2, $3, 'image/png') RETURNING id`,
      [pid, secret, randomUUID()],
    )
  )[0]!.id;
  record(G, "product asset: absolute path OUTSIDE the root", await call("GET", `/v1/products/${pid}/assets/${pAsset}/image`), {
    status: 404,
    type: "not-found",
    also: notServed,
  });
  await q(`UPDATE products SET preferred_asset_id = $2 WHERE id = $1`, [pid, pAsset]);
  record(G, "GET /v1/products/:id/image  preferred asset points outside", await call("GET", `/v1/products/${pid}/image`), {
    status: 404,
    type: "not-found",
    also: notServed,
  });

  // Place photo: the cache lives under <uploads>/places.
  const gpid = `check-${NONCE}`;
  const place = (
    await q<{ id: string }>(
      `INSERT INTO places (google_place_id, formatted_address, lat, lng, source)
       VALUES ($1, 'nowhere', 0, 0, 'check') RETURNING id`,
      [gpid],
    )
  )[0]!.id;
  await mkdir(path.join(UPLOADS, "places", gpid), { recursive: true });
  await writeFile(path.join(UPLOADS, "places", gpid, "0.png"), PNG);
  await q(
    `INSERT INTO place_photos (place_id, google_photo_name, rank, file_path, mime_type)
     VALUES ($1, 'x', 0, $2, 'image/png'), ($1, 'y', 1, $3, 'image/jpeg')`,
    [place, path.join(UPLOADS, "places", gpid, "0.png"), secret],
  );
  record(G, "place photo: absolute path inside <uploads>/places", await call("GET", `/v1/places/${place}/photos/0/content`), {
    status: 200,
    also: (o) => (o.contentType.startsWith("image/png") ? null : `content-type ${o.contentType}`),
  });
  record(G, "place photo: absolute path OUTSIDE it", await call("GET", `/v1/places/${place}/photos/1/content`), {
    status: 404,
    type: "not-found",
    also: notServed,
  });

  // Merchant photo resolves the same rows through merchants.place_id.
  // (Push the good photo behind the bad one so the bad one is "first".)
  const mBrand = `check-m-${NONCE}`;
  await q(`UPDATE place_photos SET rank = 10 WHERE place_id = $1 AND rank = 0`, [place]);
  await q(`INSERT INTO brands (brand_id, name) VALUES ($1, $1)`, [mBrand]);
  const merchant = (
    await q<{ id: string }>(
      `INSERT INTO merchants (workspace_id, brand_id, canonical_name, place_id)
       VALUES ($1, $2, $2, $3) RETURNING id`,
      [SEED_WORKSPACE_ID, mBrand, gpid],
    )
  )[0]!.id;
  record(G, "merchant photo: first photo's path is OUTSIDE the cache", await call("GET", `/v1/merchants/${merchant}/photo`), {
    status: 404,
    type: "not-found",
    also: notServed,
  });

  // Static map: the cache directory is named after `google_place_id`.
  // (With no Google key a well-named place answers 503 — the id group
  // has that case — so a 404 here is the directory check, not the key.)
  const mapEscape = `escaped-map-${NONCE}`;
  const evilPlace = (
    await q<{ id: string }>(
      `INSERT INTO places (google_place_id, formatted_address, lat, lng, source)
       VALUES ($1, 'nowhere', 1, 1, 'check') RETURNING id`,
      [`../../${mapEscape}`],
    )
  )[0]!.id;
  const mapOut = await call("GET", `/v1/places/${evilPlace}/map`);
  const mapWrote = await stat(path.join(tmp, mapEscape)).then(
    () => true,
    () => false,
  );
  record(G, "place map: google_place_id is a path out of the cache", mapOut, {
    status: 404,
    type: "not-found",
    also: () => (mapWrote ? "a directory was created outside the place cache" : null),
  });

  // Document content.
  if (uploadedDocId) {
    await q(`UPDATE documents SET file_path = $2 WHERE id = $1`, [uploadedDocId, secret]);
    record(G, "document content: file_path points OUTSIDE uploads", await call("GET", `/v1/documents/${uploadedDocId}/content`), {
      status: 404,
      type: "not-found",
      also: notServed,
    });
  }

  // /rendered and re-extract read the same column. (Re-extract stops at
  // its file preflight here; a document with no linked transaction could
  // not reach the agent in any case.)
  const htmlForm = new FormData();
  htmlForm.append("file", new Blob([`<p>rendered ${NONCE}</p>`], { type: "text/html" }), "page.html");
  htmlForm.append("kind", "other");
  const htmlDoc: string | undefined = (await call("POST", "/v1/documents", { body: htmlForm })).json?.id;
  if (htmlDoc) {
    record(G, "GET /v1/documents/:id/rendered  (file inside uploads)", await call("GET", `/v1/documents/${htmlDoc}/rendered`), {
      status: 200,
      also: (o) => (o.text.includes(`rendered ${NONCE}`) ? null : "did not render the document"),
    });
    for (const [label, stored] of [
      ["absolute path OUTSIDE uploads", secret],
      ["../ path out of uploads", "../outside/secret.txt"],
    ] as const) {
      await q(`UPDATE documents SET file_path = $2 WHERE id = $1`, [htmlDoc, stored]);
      record(G, `document rendered: ${label}`, await call("GET", `/v1/documents/${htmlDoc}/rendered`), {
        status: 404,
        type: "not-found",
        also: notServed,
      });
    }
    record(G, "POST /v1/documents/:id/re-extract  file_path points OUTSIDE uploads", await call("POST", `/v1/documents/${htmlDoc}/re-extract`), {
      status: 422,
      type: "document-file-missing",
    });
  } else {
    rows.push({ group: G, request: "GET /v1/documents/:id/rendered", status: 0, shape: "(fixture: could not upload an HTML document)", expect: "200", ok: false });
  }

  // Upload under a brand id that is a path.
  const evil = `../escaped-${NONCE}`;
  await q(`INSERT INTO brands (brand_id, name) VALUES ($1, $1)`, [evil]);
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "x.png");
  const up = await call("POST", `/v1/brands/${encodeURIComponent(evil)}/assets`, { body: form });
  const wrote = await stat(path.join(tmp, `escaped-${NONCE}`)).then(
    () => true,
    () => false,
  );
  record(G, "POST /v1/brands/..%2Fescaped/assets  (brand id is a path)", up, {
    status: 422,
    type: "validation",
    also: () => (wrote ? "a file was written outside the assets root" : null),
  });
}

// ── Report ─────────────────────────────────────────────────────────────
await db.end();
await new Promise((r) => server.close(r));
await pool.end().catch(() => {});
await rm(tmp, { recursive: true, force: true });

const w = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`\n${w("grp", 6)}${w("request", 66)}${w("got", 5)}${w("body", 58)}${w("want", 28)}`);
console.log("-".repeat(165));
for (const r of rows) {
  console.log(
    `${w(r.group, 6)}${w(r.request, 66)}${w(String(r.status), 5)}${w(r.shape, 58)}${w(r.expect, 28)}${r.ok ? "ok" : "FAIL" + (r.why ? " — " + r.why : "")}`,
  );
}
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} expectations hold` + (failed.length ? `, ${failed.length} FAILED` : ""));
if (REPORT) {
  await writeFile(REPORT, JSON.stringify(rows, null, 2) + "\n");
  console.log(`report: ${REPORT}`);
}
process.exit(failed.length ? 1 : 0);
