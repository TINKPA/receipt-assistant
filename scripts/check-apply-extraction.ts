/**
 * check-apply-extraction.ts — the server applier (`src/ingest/apply/`)
 * against a real Postgres: every branch of the apply written and read back
 * (wave 1, P2; docs/server-writer.md, "applyExtraction").
 *
 * WHY THIS EXISTS
 *
 * Under `EXTRACTION_WRITER=server_apply` this code is the only writer of
 * an ingested receipt. `check-apply-decide` proves the pure half (what a
 * record should become); this proves the writes: that each branch puts
 * exactly the rows it should in one transaction, closes the ingest and
 * finishes the run in that same transaction, and that a failure, a
 * fenced-out run or a deleted target leaves nothing behind.
 *
 * WHAT IT DOES
 *
 * Each fixture is a synthetic record (no real merchant, amount, card,
 * address or identifier), validated by `validateExtraction`, stored by
 * `recordExtraction` (T1) and applied by `applyExtraction` (T2) for a
 * document, ingest and run it stages itself, as the worker's claim would.
 * It then asserts the outcome, the ingest close, the run finish, the rows
 * written (and that no other table changed: counts of every ledger and
 * catalog table, before and after), the events, the metadata key set and
 * the per-currency balance. The fixtures:
 *
 *   purchase (two-level lines, a product_key twice) · refund with
 *   refund_of · refund whose refund_of is ambiguous · income retiring a
 *   sold item · income refused by the two-instance guard · owned items,
 *   quantity 2 · points + cash (points account under Assets) · tenders:
 *   a debit card purchase and its refund (Checking), a gift card or app
 *   balance (Cash), a mixed tender (Credit Card, warned and flagged),
 *   points + cash on a debit card · JPY and EUR
 *   (the post-commit FX pass, rates from a seeded cache) · attach by
 *   identifier · attach by the hard tuple · attach refused: not a
 *   candidate · attach refused: target deleted while the apply waited on
 *   its lock · attach refused: other direction · distinct · uncertain ·
 *   unsupported (text stamped) · statement (recorded, not booked) ·
 *   Message-ID duplicate (and one whose transaction was deleted) · parties
 *   (channel defaulted, line-level maker) · cached place · uncached place
 *   from a supplied envelope, unprojectable, unfetchable · extras
 *   colliding with metadata keys · missing fence (and a stale run's) ·
 *   invalid JSON · a repair round · a repair round whose spawn failed ·
 *   an identifier match with another total (booked, flagged) · a
 *   document hard-deleted between T1 and T2, and before T1 · one
 *   soft-deleted during the apply · characters Postgres cannot store · a
 *   Message-ID copy applied while this run read (linked under the lock) ·
 *   double apply and a stale run (fenced) · a missing
 *   account · an apply failing half-way (nothing left) and one retried
 *   past a serialization failure · re-apply of a stored record · dry run
 *   · uncached place from Google (only with GOOGLE_MAPS_API_KEY and
 *   CHECK_APPLY_GOOGLE_PLACE_ID set in this process's environment).
 *
 * Nothing touches the network otherwise: every place fetch is a supplied
 * envelope or a refusal, and FX rates come from `fx_rates` rows the script
 * writes (`FX_API_BASE` points at a closed local port).
 *
 * The database: `--db` is required and never read from DATABASE_URL, and
 * `--disposable` confirms it is a throwaway (`docker run … postgres:17`).
 * The script migrates it, then works in two workspaces of its own, new on
 * every run, and leaves them (and two fx_rates rows) behind so
 * `check-ledger` and `check-projection-replay --records` can be pointed
 * at the result. Never give it the ledger's URL.
 *
 *   npx tsx scripts/check-apply-extraction.ts --disposable \
 *     --db=postgresql://postgres:postgres@127.0.0.1:<port>/receipts [--verbose]
 */
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DB_URL = arg("db");
const VERBOSE = process.argv.includes("--verbose");
if (!DB_URL || !process.argv.includes("--disposable")) {
  console.error("usage: check-apply-extraction.ts --disposable --db=<url of a throwaway Postgres> [--verbose]");
  process.exit(2);
}
// The applier logs every failure in full, as it should in the server. The
// fixtures provoke failures on purpose, so the server's own log lines are
// counted and shown only with --verbose.
let serverLines = 0;
if (!VERBOSE) {
  const quiet = (orig: (...a: unknown[]) => void, all: boolean) => (...a: unknown[]) => {
    if (all || (typeof a[0] === "string" && /^\[(apply|fx|points)\]/.test(a[0]))) serverLines += 1;
    else orig(...a);
  };
  console.error = quiet(console.error.bind(console), true);
  console.warn = quiet(console.warn.bind(console), true);
  console.log = quiet(console.log.bind(console), false);
}
// What this process was started with, before any module reads a .env.
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";
const LIVE_PLACE_ID = process.env.CHECK_APPLY_GOOGLE_PLACE_ID ?? "";
// Every session of this script, the applier's included, commits without
// waiting for the flush: a throwaway database, and what one session sees of
// another's commit does not change. It is what keeps the run in seconds on
// a container whose fsync takes tens of milliseconds.
const FAST_URL = (() => {
  const u = new URL(DB_URL);
  u.searchParams.set("options", "-c synchronous_commit=off");
  return u.toString();
})();
process.env.DATABASE_URL = FAST_URL;
process.env.FX_API_BASE = "http://127.0.0.1:9/no-fx-source";

const started = Date.now();
const { runMigrations } = await import("../src/db/migrate.js");
await runMigrations(DB_URL);
const migratedMs = Date.now() - started;
const { pool: appPool, db: appDb } = await import("../src/db/client.js");
const A = await import("../src/ingest/apply/index.js");
const { validateExtraction, renderRepairRequest, diffRepair, appendWarnings, noteRepairRound, validateArtefact } =
  await import("../src/ingest/contract/validate.js");
const { parseArtefact } = await import("../src/ingest/contract/artefact.js");
const { APPLIER_METADATA_KEYS, EXTRACTION_STAMP_KEYS } = await import("../src/ingest/apply/metadata.js");
const { readLedgerFingerprint, diffFingerprints } = await import("../src/ingest/apply/fingerprint.js");
const { RECORD_PROMPT_VERSION } = await import("../src/ingest/prompt-contract.js");
const { verdictAbout } = await import("../src/reconcile/dedup.js");
const { GooglePlacesApiKeyMissing } = await import("../src/google/places-fetch.js");
type ApplyResult = Awaited<ReturnType<typeof A.applyExtraction>>;
type RecordResult = Awaited<ReturnType<typeof A.recordExtraction>>;
type ValidationOutcome = ReturnType<typeof validateExtraction>;
type PlacePrefetch = NonNullable<Awaited<ReturnType<typeof A.prefetchPlace>>>;
type ServerSource = NonNullable<Parameters<typeof A.applyExtraction>[0]["source"]>;

const pool = new pg.Pool({ connectionString: FAST_URL, max: 4 });
const q = async <T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, params)).rows as T[];
const one = async <T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T> => {
  const rows = await q<T>(text, params);
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}: ${text.slice(0, 80)}`);
  return rows[0]!;
};
const json = (v: unknown) => JSON.stringify(v);
/** JSON with object keys sorted at every level: jsonb does not keep the
 *  order an object was written in. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

// ── Checks and fixtures ────────────────────────────────────────────────

let checks = 0;
const failures: string[] = [];
const fixtures: { name: string; ok: boolean; skipped?: string }[] = [];
let current = "";

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  const full = `${current}: ${name}`;
  if (!ok) failures.push(`${full}${detail ? ` — ${detail}` : ""}`);
  if (VERBOSE || !ok) console.log(`${ok ? "ok  " : "FAIL"} ${full}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function fixture(name: string, fn: () => Promise<void>): Promise<void> {
  current = name;
  const before = failures.length;
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    check("ran to the end", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  const ok = failures.length === before;
  fixtures.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${Date.now() - t0} ms)`);
}

function skip(name: string, why: string): void {
  fixtures.push({ name, ok: true, skipped: why });
  console.log(`skip  ${name} (${why})`);
}

// ── Fixture data (synthetic) ───────────────────────────────────────────

const N = randomBytes(4).toString("hex");
const UPLOAD = new Date("2026-06-15T12:00:00Z");
const DATE = "2026-06-10";
const STATS = { modelObserved: "claude-sonnet-5", turns: 6, toolCalls: 3 };
type Rec = Record<string, any>;

const slug = (s: string) => `chk-${N}-${s}`;

function receipt(o: {
  brand: string;
  total: number;
  payee?: string;
  currency?: string;
  date?: string;
  at?: string | null;
  ids?: Rec;
  card?: string | null;
  items?: Rec[];
  category?: string;
  classification?: string;
  flow?: string;
}): Rec {
  const payee = o.payee ?? `Example ${o.brand}`;
  return {
    contract_version: 1,
    classification: o.classification ?? "receipt_image",
    source_used: o.classification === "receipt_email" ? "email_body" : "image",
    facts: {
      flow: o.flow ?? "purchase",
      occurred_on: o.date ?? DATE,
      occurred_at: o.at ?? null,
      payee,
      payee_as_printed: payee.toUpperCase(),
      payee_source: "printed",
      total_minor: o.total,
      currency: o.currency ?? "USD",
    },
    payment:
      o.card === null ? { method: "unknown" } : { method: "card", card_last4: o.card ?? "0000", card_network: "Visa" },
    identifiers: o.ids ?? {},
    merchant: { canonical_name: payee, brand_id: slug(o.brand), category: o.category ?? "Shopping" },
    items: o.items ?? [
      {
        line_no: 1,
        raw_name: "ITEM",
        line_total_minor: o.total,
        item_class: "consumable",
        confidence: "high",
        product_key: `${slug(o.brand)}-item`,
      },
    ],
    audit: {
      ocr_raw_payee: payee.toUpperCase(),
      correction_applied: false,
      date_candidates: ["06/10/2026"],
      chosen_date_reason: "printed in the header",
      year_sanity_ok: true,
    },
  };
}

function validate(raw: Rec, receiptText: string | null = "EXAMPLE\nTOTAL"): ValidationOutcome {
  const out = validateExtraction(raw, { uploadedAt: UPLOAD, receiptText });
  if (out.status !== "valid") throw new Error(`fixture record refused by the validator: ${json(out.report.errors)}`);
  return out;
}

const refuseFetch = async (): Promise<never> => {
  throw new GooglePlacesApiKeyMissing();
};

// ── Workspaces, staging and counts ─────────────────────────────────────

interface Ws {
  id: string;
  ownerId: string;
  acct: (name: string) => string;
}

async function makeWorkspace(label: string, omit: string[] = []): Promise<Ws> {
  const ownerId = randomUUID();
  const id = randomUUID();
  await q(`INSERT INTO users (id, email) VALUES ($1, $2)`, [ownerId, `check-${ownerId}@example.invalid`]);
  await q(`INSERT INTO workspaces (id, owner_id, name, base_currency) VALUES ($1, $2, $3, 'USD')`, [id, ownerId, label]);
  const chart: [string, string, string | null, string[]][] = [
    ["Assets", "asset", null, ["Cash", "Checking", "Savings"]],
    ["Liabilities", "liability", null, ["Credit Card"]],
    ["Equity", "equity", null, ["Opening Balance"]],
    ["Income", "income", null, ["Salary", "Other"]],
    ["Expenses", "expense", null, ["Food & Drinks", "Transportation", "Shopping", "Travel", "Entertainment", "Health", "Services"]],
  ];
  const ids = new Map<string, string>();
  for (const [root, type, , children] of chart) {
    const rootId = randomUUID();
    ids.set(root, rootId);
    await q(`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES ($1, $2, $3, $4, 'USD')`, [rootId, id, root, type]);
    for (const c of children) {
      if (omit.includes(c)) continue;
      const cid = randomUUID();
      ids.set(c, cid);
      await q(`INSERT INTO accounts (id, workspace_id, parent_id, name, type, currency) VALUES ($1, $2, $3, $4, $5, 'USD')`, [
        cid,
        id,
        rootId,
        c,
        type,
      ]);
    }
  }
  return {
    id,
    ownerId,
    acct: (name) => {
      const v = ids.get(name);
      if (!v) throw new Error(`no account ${name}`);
      return v;
    },
  };
}

interface Stage {
  workspaceId: string;
  ingestId: string;
  runId: string;
  documentId: string;
}

/** A document, its ingest `processing` and a `running` server_apply run
 *  holding the fence: the state the worker's claim (T0) leaves. */
async function stage(ws: Ws, o: { kind?: string; mime?: string; documentId?: string } = {}): Promise<Stage> {
  const documentId = o.documentId ?? randomUUID();
  const ingestId = randomUUID();
  const runId = randomUUID();
  const path = `check/${N}/${documentId}`;
  if (!o.documentId) {
    await q(
      `INSERT INTO documents (id, workspace_id, kind, file_path, mime_type, sha256) VALUES ($1, $2, $3, $4, $5, $6)`,
      [documentId, ws.id, o.kind ?? "receipt_image", path, o.mime ?? "image/jpeg", randomBytes(32).toString("hex")],
    );
  }
  await q(
    `INSERT INTO ingests (id, workspace_id, filename, mime_type, file_path, status, document_id)
     VALUES ($1, $2, 'check-fixture', $3, $4, 'processing', $5)`,
    [ingestId, ws.id, o.mime ?? "image/jpeg", path, documentId],
  );
  await newRun(ws, ingestId, documentId, runId);
  return { workspaceId: ws.id, ingestId, runId, documentId };
}

async function newRun(ws: Ws, ingestId: string, documentId: string, runId = randomUUID()): Promise<string> {
  await q(
    `INSERT INTO agent_runs (id, workspace_id, kind, status, ingest_id, document_id, trigger, writer, session_id,
                             prompt_version, prompt_git_sha, model_requested, started_at)
     VALUES ($1, $2, 'ingest', 'running', $3, $4, 'upload', 'server_apply', $5, $6, 'check', 'claude-sonnet-5', now())`,
    [runId, ws.id, ingestId, documentId, randomUUID(), RECORD_PROMPT_VERSION],
  );
  await q(`UPDATE ingests SET current_run_id = $1 WHERE id = $2`, [runId, ingestId]);
  return runId;
}

const WS_TABLES = [
  "transactions",
  "postings",
  "transaction_items",
  "products",
  "owned_items",
  "transaction_parties",
  "transaction_events",
  "merchants",
  "accounts",
  "document_extractions",
];
const GLOBAL_TABLES = ["brands", "places", "place_snapshots", "derivation_events", "reconcile_proposals"];

async function counts(ws: Ws): Promise<Record<string, number>> {
  // One round trip: the fixtures take a snapshot around every apply.
  const cols = [
    ...WS_TABLES.map((t) => `(SELECT count(*) FROM ${t} WHERE workspace_id = $1)::int AS ${t}`),
    ...GLOBAL_TABLES.map((t) => `(SELECT count(*) FROM ${t})::int AS ${t}`),
    `(SELECT count(*) FROM document_links dl JOIN documents d ON d.id = dl.document_id WHERE d.workspace_id = $1)::int AS document_links`,
  ];
  return one<Record<string, number>>(`SELECT ${cols.join(", ")}`, [ws.id]);
}

/** Snapshot now; `expect` later compares the change table by table. */
async function watch(ws: Ws): Promise<(expected: Record<string, number>) => Promise<void>> {
  const before = await counts(ws);
  return async (expected) => {
    const after = await counts(ws);
    const diff: Record<string, number> = {};
    for (const k of Object.keys(after)) if (after[k] !== before[k]) diff[k] = after[k]! - before[k]!;
    const want = Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== 0));
    const sort = (o: Record<string, number>) => json(Object.fromEntries(Object.entries(o).sort()));
    check("rows written, and nothing else", sort(diff) === sort(want), `got ${sort(diff)}, expected ${sort(want)}`);
  };
}

// ── Running a record through T1 and T2 ─────────────────────────────────

interface Ran {
  st: Stage;
  outcome: ValidationOutcome;
  rec: RecordResult;
  res: ApplyResult;
}

async function ingest(
  ws: Ws,
  raw: Rec,
  o: {
    st?: Stage;
    receiptText?: string | null;
    source?: ServerSource | null;
    place?: PlacePrefetch | null;
    placeFetcher?: (id: string) => Promise<any>;
    phash?: string[];
    kind?: string;
    mime?: string;
  } = {},
): Promise<Ran> {
  const receiptText = o.receiptText === undefined ? "EXAMPLE\nTOTAL" : o.receiptText;
  const outcome = validate(raw, receiptText);
  const st = o.st ?? (await stage(ws, { kind: o.kind, mime: o.mime }));
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: receiptText, final: true, stats: STATS });
  if (!rec.extractionId) throw new Error("T1 stored no record");
  const res = await A.applyExtraction({
    ...st,
    extractionId: rec.extractionId,
    source: o.source ?? null,
    phashTransactionIds: o.phash ?? [],
    stats: STATS,
    ...(o.place !== undefined ? { place: o.place } : { placeFetcher: o.placeFetcher ?? refuseFetch }),
  });
  return { st, outcome, rec, res };
}

/** The common assertions on a run that wrote one transaction. */
async function checkWritten(r: Ran, name = "written"): Promise<string> {
  check(`${name}: outcome written`, r.res.outcome === "written", json({ outcome: r.res.outcome, error: r.res.error }));
  const txId = r.res.transactionIds[0];
  if (!txId) throw new Error("no transaction id");
  const ing = await one(`SELECT status, classification, produced, error FROM ingests WHERE id = $1`, [r.st.ingestId]);
  check(`${name}: ingest done`, ing.status === "done" && ing.error === null, json(ing));
  check(
    `${name}: produced names the transaction, the document and the record`,
    canon(ing.produced) ===
      canon({ receipt_ids: [], transaction_ids: [txId], document_ids: [r.st.documentId], extraction_ids: [r.rec.extractionId] }),
    json(ing.produced),
  );
  const run = await one(
    `SELECT status, outcome, error_class, extraction_id, model_observed, apply_report FROM agent_runs WHERE id = $1`,
    [r.st.runId],
  );
  check(
    `${name}: run finished written, pointing at the record`,
    run.status === "finished" && run.outcome === "written" && run.error_class === null && run.extraction_id === r.rec.extractionId,
    json(run),
  );
  check(`${name}: run records the model and the branch`, run.model_observed === STATS.modelObserved && run.apply_report?.branch === "insert");
  const t = await one(`SELECT status, source_ingest_id, created_by, metadata, merchant_id, deleted_at FROM transactions WHERE id = $1`, [txId]);
  check(`${name}: posted, from this ingest`, t.status === "posted" && t.source_ingest_id === r.st.ingestId && t.deleted_at === null);
  const keys = Object.keys(t.metadata);
  check(
    `${name}: metadata keys are the applier's fixed set`,
    keys.every((k) => (APPLIER_METADATA_KEYS as readonly string[]).includes(k)) && !("items" in t.metadata),
    keys.join(","),
  );
  const ex = t.metadata.extraction ?? {};
  check(
    `${name}: extraction stamp has exactly its keys`,
    json(Object.keys(ex).sort()) === json([...EXTRACTION_STAMP_KEYS].sort()),
    json(Object.keys(ex)),
  );
  check(
    `${name}: extraction stamp names the writer, run, record and model`,
    ex.writer === "server_apply" &&
      ex.run_id === r.st.runId &&
      ex.extraction_id === r.rec.extractionId &&
      ex.prompt_version === RECORD_PROMPT_VERSION &&
      ex.model === STATS.modelObserved,
    json(ex),
  );
  const off = await q(
    `SELECT currency FROM postings WHERE transaction_id = $1 GROUP BY currency HAVING sum(amount_minor) <> 0`,
    [txId],
  );
  check(`${name}: postings balance in every currency`, off.length === 0, json(off));
  const fx = await q(`SELECT 1 FROM postings WHERE transaction_id = $1 AND (fx_rate IS NOT NULL OR amount_base_minor <> amount_minor)`, [txId]);
  check(`${name}: base = native and no fx_rate until the post-commit passes`, fx.length === 0);
  const ev = await q(`SELECT event_type, payload, actor_id FROM transaction_events WHERE transaction_id = $1`, [txId]);
  const created = ev.filter((e) => e.event_type === "created");
  check(
    `${name}: one created event with the run's ids`,
    created.length === 1 &&
      created[0]!.payload.ingest_id === r.st.ingestId &&
      created[0]!.payload.run_id === r.st.runId &&
      created[0]!.payload.extraction_id === r.rec.extractionId &&
      json(created[0]!.payload.document_ids) === json([r.st.documentId]),
    json(created),
  );
  const link = await q(`SELECT 1 FROM document_links WHERE document_id = $1 AND transaction_id = $2`, [r.st.documentId, txId]);
  check(`${name}: document linked`, link.length === 1);
  const doc = await one(`SELECT source_ingest_id FROM documents WHERE id = $1`, [r.st.documentId]);
  check(`${name}: document stamped with the ingest`, doc.source_ingest_id === r.st.ingestId);
  return txId;
}

const postingsOf = async (txId: string) =>
  q<{ account: string; amount_minor: string; currency: string }>(
    `SELECT a.name AS account, p.amount_minor::text AS amount_minor, p.currency
       FROM postings p JOIN accounts a ON a.id = p.account_id
      WHERE p.transaction_id = $1 ORDER BY p.currency, p.amount_minor DESC`,
    [txId],
  );

// ── The fixtures ───────────────────────────────────────────────────────

const W = await makeWorkspace("check-apply-extraction");
const W2 = await makeWorkspace("check-apply-extraction (no Savings)", ["Savings"]);
console.log(`# check-apply-extraction  workspace ${W.id}  nonce ${N}  (migrations ${migratedMs} ms)\n`);

// A small seed: a purchase applied normally, to be a candidate later.
async function seed(raw: Rec, o: Parameters<typeof ingest>[2] = {}): Promise<string> {
  const r = await ingest(W, raw, o);
  if (r.res.outcome !== "written") throw new Error(`seed not written: ${json(r.res)}`);
  return r.res.transactionIds[0]!;
}

let purchaseRun: Ran | null = null;

await fixture("purchase: two-level lines, one product_key twice", async () => {
  const expect = await watch(W);
  const brand = "diner";
  const r = await ingest(
    W,
    receipt({
      brand,
      total: 1850,
      category: "Food & Drinks",
      items: [
        { line_no: 1, raw_name: "COMBO MEAL", line_total_minor: 800, item_class: "food_drink", food_kind: "restaurant_dish", confidence: "high", product_key: `${slug(brand)}-combo`, product_merchant_exclusive: true },
        { line_no: 2, parent_line_no: 1, raw_name: "ADD CHEESE", line_total_minor: 100, item_class: "food_drink", confidence: "high", product_key: `${slug(brand)}-cheese`, product_merchant_exclusive: true },
        { line_no: 3, raw_name: "COMBO MEAL", line_total_minor: 800, item_class: "food_drink", food_kind: "restaurant_dish", confidence: "high", product_key: `${slug(brand)}-combo`, product_merchant_exclusive: true },
        { line_no: 4, raw_name: "TAX", line_total_minor: 150, item_class: "other", confidence: "high", line_type: "tax" },
      ],
    }),
  );
  purchaseRun = r;
  const txId = await checkWritten(r);
  const ps = await postingsOf(txId);
  check(
    "expense and Credit Card legs",
    json(ps) === json([{ account: "Food & Drinks", amount_minor: "1850", currency: "USD" }, { account: "Credit Card", amount_minor: "-1850", currency: "USD" }]),
    json(ps),
  );
  const items = await q(
    `SELECT line_no, parent_line_no, extraction_run, extraction_version, extraction_id, product_id, line_type
       FROM transaction_items WHERE transaction_id = $1 ORDER BY line_no`,
    [txId],
  );
  check("four lines, run 1, version 4.0, pointing at the record", items.length === 4 &&
    items.every((i) => i.extraction_run === 1 && i.extraction_version === RECORD_PROMPT_VERSION && i.extraction_id === r.rec.extractionId), json(items));
  check("the add-on keeps its parent", items[1]?.parent_line_no === 1);
  check("both combo lines share one product", items[0]?.product_id !== null && items[0]?.product_id === items[2]?.product_id);
  check("the tax line has no product", items[3]?.product_id === null && items[3]?.line_type === "tax");
  const combo = await one(`SELECT merchant_id, purchase_count, total_spent_minor::text AS total FROM products WHERE id = $1`, [items[0]!.product_id]);
  const tx = await one(`SELECT merchant_id FROM transactions WHERE id = $1`, [txId]);
  check("a merchant-exclusive product hangs off the merchant", combo.merchant_id === tx.merchant_id);
  check("product statistics over this purchase", combo.purchase_count === 1 && combo.total === "1600", json(combo));
  const party = await q(`SELECT role, display_name, brand_id, transaction_item_id FROM transaction_parties WHERE transaction_id = $1`, [txId]);
  check("a channel party defaulted to the merchant", party.length === 1 && party[0]!.role === "channel" && party[0]!.brand_id === slug(brand), json(party));
  const doc = await one(`SELECT ocr_text, ocr_model_version FROM documents WHERE id = $1`, [r.st.documentId]);
  check("ocr_text is the receipt-text block, stamped with the model", doc.ocr_text === "EXAMPLE\nTOTAL" && doc.ocr_model_version === STATS.modelObserved);
  const brandRow = await one(`SELECT name, user_chose_at FROM brands WHERE brand_id = $1`, [slug(brand)]);
  check("the brand is created with the record's name", brandRow.name === `Example ${brand}` && brandRow.user_chose_at === null);
  const stored = await one(`SELECT status, superseded_at FROM document_extractions WHERE id = $1`, [r.rec.extractionId]);
  check("the record is stored valid and current", stored.status === "valid" && stored.superseded_at === null);
  await expect({
    transactions: 1, postings: 2, document_links: 1, transaction_items: 4, products: 2, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1,
  });
});

await fixture("purchase: an existing real brand name is kept, a slug stub upgraded", async () => {
  const kept = slug("namedbrand");
  const stub = slug("stubbrand");
  await q(`INSERT INTO brands (brand_id, name) VALUES ($1, 'Example Named Brand'), ($2, $2)`, [kept, stub]);
  const a = await ingest(W, receipt({ brand: "namedbrand", total: 1851, payee: "EXAMPLE NAMED BRAND #12" }));
  const b = await ingest(W, receipt({ brand: "stubbrand", total: 1852, payee: "Example Stub Brand" }));
  await checkWritten(a, "named");
  await checkWritten(b, "stub");
  const rows = await q(`SELECT brand_id, name FROM brands WHERE brand_id IN ($1, $2) ORDER BY brand_id`, [kept, stub]);
  check("the real name is not overwritten", rows.find((x) => x.brand_id === kept)?.name === "Example Named Brand", json(rows));
  check("the slug stub gets the record's name", rows.find((x) => x.brand_id === stub)?.name === "Example Stub Brand", json(rows));
  check("the report says the name was kept", a.res.report?.brand?.name_kept === true && b.res.report?.brand?.name_kept === false);
});

await fixture("refund with refund_of", async () => {
  const purchase = await seed(receipt({ brand: "refunds", total: 2500, ids: { order_number: `R-${N}-1` } }));
  const expect = await watch(W);
  const r = await ingest(W, receipt({ brand: "refunds", total: -2500, flow: "refund", ids: { order_number: `R-${N}-1` },
    items: [{ line_no: 1, raw_name: "RETURN ITEM", line_total_minor: -2500, item_class: "consumable", confidence: "high", product_key: `${slug("refunds")}-item` }] }));
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  check("refund_of names the purchase", t.metadata.refund_of === purchase && t.metadata.flow === "refund", json(t.metadata.refund_of));
  const ps = await postingsOf(txId);
  check("the legs are reversed", json(ps.map((p) => [p.account, p.amount_minor])) === json([["Credit Card", "2500"], ["Shopping", "-2500"]]), json(ps));
  check("the purchase was not attached to", r.res.report?.decision?.action === "insert");
  const pLinks = await q(`SELECT 1 FROM document_links WHERE transaction_id = $1`, [purchase]);
  check("the purchase keeps its one document", pLinks.length === 1);
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, transaction_parties: 1, transaction_events: 1, document_extractions: 1 });
});

await fixture("refund whose refund_of is ambiguous (two purchases share the number)", async () => {
  await seed(receipt({ brand: "amb-one", total: 2600, ids: { order_number: `R-${N}-2` } }));
  await seed(receipt({ brand: "amb-two", total: 2601, ids: { order_number: `R-${N}-2` } }));
  const r = await ingest(W, receipt({ brand: "amb-one", total: -2600, flow: "refund", ids: { order_number: `R-${N}-2` },
    items: [{ line_no: 1, raw_name: "RETURN", line_total_minor: -2600, item_class: "consumable", confidence: "high", product_key: `${slug("amb-one")}-item` }] }));
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  check("no refund_of", !("refund_of" in t.metadata));
  check("refund_of_dropped on the apply report", (r.res.report?.warnings ?? []).some((w) => w.rule === "refund_of_dropped"));
});

let ownedTwo: { productKey: string } | null = null;

await fixture("owned items, quantity 2 (and a line that cannot be owned)", async () => {
  const brand = "electronics";
  const expect = await watch(W);
  const r = await ingest(W, receipt({ brand, total: 20000, items: [
    { line_no: 1, raw_name: "HEADPHONES", quantity: 2, unit_price_minor: 9500, line_total_minor: 19000, item_class: "durable", durability_tier: "standard", confidence: "high", product_key: `${slug(brand)}-headphones`, track_as_owned: true },
    { line_no: 2, raw_name: "CABLE", line_total_minor: 1000, item_class: "consumable", confidence: "high", product_key: `${slug(brand)}-cable`, track_as_owned: true },
  ] }));
  const txId = await checkWritten(r);
  const owned = await q(
    `SELECT o.instance_index, o.acquired_on::text AS acquired_on FROM owned_items o JOIN transaction_items ti ON ti.id = o.transaction_item_id
      WHERE ti.transaction_id = $1 ORDER BY o.instance_index`, [txId]);
  check("two instances of the durable line", json(owned) === json([{ instance_index: 1, acquired_on: DATE }, { instance_index: 2, acquired_on: DATE }]), json(owned));
  check("the consumable line is skipped with a warning", (r.res.report?.warnings ?? []).some((w) => w.rule === "owned_items_skipped" && w.path === "items[1].track_as_owned"));
  ownedTwo = { productKey: `${slug(brand)}-headphones` };
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 2, products: 2, owned_items: 2, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1 });
});

function income(o: { brand: string; total: number; sold?: Rec | null }): Rec {
  const r = receipt({ brand: o.brand, total: o.total, flow: "income", category: "Shopping", items: [
    { line_no: 1, raw_name: "BUYBACK", line_total_minor: o.total, item_class: "other", confidence: "high", line_type: "buyback" },
  ] });
  r.income = { deposit_account: "Checking", income_account: "Other" };
  if (o.sold) r.sold_item = o.sold;
  return r;
}

await fixture("income retires the one owned instance it sold", async () => {
  const brand = "camera-shop";
  const key = `${slug(brand)}-camera`;
  await seed(receipt({ brand, total: 45000, items: [
    { line_no: 1, raw_name: "CAMERA", line_total_minor: 45000, item_class: "durable", confidence: "high", product_key: key, track_as_owned: true },
  ] }));
  const before = await one(`SELECT o.id FROM owned_items o JOIN products p ON p.id = o.product_id WHERE p.product_key = $1 AND o.retired_at IS NULL`, [key]);
  const expect = await watch(W);
  const r = await ingest(W, income({ brand: "buyer", total: 30000, sold: { product_key: key, name_as_printed: "USED CAMERA" } }));
  const txId = await checkWritten(r);
  const ps = await postingsOf(txId);
  check("Checking in, Other income out", json(ps.map((p) => [p.account, p.amount_minor])) === json([["Checking", "30000"], ["Other", "-30000"]]), json(ps));
  const o = await one(`SELECT retired_at, condition, notes FROM owned_items WHERE id = $1`, [before.id]);
  check("the instance is retired as sold", o.retired_at !== null && o.condition === "sold" && /sold via/.test(o.notes ?? ""), json(o));
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  check("no owned_items_note", !("owned_items_note" in t.metadata));
  check("the report names the retired instance", r.res.report?.sold_item?.retired_id === before.id);
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1 });
});

await fixture("income: the two-instance guard retires nothing", async () => {
  if (!ownedTwo) throw new Error("needs the quantity-2 fixture");
  const r = await ingest(W, income({ brand: "buyer-two", total: 9000, sold: { product_key: ownedTwo.productKey, name_as_printed: "HEADPHONES" } }));
  const txId = await checkWritten(r);
  const live = await q(`SELECT 1 FROM owned_items o JOIN products p ON p.id = o.product_id WHERE p.product_key = $1 AND o.retired_at IS NULL`, [ownedTwo.productKey]);
  check("both instances stay owned", live.length === 2);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  check("owned_items_note says why", /2 live owned items/.test(t.metadata.owned_items_note ?? ""), json(t.metadata.owned_items_note));
  check("owned_items_skipped on the report", (r.res.report?.warnings ?? []).some((w) => w.rule === "owned_items_skipped" && w.path === "sold_item"));
});

await fixture("points + cash: points account created under Assets", async () => {
  const cur = `CHK${N.toUpperCase()}_PT`;
  const expect = await watch(W);
  const raw = receipt({ brand: "resort", total: 20000, currency: cur, category: "Travel", items: [
    { line_no: 1, raw_name: "AWARD NIGHT", line_total_minor: 20000, currency: cur, item_class: "service", confidence: "high" },
    { line_no: 2, raw_name: "RESORT FEE", line_total_minor: 3500, currency: "USD", item_class: "service", confidence: "high", line_type: "service_fee" },
  ] });
  raw.payment = { method: "points" };
  raw.points = { programme_name: "Example Stay Rewards" };
  raw.cash_component = { amount_minor: 3500, currency: "USD" };
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  const acct = await one(`SELECT id, name, parent_id, subtype, currency FROM accounts WHERE workspace_id = $1 AND subtype = 'points' AND currency = $2`, [W.id, cur]);
  check("the points account has the Assets parent (hole 7)", acct.parent_id === W.acct("Assets") && acct.name === "Example Stay Rewards points", json(acct));
  const ps = await postingsOf(txId);
  check(
    "a points pair and a cash pair",
    json(ps.map((p) => [p.account, p.amount_minor, p.currency])) ===
      json([["Travel", "20000", cur], ["Example Stay Rewards points", "-20000", cur], ["Travel", "3500", "USD"], ["Credit Card", "-3500", "USD"]]),
    json(ps),
  );
  check("the report says the account was created", r.res.report?.accounts?.points_account_created === true);
  await expect({ transactions: 1, postings: 4, document_links: 1, transaction_items: 2, transaction_parties: 1, transaction_events: 1,
    merchants: 1, brands: 1, accounts: 1, document_extractions: 1 });
});

// The owner's tender decisions (November 2026): a debit card draws on
// Checking, a gift card or app balance on Cash, a mixed tender is booked
// whole to Credit Card with a warning on the record and a review flag on
// the transaction.
await fixture("tenders: a debit card purchase and its refund go through Checking", async () => {
  const brand = "tender-debit";
  const order = `T-${N}-1`;
  const debit = { method: "debit_card", card_last4: "0000", as_printed: "US DEBIT ****0000" };
  const p = receipt({ brand, total: 3810, ids: { order_number: order } });
  p.payment = debit;
  const pr = await ingest(W, p);
  const purchase = await checkWritten(pr, "debit purchase");
  check("debit purchase: Checking pays", json((await postingsOf(purchase)).map((x) => [x.account, x.amount_minor])) === json([["Shopping", "3810"], ["Checking", "-3810"]]));
  const pm = (await one(`SELECT metadata FROM transactions WHERE id = $1`, [purchase])).metadata;
  check("debit purchase: mirror_account Checking, the card in the Payment cell", pm.mirror_account === "Checking" && pm.payment_method === "****0000" &&
    pm.card_last4 === "0000" && !("near_dup_check" in pm), json([pm.mirror_account, pm.payment_method, pm.near_dup_check]));
  check("debit purchase: the report names Checking", pr.res.report?.accounts?.mirror === "Checking" && !("flagged_for_review" in (pr.res.report?.accounts ?? {})));

  const expect = await watch(W);
  const r = receipt({ brand, total: -3810, flow: "refund", ids: { order_number: order },
    items: [{ line_no: 1, raw_name: "RETURN ITEM", line_total_minor: -3810, item_class: "consumable", confidence: "high", product_key: `${slug(brand)}-item` }] });
  r.payment = debit;
  const rr = await ingest(W, r);
  const refund = await checkWritten(rr, "debit refund");
  check("debit refund: the money returns to Checking", json((await postingsOf(refund)).map((x) => [x.account, x.amount_minor])) === json([["Checking", "3810"], ["Shopping", "-3810"]]));
  const rm = (await one(`SELECT metadata FROM transactions WHERE id = $1`, [refund])).metadata;
  check("debit refund: refund_of names the purchase", rm.refund_of === purchase && rm.mirror_account === "Checking", json([rm.refund_of, rm.mirror_account]));
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, transaction_parties: 1, transaction_events: 1, document_extractions: 1 });
});

await fixture("tenders: a gift card or app balance goes through Cash", async () => {
  const raw = receipt({ brand: "tender-gift", total: 3820 });
  raw.payment = { method: "gift_card", as_printed: "STORE APP BALANCE" };
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  check("Cash pays", json((await postingsOf(txId)).map((x) => [x.account, x.amount_minor])) === json([["Shopping", "3820"], ["Cash", "-3820"]]));
  const m = (await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId])).metadata;
  check("mirror_account Cash, the tender as printed, no flag", m.mirror_account === "Cash" && m.payment_method === "STORE APP BALANCE" && !("near_dup_check" in m),
    json([m.mirror_account, m.payment_method, m.near_dup_check]));
  check("no mixed_tender warning", !r.outcome.report.warnings.some((w) => w.rule === "mixed_tender"));
});

await fixture("tenders: a mixed tender is booked whole to Credit Card, warned and flagged for review", async () => {
  const expect = await watch(W);
  const raw = receipt({ brand: "tender-mixed", total: 3830 });
  raw.payment = { method: "mixed", as_printed: "CASH 10.00 / VISA 28.30" };
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  check("Credit Card pays the whole total", json((await postingsOf(txId)).map((x) => [x.account, x.amount_minor])) === json([["Shopping", "3830"], ["Credit Card", "-3830"]]));
  const stored = await one(`SELECT validation FROM document_extractions WHERE id = $1`, [r.rec.extractionId]);
  check("the record carries mixed_tender, as money", stored.validation.warnings.some((w: any) => w.rule === "mixed_tender" && w.path === "payment.method" && w.money === true),
    json(stored.validation.warnings));
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  const nd = t.metadata.near_dup_check;
  check("flagged for review, naming no candidate, saying the split was not booked", nd?.flagged_for_review === true && nd?.verdict === "uncertain" &&
    json(nd?.candidate_transaction_ids) === "[]" && !("candidate_transaction_id" in nd) && /split not booked/.test(nd?.reason ?? "") && nd?.decided_by === "applier", json(nd));
  const queue = await q(`SELECT id FROM transactions WHERE id = $1 AND (metadata->'near_dup_check'->>'flagged_for_review')::boolean IS TRUE`, [txId]);
  check("the review queue's predicate lists it", queue.length === 1);
  check("reconcile reads no verdict about any pair from it", verdictAbout({ near_dup_check: nd } as any, randomUUID()) === null);
  check("the run's report says why", /split not booked/.test(String(r.res.report?.accounts?.flagged_for_review ?? "")), json(r.res.report?.accounts));
  check("the dedup decision itself found nothing", r.res.report?.decision?.verdict === "none" && r.res.report?.decision?.flagged_for_review === false);
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, products: 1, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1 });
});

await fixture("tenders: points plus cash on a debit card, the cash part through Checking", async () => {
  const cur = `CHK${N.toUpperCase()}_PT`;
  const raw = receipt({ brand: "resort-debit", total: 21000, currency: cur, category: "Travel", items: [
    { line_no: 1, raw_name: "AWARD NIGHT", line_total_minor: 21000, currency: cur, item_class: "service", confidence: "high" },
    { line_no: 2, raw_name: "PARKING", line_total_minor: 2500, currency: "USD", item_class: "service", confidence: "high", line_type: "service_fee" },
  ] });
  raw.payment = { method: "debit_card", card_last4: "0000" };
  raw.points = { programme_name: "Example Stay Rewards" };
  raw.cash_component = { amount_minor: 2500, currency: "USD" };
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  const ps = await postingsOf(txId);
  check(
    "a points pair on the programme's account and a cash pair on Checking",
    json(ps.map((p) => [p.account, p.amount_minor, p.currency])) ===
      json([["Travel", "21000", cur], ["Example Stay Rewards points", "-21000", cur], ["Travel", "2500", "USD"], ["Checking", "-2500", "USD"]]),
    json(ps),
  );
  check("no account overridden", !(r.res.report?.warnings ?? []).some((w) => w.rule === "account_overridden"));
});

async function fxFixture(currency: string, total: number, rate: string, expectedBase: string, expectedFx: string) {
  await q(
    `INSERT INTO fx_rates (as_of, base, quote, rate, as_of_actual, source) VALUES ($1, $2, 'USD', $3, $1, 'manual')
     ON CONFLICT (as_of, base, quote) DO NOTHING`,
    [DATE, currency, rate],
  );
  const r = await ingest(W, receipt({ brand: `fx-${currency.toLowerCase()}`, total, currency, category: "Food & Drinks" }));
  const txId = await checkWritten(r);
  const ps = await postingsOf(txId);
  check(`amounts stay in ${currency} minor units`, ps.every((p) => p.currency === currency && Math.abs(Number(p.amount_minor)) === total), json(ps));
  await A.runPostCommitPasses(r.res, W.id);
  const legs = await q(`SELECT amount_minor::text AS amount_minor, amount_base_minor::text AS base, fx_rate::text AS fx FROM postings WHERE transaction_id = $1 ORDER BY amount_minor DESC`, [txId]);
  check(
    "the FX pass converts the NULL-marked legs at the minor-unit multiplier",
    legs[0]?.base === expectedBase && legs[1]?.base === `-${expectedBase}` && Number(legs[0]?.fx) === Number(expectedFx),
    json(legs),
  );
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  check("metadata.fx is added by the pass, after the apply", typeof t.metadata.fx === "object" && t.metadata.fx !== null);
  await A.runPostCommitPasses(r.res, W.id);
  const again = await q(`SELECT amount_base_minor::text AS base FROM postings WHERE transaction_id = $1 ORDER BY amount_minor DESC`, [txId]);
  check("running the passes again changes nothing", again[0]?.base === expectedBase);
}

await fixture("JPY: exponent 0, then the FX pass", () => fxFixture("JPY", 5000, "0.0065", "3250", "0.65"));
await fixture("EUR: then the FX pass", () => fxFixture("EUR", 1234, "1.1", "1357", "1.1"));

await fixture("attach by identifier", async () => {
  const target = await seed(receipt({ brand: "attach-id", total: 4100, ids: { order_number: `A-${N}-9` } }));
  const before = await one(`SELECT version, metadata FROM transactions WHERE id = $1`, [target]);
  const expect = await watch(W);
  const source: ServerSource = {
    text: "Your order A-9 from Example attach-id",
    email: { messageId: `chk-${N}-attach@example.invalid`, from: "Example Shop <orders@example.invalid>", subject: "Your order", date: "2026-06-10T17:00:00.000Z" },
  };
  const r = await ingest(W, receipt({ brand: "attach-id", total: 4100, classification: "receipt_email", ids: { order_number: `A-${N}-9` } }), {
    kind: "receipt_email", mime: "message/rfc822", receiptText: null, source,
  });
  check("outcome attached", r.res.outcome === "attached" && json(r.res.transactionIds) === json([target]), json(r.res));
  const ing = await one(`SELECT status, produced FROM ingests WHERE id = $1`, [r.st.ingestId]);
  check("ingest near_dup naming the target", ing.status === "near_dup" && json(ing.produced.transaction_ids) === json([target]));
  const run = await one(`SELECT outcome, apply_report FROM agent_runs WHERE id = $1`, [r.st.runId]);
  check("run attached by identifier", run.outcome === "attached" && run.apply_report.decision.tiebreaker === "identifier");
  const t = await one(`SELECT version, metadata FROM transactions WHERE id = $1`, [target]);
  const audit = t.metadata.merge_audit;
  check("merge_audit names the document, ingest, run and record", Array.isArray(audit) && audit.length === 1 &&
    audit[0].attached_document_id === r.st.documentId && audit[0].run_id === r.st.runId && audit[0].extraction_id === r.rec.extractionId, json(audit));
  const rest = { ...t.metadata };
  delete rest.merge_audit;
  check("nothing else on the target changed (version moves by the trigger)", canon(rest) === canon(before.metadata) &&
    Number(t.version) === Number(before.version) + 1,
    json({ before: Object.keys(before.metadata), after: Object.keys(rest), v0: before.version, v1: t.version }));
  const ev = await q(`SELECT payload FROM transaction_events WHERE transaction_id = $1 AND event_type = 'document_linked'`, [target]);
  check("a document_linked event", ev.length === 1 && ev[0]!.payload.document_id === r.st.documentId && ev[0]!.payload.extraction_id === r.rec.extractionId);
  const doc = await one(`SELECT ocr_text, ocr_model_version, message_id, source_meta FROM documents WHERE id = $1`, [r.st.documentId]);
  check("the attached document is stamped with the server's decode (hole 5)", doc.ocr_text === source.text && doc.ocr_model_version === A.SERVER_DECODE_VERSION);
  check("message_id and source_meta come from the server's MIME parse", doc.message_id === source.email!.messageId &&
    doc.source_meta?.channel === "eml" && doc.source_meta?.message_id === source.email!.messageId && doc.source_meta?.sender === source.email!.from);
  await expect({ document_links: 1, transaction_events: 1, document_extractions: 1 });
});

await fixture("attach by the hard tuple (card, minute, total, line totals)", async () => {
  const items = [
    { line_no: 1, raw_name: "A", line_total_minor: 1200, item_class: "consumable", confidence: "high", product_key: `${slug("tuple")}-a` },
    { line_no: 2, raw_name: "B", line_total_minor: 300, item_class: "consumable", confidence: "high", product_key: `${slug("tuple")}-b` },
  ];
  const target = await seed(receipt({ brand: "tuple", total: 1500, card: "0042", at: "2026-06-10T09:15:00-07:00", items }));
  const r = await ingest(W, receipt({ brand: "tuple", total: 1500, card: "0042", at: "2026-06-10T09:15:40-07:00", items }));
  check("attached to the target", r.res.outcome === "attached" && r.res.transactionIds[0] === target, json(r.res));
  check("by the hard tuple", r.res.report?.decision?.tiebreaker === "hard_tuple");
});

await fixture("attach refused: not a candidate (another workspace, outside the window)", async () => {
  // The same order number in the other workspace, and 45 days earlier here.
  const other = await ingest(W2, receipt({ brand: "far", total: 1600, ids: { order_number: `X-${N}-11` } }));
  check("the other workspace's seed is written", other.res.outcome === "written");
  await seed(receipt({ brand: "far", total: 1600, date: "2026-04-26", ids: { order_number: `X-${N}-11` } }));
  const r = await ingest(W, receipt({ brand: "far", total: 1600, ids: { order_number: `X-${N}-11` } }));
  await checkWritten(r);
  check("no candidate at all", r.res.report?.decision?.verdict === "none" && (r.res.report?.candidates ?? []).length === 0, json(r.res.report?.candidates));
});

await fixture("attach refused: the target is deleted while the apply waits on its lock", async () => {
  const target = await seed(receipt({ brand: "race", total: 1700, ids: { order_number: `D-${N}-12` } }));
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE transactions SET deleted_at = now() WHERE id = $1", [target]);
    const pending = ingest(W, receipt({ brand: "race", total: 1700, ids: { order_number: `D-${N}-12` } }));
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const w = await q(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%' AND datname = current_database()`);
      waiting = w.length > 0;
      if (!waiting) await new Promise((res) => setTimeout(res, 50));
    }
    check("the apply waited on the target's row lock", waiting);
    await holder.query("COMMIT");
    const r = await pending;
    await checkWritten(r);
    check("retried once, then inserted", r.res.attempts === 2 && r.res.report?.decision?.verdict === "none", json({ attempts: r.res.attempts, d: r.res.report?.decision }));
    const link = await q(`SELECT 1 FROM document_links WHERE document_id = $1 AND transaction_id = $2`, [r.st.documentId, target]);
    check("the deleted target got no link", link.length === 0);
  } finally {
    holder.release();
  }
});

await fixture("attach refused: the candidate moved money the other way", async () => {
  const refund = await seed(receipt({ brand: "cross", total: -1800, flow: "refund", ids: { order_number: `X-${N}-13` },
    items: [{ line_no: 1, raw_name: "RETURN", line_total_minor: -1800, item_class: "consumable", confidence: "high" }] }));
  const r = await ingest(W, receipt({ brand: "cross", total: 1800, ids: { order_number: `X-${N}-13` } }));
  await checkWritten(r);
  const dropped = (r.res.report?.decision?.dropped ?? []) as { id: string; why: string }[];
  check("the refund is dropped by the direction gate", dropped.some((d) => d.id === refund && d.why === "direction"), json(dropped));
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [r.res.transactionIds[0]]);
  check("a purchase gets no refund_of", !("refund_of" in t.metadata));
});

await fixture("distinct: same merchant and amount, different printed numbers", async () => {
  const a = await seed(receipt({ brand: "dist", total: 1900, ids: { order_number: `S-${N}-14a` } }));
  const r = await ingest(W, receipt({ brand: "dist", total: 1900, ids: { order_number: `S-${N}-14b` } }));
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  const nd = t.metadata.near_dup_check;
  check("near_dup_check distinct, not flagged, naming the candidate", nd?.verdict === "distinct" && nd?.flagged_for_review === false &&
    nd?.candidate_transaction_id === a && nd?.decided_by === "applier", json(nd));
});

await fixture("uncertain: a candidate with no tiebreaker", async () => {
  const a = await seed(receipt({ brand: "unc", total: 2100, card: null }));
  const r = await ingest(W, receipt({ brand: "unc", total: 2100, card: null }));
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  const nd = t.metadata.near_dup_check;
  check("near_dup_check uncertain and flagged", nd?.verdict === "uncertain" && nd?.flagged_for_review === true && nd?.candidate_transaction_id === a, json(nd));
});

await fixture("an identifier match with another total is booked, flagged (a second partial refund)", async () => {
  const refundItems = (t: number) => [{ line_no: 1, raw_name: "RETURN", line_total_minor: t, item_class: "consumable", confidence: "high" }];
  const first = await seed(receipt({ brand: "partial", total: -2000, flow: "refund", ids: { order_number: `P-${N}-15` }, items: refundItems(-2000) }));
  const r = await ingest(W, receipt({ brand: "partial", total: -1500, flow: "refund", ids: { order_number: `P-${N}-15` }, items: refundItems(-1500) }));
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  const nd = t.metadata.near_dup_check;
  check("near_dup_check uncertain, flagged, naming the first refund", nd?.verdict === "uncertain" && nd?.flagged_for_review === true &&
    nd?.candidate_transaction_id === first && /the total differs/.test(nd?.reason ?? ""), json(nd));
  const ps = await postingsOf(txId);
  check("its own money is booked", ps.some((p) => p.account === "Shopping" && p.amount_minor === "-1500"), json(ps));
});

await fixture("unsupported: nothing booked, the text stamped", async () => {
  const expect = await watch(W);
  const outcome = validateExtraction(
    { contract_version: 1, classification: "unsupported", unsupported: { reason: "marketing", note: "a synthetic flyer" } },
    { uploadedAt: UPLOAD, receiptText: "SALE THIS WEEK" },
  );
  const st = await stage(W);
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "SALE THIS WEEK", final: true, stats: STATS });
  const res = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  check("outcome unsupported", res.outcome === "unsupported" && res.ingestStatus === "unsupported", json(res));
  const ing = await one(`SELECT status, error, produced FROM ingests WHERE id = $1`, [st.ingestId]);
  check("ingest unsupported with the note", ing.status === "unsupported" && ing.error === "a synthetic flyer" &&
    json(ing.produced.extraction_ids) === json([rec.extractionId]));
  const doc = await one(`SELECT ocr_text, source_ingest_id FROM documents WHERE id = $1`, [st.documentId]);
  check("ocr_text stamped (hole 5)", doc.ocr_text === "SALE THIS WEEK" && doc.source_ingest_id === st.ingestId);
  const run = await one(`SELECT outcome, extraction_id FROM agent_runs WHERE id = $1`, [st.runId]);
  check("run unsupported, pointing at the record", run.outcome === "unsupported" && run.extraction_id === rec.extractionId);
  await expect({ document_extractions: 1 });
});

await fixture("statement: recorded as evidence, not booked", async () => {
  const expect = await watch(W);
  const outcome = validateExtraction(
    {
      contract_version: 1,
      classification: "statement_pdf",
      statement_rows: [
        { occurred_on: "2026-06-01", description: "EXAMPLE STORE", amount_minor: 1234, currency: "USD", kind: "charge" },
        { occurred_on: "2026-06-03", description: "PAYMENT THANK YOU", amount_minor: -1234, currency: "USD", kind: "payment" },
      ],
    },
    { uploadedAt: UPLOAD, receiptText: "STATEMENT" },
  );
  const st = await stage(W, { kind: "statement_pdf", mime: "application/pdf" });
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "STATEMENT", final: true, stats: STATS });
  const res = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  check("outcome recorded_only", res.outcome === "recorded_only", json(res));
  const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st.ingestId]);
  check("ingest unsupported, saying booking is not built", ing.status === "unsupported" && ing.error === A.STATEMENT_NOT_BOOKED);
  const stored = await one(`SELECT classification, result FROM document_extractions WHERE id = $1`, [rec.extractionId]);
  check("the rows are kept on the record", stored.classification === "statement_pdf" && stored.result.statement_rows.length === 2);
  await expect({ document_extractions: 1 });
});

await fixture("Message-ID duplicate: linked to the live transaction, closed dedup", async () => {
  const mid = `chk-${N}-dup@example.invalid`;
  const email = { messageId: mid, from: "Example Shop <orders@example.invalid>", subject: "Receipt", date: "2026-06-10T18:00:00.000Z" };
  const first = await ingest(W, receipt({ brand: "mail", total: 2200, classification: "receipt_email" }), {
    kind: "receipt_email", mime: "message/rfc822", receiptText: null, source: { text: "Receipt body", email },
  });
  const original = await checkWritten(first, "the first copy");
  const expect = await watch(W);
  const st = await stage(W, { kind: "receipt_email", mime: "message/rfc822" });
  const res = await A.applyMessageIdDuplicate({ ...st, source: { text: "Receipt body, forwarded", email } });
  check("outcome duplicate_skip", res?.outcome === "duplicate_skip" && json(res?.transactionIds) === json([original]), json(res));
  const ing = await one(`SELECT status, classification, produced FROM ingests WHERE id = $1`, [st.ingestId]);
  check("ingest dedup naming the transaction", ing.status === "dedup" && ing.classification === "receipt_email" &&
    json(ing.produced.transaction_ids) === json([original]));
  const link = await q(`SELECT 1 FROM document_links WHERE document_id = $1 AND transaction_id = $2`, [st.documentId, original]);
  check("the copy is linked (X9)", link.length === 1);
  const doc = await one(`SELECT message_id, source_meta, ocr_text, ocr_model_version FROM documents WHERE id = $1`, [st.documentId]);
  check("the copy keeps the id in source_meta, the column stays with the original", doc.message_id === null &&
    doc.source_meta?.message_id === mid && doc.ocr_model_version === A.SERVER_DECODE_VERSION);
  const run = await one(`SELECT outcome, status, session_id, model_requested, cli_version FROM agent_runs WHERE id = $1`, [st.runId]);
  check("run finished duplicate_skip", run.status === "finished" && run.outcome === "duplicate_skip");
  check("nothing was spawned: no session, model or CLI on the run", run.session_id === null && run.model_requested === null &&
    run.cli_version === null, json(run));
  await expect({ document_links: 1, transaction_events: 1 });

  // The same id whose transaction is gone: not a duplicate; the copy is
  // extracted, and its stamp leaves the id with the original document.
  await q(`UPDATE transactions SET deleted_at = now() WHERE id = $1`, [original]);
  const st2 = await stage(W, { kind: "receipt_email", mime: "message/rfc822" });
  const none = await A.applyMessageIdDuplicate({ ...st2, source: { text: "Receipt body again", email } });
  check("no live transaction holds the id: null, nothing written", none === null);
  const still = await one(`SELECT status FROM ingests WHERE id = $1`, [st2.ingestId]);
  check("the ingest is still processing", still.status === "processing");
  const again = await ingest(W, receipt({ brand: "mail", total: 2200, classification: "receipt_email" }), {
    st: st2, receiptText: null, source: { text: "Receipt body again", email },
  });
  await checkWritten(again, "re-extracted");
  check("its stamp leaves message_id to the original", again.res.report?.message_id_stored === false);
});

await fixture("parties: channel defaulted, seller, line-level maker", async () => {
  const brand = "market";
  const raw = receipt({ brand, total: 2300, items: [
    { line_no: 1, raw_name: "WIDGET", line_total_minor: 1300, item_class: "consumable", confidence: "high", product_key: `${slug(brand)}-widget` },
    { line_no: 2, raw_name: "EXAMPLE MAKER GADGET", line_total_minor: 1000, item_class: "consumable", confidence: "high", product_key: `${slug(brand)}-gadget` },
  ] });
  raw.parties = [
    { role: "seller", display_name: "Example Seller" },
    { role: "maker", display_name: "Example Maker", line_no: 2 },
    { role: "maker", display_name: "Nobody", line_no: 99 },
  ];
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  check("the line-99 party is dropped by the validator", r.outcome.report.warnings.some((w) => w.rule === "party_line_dropped"));
  const parties = await q(
    `SELECT tp.role, tp.display_name, tp.brand_id, ti.line_no FROM transaction_parties tp
       LEFT JOIN transaction_items ti ON ti.id = tp.transaction_item_id WHERE tp.transaction_id = $1 ORDER BY tp.role, tp.display_name`,
    [txId],
  );
  check("channel, maker on line 2, seller", json(parties) === json([
    { role: "channel", display_name: `Example ${brand}`, brand_id: slug(brand), line_no: null },
    { role: "maker", display_name: "Example Maker", brand_id: null, line_no: 2 },
    { role: "seller", display_name: "Example Seller", brand_id: null, line_no: null },
  ]), json(parties));
});

await fixture("cached place: counters only, Layer 3 kept, receipt zh name filled", async () => {
  const gid = `ChIJchk${N}cached01`;
  const placeId = randomUUID();
  const raw0 = { v1: { en: { displayName: { text: "Example Cached Place" } } }, fetched_at: "2026-01-01T00:00:00.000Z" };
  await q(
    `INSERT INTO places (id, google_place_id, formatted_address, lat, lng, source, raw_response, custom_name, hit_count)
     VALUES ($1, $2, '1 Example Way', 1.5, 2.5, 'google_places', $3, 'A name the user chose', 1)`,
    [placeId, gid, JSON.stringify(raw0)],
  );
  const expect = await watch(W);
  const raw = receipt({ brand: "placed", total: 2400 });
  raw.place = { google_place_id: gid, resolved_via: "geocode_address" };
  raw.merchant.name_zh_printed = "示例商店 EXAMPLE";
  const r = await ingest(W, raw, { placeFetcher: async () => { throw new Error("a cache hit must not fetch"); } });
  const txId = await checkWritten(r);
  const p = await one(`SELECT hit_count, raw_response, custom_name, display_name_zh, display_name_zh_source, display_name_zh_is_native FROM places WHERE id = $1`, [placeId]);
  check("hit_count + 1, raw_response untouched", p.hit_count === 2 && json(p.raw_response) === json(raw0), json(p));
  check("custom_name untouched", p.custom_name === "A name the user chose");
  check("the receipt's CJK run stored as receipt_ocr", p.display_name_zh === "示例商店" && p.display_name_zh_source === "receipt_ocr" && p.display_name_zh_is_native === true, json(p));
  const t = await one(`SELECT place_id FROM transactions WHERE id = $1`, [txId]);
  check("the transaction links the place", t.place_id === placeId);
  check("the report says hit", r.res.report?.place?.cache === "hit");
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, products: 1, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1 });
});

function envelope(gid: string, withLocation = true) {
  return {
    v1: {
      en: {
        id: gid,
        displayName: { text: "Example Fetched Place", languageCode: "en" },
        formattedAddress: "2 Example Way, Example City",
        ...(withLocation ? { location: { latitude: 10.25, longitude: -20.5 } } : {}),
        types: ["store", "point_of_interest"],
        primaryType: "store",
        postalAddress: { postalCode: "00000", regionCode: "US" },
        rating: 4.5,
        userRatingCount: 12,
      },
      "zh-CN": { id: gid, displayName: { text: "Example Fetched Place", languageCode: "en" } },
    },
    fetched_at: "2026-06-15T12:00:00.000Z",
  };
}

await fixture("uncached place: inserted from the envelope, one snapshot", async () => {
  const gid = `ChIJchk${N}fetched1`;
  const expect = await watch(W);
  const raw = receipt({ brand: "fetched", total: 2700 });
  raw.place = { google_place_id: gid, resolved_via: "find_place_text" };
  raw.merchant.name_zh_printed = "示例";
  const r = await ingest(W, raw, { placeFetcher: async (id: string) => envelope(id) });
  const txId = await checkWritten(r);
  const p = await one(
    `SELECT id, source, hit_count, raw_response, display_name_en, display_name_zh, display_name_zh_source, types, lat::text AS lat,
            formatted_address, rating::text AS rating, custom_name, metadata FROM places WHERE google_place_id = $1`,
    [gid],
  );
  check("projected columns and the v1 envelope", p.source === "google_places" && p.hit_count === 1 &&
    p.display_name_en === "Example Fetched Place" && json(p.types) === json(["store", "point_of_interest"]) &&
    p.lat === "10.250000" && p.formatted_address === "2 Example Way, Example City" && p.rating === "4.5" &&
    p.raw_response?.v1?.en?.id === gid && p.custom_name === null, json(p));
  check("no Chinese from Google, so the receipt's goes in as receipt_ocr", p.display_name_zh === "示例" && p.display_name_zh_source === "receipt_ocr");
  check("the projection is stamped on the place", p.metadata?.derivation?.projection_version !== undefined);
  const snaps = await q(`SELECT source, fetched_by_sha, fetched_at FROM place_snapshots WHERE place_id = $1`, [p.id]);
  check("one snapshot of the fetch", snaps.length === 1 && snaps[0]!.source === "google_places");
  const t = await one(`SELECT place_id FROM transactions WHERE id = $1`, [txId]);
  check("the transaction links it", t.place_id === p.id);
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, products: 1, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 1, places: 1, place_snapshots: 1 });
});

await fixture("uncached place: unprojectable envelope, and an unfetchable one", async () => {
  const a = receipt({ brand: "noloc", total: 2800 });
  a.place = { google_place_id: `ChIJchk${N}noloc001`, resolved_via: "geocode_address" };
  const ra = await ingest(W, a, { placeFetcher: async (id: string) => envelope(id, false) });
  const ta = await checkWritten(ra, "unprojectable");
  check("place_not_projectable, no place", (ra.res.report?.warnings ?? []).some((w) => w.rule === "place_not_projectable") &&
    (await one(`SELECT place_id FROM transactions WHERE id = $1`, [ta])).place_id === null);
  const b = receipt({ brand: "nokey", total: 2801 });
  b.place = { google_place_id: `ChIJchk${N}nokey001`, resolved_via: "geocode_address" };
  const rb = await ingest(W, b);
  const tb = await checkWritten(rb, "unfetchable");
  check("place_fetch_failed, no place", (rb.res.report?.warnings ?? []).some((w) => w.rule === "place_fetch_failed") &&
    (await one(`SELECT place_id FROM transactions WHERE id = $1`, [tb])).place_id === null);
  const rows = await q(`SELECT 1 FROM places WHERE google_place_id IN ($1, $2)`, [a.place.google_place_id, b.place.google_place_id]);
  check("neither left a places row", rows.length === 0);
});

await fixture("extras colliding with metadata keys stay in their bags", async () => {
  const raw = receipt({ brand: "extras", total: 2900 });
  raw.other_references = { refund_of: randomUUID(), order_number: `E-${N}-1`, near_dup_check: "x" };
  raw.receipt_facts = { flow: "income", extraction: "x", mirror_account: "Cash", table_number: 7 };
  const r = await ingest(W, raw);
  const txId = await checkWritten(r);
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [txId]);
  const m = t.metadata;
  check("no top-level refund_of, near_dup_check or order_number from the bags",
    !("refund_of" in m) && !("near_dup_check" in m) && !("order_number" in m), Object.keys(m).join(","));
  check("flow, mirror_account and extraction are the applier's", m.flow === "purchase" && m.mirror_account === "Credit Card" && typeof m.extraction === "object");
  check("the bags keep the colliding keys", m.other_references?.refund_of === raw.other_references.refund_of &&
    m.receipt_facts?.flow === "income" && m.receipt_facts?.table_number === 7);
  const forbidden = validateExtraction({ ...receipt({ brand: "extras", total: 1 }), refund_of: randomUUID() }, { uploadedAt: UPLOAD });
  check("refund_of at the top level is refused by the contract", forbidden.status === "invalid" &&
    forbidden.report.errors.some((e) => e.rule === "schema" && e.path === "refund_of"), json(forbidden.report.errors));
});

await fixture("missing fence: no record, the ingest errors", async () => {
  const expect = await watch(W);
  const st = await stage(W);
  const artefact = parseArtefact({ stdout: "I read the receipt.\nDONE ingest" });
  check("the parser finds no record", !artefact.ok && artefact.reason === "artefact_missing");
  check("nothing to validate", validateArtefact(artefact, { uploadedAt: UPLOAD }) === null);
  const closed = await A.closeRunWithoutRecord(st, { error: "extraction record missing: no json block with contract_version in the output" });
  check("closed", closed);
  const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st.ingestId]);
  check("ingest error, retryable text", ing.status === "error" && /^extraction record missing/.test(ing.error));
  const run = await one(`SELECT outcome, error_class FROM agent_runs WHERE id = $1`, [st.runId]);
  check("run invalid_record / artefact_missing", run.outcome === "invalid_record" && run.error_class === "artefact_missing");

  // A run that lost its ingest to a newer one: not its close to make.
  const st2 = await stage(W);
  const newer = await newRun(W, st2.ingestId, st2.documentId);
  const stale = await A.closeRunWithoutRecord(st2, { error: "extraction record missing: nothing" });
  check("a stale run closes nothing", stale === false);
  const old = await one(`SELECT status, outcome, error_class FROM agent_runs WHERE id = $1`, [st2.runId]);
  check("the stale run finishes failed / fenced_out, not artefact_missing", old.status === "finished" && old.outcome === "failed" &&
    old.error_class === "fenced_out", json(old));
  const ing2 = await one(`SELECT status FROM ingests WHERE id = $1`, [st2.ingestId]);
  check("the ingest is left to the newer run", ing2.status === "processing");
  check("the newer run closes it", await A.closeRunWithoutRecord({ ...st2, runId: newer }, { error: "extraction record missing: nothing" }));
  await expect({});
});

await fixture("invalid JSON: stored as evidence, the ingest errors", async () => {
  const expect = await watch(W);
  const st = await stage(W);
  const stdout = 'Reasoning done.\n```json\n{"contract_version": 1, "classification": "receipt_image",,}\n```\n';
  const artefact = parseArtefact({ stdout });
  check("the parser reports json_parse", !artefact.ok && artefact.reason === "json_parse");
  const outcome = validateArtefact(artefact, { uploadedAt: UPLOAD });
  check("an invalid outcome", outcome?.status === "invalid");
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome: outcome!, final: true, stats: STATS });
  check("stored invalid and closed", rec.status === "invalid" && rec.closed);
  const stored = await one(`SELECT status, result, superseded_at FROM document_extractions WHERE id = $1`, [rec.extractionId]);
  check("the unparsed text is the evidence", stored.status === "invalid" && typeof stored.result.unparsed_text === "string");
  const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st.ingestId]);
  check("ingest error names the rule", ing.status === "error" && ing.error === "extraction record rejected: record: json_parse", ing.error);
  const run = await one(`SELECT outcome, error_class, extraction_id FROM agent_runs WHERE id = $1`, [st.runId]);
  check("run invalid_record / artefact_invalid", run.outcome === "invalid_record" && run.error_class === "artefact_invalid" && run.extraction_id === rec.extractionId);
  await expect({ document_extractions: 1 });
});

await fixture("a repair round: errors named, an unnamed money change warned", async () => {
  const first = receipt({ brand: "repair", total: 3100, date: "2026-02-30" });
  const bad = validateExtraction(first, { uploadedAt: UPLOAD, receiptText: "R" });
  check("the first record is refused for its date", bad.status === "invalid" && bad.report.errors.some((e) => e.rule === "calendar_date" && e.path === "facts.occurred_on"));
  const request = renderRepairRequest(bad.report.errors);
  check("the request names the path and rule, never a value", /facts\.occurred_on — calendar_date/.test(request) && !request.includes("2026-02-30"));
  const second = receipt({ brand: "repair", total: 3150, date: "2026-02-28" });
  second.items[0].line_total_minor = 3150;
  const good = validateExtraction(second, { uploadedAt: UPLOAD, receiptText: "R" });
  check("the repaired record is valid", good.status === "valid");
  const diff = diffRepair(first, second, bad.report.errors);
  check("the total change is unnamed and money", diff.unnamed.some((c) => c.path === "facts.total_minor" && c.money));
  appendWarnings(good.report, diff.warnings);
  noteRepairRound(good.report, 1, bad.report.errors);
  const st = await stage(W);
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome: good, rawText: "R", repairRounds: 1, final: true, stats: STATS });
  const stored = await one(`SELECT validation FROM document_extractions WHERE id = $1`, [rec.extractionId]);
  check("the record carries the round and the warning", stored.validation.repairs?.[0]?.round === 1 &&
    stored.validation.warnings.some((w: any) => w.rule === "repair_changed_unnamed" && w.money === true));
  const res = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  await checkWritten({ st, outcome: good, rec, res });
  const run = await one(`SELECT repair_rounds FROM agent_runs WHERE id = $1`, [st.runId]);
  check("the run counts the round", run.repair_rounds === 1);
});

await fixture("double apply and a stale run are fenced out", async () => {
  if (!purchaseRun) throw new Error("needs the purchase fixture");
  const expect = await watch(W);
  const again = await A.applyExtraction({ ...purchaseRun.st, extractionId: purchaseRun.rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  check("the second apply of a run is fenced out", again.outcome === "failed" && again.errorClass === "fenced_out" && again.ingestStatus === null, json(again));
  const run = await one(`SELECT outcome, error_class FROM agent_runs WHERE id = $1`, [purchaseRun.st.runId]);
  check("the first finish stands", run.outcome === "written" && run.error_class === null);
  const ing = await one(`SELECT status FROM ingests WHERE id = $1`, [purchaseRun.st.ingestId]);
  check("the ingest stays done", ing.status === "done");

  // A newer run took the ingest over: the old run's record and apply are refused.
  const st = await stage(W);
  const outcome = validate(receipt({ brand: "stale", total: 3200 }));
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "X", final: true, stats: STATS });
  const newer = await newRun(W, st.ingestId, st.documentId);
  const stale = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  check("the stale run's apply is fenced out", stale.outcome === "failed" && stale.errorClass === "fenced_out");
  const staleRec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "X", final: true, stats: STATS });
  check("so is its T1", staleRec.fencedOut && staleRec.extractionId === null);
  const oldRun = await one(`SELECT status, outcome, error_class FROM agent_runs WHERE id = $1`, [st.runId]);
  check("the stale run is finished failed / fenced_out", oldRun.status === "finished" && oldRun.outcome === "failed" && oldRun.error_class === "fenced_out");
  const ing2 = await one(`SELECT status, current_run_id FROM ingests WHERE id = $1`, [st.ingestId]);
  check("the ingest is left to the newer run", ing2.status === "processing" && ing2.current_run_id === newer);
  // The newer run finishes the job.
  const r = await ingest(W, receipt({ brand: "stale", total: 3200 }), { st: { ...st, runId: newer }, receiptText: "X" });
  await checkWritten(r, "the newer run");
  await expect({ transactions: 1, postings: 2, document_links: 1, transaction_items: 1, products: 1, transaction_parties: 1,
    transaction_events: 1, merchants: 1, brands: 1, document_extractions: 2 });
});

await fixture("a document hard-deleted between T1 and T2: the ingest still closes", async () => {
  const st = await stage(W);
  const outcome = validate(receipt({ brand: "purged", total: 3300 }));
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "X", final: true, stats: STATS });
  check("the record is stored", rec.status === "valid" && rec.extractionId !== null);
  // The purge a `DELETE /v1/documents/:id?hard=true` does: the record goes
  // with the document (ON DELETE CASCADE), the run's pointer to it is nulled.
  await q(`DELETE FROM documents WHERE id = $1`, [st.documentId]);
  const res = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
  check("the apply fails", res.outcome === "failed" && res.errorClass === "apply" && res.ingestStatus === "error", json(res));
  const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st.ingestId]);
  check("the ingest is closed error, not left processing", ing.status === "error" && /^apply failed: record_missing/.test(ing.error), json(ing));
  const run = await one(`SELECT status, outcome, error_class, extraction_id FROM agent_runs WHERE id = $1`, [st.runId]);
  check("the run finished failed / apply, naming no gone record", run.status === "finished" && run.outcome === "failed" &&
    run.error_class === "apply" && run.extraction_id === null, json(run));

  // Deleted before T1 could store anything: the same close, from T1.
  const st2 = await stage(W);
  await q(`DELETE FROM documents WHERE id = $1`, [st2.documentId]);
  const rec2 = await A.recordExtraction({ ...st2, origin: "stub", outcome, rawText: "X", final: true, stats: STATS });
  check("T1 closes the run itself", rec2.closed && rec2.extractionId === null && /^apply failed: document_missing/.test(rec2.error ?? ""), json(rec2));
  const ing2 = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st2.ingestId]);
  check("the ingest says the document is missing", ing2.status === "error" && ing2.error === rec2.error);
  const run2 = await one(`SELECT outcome, error_class FROM agent_runs WHERE id = $1`, [st2.runId]);
  check("the run finished failed / apply", run2.outcome === "failed" && run2.error_class === "apply");
});

await fixture("a document soft-deleted during the apply is document_deleted, not internal", async () => {
  const st = await stage(W);
  const outcome = validate(receipt({ brand: "softgone", total: 3400 }));
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "X", final: true, stats: STATS });
  // The prologue reads the document without a lock; a delete that lands
  // after it is seen under the document's lock (the stamp's UPDATE waits
  // for it, then finds the row deleted).
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE documents SET deleted_at = now() WHERE id = $1", [st.documentId]);
    const pending = A.applyExtraction({ ...st, extractionId: rec.extractionId!, stats: STATS, placeFetcher: refuseFetch });
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const w = await q(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%documents%' AND datname = current_database()`);
      waiting = w.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    check("the apply waited on the document's row lock", waiting);
    await holder.query("COMMIT");
    const res = await pending;
    check("the apply fails as document_deleted", res.outcome === "failed" && /^apply failed: document_deleted/.test(res.error ?? ""), json(res));
    const t = await q(`SELECT 1 FROM transactions WHERE source_ingest_id = $1`, [st.ingestId]);
    check("nothing booked", t.length === 0);
  } finally {
    holder.release();
  }
});

await fixture("a repair round whose spawn failed: the record is evidence, the run an agent error", async () => {
  const expect = await watch(W);
  const st = await stage(W);
  const bad = validateExtraction(receipt({ brand: "outage", total: 3500, date: "2026-02-30" }), { uploadedAt: UPLOAD, receiptText: "R" });
  const rec = await A.recordExtraction({
    ...st,
    origin: "stub",
    outcome: bad,
    rawText: "R",
    repairRounds: 1,
    final: true,
    stats: STATS,
    agentFailure: { errorClass: "auth", error: "claude -p exited 1: authentication_error (synthetic)" },
  });
  check("stored invalid and closed", rec.status === "invalid" && rec.closed);
  const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [st.ingestId]);
  check("the ingest carries the agent's error, not 'record rejected'", ing.status === "error" && /authentication_error/.test(ing.error), ing.error);
  const run = await one(`SELECT outcome, error_class, extraction_id, repair_rounds FROM agent_runs WHERE id = $1`, [st.runId]);
  check("run agent_error / auth, pointing at the invalid record", run.outcome === "agent_error" && run.error_class === "auth" &&
    run.extraction_id === rec.extractionId && run.repair_rounds === 1, json(run));
  await expect({ document_extractions: 1 });
});

await fixture("characters Postgres cannot store: removed, and the receipt is written", async () => {
  const raw = receipt({ brand: "nul", total: 3600, classification: "receipt_email", payee: "Example\u0000 Nul" });
  const outcome = validateExtraction(raw, { uploadedAt: UPLOAD, receiptText: null });
  check("the record is valid, the NUL removed", outcome.status === "valid" && outcome.record?.facts?.payee === "Example Nul" &&
    outcome.report.normalizations.some((n) => n.rule === "unsafe_character_removed"));
  const source: ServerSource = {
    text: "Receipt\u0000 body with a lone \ud800 surrogate",
    email: { messageId: `chk-${N}-nul@example.invalid`, from: "Example <a@example.invalid>", subject: "Sub\u0000ject", date: null },
  };
  const st = await stage(W, { kind: "receipt_email", mime: "message/rfc822" });
  const rec = await A.recordExtraction({ ...st, origin: "stub", outcome, rawText: "raw\u0000 text", final: true, stats: STATS });
  check("T1 stores it", rec.status === "valid");
  const res = await A.applyExtraction({ ...st, extractionId: rec.extractionId!, source, stats: STATS, placeFetcher: refuseFetch });
  await checkWritten({ st, outcome, rec, res });
  const stored = await one(`SELECT raw_text FROM document_extractions WHERE id = $1`, [rec.extractionId]);
  check("raw_text stored without the NUL", stored.raw_text === "raw text");
  const doc = await one(`SELECT ocr_text, source_meta FROM documents WHERE id = $1`, [st.documentId]);
  check("ocr_text and the envelope stamped without them", doc.ocr_text === "raw text" && doc.source_meta?.subject === "Subject", json(doc));
});

await fixture("Message-ID copy applied while this run read: linked under the lock", async () => {
  const mid = `chk-${N}-inflight@example.invalid`;
  const email = { messageId: mid, from: "Example Shop <orders@example.invalid>", subject: "Receipt", date: "2026-06-10T18:30:00.000Z" };
  const raw = receipt({ brand: "inflight", total: 3700, classification: "receipt_email" });
  // Both copies pass the pre-spawn check (nothing holds the id yet); the
  // first is applied while the second is still being read.
  const stB = await stage(W, { kind: "receipt_email", mime: "message/rfc822" });
  const preB = await A.applyMessageIdDuplicate({ ...stB, source: { text: "Receipt body", email } });
  check("the pre-spawn check finds nothing yet", preB === null);
  const first = await ingest(W, raw, { kind: "receipt_email", mime: "message/rfc822", receiptText: null, source: { text: "Receipt body", email } });
  const original = await checkWritten(first, "the first copy");
  const expect = await watch(W);
  const outcome = validate(raw, null);
  const rec = await A.recordExtraction({ ...stB, origin: "stub", outcome, final: true, stats: STATS });
  const res = await A.applyExtraction({ ...stB, extractionId: rec.extractionId!, source: { text: "Receipt body (copy)", email }, stats: STATS, placeFetcher: refuseFetch });
  check("closed as a duplicate, not inserted", res.outcome === "duplicate_skip" && json(res.transactionIds) === json([original]), json(res));
  const ing = await one(`SELECT status, produced FROM ingests WHERE id = $1`, [stB.ingestId]);
  check("ingest dedup, naming the transaction and the record", ing.status === "dedup" &&
    json(ing.produced.transaction_ids) === json([original]) && json(ing.produced.extraction_ids) === json([rec.extractionId]));
  const run = await one(`SELECT outcome, session_id FROM agent_runs WHERE id = $1`, [stB.runId]);
  check("the run keeps its session (the agent did read)", run.outcome === "duplicate_skip" && run.session_id !== null);
  await expect({ document_links: 1, transaction_events: 1, document_extractions: 1 });
});

await fixture("a missing account is a failed apply, never a model error", async () => {
  const expect = await watch(W2);
  const raw = income({ brand: "payer", total: 5000 });
  raw.income = { deposit_account: "Savings", income_account: "Other" };
  const r = await ingest(W2, raw);
  check("outcome failed / apply", r.res.outcome === "failed" && r.res.errorClass === "apply" && /account_missing/.test(r.res.error ?? ""), json(r.res));
  const ing = await one(`SELECT status, error, produced FROM ingests WHERE id = $1`, [r.st.ingestId]);
  check("ingest error, the record named for a re-apply", ing.status === "error" && /^apply failed: account_missing/.test(ing.error) &&
    json(ing.produced.extraction_ids) === json([r.rec.extractionId]));
  await expect({ document_extractions: 1 });
});

let halfway: Ran | null = null;

await fixture("an apply failing half-way leaves nothing behind", async () => {
  const marker = `CHK-FAIL-${N}`;
  await q(`CREATE OR REPLACE FUNCTION chk_fail_party() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN IF NEW.display_name = '${marker}' THEN RAISE EXCEPTION 'check: fail half-way'; END IF; RETURN NEW; END $$`);
  await q(`DROP TRIGGER IF EXISTS chk_fail_party ON transaction_parties`);
  await q(`CREATE TRIGGER chk_fail_party BEFORE INSERT ON transaction_parties FOR EACH ROW EXECUTE FUNCTION chk_fail_party()`);
  try {
    const gid = `ChIJchk${N}halfway1`;
    const expect = await watch(W);
    const raw = receipt({ brand: "halfway", total: 3300, items: [
      { line_no: 1, raw_name: "GADGET", line_total_minor: 3300, item_class: "durable", confidence: "high", product_key: `${slug("halfway")}-gadget`, track_as_owned: true },
    ] });
    raw.parties = [{ role: "seller", display_name: marker }];
    raw.place = { google_place_id: gid, resolved_via: "geocode_address" };
    const r = await ingest(W, raw, { placeFetcher: async (id: string) => envelope(id) });
    halfway = r;
    check("outcome failed / apply with the SQLSTATE", r.res.outcome === "failed" && r.res.error === "apply failed: P0001", json(r.res));
    const ing = await one(`SELECT status, error FROM ingests WHERE id = $1`, [r.st.ingestId]);
    check("ingest error", ing.status === "error");
    const doc = await one(`SELECT ocr_text, source_ingest_id FROM documents WHERE id = $1`, [r.st.documentId]);
    check("the document is not stamped", doc.ocr_text === null && doc.source_ingest_id === null);
    const rec = await one(`SELECT status, superseded_at FROM document_extractions WHERE id = $1`, [r.rec.extractionId]);
    check("the record stays valid and unapplied", rec.status === "valid" && rec.superseded_at === null);
    const run = await one(`SELECT outcome, error_class, status FROM agent_runs WHERE id = $1`, [r.st.runId]);
    check("run failed / apply", run.status === "finished" && run.outcome === "failed" && run.error_class === "apply");
    // No brand, merchant, product, owned item, place or snapshot either.
    await expect({ document_extractions: 1 });
  } finally {
    await q(`DROP TRIGGER IF EXISTS chk_fail_party ON transaction_parties`);
    await q(`DROP FUNCTION IF EXISTS chk_fail_party()`);
  }
});

await fixture("a serialization failure is retried in-process", async () => {
  await q(`CREATE SEQUENCE IF NOT EXISTS chk_retry_seq`);
  await q(`SELECT setval('chk_retry_seq', 1, false)`);
  await q(`CREATE OR REPLACE FUNCTION chk_retry_once() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN IF nextval('chk_retry_seq') = 1 THEN RAISE EXCEPTION 'check: retry me' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`);
  await q(`DROP TRIGGER IF EXISTS chk_retry_once ON transaction_events`);
  await q(`CREATE TRIGGER chk_retry_once BEFORE INSERT ON transaction_events FOR EACH ROW EXECUTE FUNCTION chk_retry_once()`);
  try {
    const r = await ingest(W, receipt({ brand: "retry", total: 3400 }));
    await checkWritten(r);
    check("written on the second attempt", r.res.attempts === 2 && r.res.report?.attempts === 2, json({ attempts: r.res.attempts }));
    const n = await one(`SELECT count(*)::int AS n FROM transactions WHERE source_ingest_id = $1`, [r.st.ingestId]);
    check("exactly one transaction", n.n === 1);
  } finally {
    await q(`DROP TRIGGER IF EXISTS chk_retry_once ON transaction_events`);
    await q(`DROP FUNCTION IF EXISTS chk_retry_once()`);
    await q(`DROP SEQUENCE IF EXISTS chk_retry_seq`);
  }
});

await fixture("re-apply of a stored record (apply-only), never a re-read", async () => {
  if (!halfway) throw new Error("needs the half-way fixture");
  // A fresh ingest and run for the same document, as a retry would make.
  const ingestId = randomUUID();
  await q(`INSERT INTO ingests (id, workspace_id, filename, file_path, status, document_id) VALUES ($1, $2, 'retry', $3, 'processing', $4)`,
    [ingestId, W.id, `check/${N}/retry`, halfway.st.documentId]);
  const runId = await newRun(W, ingestId, halfway.st.documentId);
  const st = { workspaceId: W.id, ingestId, runId, documentId: halfway.st.documentId };
  const res = await A.reapplyRecord({ ...st, stats: STATS, placeFetcher: async (id: string) => envelope(id) });
  check("outcome reapplied, the insert branch", res.outcome === "reapplied" && res.report?.branch === "insert" && res.extractionId === halfway.rec.extractionId, json(res));
  const t = await one(`SELECT metadata FROM transactions WHERE id = $1`, [res.transactionIds[0]]);
  check("the transaction points at the stored record", t.metadata.extraction.extraction_id === halfway.rec.extractionId);
  const parties = await q(`SELECT display_name FROM transaction_parties WHERE transaction_id = $1 ORDER BY display_name`, [res.transactionIds[0]]);
  check("the party that failed before is written now", parties.some((p) => p.display_name === `CHK-FAIL-${N}`));
  const owned = await q(`SELECT 1 FROM owned_items o JOIN transaction_items ti ON ti.id = o.transaction_item_id WHERE ti.transaction_id = $1`, [res.transactionIds[0]]);
  check("and the owned item", owned.length === 1);
});

await fixture("dry run: the stored record re-projects to its transaction", async () => {
  if (!purchaseRun) throw new Error("needs the purchase fixture");
  const txId = purchaseRun.res.transactionIds[0]!;
  const dry = await A.dryRun({ workspaceId: W.id, documentId: purchaseRun.st.documentId, extractionId: purchaseRun.rec.extractionId!, excludeTransactionIds: [txId] });
  const ledger = await readLedgerFingerprint(appDb, txId);
  check("the fingerprints agree", dry.fingerprint !== null && ledger !== null && diffFingerprints(dry.fingerprint, ledger).length === 0,
    ledger && dry.fingerprint ? diffFingerprints(dry.fingerprint, ledger).join(",") : "missing");
  const withSelf = await A.dryRun({ workspaceId: W.id, documentId: purchaseRun.st.documentId, extractionId: purchaseRun.rec.extractionId! });
  check("without the exclusion its own transaction is a candidate", (withSelf.decision?.considered ?? []).some((v) => v.id === txId));
});

if (GOOGLE_KEY && LIVE_PLACE_ID) {
  await fixture("uncached place from Google (live)", async () => {
    process.env.GOOGLE_MAPS_API_KEY = GOOGLE_KEY;
    await q(`DELETE FROM places WHERE google_place_id = $1 AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.place_id = places.id)`, [LIVE_PLACE_ID]);
    const cached = (await q(`SELECT 1 FROM places WHERE google_place_id = $1`, [LIVE_PLACE_ID])).length > 0;
    const raw = receipt({ brand: "live-place", total: 3500 });
    raw.place = { google_place_id: LIVE_PLACE_ID, resolved_via: "find_place_text" };
    const r = await A.applyExtraction({
      ...(await (async () => {
        const st = await stage(W);
        const rec = await A.recordExtraction({ ...st, origin: "stub", outcome: validate(raw), rawText: "X", final: true, stats: STATS });
        return { ...st, extractionId: rec.extractionId! };
      })()),
      stats: STATS,
    });
    check("written with the place linked", r.outcome === "written" && r.report?.place?.place_id !== null, json(r.report?.place));
    check(cached ? "it was already cached: a hit" : "fetched and inserted", r.report?.place?.cache === (cached ? "hit" : "inserted"));
  });
} else {
  skip("uncached place from Google (live)", "needs GOOGLE_MAPS_API_KEY and CHECK_APPLY_GOOGLE_PLACE_ID in this process's environment");
}

// ── Summary ────────────────────────────────────────────────────────────

await pool.end();
await appPool.end();
const ran = fixtures.filter((f) => !f.skipped);
const passed = ran.filter((f) => f.ok).length;
console.log(
  `\n${passed}/${ran.length} fixtures passed (${checks} checks)` +
    (fixtures.length > ran.length ? `, ${fixtures.length - ran.length} skipped` : "") +
    `\nworkspaces ${W.id} and ${W2.id}` +
    (serverLines > 0 ? `\n${serverLines} server log line(s) hidden; --verbose shows them` : ""),
);
if (failures.length > 0) {
  console.log(`\n${failures.length} failed check(s):`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
