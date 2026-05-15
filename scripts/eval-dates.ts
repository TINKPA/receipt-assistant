/**
 * eval-dates.ts — Date-OCR evaluation harness for issue #27 AC#3.
 *
 * Round-trips a manifest of fixtures through the live `/v1/ingest/batch`
 * worker pipeline (single-call agent flow, post-#32 ledger API) and
 * scores extracted (date, total, payee) per fixture against committed
 * ground truth in `scripts/eval-dates.fixtures.json`.
 *
 * Per fixture, the harness:
 *   1. Re-encodes the source JPG (sips) so a fresh SHA bumps past
 *      dedupe and forces the worker to actually run claude on it.
 *   2. Uploads via multipart POST /v1/ingest/batch (all fixtures in
 *      one batch).
 *   3. Polls GET /v1/batches/<id> until every item reaches a terminal
 *      status (done / unsupported / error). Aborts on 5-min timeout.
 *   4. For each `done` item, GET /v1/transactions/<id> to pull
 *      occurred_on / payee / postings[].amount_minor.
 *   5. Scores per bucket (see eval-dates.md for pass criteria).
 *   6. Emits scripts/eval-dates.report.{json,md}.
 *
 * No `--json-schema`, no DB writes, no auth headers (seed-workspace
 * middleware). Single-file; only deps are tsx + Node built-ins.
 *
 * CLI:
 *   --base <url>           API base, default http://localhost:3000
 *   --manifest <path>      Fixture manifest, default scripts/eval-dates.fixtures.json
 *   --uploads-dir <path>   SHA-named JPG root, default the iCloud project's data/uploads/uploads
 *   --limit <n>            Cap fixture count, default all
 *   --gate                 Exit 1 if aggregate date_accuracy < 0.9 (AC#1)
 *
 * Run: `npm run eval:dates` (or `npx tsx scripts/eval-dates.ts`).
 */
import { spawn } from "child_process";
import { readFile, writeFile, mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────

type Bucket = "hard_date" | "hard_total" | "hard_all" | "good_rejects" | "good";

interface Fixture {
  sha256: string;
  original_filename: string;
  bucket: Bucket;
  ground_truth: {
    date: string;
    merchant_tokens: string[];
    total_minor: number | null;
  };
  expected_status: "done" | "unsupported" | "error";
  notes: string;
}

interface BatchItem {
  ingest_id: string;
  filename: string;
  status: "queued" | "processing" | "done" | "unsupported" | "error";
  produced: {
    transaction_ids: string[];
    document_ids: string[];
    receipt_ids: string[];
  } | null;
  error: string | null;
}

interface Transaction {
  id: string;
  occurred_on: string;
  payee: string | null;
  postings: { amount_minor: number; currency: string }[];
}

interface FixtureResult {
  fixture: Fixture;
  ingest_id: string | null;
  ingest_status: string;
  ingest_error: string | null;
  transaction_id: string | null;
  extracted: {
    occurred_on: string | null;
    payee: string | null;
    total_minor: number | null;
  };
  scoring: {
    date_match: boolean | null;
    total_match: boolean | null;
    payee_match: boolean | null;
    status_match: boolean;
    bucket_pass: boolean;
  };
  duration_ms: number;
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]!] = m[2] ?? true;
  }
  const HOME = process.env.HOME!;
  return {
    base: (args.base as string) ?? "http://localhost:3000",
    manifest: (args.manifest as string) ?? path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "eval-dates.fixtures.json",
    ),
    uploadsDir: (args["uploads-dir"] as string)
      ?? process.env.UPLOADS_DIR
      ?? path.join(
        HOME,
        "Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads",
      ),
    limit: args.limit ? Number(args.limit) : undefined,
    gate: args.gate === true || args.gate === "true",
  };
}

// ── Re-encode via sips (bumps SHA past dedupe) ─────────────────────────

async function sipsReencode(srcPath: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "sips",
      ["-s", "format", "jpeg", "-s", "formatOptions", "75",
       srcPath, "--out", outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sips exit ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

// ── HTTP helpers ───────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${url} → ${r.status}: ${body.slice(0, 500)}`);
  }
  return r.json() as Promise<T>;
}

interface CreateBatchResponse {
  batchId: string;
  status: string;
  items: { ingestId: string; filename: string; mime_type: string | null }[];
  poll: string;
}

async function postBatch(
  base: string,
  files: { filename: string; bytes: Uint8Array }[],
): Promise<CreateBatchResponse> {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([f.bytes as BlobPart], { type: "image/jpeg" }), f.filename);
  }
  return fetchJson<CreateBatchResponse>(`${base}/v1/ingest/batch`, {
    method: "POST",
    body: form,
  });
}

interface BatchRow {
  id: string;
  status: string;
  items: BatchItem[];
}

async function getBatch(base: string, id: string): Promise<BatchRow> {
  type ApiBatchItem = {
    id: string;
    filename: string;
    status: BatchItem["status"];
    produced: BatchItem["produced"];
    error: string | null;
  };
  const raw = await fetchJson<{ id: string; status: string; items: ApiBatchItem[] }>(
    `${base}/v1/batches/${id}`,
  );
  return {
    id: raw.id,
    status: raw.status,
    items: raw.items.map((r) => ({
      ingest_id: r.id,
      filename: r.filename,
      status: r.status,
      produced: r.produced,
      error: r.error,
    })),
  };
}

async function getTransaction(base: string, id: string): Promise<Transaction> {
  const t = await fetchJson<{
    id: string;
    occurred_on: string;
    payee: string | null;
    postings: { amount_minor: number; currency: string }[];
  }>(`${base}/v1/transactions/${id}`);
  return t;
}

// ── Poll until terminal ────────────────────────────────────────────────

const TERMINAL = new Set<BatchItem["status"]>(["done", "unsupported", "error"]);

async function pollBatch(
  base: string,
  batchId: string,
  fixtureCount: number,
  timeoutMs: number,
): Promise<BatchRow> {
  const start = Date.now();
  let last: BatchRow | null = null;
  let lastDoneCount = -1;
  while (Date.now() - start < timeoutMs) {
    const row = await getBatch(base, batchId);
    const done = row.items.filter((i) => TERMINAL.has(i.status)).length;
    if (done !== lastDoneCount) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.error(`  [${elapsed}s] ${done}/${fixtureCount} terminal`);
      lastDoneCount = done;
    }
    if (done === fixtureCount) return row;
    last = row;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Batch ${batchId} did not finish in ${timeoutMs}ms; last state: ${JSON.stringify(
      last?.items.map((i) => ({ filename: i.filename, status: i.status })),
    )}`,
  );
}

// ── Scoring ────────────────────────────────────────────────────────────

function score(
  fx: Fixture,
  ingest_status: string,
  ext: { occurred_on: string | null; payee: string | null; total_minor: number | null },
): FixtureResult["scoring"] {
  const status_match = ingest_status === fx.expected_status;

  const dateMatch =
    ext.occurred_on == null ? null : ext.occurred_on === fx.ground_truth.date;

  const totalMatch =
    fx.ground_truth.total_minor == null || ext.total_minor == null
      ? null
      : ext.total_minor === fx.ground_truth.total_minor;

  const payeeLower = (ext.payee ?? "").toLowerCase();
  const payeeMatch =
    ext.payee == null
      ? null
      : fx.ground_truth.merchant_tokens.some((t) => payeeLower.includes(t));

  // Bucket-specific pass:
  // - good_rejects: status must be `unsupported` (no extraction needed)
  // - good: date+total+payee all match (or null total ⇒ skipped)
  // - hard_date: date_match focal; total/payee informational
  // - hard_total: total_match focal
  // - hard_all: all three must match (the WingHopFung-style fixture
  //            is the hardest gate, the one a prompt fix needs to clear).
  let bucket_pass = false;
  if (fx.bucket === "good_rejects") {
    bucket_pass = ingest_status === "unsupported";
  } else if (ingest_status !== "done") {
    bucket_pass = false; // expected `done` but got error/unsupported
  } else if (fx.bucket === "good") {
    bucket_pass = !!(dateMatch && (totalMatch ?? true) && payeeMatch);
  } else if (fx.bucket === "hard_date") {
    bucket_pass = !!dateMatch;
  } else if (fx.bucket === "hard_total") {
    bucket_pass = !!totalMatch;
  } else if (fx.bucket === "hard_all") {
    bucket_pass = !!(dateMatch && totalMatch && payeeMatch);
  }

  return {
    date_match: dateMatch,
    total_match: totalMatch,
    payee_match: payeeMatch,
    status_match,
    bucket_pass,
  };
}

// ── Reporting ──────────────────────────────────────────────────────────

interface Aggregate {
  total_fixtures: number;
  extracted_count: number;
  date_match_count: number;
  date_accuracy: number;
  total_match_count: number;
  total_accuracy: number;
  payee_match_count: number;
  payee_accuracy: number;
  bucket_summary: Record<string, { pass: number; total: number }>;
}

function aggregate(results: FixtureResult[]): Aggregate {
  const extracted = results.filter((r) => r.scoring.date_match !== null);
  const dateOk = extracted.filter((r) => r.scoring.date_match === true).length;
  const totalCandidates = extracted.filter((r) => r.scoring.total_match !== null);
  const totalOk = totalCandidates.filter((r) => r.scoring.total_match === true).length;
  const payeeCandidates = extracted.filter((r) => r.scoring.payee_match !== null);
  const payeeOk = payeeCandidates.filter((r) => r.scoring.payee_match === true).length;

  const bucketSummary: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    const b = r.fixture.bucket;
    bucketSummary[b] ??= { pass: 0, total: 0 };
    bucketSummary[b].total += 1;
    if (r.scoring.bucket_pass) bucketSummary[b].pass += 1;
  }

  return {
    total_fixtures: results.length,
    extracted_count: extracted.length,
    date_match_count: dateOk,
    date_accuracy: extracted.length === 0 ? 0 : dateOk / extracted.length,
    total_match_count: totalOk,
    total_accuracy: totalCandidates.length === 0 ? 0 : totalOk / totalCandidates.length,
    payee_match_count: payeeOk,
    payee_accuracy: payeeCandidates.length === 0 ? 0 : payeeOk / payeeCandidates.length,
    bucket_summary: bucketSummary,
  };
}

function renderMarkdown(
  agg: Aggregate,
  results: FixtureResult[],
  meta: { batchId: string; durationMs: number; base: string },
): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push(`# Date-OCR eval baseline — ${new Date().toISOString().slice(0, 19)}Z`);
  lines.push("");
  lines.push(`Batch \`${meta.batchId}\` · ${(meta.durationMs / 1000).toFixed(1)}s · ${meta.base}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value | n |");
  lines.push("|---|---|---|");
  lines.push(`| **Date accuracy** | **${pct(agg.date_accuracy)}** | ${agg.date_match_count} / ${agg.extracted_count} |`);
  lines.push(`| Total accuracy | ${pct(agg.total_accuracy)} | ${agg.total_match_count} / ${agg.extracted_count} |`);
  lines.push(`| Payee accuracy | ${pct(agg.payee_accuracy)} | ${agg.payee_match_count} / ${agg.extracted_count} |`);
  lines.push("");

  lines.push("## By bucket");
  lines.push("");
  lines.push("| Bucket | Pass | Total |");
  lines.push("|---|---|---|");
  for (const [b, s] of Object.entries(agg.bucket_summary)) {
    lines.push(`| \`${b}\` | ${s.pass} | ${s.total} |`);
  }
  lines.push("");

  lines.push("## Per-fixture");
  lines.push("");
  lines.push("| Bucket | Filename | Status | Date (got → want) | Total (got → want) | Payee | Pass |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    const gtDate = r.fixture.ground_truth.date;
    const gtTotal = r.fixture.ground_truth.total_minor;
    const dateCell = r.extracted.occurred_on
      ? `${r.extracted.occurred_on === gtDate ? "✅" : "❌"} ${r.extracted.occurred_on}${r.extracted.occurred_on !== gtDate ? ` → ${gtDate}` : ""}`
      : "—";
    const totalCell =
      r.extracted.total_minor == null || gtTotal == null
        ? "—"
        : `${r.extracted.total_minor === gtTotal ? "✅" : "❌"} ${(r.extracted.total_minor / 100).toFixed(2)}${r.extracted.total_minor !== gtTotal ? ` → ${(gtTotal / 100).toFixed(2)}` : ""}`;
    const payeeCell = r.extracted.payee
      ? `${r.scoring.payee_match ? "✅" : "❌"} ${r.extracted.payee}`
      : "—";
    const pass = r.scoring.bucket_pass ? "✅" : "❌";
    lines.push(
      `| \`${r.fixture.bucket}\` | ${r.fixture.original_filename} | ${r.ingest_status} | ${dateCell} | ${totalCell} | ${payeeCell} | ${pass} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(`# eval-dates`);
  console.error(`  base:        ${args.base}`);
  console.error(`  manifest:    ${args.manifest}`);
  console.error(`  uploads-dir: ${args.uploadsDir}`);

  const manifest = JSON.parse(await readFile(args.manifest, "utf8")) as Fixture[];
  const fixtures = args.limit ? manifest.slice(0, args.limit) : manifest;
  console.error(`  fixtures:    ${fixtures.length} (${manifest.length} in manifest)`);

  // 1. Re-encode each source file into a temp dir.
  const tmp = await mkdtemp(path.join(tmpdir(), "eval-dates-"));
  console.error(`  tmp:         ${tmp}`);
  const cleanup = async () => rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });

  const start = Date.now();
  console.error(`\n[1/4] sips re-encoding ${fixtures.length} fixtures...`);
  const files: { fixture: Fixture; filename: string; bytes: Uint8Array }[] = [];
  for (const fx of fixtures) {
    const src = path.join(args.uploadsDir, `${fx.sha256}.jpg`);
    try { await stat(src); } catch {
      throw new Error(`Missing source JPG: ${src} (for fixture ${fx.original_filename})`);
    }
    const out = path.join(tmp, `${fx.sha256}.jpg`);
    await sipsReencode(src, out);
    files.push({
      fixture: fx,
      filename: fx.original_filename,
      bytes: new Uint8Array(await readFile(out)),
    });
  }

  // 2. Upload one batch.
  console.error(`\n[2/4] POST /v1/ingest/batch (${files.length} files, ~${(files.reduce((s, f) => s + f.bytes.length, 0) / 1024 / 1024).toFixed(1)} MB)`);
  const batch = await postBatch(args.base, files);
  console.error(`  batchId:     ${batch.batchId}`);

  // Pair each fixture with its returned ingest_id (by filename + upload order).
  // The API returns items in upload order, so we just zip them.
  if (batch.items.length !== files.length) {
    throw new Error(`Batch items count ${batch.items.length} != files count ${files.length}`);
  }
  const ingestByFx = new Map<Fixture, string>();
  files.forEach((f, i) => ingestByFx.set(f.fixture, batch.items[i]!.ingestId));

  // 3. Poll until terminal.
  console.error(`\n[3/4] Polling /v1/batches/${batch.batchId} until all terminal (timeout 30 min)`);
  const batchRow = await pollBatch(args.base, batch.batchId, files.length, 30 * 60 * 1000);
  await cleanup();

  // 4. For each fixture, pull transaction details + score.
  console.error(`\n[4/4] Fetching transactions and scoring`);
  const itemByIngest = new Map(batchRow.items.map((i) => [i.ingest_id, i]));
  const results: FixtureResult[] = [];
  for (const fx of fixtures) {
    const ingestId = ingestByFx.get(fx)!;
    const item = itemByIngest.get(ingestId)!;
    const t0 = Date.now();

    let occurred_on: string | null = null;
    let payee: string | null = null;
    let total_minor: number | null = null;
    let txId: string | null = null;
    if (item.status === "done") {
      txId = item.produced?.transaction_ids[0] ?? null;
      if (txId) {
        try {
          const tx = await getTransaction(args.base, txId);
          occurred_on = tx.occurred_on;
          payee = tx.payee;
          // Total = max absolute amount across postings (the expense leg).
          // Double-entry guarantees one positive + one negative; absolute
          // values agree.
          const amts = tx.postings.map((p) => Math.abs(p.amount_minor));
          total_minor = amts.length > 0 ? Math.max(...amts) : null;
        } catch (e) {
          console.error(`  warn: GET /v1/transactions/${txId} failed: ${(e as Error).message}`);
        }
      }
    }

    const scoring = score(fx, item.status, { occurred_on, payee, total_minor });
    results.push({
      fixture: fx,
      ingest_id: ingestId,
      ingest_status: item.status,
      ingest_error: item.error,
      transaction_id: txId,
      extracted: { occurred_on, payee, total_minor },
      scoring,
      duration_ms: Date.now() - t0,
    });
  }

  const durationMs = Date.now() - start;
  const agg = aggregate(results);

  // 5. Write reports.
  const reportDir = path.dirname(args.manifest);
  const jsonOut = {
    generated_at: new Date().toISOString(),
    batchId: batch.batchId,
    base: args.base,
    duration_ms: durationMs,
    aggregate: agg,
    fixtures: results,
  };
  await writeFile(path.join(reportDir, "eval-dates.report.json"), JSON.stringify(jsonOut, null, 2));
  await writeFile(
    path.join(reportDir, "eval-dates.report.md"),
    renderMarkdown(agg, results, { batchId: batch.batchId, durationMs, base: args.base }),
  );

  // 6. Console summary + gate.
  console.error(`\nDone in ${(durationMs / 1000).toFixed(1)}s.`);
  console.error(`Date accuracy: ${(agg.date_accuracy * 100).toFixed(1)}% (${agg.date_match_count}/${agg.extracted_count})`);
  console.error(`Reports: ${path.join(reportDir, "eval-dates.report.{json,md}")}`);

  if (args.gate && agg.date_accuracy < 0.9) {
    console.error(`\nGATE FAILED: date accuracy ${(agg.date_accuracy * 100).toFixed(1)}% < 90%`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
