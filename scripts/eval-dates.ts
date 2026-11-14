/**
 * eval-dates.ts — extraction accuracy harness (#27, and the wave-1 A/B).
 *
 * Round-trips a manifest of real documents through the live
 * `/v1/ingest/batch` worker pipeline and scores what the agent wrote
 * against ground truth: date, total and payee as since #27, plus
 * classification, flow (purchase / refund / income) and currency. It also
 * records, per document, the model the run was stamped with and the one
 * the transcript shows, turns and billed tokens. Full contract, manifest
 * format and pass rules: scripts/eval-dates.md.
 *
 * Per trial, the harness:
 *   1. (--reset) runs scripts/sandbox-reset.sh, so every document is new
 *      to the ledger. Without it a copy from an earlier trial is found as
 *      a near-duplicate and nothing is extracted.
 *   2. Copies each fixture under a new sha256 without changing what the
 *      agent reads: images through `sips` (as since #27), PDFs with bytes
 *      appended after the final %%EOF (the text layer survives; `sips`
 *      would rasterise the page), emails with one extra header line, HTML
 *      with a trailing comment. A fixture whose source file is missing is
 *      reported and skipped, never fatal.
 *   3. Uploads the copies with their real content type and polls until
 *      every ingest is terminal (done / unsupported / error / dedup /
 *      near_dup) and the batch has finished reconciling.
 *   4. Reads each transaction over the API, scores it, finds the agent's
 *      transcript by ingest id, and (--dump) writes the rows the run left
 *      in the database to a directory outside the repo.
 *   5. Writes `eval-dates.<run id>.report.{json,md}`.
 *
 * It talks to the HTTP API and, only with --dump, to Postgres with
 * read-only transactions. No auth headers (seed-workspace middleware), no
 * `--json-schema`. Deps: tsx, Node built-ins, `pg`.
 *
 * CLI — `--key=value`, or a bare `--flag` for the switches. The space form
 * (`--limit 5`) and unknown flags are refused; until wave 1 they were bound
 * to `true` silently, and `--limit 5` ran ONE fixture.
 *   --base=<url>          API base. Default http://127.0.0.1:3001 (the sandbox).
 *   --allow-production    Allow a base on port 3000, production's port. Every
 *                         fixture becomes a transaction in that ledger.
 *   --manifest=<path>     Default scripts/eval-dates.fixtures.json (corpus C1).
 *   --uploads-dir=<path>  Where fixture sources live. Default the iCloud
 *                         project's data/uploads/uploads (or $UPLOADS_DIR).
 *   --limit=<n>           Take the first n manifest entries.
 *   --trials=<n>          Run the set n times, one batch per trial. Default 1.
 *   --reset               Run scripts/sandbox-reset.sh before every trial.
 *                         Required when --trials > 1.
 *   --run-id=<id>         Default ed-<UTC timestamp>-<4 hex>.
 *   --label=<text>        Free text on the report, e.g. "arm A".
 *   --out=<dir>           Report directory. Default the manifest's directory.
 *   --dump=<dir>          Write each fixture's rows as JSON under
 *                         <dir>/<run id>/t<trial>/. Needs --pg. Refused
 *                         inside this repository: the rows are real receipts.
 *   --pg=<url>            Postgres of the stack under test (sandbox:
 *                         postgresql://postgres:postgres@127.0.0.1:5433/receipts).
 *   --transcripts=<dir>   Session JSONL directory of the stack under test.
 *                         Default the sandbox's; `none` to skip.
 *   --timeout-min=<n>     Per-trial polling timeout. Default 60.
 *   --gate                Exit 1 if aggregate date accuracy < 0.9 (#27 AC#1).
 *   --dry-run             Resolve and copy every fixture, check the copies, and
 *                         stop: no upload, no server, no model calls.
 *   --rescore=<batch id>[,<batch id>]
 *                         Score batches that already ran, with the current
 *                         manifest and code: no reset, no upload, no model
 *                         calls. Fixtures are matched to items by upload
 *                         filename. For corrected ground truth, or to dump
 *                         a run after the fact.
 *
 * Run: `npm run eval:dates -- --reset` against a sandbox that is up.
 */
import { spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";
import pg from "pg";

// ── Types ──────────────────────────────────────────────────────────────

type Bucket =
  | "hard_date"
  | "hard_total"
  | "hard_all"
  | "good_rejects"
  | "good"
  | "duplicate";
const BUCKETS: readonly Bucket[] = [
  "hard_date",
  "hard_total",
  "hard_all",
  "good_rejects",
  "good",
  "duplicate",
];

type Flow = "purchase" | "refund" | "income";
type SourceKind = "image" | "pdf" | "eml" | "html";
type IngestStatus = "queued" | "processing" | "done" | "error" | "unsupported" | "dedup" | "near_dup";

interface GroundTruth {
  /** YYYY-MM-DD. Not scored on a `duplicate` or `good_rejects` fixture. */
  date: string | null;
  /** Lowercase; the payee passes if it contains any of them. */
  merchant_tokens: string[];
  /** Signed minor units of `currency`, as the ledger books it: a refund is
   *  scored on its magnitude. Null skips the total. */
  total_minor: number | null;
  /** Default USD. A points currency is its ledger code (`HYATT_PT`). */
  currency?: string;
  /** Default purchase. */
  flow?: Flow;
  /** Default from the file: image → receipt_image, pdf → receipt_pdf,
   *  eml → receipt_email, html → either of receipt_email / receipt_pdf
   *  (production has filed saved pages under both). */
  classification?: string | string[];
  /** Key of another fixture in the same manifest that is the same money
   *  event. This one must not book a second transaction. */
  duplicate_of?: string;
}

interface Fixture {
  /** Stable name in reports and dumps. Default: document_id, else the
   *  first 12 hex of sha256. */
  key?: string;
  /** Source is `<uploads-dir>/<sha256>.<ext>` (corpus C1). */
  sha256?: string;
  /** Source is `<uploads-dir>/<stored_path>`: `documents.file_path` of the
   *  production row (corpus C2). */
  stored_path?: string;
  /** Production document id. Provenance only; never sent anywhere. */
  document_id?: string;
  /** Filename the copy is uploaded as. Default `<key>.<ext>`. The prompt
   *  never contains it. */
  original_filename?: string;
  bucket: Bucket;
  ground_truth: GroundTruth;
  /** One status or several acceptable ones. */
  expected_status: IngestStatus | IngestStatus[];
  notes?: string;
}

interface Prepared {
  fixture: Fixture;
  key: string;
  kind: SourceKind;
  source: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
}

/** A fixture ready to copy: everything but the copy itself. */
type Ready = Omit<Prepared, "bytes" | "sha256">;

interface Skipped {
  key: string;
  reason: string;
}

interface Extracted {
  occurred_on: string | null;
  payee: string | null;
  total_minor: number | null;
  currency: string | null;
  currencies: string[];
  flow: Flow | null;
  classification: string | null;
  /** `metadata.extraction.model`: what the run was told it is. */
  model_stamped: string | null;
  prompt_version: string | null;
  writer: string | null;
}

interface Scoring {
  date_match: boolean | null;
  total_match: boolean | null;
  payee_match: boolean | null;
  classification_match: boolean | null;
  flow_match: boolean | null;
  currency_match: boolean | null;
  status_match: boolean;
  bucket_pass: boolean;
}

interface SessionSummary {
  session_id: string;
  model_observed: string | null;
  turns: number;
  tool_calls: number;
  billed_input: number;
  cache_read: number;
  cache_creation: number;
  fresh_input: number;
  output: number;
  wall_s: number | null;
}

interface FixtureResult {
  key: string;
  bucket: Bucket;
  trial: number;
  filename: string;
  kind: SourceKind;
  /** Null under --rescore (the copy is not at hand). */
  upload_sha256: string | null;
  batch_id: string;
  ingest_id: string;
  ingest_status: string;
  ingest_error: string | null;
  transaction_id: string | null;
  document_id: string | null;
  /** PDFs only: the stored bytes equal the upload and still carry text. */
  pdf_text_layer: boolean | null;
  extracted: Extracted;
  scoring: Scoring;
  session: SessionSummary | null;
  /** `agent_runs.id`, once run records exist (--pg). */
  agent_run_id: string | null;
}

// ── CLI ────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME = homedir();

const VALUE_FLAGS = [
  "base", "manifest", "uploads-dir", "limit", "trials", "run-id", "label",
  "out", "dump", "pg", "transcripts", "timeout-min", "rescore",
] as const;
const BARE_FLAGS = ["allow-production", "reset", "gate", "dry-run"] as const;

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unexpected argument ${JSON.stringify(a)}: flags are --key=value or a bare --flag`);
    const [, k, v] = m as unknown as [string, string, string | undefined];
    if ((VALUE_FLAGS as readonly string[]).includes(k)) {
      // The space form (`--limit 5`) used to bind `true` and run ONE fixture.
      if (v === undefined) throw new Error(`--${k} needs a value: --${k}=<value>`);
      args[k] = v;
    } else if ((BARE_FLAGS as readonly string[]).includes(k)) {
      if (v !== undefined && v !== "true") throw new Error(`--${k} takes no value`);
      args[k] = true;
    } else {
      throw new Error(`unknown flag --${k}`);
    }
  }
  const str = (k: (typeof VALUE_FLAGS)[number]) => args[k] as string | undefined;
  const flag = (k: (typeof BARE_FLAGS)[number]) => args[k] === true;
  const num = (k: (typeof VALUE_FLAGS)[number], dflt: number) => {
    const v = str(k);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${k} must be a positive integer, got ${JSON.stringify(v)}`);
    return n;
  };
  const manifest = path.resolve(str("manifest") ?? path.join(SCRIPT_DIR, "eval-dates.fixtures.json"));
  const transcripts = str("transcripts");
  return {
    base: (str("base") ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    allowProduction: flag("allow-production"),
    manifest,
    uploadsDir:
      str("uploads-dir") ??
      process.env.UPLOADS_DIR ??
      path.join(HOME, "Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads"),
    limit: str("limit") !== undefined ? num("limit", 0) : undefined,
    trials: num("trials", 1),
    reset: flag("reset"),
    runId: str("run-id") ?? defaultRunId(),
    label: str("label") ?? null,
    out: path.resolve(str("out") ?? path.dirname(manifest)),
    dump: str("dump") ? path.resolve(str("dump")!) : null,
    pg: str("pg") ?? null,
    transcripts:
      transcripts === "none"
        ? null
        : path.resolve(
            transcripts ?? path.join(HOME, "Developer/receipt-assistant-data/test-claude/projects/-app"),
          ),
    timeoutMs: num("timeout-min", 60) * 60_000,
    rescore: str("rescore") ? str("rescore")!.split(",").map((x) => x.trim()).filter(Boolean) : null,
    gate: flag("gate"),
    dryRun: flag("dry-run"),
  };
}
type Args = ReturnType<typeof parseArgs>;

function defaultRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `ed-${ts}-${randomBytes(2).toString("hex")}`;
}

function checkArgs(args: Args): void {
  const url = new URL(args.base);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port === "3000" && !args.allowProduction) {
    throw new Error(
      `--base=${args.base} is on port 3000, production's port. Every fixture would be booked in ` +
        `that ledger. Run against the sandbox (http://127.0.0.1:3001, reset first), or pass ` +
        `--allow-production if that really is what you want.`,
    );
  }
  if (args.trials > 1 && !args.reset) {
    throw new Error(
      `--trials=${args.trials} needs --reset: the second trial's copies would be found as ` +
        `near-duplicates of the first trial's (same pHash, same identifiers) and nothing would be extracted.`,
    );
  }
  if (args.dump && !args.pg) throw new Error("--dump needs --pg=<postgres url of the stack under test>");
  if (args.rescore && (args.reset || args.trials > 1)) {
    throw new Error("--rescore scores batches that already ran; it takes neither --reset nor --trials");
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(args.runId)) {
    throw new Error(`--run-id may hold letters, digits, '.', '_' and '-' only (got ${JSON.stringify(args.runId)})`);
  }
  if (args.dump) {
    for (const root of repositoryRoots()) {
      if (isInside(args.dump, root)) {
        throw new Error(
          `--dump=${args.dump} is inside the repository (${root}). The dump holds real receipts; ` +
            `write it outside any checkout.`,
        );
      }
    }
  }
}

/** This checkout and, when it is a worktree, the main checkout it hangs off. */
function repositoryRoots(): string[] {
  const roots = new Set<string>([realpathOr(REPO_ROOT)]);
  const common = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (common.status === 0 && common.stdout.trim()) {
    roots.add(realpathOr(path.dirname(common.stdout.trim())));
  }
  return [...roots];
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `p` is `root` or below it. `p` may not exist yet. */
function isInside(p: string, root: string): boolean {
  let probe = path.resolve(p);
  const tail: string[] = [];
  // Resolve the deepest existing ancestor so a symlinked parent counts.
  for (;;) {
    try {
      probe = path.join(realpathSync(probe), ...tail.reverse());
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
  const rel = path.relative(root, probe);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ── Manifest ───────────────────────────────────────────────────────────

const STATUSES: readonly IngestStatus[] = ["queued", "processing", "done", "error", "unsupported", "dedup", "near_dup"];
const TERMINAL = new Set<string>(["done", "unsupported", "error", "dedup", "near_dup"]);

function fixtureKey(fx: Fixture): string {
  return fx.key ?? fx.document_id ?? (fx.sha256 ? fx.sha256.slice(0, 12) : "?");
}

/** Problems with one entry; empty when it can run. */
function validateFixture(fx: Fixture): string[] {
  const errs: string[] = [];
  if (!fx || typeof fx !== "object") return ["not an object"];
  if (!fx.sha256 && !fx.stored_path) errs.push("needs sha256 or stored_path");
  if (fx.stored_path && (path.isAbsolute(fx.stored_path) || fx.stored_path.split(/[\\/]/).includes(".."))) {
    errs.push("stored_path must be relative to the uploads dir");
  }
  if (!BUCKETS.includes(fx.bucket)) errs.push(`unknown bucket ${JSON.stringify(fx.bucket)}`);
  const gt = fx.ground_truth;
  if (!gt || typeof gt !== "object") errs.push("needs ground_truth");
  else {
    if (gt.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(gt.date)) errs.push(`ground_truth.date ${JSON.stringify(gt.date)} is not YYYY-MM-DD`);
    if (!Array.isArray(gt.merchant_tokens)) errs.push("ground_truth.merchant_tokens must be an array");
    if (gt.total_minor != null && !Number.isSafeInteger(gt.total_minor)) errs.push("ground_truth.total_minor must be an integer");
    if (gt.flow && !["purchase", "refund", "income"].includes(gt.flow)) errs.push(`unknown flow ${JSON.stringify(gt.flow)}`);
    if (fx.bucket === "duplicate" && !gt.duplicate_of) errs.push("a duplicate fixture needs ground_truth.duplicate_of");
  }
  for (const s of [fx.expected_status].flat()) {
    if (!STATUSES.includes(s)) errs.push(`unknown expected_status ${JSON.stringify(s)}`);
  }
  return errs;
}

// ── Sources and copies ─────────────────────────────────────────────────

const KIND_BY_EXT: Record<string, SourceKind> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".heic": "image",
  ".webp": "image",
  ".pdf": "pdf",
  ".eml": "eml",
  ".html": "html",
  ".htm": "html",
};

const MIME_BY_KIND: Record<SourceKind, string> = {
  image: "image/jpeg", // every image is re-encoded to JPEG
  pdf: "application/pdf",
  eml: "message/rfc822",
  html: "text/html",
};

const UPLOAD_EXT: Record<SourceKind, string> = { image: ".jpg", pdf: ".pdf", eml: ".eml", html: ".html" };

const DEFAULT_CLASSIFICATION: Record<SourceKind, string[]> = {
  image: ["receipt_image"],
  pdf: ["receipt_pdf"],
  eml: ["receipt_email"],
  html: ["receipt_email", "receipt_pdf"],
};

async function locateSource(
  fx: Fixture,
  uploadsDir: string,
  bySha: Map<string, string[]>,
): Promise<{ path: string } | { missing: string }> {
  if (fx.stored_path) {
    const p = path.join(uploadsDir, fx.stored_path);
    try {
      await stat(p);
      return { path: p };
    } catch {
      return { missing: `source file not found: ${p}` };
    }
  }
  const hits = bySha.get(fx.sha256!.toLowerCase()) ?? [];
  if (hits.length === 0) return { missing: `no file named ${fx.sha256}.* in ${uploadsDir}` };
  if (hits.length > 1) return { missing: `ambiguous source, several files named ${fx.sha256}.*: ${hits.join(", ")}` };
  return { path: path.join(uploadsDir, hits[0]!) };
}

function run(cmd: string, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (e) => resolve({ code: null, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sipsReencode(srcPath: string, outPath: string): Promise<void> {
  const r = await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "75", srcPath, "--out", outPath]);
  if (r.code !== 0) throw new Error(`sips exit ${r.code}: ${r.stderr.trim()}`);
}

/**
 * A copy with a new sha256 and the same content for the reader.
 *
 * PDF: bytes after the final `%%EOF` are outside the document. Readers find
 * the trailer by scanning back from the end, so a short comment line there
 * leaves pages, fonts and the text layer as they were. (`sips`, which this
 * harness used for every file until wave 1, rasterises a PDF into a JPEG
 * and loses the text the agent's PDF path reads first.)
 * Email: one `X-Eval-Nonce` header before the first line. Appending to the
 * body instead would corrupt a single-part base64 body.
 * HTML: a trailing comment, which the decoded text never shows.
 */
async function makeCopy(kind: SourceKind, src: string, tmp: string, nonce: string): Promise<Uint8Array> {
  if (kind === "image") {
    const out = path.join(tmp, `${nonce}.jpg`);
    await sipsReencode(src, out);
    return new Uint8Array(await readFile(out));
  }
  const bytes = await readFile(src);
  if (kind === "pdf") {
    if (bytes.lastIndexOf("%%EOF") === -1) throw new Error("not a PDF: no %%EOF marker");
    const sep = bytes[bytes.length - 1] === 0x0a ? "" : "\n";
    return new Uint8Array(Buffer.concat([bytes, Buffer.from(`${sep}%eval-dates ${nonce}\n`, "latin1")]));
  }
  if (kind === "eml") {
    const crlf = bytes.subarray(0, 4096).includes("\r\n");
    return new Uint8Array(Buffer.concat([Buffer.from(`X-Eval-Nonce: ${nonce}${crlf ? "\r\n" : "\n"}`, "latin1"), bytes]));
  }
  return new Uint8Array(Buffer.concat([bytes, Buffer.from(`\n<!-- eval-dates ${nonce} -->\n`, "utf8")]));
}

let pdftotextAvailable: boolean | null = null;
async function pdfText(bytes: Uint8Array, tmp: string): Promise<string | null> {
  if (pdftotextAvailable === false) return null;
  const p = path.join(tmp, `probe-${randomBytes(4).toString("hex")}.pdf`);
  await writeFile(p, bytes);
  const r = await run("pdftotext", ["-layout", p, "-"]);
  await rm(p, { force: true });
  if (r.code === null) {
    pdftotextAvailable = false;
    return null;
  }
  pdftotextAvailable = true;
  return r.code === 0 ? r.stdout : "";
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// ── HTTP ───────────────────────────────────────────────────────────────

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
  items: { ingestId: string; filename: string; mime_type: string | null }[];
}

async function postBatch(base: string, files: Prepared[]): Promise<CreateBatchResponse> {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.bytes as BlobPart], { type: f.mime }), f.filename);
  return fetchJson<CreateBatchResponse>(`${base}/v1/ingest/batch`, { method: "POST", body: form });
}

interface ApiIngest {
  id: string;
  filename: string;
  status: IngestStatus;
  classification: string | null;
  produced: { transaction_ids: string[]; document_ids: string[] } | null;
  error: string | null;
}
interface ApiBatch {
  id: string;
  status: string;
  items: ApiIngest[];
}

interface ApiTransaction {
  id: string;
  occurred_on: string;
  payee: string | null;
  metadata: Record<string, unknown> | null;
  postings: { amount_minor: number; currency: string; account_type: string }[];
}

/** Batch states that mean reconcile may still rewrite transactions. */
const BATCH_BUSY = new Set(["pending", "processing", "reconciling"]);

async function pollBatches(base: string, ids: string[], timeoutMs: number): Promise<Map<string, ApiBatch>> {
  const start = Date.now();
  let lastLine = "";
  for (;;) {
    const rows = await Promise.all(ids.map((id) => fetchJson<ApiBatch>(`${base}/v1/batches/${id}`)));
    const items = rows.flatMap((r) => r.items);
    const terminal = items.filter((i) => TERMINAL.has(i.status)).length;
    const busy = rows.filter((r) => BATCH_BUSY.has(r.status)).map((r) => r.status);
    const line = `${terminal}/${items.length} terminal` + (terminal === items.length && busy.length ? `, batch ${busy.join(",")}` : "");
    if (line !== lastLine) {
      console.error(`  [${Math.floor((Date.now() - start) / 1000)}s] ${line}`);
      lastLine = line;
    }
    if (terminal === items.length && busy.length === 0) return new Map(rows.map((r) => [r.id, r]));
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `batches ${ids.join(", ")} not finished after ${Math.round(timeoutMs / 60000)} min: ` +
          JSON.stringify(items.map((i) => ({ filename: i.filename, status: i.status }))),
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ── Reading a transaction ──────────────────────────────────────────────

function emptyExtracted(classification: string | null): Extracted {
  return {
    occurred_on: null,
    payee: null,
    total_minor: null,
    currency: null,
    currencies: [],
    flow: null,
    classification,
    model_stamped: null,
    prompt_version: null,
    writer: null,
  };
}

/**
 * Flow, currency and total from the postings, the way the ledger means
 * them (#221): an income leg makes it income; otherwise the sign of the
 * expense legs separates a purchase from a refund. The scored currency is
 * the spend leg's (a points stay with a cash part has two; the points one
 * is the transaction's currency). The total is the largest magnitude in
 * that currency, which is the mirror leg, so a split across several
 * expense accounts still scores as one total.
 */
function readMoney(tx: ApiTransaction): Pick<Extracted, "total_minor" | "currency" | "currencies" | "flow"> {
  const income = tx.postings.filter((p) => p.account_type === "income");
  const expense = tx.postings.filter((p) => p.account_type === "expense");
  const spend = income.length > 0 ? income : expense;
  const currencies = [...new Set(spend.map((p) => p.currency))].sort();
  let flow: Flow | null = null;
  if (income.length > 0) flow = "income";
  else if (expense.length > 0) flow = expense.reduce((s, p) => s + p.amount_minor, 0) < 0 ? "refund" : "purchase";

  let currency: string | null = currencies.find((c) => c.endsWith("_PT")) ?? null;
  if (!currency && currencies.length > 0) {
    const bySize = currencies.map((c) => ({
      c,
      size: spend.filter((p) => p.currency === c).reduce((s, p) => s + Math.abs(p.amount_minor), 0),
    }));
    bySize.sort((a, b) => b.size - a.size);
    currency = bySize[0]!.c;
  }
  const inCurrency = tx.postings.filter((p) => currency === null || p.currency === currency);
  const amounts = inCurrency.map((p) => Math.abs(p.amount_minor));
  return { total_minor: amounts.length > 0 ? Math.max(...amounts) : null, currency, currencies, flow };
}

// ── Transcripts ────────────────────────────────────────────────────────

/**
 * Turns and tokens of one session JSONL, grouped by `message.id`: the CLI
 * writes one record per content block and repeats the turn's `usage` on
 * each, so counting records double counts (see the header of
 * scripts/measure-ingest-turns.ts). Billed input is fresh + cache read +
 * cache write.
 *
 * Wave 1 moves the server's copy of this parser into
 * src/session-transcript.ts (`summarizeSession`) and stores the result on
 * `agent_runs`; switch to that once it exists.
 */
function summarizeJsonl(text: string, sessionId: string): SessionSummary {
  const turns = new Map<string, { usage: Record<string, number>; tools: number }>();
  let model: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn last line of a live session
    }
    const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(t)) {
      first ??= t;
      last = t;
    }
    if (rec.type !== "assistant") continue;
    const msg = rec.message ?? {};
    if (msg.model && msg.model !== "<synthetic>") model ??= msg.model;
    const id: string = msg.id ?? `_noid_${turns.size}`;
    let turn = turns.get(id);
    if (!turn) {
      turn = { usage: msg.usage ?? {}, tools: 0 };
      turns.set(id, turn);
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) if (b?.type === "tool_use") turn.tools++;
  }
  const sum = (k: string) => [...turns.values()].reduce((s, t) => s + (Number(t.usage[k]) || 0), 0);
  const fresh = sum("input_tokens");
  const read = sum("cache_read_input_tokens");
  const write = sum("cache_creation_input_tokens");
  return {
    session_id: sessionId,
    model_observed: model,
    turns: turns.size,
    tool_calls: [...turns.values()].reduce((s, t) => s + t.tools, 0),
    billed_input: fresh + read + write,
    cache_read: read,
    cache_creation: write,
    fresh_input: fresh,
    output: sum("output_tokens"),
    wall_s: first !== null && last !== null ? Math.round((last - first) / 1000) : null,
  };
}

/** Find each ingest's session: its id is in the prompt, the first user record. */
async function findSessions(dir: string, sinceMs: number, ingestIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    console.error(`  transcripts: ${dir} not readable; turns and tokens are not recorded`);
    return found;
  }
  const wanted = new Set(ingestIds);
  for (const name of names) {
    if (wanted.size === 0) break;
    const p = path.join(dir, name);
    const st = await stat(p).catch(() => null);
    if (!st || st.mtimeMs < sinceMs) continue;
    const text = await readFile(p, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      let rec: { type?: string; message?: { content?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "user") continue;
      const content = rec.message?.content;
      const prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
      for (const id of wanted) {
        if (prompt.includes(id)) {
          found.set(id, p);
          wanted.delete(id);
          break;
        }
      }
      break; // only the first user record is the prompt
    }
  }
  return found;
}

// ── Scoring ────────────────────────────────────────────────────────────

function expectedClassifications(fx: Fixture, kind: SourceKind): string[] {
  const gt = fx.ground_truth.classification;
  if (gt) return [gt].flat();
  if (fx.bucket === "good_rejects") return ["unsupported"];
  return DEFAULT_CLASSIFICATION[kind];
}

function score(
  fx: Fixture,
  kind: SourceKind,
  status: string,
  ext: Extracted,
  twinTx: string | null,
  ownTx: string | null,
  bookedNew: boolean,
): Scoring {
  const gt = fx.ground_truth;
  const status_match = [fx.expected_status].flat().includes(status as IngestStatus);
  const date_match = ext.occurred_on == null || gt.date == null ? null : ext.occurred_on === gt.date;
  const total_match =
    gt.total_minor == null || ext.total_minor == null ? null : ext.total_minor === Math.abs(gt.total_minor);
  const payee_match =
    ext.payee == null || gt.merchant_tokens.length === 0
      ? null
      : gt.merchant_tokens.some((t) => ext.payee!.toLowerCase().includes(t.toLowerCase()));
  const classification_match =
    ext.classification == null ? null : expectedClassifications(fx, kind).includes(ext.classification);
  const flow_match = ext.flow == null ? null : ext.flow === (gt.flow ?? "purchase");
  const currency_match = ext.currency == null ? null : ext.currency === (gt.currency ?? "USD");

  // Bucket pass, unchanged from #27 for the five original buckets, except
  // that a field the ground truth leaves out (a null date: nothing printed
  // says when) is skipped instead of failing. The three new fields are
  // scored and aggregated on their own (wave-1 gate G1 (c)), not folded in.
  const need = (gtHas: boolean, m: boolean | null) => !gtHas || m === true;
  let bucket_pass = false;
  if (fx.bucket === "good_rejects") bucket_pass = status === "unsupported";
  else if (fx.bucket === "duplicate") {
    // Not a second booking: no transaction of its own, or the twin's.
    bucket_pass = status_match && (!bookedNew || (ownTx !== null && ownTx === twinTx));
  } else if (status !== "done") bucket_pass = false;
  else if (fx.bucket === "good") {
    bucket_pass =
      need(gt.date != null, date_match) &&
      (total_match ?? true) &&
      need(gt.merchant_tokens.length > 0, payee_match);
  }
  else if (fx.bucket === "hard_date") bucket_pass = !!date_match;
  else if (fx.bucket === "hard_total") bucket_pass = !!total_match;
  else if (fx.bucket === "hard_all") bucket_pass = !!(date_match && total_match && payee_match);
  return { date_match, total_match, payee_match, classification_match, flow_match, currency_match, status_match, bucket_pass };
}

// ── Dump (SELECT only) ─────────────────────────────────────────────────

async function openReadOnly(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
  await client.connect();
  const ro = await client.query("SHOW default_transaction_read_only");
  if (ro.rows[0]?.default_transaction_read_only !== "on") {
    await client.end();
    throw new Error("--pg connection is not read-only; refusing to dump");
  }
  return client;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${name}`]);
  return r.rows[0]?.ok === true;
}

/**
 * Everything one ingest left behind, as rows. Whole rows (`to_jsonb`), so
 * the dump keeps up with migrations without edits here; the arm diff
 * (wave-1 P4) picks its fields from them.
 */
async function dumpIngest(client: pg.Client, ingestId: string, hasRuns: boolean): Promise<Record<string, unknown>> {
  const one = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows.map((r) => r.j);
  const ingest = (await one("SELECT to_jsonb(i) AS j FROM ingests i WHERE i.id = $1", [ingestId]))[0] ?? null;
  const produced = (ingest as { produced?: { transaction_ids?: string[]; document_ids?: string[] } } | null)?.produced;
  const docIds = new Set<string>(produced?.document_ids ?? []);
  for (const r of await one("SELECT to_jsonb(d.id) AS j FROM documents d WHERE d.source_ingest_id = $1", [ingestId])) {
    docIds.add(r as string);
  }
  const links = await one("SELECT to_jsonb(l) AS j FROM document_links l WHERE l.document_id = ANY($1::uuid[])", [[...docIds]]);
  const txIds = new Set<string>(produced?.transaction_ids ?? []);
  for (const l of links as { transaction_id: string }[]) txIds.add(l.transaction_id);
  for (const r of await one("SELECT to_jsonb(t.id) AS j FROM transactions t WHERE t.source_ingest_id = $1", [ingestId])) {
    txIds.add(r as string);
  }
  const tx = [...txIds];
  const transactions = await one("SELECT to_jsonb(t) AS j FROM transactions t WHERE t.id = ANY($1::uuid[])", [tx]);
  const placeIds = (transactions as { place_id?: string }[]).map((t) => t.place_id).filter(Boolean);
  const merchantIds = (transactions as { merchant_id?: string }[]).map((t) => t.merchant_id).filter(Boolean);
  return {
    ingest,
    documents: await one("SELECT to_jsonb(d) AS j FROM documents d WHERE d.id = ANY($1::uuid[])", [[...docIds]]),
    document_links: links,
    transactions,
    postings: await one(
      `SELECT to_jsonb(p) || jsonb_build_object('account_name', a.name, 'account_type', a.type) AS j
         FROM postings p JOIN accounts a ON a.id = p.account_id
        WHERE p.transaction_id = ANY($1::uuid[]) ORDER BY p.transaction_id, p.created_at, p.id`,
      [tx],
    ),
    transaction_items: await one(
      "SELECT to_jsonb(i) AS j FROM transaction_items i WHERE i.transaction_id = ANY($1::uuid[]) ORDER BY i.transaction_id, i.line_no",
      [tx],
    ),
    transaction_parties: await one(
      "SELECT to_jsonb(p) AS j FROM transaction_parties p WHERE p.transaction_id = ANY($1::uuid[])",
      [tx],
    ),
    transaction_events: await one(
      "SELECT to_jsonb(e) AS j FROM transaction_events e WHERE e.transaction_id = ANY($1::uuid[]) ORDER BY e.created_at",
      [tx],
    ),
    places: await one("SELECT to_jsonb(p) - 'raw_response' AS j FROM places p WHERE p.id = ANY($1::uuid[])", [placeIds]),
    merchants: await one("SELECT to_jsonb(m) AS j FROM merchants m WHERE m.id = ANY($1::uuid[])", [merchantIds]),
    owned_items: await one(
      `SELECT to_jsonb(o) AS j FROM owned_items o
         JOIN transaction_items i ON i.id = o.transaction_item_id
        WHERE i.transaction_id = ANY($1::uuid[])`,
      [tx],
    ),
    reconcile_proposals: await one(
      "SELECT to_jsonb(r) AS j FROM reconcile_proposals r WHERE r.payload::text LIKE ANY($1::text[])",
      [tx.map((id) => `%${id}%`)],
    ).catch(() => []),
    agent_runs: hasRuns
      ? await one("SELECT to_jsonb(r) AS j FROM agent_runs r WHERE r.ingest_id = $1", [ingestId]).catch(() => [])
      : [],
  };
}

// ── Aggregates ─────────────────────────────────────────────────────────

const FIELDS = ["date", "total", "payee", "classification", "flow", "currency"] as const;
type Field = (typeof FIELDS)[number];
const fieldOf = (s: Scoring, f: Field): boolean | null => s[`${f}_match` as keyof Scoring] as boolean | null;

interface FieldAgg {
  correct: number;
  scored: number;
  accuracy: number;
}

function aggregate(results: FixtureResult[]) {
  const fields = Object.fromEntries(
    FIELDS.map((f) => {
      const scored = results.filter((r) => fieldOf(r.scoring, f) !== null);
      const correct = scored.filter((r) => fieldOf(r.scoring, f) === true).length;
      return [f, { correct, scored: scored.length, accuracy: scored.length ? correct / scored.length : 0 }];
    }),
  ) as Record<Field, FieldAgg>;
  const buckets: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    buckets[r.bucket] ??= { pass: 0, total: 0 };
    buckets[r.bucket]!.total++;
    if (r.scoring.bucket_pass) buckets[r.bucket]!.pass++;
  }
  const sessions = results.map((r) => r.session).filter((s): s is SessionSummary => s !== null);
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };
  const statuses: Record<string, number> = {};
  for (const r of results) statuses[r.ingest_status] = (statuses[r.ingest_status] ?? 0) + 1;
  return {
    fixtures: results.length,
    statuses,
    fields,
    buckets,
    cost: {
      sessions_found: sessions.length,
      median_turns: median(sessions.map((s) => s.turns)),
      median_billed_input: median(sessions.map((s) => s.billed_input)),
      median_output: median(sessions.map((s) => s.output)),
      median_wall_s: median(sessions.map((s) => s.wall_s ?? 0)),
      total_billed_input: sessions.reduce((a, s) => a + s.billed_input, 0),
    },
    models_stamped: [...new Set(results.map((r) => r.extracted.model_stamped).filter(Boolean))],
    models_observed: [...new Set(sessions.map((s) => s.model_observed).filter(Boolean))],
  };
}

type Verdict = "pass" | "fail" | "split" | "n/a";

/** Per fixture and field, the majority over trials (wave-1 gate G1). */
function majority(results: FixtureResult[]) {
  const byKey = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  return [...byKey.entries()].map(([key, rs]) => {
    const verdict = (vals: (boolean | null)[]): Verdict => {
      const t = vals.filter((v) => v === true).length;
      const f = vals.filter((v) => v === false).length;
      if (t + f === 0) return "n/a";
      const n = vals.length;
      if (t * 2 > n) return "pass";
      if (f * 2 > n) return "fail";
      return "split";
    };
    return {
      key,
      bucket: rs[0]!.bucket,
      trials: rs.length,
      bucket_pass: verdict(rs.map((r) => r.scoring.bucket_pass)),
      ...Object.fromEntries(FIELDS.map((f) => [f, verdict(rs.map((r) => fieldOf(r.scoring, f)))])),
    } as { key: string; bucket: Bucket; trials: number; bucket_pass: Verdict } & Record<Field, Verdict>;
  });
}

// ── Report ─────────────────────────────────────────────────────────────

interface Report {
  run_id: string;
  label: string | null;
  generated_at: string;
  base: string;
  server: unknown;
  manifest: string;
  trials: number;
  duration_ms: number;
  skipped: Skipped[];
  aggregate: ReturnType<typeof aggregate>;
  per_trial: { trial: number; batch_ids: string[]; aggregate: ReturnType<typeof aggregate> }[];
  majority: ReturnType<typeof majority>;
  fixtures: FixtureResult[];
}

function renderMarkdown(rep: Report): string {
  const pct = (a: FieldAgg) => (a.scored ? `${((a.correct / a.scored) * 100).toFixed(1)}%` : "—");
  const n = (x: number | null) => (x == null ? "—" : x.toLocaleString("en-US"));
  const mark = (v: boolean | null) => (v === null ? "—" : v ? "✅" : "❌");
  const L: string[] = [];
  const agg = rep.aggregate;
  L.push(`# Extraction eval ${rep.run_id}${rep.label ? ` (${rep.label})` : ""}`);
  L.push("");
  L.push(
    `${rep.generated_at.slice(0, 19)}Z · ${rep.base} · ${rep.trials} trial(s) · ${(rep.duration_ms / 60000).toFixed(1)} min · ` +
      `manifest \`${path.basename(rep.manifest)}\``,
  );
  const srv = rep.server as { gitSha?: string; promptVersion?: string } | null;
  if (srv) L.push(`Server: \`${JSON.stringify(srv)}\``);
  L.push(`Models stamped: ${agg.models_stamped.join(", ") || "—"} · observed: ${agg.models_observed.join(", ") || "—"}`);
  L.push("");
  L.push("## Fields (all trials)");
  L.push("");
  L.push("| Field | Accuracy | Correct / scored |");
  L.push("|---|---|---|");
  for (const f of FIELDS) L.push(`| ${f} | ${pct(agg.fields[f])} | ${agg.fields[f].correct} / ${agg.fields[f].scored} |`);
  L.push("");
  L.push(`Statuses: ${Object.entries(agg.statuses).map(([s, c]) => `${s} ${c}`).join(", ")}`);
  L.push("");
  L.push("## Buckets (all trials)");
  L.push("");
  L.push("| Bucket | Pass | Total |");
  L.push("|---|---|---|");
  for (const [b, s] of Object.entries(agg.buckets)) L.push(`| \`${b}\` | ${s.pass} | ${s.total} |`);
  L.push("");
  L.push("## Cost");
  L.push("");
  L.push(
    `Sessions found ${agg.cost.sessions_found} of ${agg.fixtures} · median turns ${n(agg.cost.median_turns)} · ` +
      `median billed input ${n(agg.cost.median_billed_input)} · median output ${n(agg.cost.median_output)} · ` +
      `median wall ${n(agg.cost.median_wall_s)} s · total billed input ${n(agg.cost.total_billed_input)}`,
  );
  L.push("");
  if (rep.trials > 1) {
    L.push("## Per fixture, majority over trials");
    L.push("");
    L.push(`| Fixture | Bucket | Pass | ${FIELDS.join(" | ")} |`);
    L.push(`|---|---|---|${FIELDS.map(() => "---").join("|")}|`);
    for (const m of rep.majority) {
      L.push(`| \`${m.key}\` | \`${m.bucket}\` | ${m.bucket_pass} | ${FIELDS.map((f) => m[f]).join(" | ")} |`);
    }
    L.push("");
  }
  L.push("## Per run");
  L.push("");
  L.push("| Trial | Fixture | Bucket | Status | Class | Flow | Ccy | Date | Total | Payee | Pass | Turns | Billed in | Model |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.fixtures) {
    const e = r.extracted;
    const s = r.scoring;
    L.push(
      `| ${r.trial} | \`${r.key}\` | \`${r.bucket}\` | ${r.ingest_status} | ${mark(s.classification_match)} ${e.classification ?? ""} | ` +
        `${mark(s.flow_match)} ${e.flow ?? ""} | ${mark(s.currency_match)} ${e.currency ?? ""} | ` +
        `${mark(s.date_match)} ${e.occurred_on ?? ""} | ${mark(s.total_match)} ${e.total_minor ?? ""} | ` +
        `${mark(s.payee_match)} ${e.payee ?? ""} | ${s.bucket_pass ? "✅" : "❌"} | ${n(r.session?.turns ?? null)} | ` +
        `${n(r.session?.billed_input ?? null)} | ${r.session?.model_observed ?? e.model_stamped ?? "—"} |`,
    );
  }
  L.push("");
  const errors = rep.fixtures.filter((r) => r.ingest_error && r.ingest_status === "error");
  if (errors.length) {
    L.push("## Errors");
    L.push("");
    for (const r of errors) L.push(`- t${r.trial} \`${r.key}\`: ${r.ingest_error!.replace(/\s+/g, " ").slice(0, 300)}`);
    L.push("");
  }
  const pdfs = rep.fixtures.filter((r) => r.pdf_text_layer !== null);
  if (pdfs.length) {
    L.push(`PDF text layer kept on the stored file: ${pdfs.filter((r) => r.pdf_text_layer).length} of ${pdfs.length}.`);
    L.push("");
  }
  if (rep.skipped.length) {
    L.push("## Skipped");
    L.push("");
    for (const s of rep.skipped) L.push(`- \`${s.key}\`: ${s.reason}`);
    L.push("");
  }
  return L.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────

async function resetSandbox(): Promise<void> {
  console.error("  sandbox-reset.sh");
  const r = spawnSync(path.join(SCRIPT_DIR, "sandbox-reset.sh"), [], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`scripts/sandbox-reset.sh exited ${r.status}; not running a trial on a dirty ledger`);
}

interface Uploaded {
  file: Ready;
  /** sha256 of the uploaded copy; null when adopting a batch (--rescore). */
  sha256: string | null;
  ingestId: string;
}

/** Reset (if asked), copy, upload. One batch per 50 files. */
async function uploadTrial(
  args: Args,
  trial: number,
  prepared: Ready[],
  tmp: string,
): Promise<{ uploaded: Uploaded[]; batchIds: string[]; startedAt: number }> {
  if (args.reset) await resetSandbox();
  const startedAt = Date.now();
  const files: Prepared[] = [];
  for (const [i, p] of prepared.entries()) {
    const bytes = await makeCopy(p.kind, p.source, tmp, `${args.runId}.t${trial}.${i}`);
    files.push({ ...p, bytes, sha256: sha256Hex(bytes) });
  }
  const uploaded: Uploaded[] = [];
  const batchIds: string[] = [];
  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const mb = chunk.reduce((s, f) => s + f.bytes.length, 0) / 1024 / 1024;
    const batch = await postBatch(args.base, chunk);
    if (batch.items.length !== chunk.length) {
      throw new Error(`batch ${batch.batchId} has ${batch.items.length} items for ${chunk.length} files`);
    }
    chunk.forEach((f, j) => {
      const { bytes: _bytes, sha256, ...file } = f;
      uploaded.push({ file, sha256, ingestId: batch.items[j]!.ingestId });
    });
    batchIds.push(batch.batchId);
    console.error(`  POST /v1/ingest/batch → ${batch.batchId} (${chunk.length} files, ${mb.toFixed(1)} MB)`);
  }
  return { uploaded, batchIds, startedAt };
}

/** --rescore: pair existing batch items with fixtures by upload filename. */
async function adoptBatches(
  args: Args,
  prepared: Ready[],
  batchIds: string[],
): Promise<{ uploaded: Uploaded[]; batchIds: string[]; startedAt: number }> {
  const byName = new Map(prepared.map((p) => [p.filename, p]));
  const uploaded: Uploaded[] = [];
  let startedAt = Infinity;
  for (const id of batchIds) {
    const b = await fetchJson<ApiBatch & { created_at: string }>(`${args.base}/v1/batches/${id}`);
    startedAt = Math.min(startedAt, Date.parse(b.created_at));
    for (const it of b.items) {
      const file = byName.get(it.filename);
      if (!file) {
        console.error(`  warn: ${it.filename} in batch ${id} matches no fixture; ignored`);
        continue;
      }
      byName.delete(it.filename);
      uploaded.push({ file, sha256: null, ingestId: it.id });
    }
  }
  for (const p of byName.values()) console.error(`  warn: ${p.key} is not in the batches; not scored`);
  return { uploaded, batchIds, startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
}

/** Wait for the batches, then read, score and (--dump) dump every fixture. */
async function collectTrial(
  args: Args,
  trial: number,
  run: { uploaded: Uploaded[]; batchIds: string[]; startedAt: number },
  tmp: string,
  db: { client: pg.Client; hasRuns: boolean } | null,
): Promise<FixtureResult[]> {
  const batches = await pollBatches(args.base, run.batchIds, args.timeoutMs);
  const items = new Map<string, ApiIngest & { batch_id: string }>();
  for (const [id, b] of batches) for (const it of b.items) items.set(it.id, { ...it, batch_id: id });

  const sessions = args.transcripts
    ? await findSessions(args.transcripts, run.startedAt - 60_000, run.uploaded.map((u) => u.ingestId))
    : new Map<string, string>();

  // Each fixture's transaction, to score a duplicate against its twin's.
  const txOfKey = new Map<string, string | null>();
  const results: FixtureResult[] = [];
  for (const { file: f, sha256, ingestId } of run.uploaded) {
    const item = items.get(ingestId)!;
    const produced = item.produced ?? { transaction_ids: [], document_ids: [] };
    const txId = produced.transaction_ids[0] ?? null;
    txOfKey.set(f.key, txId);
    let extracted = emptyExtracted(item.classification);
    if (txId && item.status === "done") {
      try {
        const tx = await fetchJson<ApiTransaction>(`${args.base}/v1/transactions/${txId}`);
        const ex = (tx.metadata?.extraction ?? {}) as Record<string, unknown>;
        extracted = {
          ...extracted,
          occurred_on: tx.occurred_on,
          payee: tx.payee,
          ...readMoney(tx),
          model_stamped: typeof ex.model === "string" ? ex.model : null,
          prompt_version: typeof ex.prompt_version === "string" ? ex.prompt_version : null,
          writer: typeof ex.writer === "string" ? ex.writer : null,
        };
      } catch (e) {
        console.error(`  warn: GET /v1/transactions/${txId}: ${(e as Error).message}`);
      }
    }

    // A PDF must arrive as uploaded and still carry its text layer.
    let pdfTextLayer: boolean | null = null;
    const docId = produced.document_ids[0] ?? null;
    if (f.kind === "pdf" && docId) {
      const r = await fetch(`${args.base}/v1/documents/${docId}/content`);
      if (r.ok) {
        const stored = new Uint8Array(await r.arrayBuffer());
        const text = await pdfText(stored, tmp);
        pdfTextLayer = (sha256 === null || sha256Hex(stored) === sha256) && (text === null || text.trim().length > 0);
      }
    }

    const sessionPath = sessions.get(ingestId);
    const session = sessionPath
      ? summarizeJsonl(await readFile(sessionPath, "utf8"), path.basename(sessionPath, ".jsonl"))
      : null;

    let agentRunId: string | null = null;
    if (db?.hasRuns) {
      const r = await db.client
        .query(
          "SELECT (to_jsonb(r)->>'id') AS id FROM agent_runs r WHERE (to_jsonb(r)->>'ingest_id') = $1 " +
            "ORDER BY (to_jsonb(r)->>'started_at') DESC NULLS LAST LIMIT 1",
          [ingestId],
        )
        .catch(() => null);
      agentRunId = r?.rows[0]?.id ?? null;
    }

    results.push({
      key: f.key,
      bucket: f.fixture.bucket,
      trial,
      filename: f.filename,
      kind: f.kind,
      upload_sha256: sha256,
      batch_id: item.batch_id,
      ingest_id: ingestId,
      ingest_status: item.status,
      ingest_error: item.error,
      transaction_id: txId,
      document_id: docId,
      pdf_text_layer: pdfTextLayer,
      extracted,
      scoring: score(f.fixture, f.kind, item.status, extracted, null, null, false), // replaced below
      session,
      agent_run_id: agentRunId,
    });
  }

  // Score now that every twin's transaction is known.
  for (const [i, r] of results.entries()) {
    const f = run.uploaded[i]!.file;
    const twin = f.fixture.ground_truth.duplicate_of;
    const twinTx = twin ? (txOfKey.get(twin) ?? null) : null;
    const bookedNew = r.ingest_status === "done" && r.transaction_id !== null;
    r.scoring = score(f.fixture, f.kind, r.ingest_status, r.extracted, twinTx, r.transaction_id, bookedNew);
  }

  if (db && args.dump) {
    const dir = path.join(args.dump, args.runId, `t${trial}`);
    await mkdir(dir, { recursive: true });
    // A dump that fails (a renamed column, a dropped table) is recorded in
    // the file and the run goes on: the scores are already in hand.
    let failed = 0;
    for (const r of results) {
      const rows = await dumpIngest(db.client, r.ingest_id, db.hasRuns).catch((e: Error) => {
        failed++;
        return { dump_error: e.message };
      });
      await writeFile(path.join(dir, `${r.key}.json`), JSON.stringify({ result: r, rows }, null, 2));
    }
    console.error(`  dump: ${dir}${failed ? ` (${failed} fixture(s) failed to dump; see dump_error)` : ""}`);
  }
  return results;
}

/** What the up-front PDF check found, per fixture key, for --dry-run. */
const pdfChecks = new Map<string, string>();

/**
 * A text-layer PDF must read the same after the copy as before (the reason
 * PDFs no longer go through sips). Returns why not, or null when it does.
 */
async function checkPdfCopy(p: Ready, tmp: string): Promise<string | null> {
  const before = await pdfText(new Uint8Array(await readFile(p.source)), tmp);
  const after = await pdfText(await makeCopy("pdf", p.source, tmp, "check"), tmp);
  if (before === null || after === null) {
    pdfChecks.set(p.key, "(pdftotext not available, text layer not checked)");
    return null;
  }
  if (before.trim() !== after.trim()) return "copying it changed what pdftotext reads from it";
  pdfChecks.set(p.key, before.trim() ? `text layer kept, ${after.trim().length} chars` : "no text layer (a scan)");
  return null;
}

/** Make every copy a trial would upload; upload nothing. */
async function dryRun(args: Args, prepared: Ready[]): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "eval-dates-"));
  try {
    console.error(`\n--dry-run: ${prepared.length} copies, nothing uploaded`);
    for (const [i, p] of prepared.entries()) {
      const bytes = await makeCopy(p.kind, p.source, tmp, `${args.runId}.dry.${i}`);
      const check = p.kind === "pdf" ? ` ${pdfChecks.get(p.key) ?? ""}` : "";
      const expect = [p.fixture.expected_status].flat().join("|");
      console.error(
        `  ${p.key.padEnd(24)} ${p.fixture.bucket.padEnd(12)} ${p.kind.padEnd(5)} ${p.mime.padEnd(15)} ` +
          `${String(bytes.length).padStart(9)} B  expect ${expect}${check}`,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkArgs(args);
  console.error(`# eval-dates ${args.runId}${args.label ? ` (${args.label})` : ""}`);
  console.error(`  base:        ${args.base}`);
  console.error(`  manifest:    ${args.manifest}`);
  console.error(`  uploads-dir: ${args.uploadsDir}`);

  const manifest = JSON.parse(await readFile(args.manifest, "utf8")) as Fixture[];
  if (!Array.isArray(manifest)) throw new Error(`${args.manifest} is not a JSON array of fixtures`);
  const taken = args.limit ? manifest.slice(0, args.limit) : manifest;

  // Resolve every source up front. A missing or malformed entry is reported
  // and skipped; it never stops the run (one deleted file used to abort
  // the whole corpus at fixture 5).
  const bySha = new Map<string, string[]>();
  for (const name of await readdir(args.uploadsDir).catch(() => [] as string[])) {
    const sha = name.split(".")[0]!.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(sha)) bySha.set(sha, [...(bySha.get(sha) ?? []), name]);
  }
  const skipped: Skipped[] = [];
  const prepared: Ready[] = [];
  const checkTmp = await mkdtemp(path.join(tmpdir(), "eval-dates-check-"));
  const keys = new Set<string>();
  for (const fx of taken) {
    const key = fixtureKey(fx);
    const problems = validateFixture(fx);
    if (keys.has(key)) problems.push(`duplicate key ${key}`);
    if (problems.length) {
      skipped.push({ key, reason: `invalid manifest entry: ${problems.join("; ")}` });
      continue;
    }
    keys.add(key);
    const src = await locateSource(fx, args.uploadsDir, bySha);
    if ("missing" in src) {
      skipped.push({ key, reason: src.missing });
      continue;
    }
    const kind = KIND_BY_EXT[path.extname(src.path).toLowerCase()];
    if (!kind) {
      skipped.push({ key, reason: `no upload type for ${path.extname(src.path) || "an extension-less file"}` });
      continue;
    }
    const filename = fx.original_filename ?? `${key}${UPLOAD_EXT[kind]}`;
    const entry = { fixture: fx, key, kind, source: src.path, filename, mime: MIME_BY_KIND[kind] };
    if (kind === "pdf") {
      const why = await checkPdfCopy(entry, checkTmp).catch((e: Error) => e.message);
      if (why) {
        skipped.push({ key, reason: why });
        continue;
      }
    }
    prepared.push(entry);
  }
  await rm(checkTmp, { recursive: true, force: true });
  for (const p of prepared) {
    const twin = p.fixture.ground_truth.duplicate_of;
    if (twin && !prepared.some((q) => q.key === twin)) {
      console.error(`  warn: ${p.key} is a duplicate of ${twin}, which is not in this run; it scores as a lone document`);
    }
  }
  console.error(`  fixtures:    ${prepared.length} runnable, ${skipped.length} skipped (${taken.length} taken of ${manifest.length})`);
  for (const s of skipped) console.error(`  SKIP ${s.key}: ${s.reason}`);
  if (prepared.length === 0) throw new Error("no runnable fixtures");

  if (args.dryRun) {
    await dryRun(args, prepared);
    return;
  }

  const server = await fetchJson<unknown>(`${args.base}/version`).catch(() => null);
  const db = args.pg
    ? await openReadOnly(args.pg).then(async (client) => ({ client, hasRuns: await tableExists(client, "agent_runs") }))
    : null;
  const tmp = await mkdtemp(path.join(tmpdir(), "eval-dates-"));
  const cleanup = async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await db?.client.end().catch(() => {});
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });

  const start = Date.now();
  const all: FixtureResult[] = [];
  const perTrial: Report["per_trial"] = [];
  try {
    for (let t = 1; t <= args.trials; t++) {
      console.error(`\n── trial ${t}/${args.trials}${args.rescore ? ` (rescoring ${args.rescore.join(", ")})` : ""} ──`);
      const run = args.rescore
        ? await adoptBatches(args, prepared, args.rescore)
        : await uploadTrial(args, t, prepared, tmp);
      const results = await collectTrial(args, t, run, tmp, db);
      all.push(...results);
      perTrial.push({ trial: t, batch_ids: run.batchIds, aggregate: aggregate(results) });
      const a = perTrial.at(-1)!.aggregate;
      console.error(
        `  trial ${t}: date ${a.fields.date.correct}/${a.fields.date.scored}, total ${a.fields.total.correct}/${a.fields.total.scored}, ` +
          `payee ${a.fields.payee.correct}/${a.fields.payee.scored}, statuses ${JSON.stringify(a.statuses)}`,
      );
    }
  } finally {
    await cleanup();
  }

  const report: Report = {
    run_id: args.runId,
    label: args.label,
    generated_at: new Date().toISOString(),
    base: args.base,
    server,
    manifest: args.manifest,
    trials: args.trials,
    duration_ms: Date.now() - start,
    skipped,
    aggregate: aggregate(all),
    per_trial: perTrial,
    majority: majority(all),
    fixtures: all,
  };
  await mkdir(args.out, { recursive: true });
  const stem = path.join(args.out, `eval-dates.${args.runId}.report`);
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2));
  await writeFile(`${stem}.md`, renderMarkdown(report));

  const d = report.aggregate.fields.date;
  console.error(`\nDone in ${(report.duration_ms / 60000).toFixed(1)} min.`);
  console.error(`Date accuracy: ${(d.accuracy * 100).toFixed(1)}% (${d.correct}/${d.scored})`);
  console.error(`Reports: ${stem}.{json,md}`);
  if (args.gate && d.accuracy < 0.9) {
    console.error(`\nGATE FAILED: date accuracy ${(d.accuracy * 100).toFixed(1)}% < 90%`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
