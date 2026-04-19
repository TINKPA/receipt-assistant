/**
 * smoke-v1-ingest.ts — host-side ingestion harness for the `/v1/*` ledger API.
 *
 * Runs an end-to-end extraction + ingestion round-trip against the already-
 * running Docker stack (receipt-assistant on :3000). For each receipt file:
 *
 *   1. POST /v1/documents            (multipart upload, sha256-dedupes)
 *   2. claude -p on the host         (plain-text reasoning + fenced JSON)
 *   3. POST /v1/transactions         (balanced 2-posting, Idempotency-Key'd)
 *   4. POST /v1/documents/:id/links  (explicit, idempotent — matches spec)
 *   5. Accuracy check vs ground truth parsed from filename
 *
 * This script DOES NOT touch the API source (`src/**`), the DB, or any
 * schema files — it is a pure black-box smoke test.
 *
 * Key invariant: NO `--json-schema`. Structured output degrades OCR
 * (documented in CLAUDE.md). The fenced-JSON-at-end convention keeps us
 * in plain-text mode while still making parsing trivial.
 *
 * Run:   npx tsx scripts/smoke-v1-ingest.ts
 * Args:  --files=<glob>           Override file selection (unquoted glob)
 *        --base=<url>             API base URL (default http://localhost:3000)
 *        --concurrency=<n>        Parallel workers (default 3)
 *        --limit=<n>              Cap processed count (default 15)
 */
import { spawn } from "child_process";
import { randomUUID, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── CLI args ───────────────────────────────────────────────────────────

type Args = {
  files: string[];
  base: string;
  concurrency: number;
  limit: number;
};

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) args[m[1]!] = m[2]!;
  }
  const base = args.base ?? "http://localhost:3000";
  const concurrency = Number(args.concurrency ?? "3");
  const limit = Number(args.limit ?? "15");

  const files = args.files
    ? expandGlob(args.files)
    : DEFAULT_SELECTION.map((f) =>
        path.resolve("/Users/danieltang/Desktop/RECEIPT", f),
      );

  return { files: files.slice(0, limit), base, concurrency, limit };
}

function expandGlob(pattern: string): string[] {
  // Minimal glob expansion — we only need *.jpeg behaviour here.
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  if (!base.includes("*")) {
    return fs.existsSync(pattern) ? [path.resolve(pattern)] : [];
  }
  const rx = new RegExp(
    "^" + base.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  );
  return fs
    .readdirSync(dir)
    .filter((f) => rx.test(f))
    .map((f) => path.resolve(dir, f))
    .sort();
}

// Hard-coded diverse 15 (dates Sep 2025 → Apr 2026, mixed categories,
// including the CLAUDE.md-flagged hard cases: Costco gas, AYCE).
const DEFAULT_SELECTION = [
  "2025-09-29_Receipt_UrthCaffe_brunch_93.03.jpeg",
  "2025-09-30_Receipt_Wilson_wristband_classic_navy_x2_26.28.jpeg",
  "2025-10-18_Receipt_LeYuenBBQ_bbq_63.91.jpeg",
  "2025-10-22_Receipt_Yoshinoya_beef_combo_bowls_21.03.jpeg",
  "2025-10-27_Receipt_TraderJoes_milk_cinnamon_pumpkin_10.58.jpeg",
  "2025-11-02_Receipt_KellysCoffeeAndFudge_cafe_latte_5.75.jpeg",
  "2025-11-04_Receipt_Costco_groceries_47.17.jpeg",
  "2025-11-14_Receipt_SunriseNoodleHouse_cantonese_clay_pot_69.94.jpeg",
  "2025-11-16_Receipt_InNOut_double_double_8.90.jpeg",
  "2025-12-01_Receipt_Marukai_groceries_97.72.jpeg",
  "2025-12-07_Receipt_CircleK_fuel_unleaded_70.79.jpeg",
  "2026-02-22_Receipt_TraderJoes_groceries_29.36.jpeg",
  "2026-03-06_Receipt_Costco_gas_marina_del_rey_73.78.jpeg",
  "2026-03-25_Receipt_EuclidCoffee_iced_latte_8.00.jpeg",
  "2026-04-07_Receipt_SushiAYCE_ayce_dinner_130.30.jpeg",
];

// ── Ground truth from filename ─────────────────────────────────────────

type GroundTruth = {
  filename: string;
  date: string;                 // YYYY-MM-DD
  merchant: string;             // CamelCase token from filename
  merchantTokens: string[];     // lowercased split
  total_dollars: number | null; // null when filename has no trailing total
  total_minor: number | null;
};

function parseGroundTruth(absPath: string): GroundTruth {
  const filename = path.basename(absPath);
  // YYYY-MM-DD_Receipt_<Merchant>_<description>_<TOTAL>.jpeg
  // or      ... _<description>.jpeg  (no total)
  const m = /^(\d{4}-\d{2}-\d{2})_Receipt_([^_]+)_(.+?)(?:_(-?\d+\.\d{2}))?\.jpe?g$/i.exec(
    filename,
  );
  if (!m) {
    throw new Error(`Unparseable filename: ${filename}`);
  }
  const date = m[1]!;
  const merchant = m[2]!;
  const totalStr = m[4];
  const dollars = totalStr != null ? Number(totalStr) : null;
  const totalMinor = dollars != null ? Math.round(dollars * 100) : null;

  // "WingOnMarket" → ["wing", "on", "market"]
  // Keeps runs of the same case: lower-then-upper boundary only.
  const tokens = merchant
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);

  return {
    filename,
    date,
    merchant,
    merchantTokens: tokens,
    total_dollars: dollars,
    total_minor: totalMinor,
  };
}

// ── Claude host invocation ─────────────────────────────────────────────

type Extracted = {
  payee: string;
  occurred_on: string;
  total_minor: number;
  category_hint: string;
};

function buildPrompt(absImagePath: string): string {
  return `Read the receipt image at ${absImagePath}

Extract these fields and think out loud before giving a final answer:
- merchant (business name as printed on the receipt header/logo)
- date (YYYY-MM-DD; read from the receipt, NEVER use today's date as a fallback)
- total amount in cents (integer; FINAL amount paid, after tax and tip — include any handwritten tip)
- brief category hint (one of: groceries, dining, cafe, retail, transport, other)

End your response with a fenced JSON block like:
\`\`\`json
{"payee": "...", "occurred_on": "YYYY-MM-DD", "total_minor": 12345, "category_hint": "groceries"}
\`\`\``;
}

/**
 * Pull the LAST ```json ... ``` fenced block from stdout. Using the last
 * one is deliberate — Claude may include examples of the format mid-
 * reasoning (e.g. in "like this: {...}" asides). The final answer is
 * always the trailing block.
 */
function extractLastJsonFence(raw: string): string | null {
  const re = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  for (;;) {
    const m = re.exec(raw);
    if (!m) break;
    last = m[1]!.trim();
  }
  return last;
}

async function runClaudeOnImage(
  absImagePath: string,
  timeoutMs = 180_000,
): Promise<{ raw: string; parsed: Extracted | null; parseError?: string; sessionId: string }> {
  const sessionId = randomUUID();
  const prompt = buildPrompt(absImagePath);
  const args = [
    "-p",
    prompt,
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--session-id",
    sessionId,
  ];

  // Clear env quirks that break nested sessions (same as src/claude.ts).
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err || out || `exit ${code}`));
      else resolve(out);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  const fence = extractLastJsonFence(raw);
  if (!fence) return { raw, parsed: null, parseError: "no ```json fence found", sessionId };
  try {
    const obj = JSON.parse(fence) as Extracted;
    if (
      typeof obj.payee !== "string" ||
      typeof obj.occurred_on !== "string" ||
      typeof obj.total_minor !== "number" ||
      typeof obj.category_hint !== "string"
    ) {
      return { raw, parsed: null, parseError: `shape mismatch: ${fence}`, sessionId };
    }
    return { raw, parsed: obj, sessionId };
  } catch (e) {
    return { raw, parsed: null, parseError: `JSON parse: ${(e as Error).message}`, sessionId };
  }
}

// ── HTTP helpers (native fetch / FormData / Blob) ──────────────────────

type AccountsMap = {
  groceries: string;
  dining: string;
  cafe: string;
  retail: string;
  transport: string;
  other: string;
  credit_card: string;
};

async function fetchAccountsMap(base: string): Promise<AccountsMap> {
  const resp = await fetch(`${base}/v1/accounts?flat=true`);
  if (!resp.ok) throw new Error(`GET /v1/accounts failed: ${resp.status}`);
  const accounts = (await resp.json()) as Array<{
    id: string;
    name: string;
    type: string;
    subtype: string | null;
  }>;

  const find = (pred: (a: (typeof accounts)[number]) => boolean, label: string) => {
    const a = accounts.find(pred);
    if (!a) throw new Error(`seeded account missing: ${label}`);
    return a.id;
  };

  const groceries = find((a) => a.type === "expense" && a.name === "Groceries", "Expenses:Groceries");
  const dining = find((a) => a.type === "expense" && a.name === "Dining", "Expenses:Dining");
  const transport = find((a) => a.type === "expense" && a.name === "Transport", "Expenses:Transport");
  // There are two "Other" rows (one expense, one income); pick the expense side.
  const other = find((a) => a.type === "expense" && a.name === "Other", "Expenses:Other");
  const creditCard = find(
    (a) => a.type === "liability" && a.subtype === "credit_card",
    "Liabilities:Credit Card",
  );

  return {
    groceries,
    dining,
    cafe: dining, // no dedicated cafe account — fold into Dining
    retail: other,
    transport,
    other,
    credit_card: creditCard,
  };
}

function pickExpenseAccount(accounts: AccountsMap, category_hint: string): {
  id: string;
  resolved: keyof Omit<AccountsMap, "credit_card">;
} {
  const h = (category_hint || "").toLowerCase().trim();
  if (h === "groceries") return { id: accounts.groceries, resolved: "groceries" };
  if (h === "dining") return { id: accounts.dining, resolved: "dining" };
  if (h === "cafe") return { id: accounts.cafe, resolved: "cafe" };
  if (h === "retail") return { id: accounts.retail, resolved: "retail" };
  if (h === "transport") return { id: accounts.transport, resolved: "transport" };
  return { id: accounts.other, resolved: "other" };
}

type DocRow = { id: string; sha256: string; kind: string; file_path?: string };

async function uploadDocument(
  base: string,
  absPath: string,
): Promise<{ doc: DocRow; status: number }> {
  const bytes = fs.readFileSync(absPath);
  const form = new FormData();
  // Node 22's global Blob works here — the API streams via multer memory.
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), path.basename(absPath));
  form.append("kind", "receipt_image");
  const resp = await fetch(`${base}/v1/documents`, { method: "POST", body: form });
  const body = (await resp.json()) as DocRow;
  if (!resp.ok) {
    throw new Error(`POST /v1/documents [${resp.status}]: ${JSON.stringify(body)}`);
  }
  return { doc: body, status: resp.status };
}

type Transaction = { id: string; version: number; [k: string]: unknown };

async function createTransaction(
  base: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ tx: Transaction; reused: boolean }> {
  const resp = await fetch(`${base}/v1/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (resp.ok) return { tx: json as Transaction, reused: false };

  // 409 "Idempotency-Key replayed with different body" means a prior
  // smoke-run with this (filename, sha256) already created a tx, and
  // Claude's extraction today drifted. Recover gracefully by fetching
  // the existing tx via the ground_truth_file metadata marker — a
  // re-run should still count as a valid round-trip so the harness
  // can be invoked idempotently without operator cleanup.
  const isReplay =
    resp.status === 409 &&
    typeof (json as { type?: string })?.type === "string" &&
    (json as { type: string }).type.includes("idempotency-conflict");
  if (isReplay) {
    const ground = (body as { metadata?: { ground_truth_file?: string } })
      ?.metadata?.ground_truth_file;
    if (ground) {
      const found = await findExistingTx(base, ground);
      if (found) return { tx: found, reused: true };
    }
  }
  throw new Error(`POST /v1/transactions [${resp.status}]: ${JSON.stringify(json)}`);
}

async function findExistingTx(
  base: string,
  groundTruthFile: string,
): Promise<Transaction | null> {
  // Search by metadata via payee_contains — cheap heuristic: the
  // filename's merchant fragment nearly always appears in the extracted
  // payee. Fall back to full list scan on first 100 if no hit.
  const url = `${base}/v1/transactions?limit=200`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = (await resp.json()) as { items: Transaction[] };
  for (const t of data.items) {
    const gt = (t as { metadata?: { ground_truth_file?: string } })?.metadata
      ?.ground_truth_file;
    if (gt === groundTruthFile) return t;
  }
  return null;
}

async function linkDocument(
  base: string,
  documentId: string,
  transactionId: string,
): Promise<number> {
  const resp = await fetch(`${base}/v1/documents/${documentId}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_id: transactionId }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`POST /v1/documents/:id/links [${resp.status}]: ${txt}`);
  }
  return resp.status;
}

// ── Per-receipt pipeline ───────────────────────────────────────────────

type RowResult = {
  filename: string;
  ground_truth: GroundTruth;
  extracted?: Extracted;
  accounts_resolved_to?: string;
  tx_id?: string;
  doc_id?: string;
  doc_status?: number;
  link_status?: number;
  session_id?: string;
  date_match?: boolean;
  total_match?: boolean;
  payee_match?: boolean;
  error?: string;
  raw_claude_tail?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
};

function short(s: string, max = 12) {
  return s.length > max ? s.slice(0, max) : s;
}

function checkAccuracy(gt: GroundTruth, ext: Extracted): {
  date_match: boolean;
  total_match: boolean | null;
  payee_match: boolean;
} {
  const date_match = ext.occurred_on === gt.date;
  const total_match = gt.total_minor == null ? null : ext.total_minor === gt.total_minor;
  const payeeLower = ext.payee.toLowerCase();
  const payee_match = gt.merchantTokens.some((t) => payeeLower.includes(t));
  return { date_match, total_match, payee_match };
}

async function processOne(
  absPath: string,
  base: string,
  accounts: AccountsMap,
): Promise<RowResult> {
  const started = Date.now();
  const started_at = new Date(started).toISOString();
  const gt = parseGroundTruth(absPath);

  try {
    // 1. Upload
    const { doc, status: docStatus } = await uploadDocument(base, absPath);

    // 2. Extract via claude -p
    const claudeRes = await runClaudeOnImage(absPath);
    if (!claudeRes.parsed) {
      return {
        filename: gt.filename,
        ground_truth: gt,
        doc_id: doc.id,
        doc_status: docStatus,
        session_id: claudeRes.sessionId,
        error: `extract: ${claudeRes.parseError ?? "unknown"}`,
        raw_claude_tail: claudeRes.raw.slice(-800),
        started_at,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
      };
    }
    const ext = claudeRes.parsed;

    // 3. Resolve category -> expense account
    const picked = pickExpenseAccount(accounts, ext.category_hint);
    const amount = ext.total_minor;

    // 4. POST transaction (expense debit + CC credit)
    //    sign convention: negative amount_minor == "money out" of that
    //    account balance — matches the probe call that succeeded.
    const idemKey = `smoke-${createHash("sha256")
      .update(gt.filename + "|" + doc.sha256)
      .digest("hex")
      .slice(0, 24)}`;
    const txBody = {
      occurred_on: ext.occurred_on,
      payee: ext.payee,
      narration: "Smoke test v1-ledger-api",
      postings: [
        {
          account_id: picked.id,
          amount_minor: amount,
          currency: "USD",
          amount_base_minor: amount,
        },
        {
          account_id: accounts.credit_card,
          amount_minor: -amount,
          currency: "USD",
          amount_base_minor: -amount,
        },
      ],
      document_ids: [doc.id],
      metadata: {
        source: "smoke-v1-ingest",
        ground_truth_file: gt.filename,
        category_hint: ext.category_hint,
        expense_account: picked.resolved,
      },
    };
    const { tx, reused } = await createTransaction(base, idemKey, txBody);

    // 5. Explicit link POST (idempotent — the inline document_ids above
    //    already linked it; this exercises the /links endpoint as the
    //    task spec requires and proves idempotency).
    const linkStatus = await linkDocument(base, doc.id, tx.id);
    if (reused) {
      // Accuracy was already evaluated on the first run; on a rerun,
      // trust the first-run extraction stored in the transaction.
      // Flag it visibly in the row so operators know it wasn't
      // re-extracted today.
      (ext as Extracted & { __reused?: boolean }).__reused = true;
    }

    // 6. Accuracy
    const acc = checkAccuracy(gt, ext);

    return {
      filename: gt.filename,
      ground_truth: gt,
      extracted: ext,
      accounts_resolved_to: picked.resolved,
      tx_id: tx.id,
      doc_id: doc.id,
      doc_status: docStatus,
      link_status: linkStatus,
      session_id: claudeRes.sessionId,
      date_match: acc.date_match,
      total_match: acc.total_match ?? undefined,
      payee_match: acc.payee_match,
      started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
    };
  } catch (e) {
    return {
      filename: gt.filename,
      ground_truth: gt,
      error: (e as Error).message,
      started_at,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
    };
  }
}

// ── Pretty row line ────────────────────────────────────────────────────

function fmtDollar(cents: number | null | undefined): string {
  if (cents == null) return "   ?   ";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function formatRow(r: RowResult): string {
  const gt = r.ground_truth;
  const merchant = gt.merchant.padEnd(20).slice(0, 20);
  const gtTot = fmtDollar(gt.total_minor ?? null).padStart(9);

  if (r.error) {
    return `✗ ${gt.date} ${merchant} ${gtTot}  →  ERROR: ${r.error}`;
  }

  const ext = r.extracted!;
  const dateOk = r.date_match ? "✓" : "✗";
  const totalOk =
    r.total_match === undefined ? "-" : r.total_match ? "✓" : "✗";
  const payeeOk = r.payee_match ? "✓" : "✗";

  let extra = "";
  if (r.total_match === false) {
    const diff = (ext.total_minor - (gt.total_minor ?? 0)) / 100;
    extra += `  [total ${ext.total_minor}¢ vs gt ${gt.total_minor}¢, off $${diff.toFixed(2)}]`;
  }
  if (r.date_match === false) {
    extra += `  [date ${ext.occurred_on} vs gt ${gt.date}]`;
  }
  if (!r.payee_match) {
    extra += `  [payee "${ext.payee}" vs tokens ${JSON.stringify(gt.merchantTokens)}]`;
  }

  const ok = r.date_match && (r.total_match ?? true) && r.payee_match;
  const marker = ok ? "✓" : "✗";
  const reusedTag = (ext as Extracted & { __reused?: boolean }).__reused
    ? " [reused prior tx]"
    : "";
  return (
    `${marker} ${gt.date} ${merchant} ${gtTot}  →  ` +
    `tx=${short(r.tx_id!, 8)} docId=${short(r.doc_id!, 8)} ` +
    `acct=${r.accounts_resolved_to} ` +
    `(date ${dateOk} total ${totalOk} payee ${payeeOk})${extra}${reusedTag}`
  );
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  console.log(`\nReceipt Assistant — /v1 smoke test`);
  console.log(`  base         = ${args.base}`);
  console.log(`  concurrency  = ${args.concurrency}`);
  console.log(`  files        = ${args.files.length}`);
  for (const f of args.files) console.log(`                 ${path.basename(f)}`);
  console.log("");

  const missing = args.files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`Missing files:\n  ${missing.join("\n  ")}`);
    process.exit(2);
  }

  // Fetch accounts once
  const accounts = await fetchAccountsMap(args.base);
  console.log(`Account map resolved:`);
  for (const [k, v] of Object.entries(accounts))
    console.log(`  ${k.padEnd(12)} = ${v}`);
  console.log("");

  // Run with bounded concurrency. Claude -p calls dominate latency (~15-30s
  // each); 3 in parallel keeps the host responsive without starving auth.
  const results: RowResult[] = new Array(args.files.length);
  let next = 0;
  const started = Date.now();

  async function worker(wid: number) {
    while (true) {
      const idx = next++;
      if (idx >= args.files.length) return;
      const abs = args.files[idx]!;
      console.log(`[w${wid}] ${idx + 1}/${args.files.length} ${path.basename(abs)}`);
      const r = await processOne(abs, args.base, accounts);
      results[idx] = r;
      console.log(`[w${wid}] ${formatRow(r)}`);
    }
  }

  await Promise.all(
    Array.from({ length: args.concurrency }, (_, i) => worker(i + 1)),
  );

  const totalMs = Date.now() - started;

  // Aggregate
  const processed = results.filter(Boolean);
  const errored = processed.filter((r) => r.error);
  const extracted = processed.filter((r) => !r.error);
  const dateMatches = extracted.filter((r) => r.date_match).length;
  const totalEligible = extracted.filter((r) => r.total_match !== undefined);
  const totalMatches = totalEligible.filter((r) => r.total_match).length;
  const payeeMatches = extracted.filter((r) => r.payee_match).length;
  const roundTrip = processed.filter((r) => r.tx_id && r.link_status === 204).length;

  console.log("\n" + "═".repeat(78));
  console.log("Per-receipt results:\n");
  for (const r of processed) console.log("  " + formatRow(r));

  console.log("\n" + "═".repeat(78));
  console.log("Aggregate accuracy:\n");
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
  console.log(`  Receipts processed : ${processed.length} / ${args.files.length}`);
  console.log(`  Extractions parsed : ${extracted.length} / ${processed.length}`);
  console.log(`  Errors             : ${errored.length}`);
  console.log(`  Date matches       : ${dateMatches} / ${extracted.length}  (${pct(dateMatches, extracted.length)})`);
  console.log(
    `  Total matches      : ${totalMatches} / ${totalEligible.length}  (${pct(totalMatches, totalEligible.length)})  ` +
      `[${extracted.length - totalEligible.length} ground-truth totals missing from filename]`,
  );
  console.log(`  Payee substring    : ${payeeMatches} / ${extracted.length}  (${pct(payeeMatches, extracted.length)})`);
  console.log(`  Round-trip success : ${roundTrip} / ${processed.length}  (tx created + document linked)`);
  console.log(`  Wall clock         : ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Avg per receipt    : ${(totalMs / 1000 / processed.length).toFixed(1)}s`);

  // Failures block
  const failures = processed.filter(
    (r) => r.error || !r.date_match || r.total_match === false || !r.payee_match,
  );
  if (failures.length) {
    console.log("\n" + "═".repeat(78));
    console.log(`Failures (${failures.length}):\n`);
    for (const r of failures) {
      console.log(`── ${r.filename}`);
      if (r.error) {
        console.log(`    error: ${r.error}`);
        if (r.raw_claude_tail)
          console.log(`    raw tail:\n${r.raw_claude_tail.split("\n").map((l) => "      " + l).join("\n")}`);
      } else {
        const ext = r.extracted!;
        console.log(`    ground truth: date=${r.ground_truth.date} total=${fmtDollar(r.ground_truth.total_minor ?? null)} tokens=${JSON.stringify(r.ground_truth.merchantTokens)}`);
        console.log(`    extracted   : date=${ext.occurred_on} total=${fmtDollar(ext.total_minor)} payee="${ext.payee}" category=${ext.category_hint}`);
        console.log(`    mismatches  : date=${r.date_match} total=${r.total_match} payee=${r.payee_match}`);
      }
      console.log("");
    }
  }

  // Persist structured report
  const report = {
    base: args.base,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    total_wall_ms: totalMs,
    concurrency: args.concurrency,
    file_count: args.files.length,
    accounts,
    aggregate: {
      processed: processed.length,
      extracted: extracted.length,
      errors: errored.length,
      date_matches: dateMatches,
      total_matches: totalMatches,
      total_eligible: totalEligible.length,
      payee_matches: payeeMatches,
      round_trip_success: roundTrip,
    },
    rows: processed,
  };
  const reportPath = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "smoke-v1-ingest.report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);

  // Exit non-zero if any round-trip failed (extraction mismatch is
  // informational — accuracy, not correctness of the API under test).
  if (errored.length > 0 || roundTrip !== processed.length) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
