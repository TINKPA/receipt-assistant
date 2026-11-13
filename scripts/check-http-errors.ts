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
 *   route unknown URLs and methods → problem+json 404, not Express HTML
 *   body  malformed JSON, oversized bodies, broken multipart → 400 / 413
 *   cur   pagination cursors that this API did not issue → 400
 *   pg    Postgres constraint and data errors → 400 / 409 / 422
 *   500   an unexpected error → fixed sentence + trace id; the detail
 *         goes to the server log under that id, never to the client
 *   idem  Idempotency-Key: replay, conflict, concurrent duplicates,
 *         a key reused after its row expired
 *   etag  document metadata ETag moves when the document does
 *   file  asset endpoints refuse a stored path outside their directory
 *         and never serve SVG / HTML able to run script on our origin
 *
 * It WRITES to the database it is given — products, a transaction,
 * documents, brand / asset / place rows — and never cleans them up.
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
import { mkdtemp, mkdir, rm, symlink, writeFile, stat } from "node:fs/promises";
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
    ["GET", `/v1/ingests/${BAD}`],
    ["POST", `/v1/ingests/${BAD}/retry`],
    ["GET", `/v1/places/${BAD}`],
    ["PATCH", `/v1/places/${BAD}`],
    ["POST", `/v1/places/${BAD}/re-derive`],
    ["POST", `/v1/places/${BAD}/refresh`],
    ["GET", `/v1/places/${BAD}/map`],
    ["GET", `/v1/places/${BAD}/photos/0/content`],
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
  mini.use(problemModule.problemHandler);
  const miniServer = mini.listen(0, "127.0.0.1");
  await new Promise((r) => miniServer.once("listening", r));
  const MINI = `http://127.0.0.1:${(miniServer.address() as AddressInfo).port}`;
  const hit = (name: string): Promise<Obs> => call("GET", `/throw/${name}`, { base: MINI });
  const noSecret = (o: Obs): string | null =>
    /hunter2|secret_|credentials/.test(o.text) ? "body carries the query, a parameter or a path" : null;

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
      ["unique", 409, "conflict", (o) => (o.json?.constraint === "owned_items_tx_item_instance_uq" ? null : "constraint name missing")],
      ["fk_insert", 422, "invalid-reference"],
      ["fk_delete", 409, "still-referenced"],
      ["check", 422, "constraint-violation"],
      ["trigger", 422, "constraint-violation", (o) => (/do not balance/.test(o.json?.detail ?? "") ? null : "trigger's own sentence was dropped")],
      ["not_null", 422, "constraint-violation"],
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
  await new Promise((r) => miniServer.close(r));
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

  // Document content.
  if (uploadedDocId) {
    await q(`UPDATE documents SET file_path = $2 WHERE id = $1`, [uploadedDocId, secret]);
    record(G, "document content: file_path points OUTSIDE uploads", await call("GET", `/v1/documents/${uploadedDocId}/content`), {
      status: 404,
      type: "not-found",
      also: notServed,
    });
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
