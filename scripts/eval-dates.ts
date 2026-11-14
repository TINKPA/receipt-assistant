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
 * Before anything is uploaded it reads the environment of the container
 * that serves --base (docker inspect, a fixed list of keys, never a
 * secret's value): it refuses a stack that is not a sandbox
 * (EXTRACTOR_STUB_ALLOWED=1) or runs more than one extraction at a time,
 * and records the model, writer and concurrency on the report, since
 * those are what the two arms of the A/B must hold equal.
 *
 * Per trial, the harness:
 *   1. Waits until the stack has no extraction in flight, then (--reset)
 *      runs scripts/sandbox-reset.sh, so every document is new to the
 *      ledger. Without the reset a copy from an earlier trial is found as
 *      a near-duplicate and nothing is extracted.
 *   2. Copies each fixture under a new sha256 without changing what the
 *      agent reads: images through `sips` (as since #27), PDFs with bytes
 *      appended after the final %%EOF (the text layer survives; `sips`
 *      would rasterise the page), emails with one extra header line, HTML
 *      with a trailing comment. A fixture whose source file is missing is
 *      reported and skipped, never fatal.
 *   3. Uploads the copies with their real content type and polls until
 *      every ingest is terminal (done / unsupported / error / dedup /
 *      near_dup) and the batch has finished reconciling. A poll that fails
 *      is retried; the trial is given up only when nothing has moved for
 *      --stall-min, or after --timeout-min.
 *   4. Reads each transaction over the API, scores it, finds the agent's
 *      transcript, and (--dump) writes the rows the run left in the
 *      database to a directory outside the repo.
 *   5. Writes `eval-dates.<run id>.report.{json,md}`, after every trial and
 *      again when the run ends or stops, so a trial that fails (or Ctrl-C)
 *      never loses the trials before it. A trial that did not finish is
 *      kept in the report, left out of the aggregates, and ends the run:
 *      the stack still has its work in flight.
 *
 * It talks to the HTTP API, to `docker inspect`, and, only with --pg, to
 * Postgres with read-only transactions. No auth headers (seed-workspace
 * middleware), no `--json-schema`. Deps: tsx, Node built-ins, `pg`.
 *
 * Exit: 0 every trial finished (and --gate passed); 1 refused, a fatal
 * error, or --gate failed; 3 stopped before every trial finished; 130
 * interrupted. A report is written in every case but a refusal.
 *
 * CLI — `--key=value`, or a bare `--flag` for the switches. The space form
 * (`--limit 5`) and unknown flags are refused; until wave 1 they were bound
 * to `true` silently, and `--limit 5` ran ONE fixture.
 *   --base=<url>          API base. Default http://127.0.0.1:3001 (the sandbox).
 *   --container=<name>    The container serving --base. Default
 *                         receipt-assistant-test (the sandbox app). It must
 *                         publish --base's port and have
 *                         EXTRACTOR_STUB_ALLOWED=1. `none` skips the check
 *                         (a server you run yourself, outside docker); the
 *                         report then says the conditions are unknown.
 *   --allow-production    Allow a stack that is not a sandbox, or a base on
 *                         port 3000. Every fixture becomes a transaction in
 *                         that ledger.
 *   --allow-concurrency   Run although the container's MAX_CLAUDE_CONCURRENCY
 *                         is not 1. Never for an arm of the A/B: neighbours
 *                         in one batch extracted in parallel race on dedup.
 *   --manifest=<path>     Default scripts/eval-dates.fixtures.json (corpus C1).
 *   --uploads-dir=<path>  Where fixture sources live. Default the iCloud
 *                         project's data/uploads/uploads (or $UPLOADS_DIR).
 *   --limit=<n>           Take the first n manifest entries.
 *   --trials=<n>          Run the set n times, one batch per trial. Default 1.
 *   --reset               Run scripts/sandbox-reset.sh before every trial.
 *                         Required when --trials > 1. Only for a --container
 *                         in the compose project that script resets.
 *   --run-id=<id>         Default ed-<UTC timestamp>-<4 hex>.
 *   --label=<text>        Free text on the report, e.g. "arm A".
 *   --out=<dir>           Report directory. Default the manifest's directory.
 *   --dump=<dir>          Write each fixture's rows as JSON under
 *                         <dir>/<run id>/t<trial>/. Needs --pg. Refused
 *                         inside this repository: the rows are real receipts.
 *   --pg=<url>            Postgres of the stack under test (sandbox:
 *                         postgresql://postgres:postgres@127.0.0.1:5433/receipts).
 *                         Also used to find each upload's own document and,
 *                         once run records exist, its transcript.
 *   --transcripts=<dir>   Session JSONL directory of the stack under test.
 *                         Default the sandbox's; `none` to skip.
 *   --stall-min=<n>       Give a trial up when no ingest or batch has changed
 *                         state for n minutes. Default the stack's per-run
 *                         timeout (CLAUDE_TIMEOUT_MS, else 15 min) + 5.
 *   --timeout-min=<n>     Hard cap per trial. Default enough for every
 *                         fixture to use the full per-run timeout at the
 *                         stack's concurrency, + 15.
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
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { summarizeSession } from "../src/session-transcript.js";

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
const FIELDS = ["date", "total", "payee", "classification", "flow", "currency"] as const;
type Field = (typeof FIELDS)[number];
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
  /**
   * The same six fields with "nothing extracted" counted as wrong: on a
   * fixture that expects its own transaction, a field the ground truth
   * names but the run left empty (no transaction, an error, no payee) is
   * `false` here, where the fields above say null (not scored). This is
   * the view the arms are compared on: an arm that errors must not look
   * more accurate for it.
   */
  strict: Record<Field, boolean | null>;
}

/** What the post-upload PDF check found on the stored file. */
type PdfCheck =
  | "text_kept" // same bytes as uploaded, pdftotext reads what it read from the original
  | "scan_kept" // same, and the original has no text layer either (a scan)
  | "changed" // pdftotext reads something else from the stored file
  | "bytes_differ" // the stored file is not the copy that was uploaded
  | "not_found" // no document of this upload's own (attached to a twin, or errored before)
  | "unchecked"; // pdftotext not available

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
  /** As last seen; not terminal when `unfinished`. */
  ingest_status: string;
  ingest_error: string | null;
  /** The trial was given up before this ingest reached a terminal status. */
  unfinished: boolean;
  transaction_id: string | null;
  /** The upload's own document when it could be told apart (by sha256, or
   *  by file path with --pg), else the first one the ingest produced. */
  document_id: string | null;
  /** PDFs only: true when the stored file is the uploaded copy and reads
   *  the same as the original (`pdf_check` text_kept); false when it was
   *  changed; null when there was nothing to check or no text to keep. */
  pdf_text_layer: boolean | null;
  pdf_check: PdfCheck | null;
  extracted: Extracted;
  scoring: Scoring;
  session: SessionSummary | null;
  /** How the transcript was found: by `agent_runs.session_id`, or by the
   *  ingest id in the prompt. */
  session_source: "agent_runs" | "prompt" | null;
  /** `agent_runs.id`, once run records exist (--pg). */
  agent_run_id: string | null;
}

// ── CLI ────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME = homedir();

const VALUE_FLAGS = [
  "base", "container", "manifest", "uploads-dir", "limit", "trials", "run-id", "label",
  "out", "dump", "pg", "transcripts", "stall-min", "timeout-min", "rescore",
] as const;
const BARE_FLAGS = ["allow-production", "allow-concurrency", "reset", "gate", "dry-run"] as const;

/** The sandbox app container (docker-compose.test.yml). */
const SANDBOX_CONTAINER = "receipt-assistant-test";

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
  const container = str("container") ?? SANDBOX_CONTAINER;
  return {
    base: (str("base") ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    container: container === "none" ? null : container,
    allowProduction: flag("allow-production"),
    allowConcurrency: flag("allow-concurrency"),
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
    /** Null: derived from the stack (see trialTimeouts). */
    stallMs: str("stall-min") !== undefined ? num("stall-min", 0) * 60_000 : null,
    timeoutMs: str("timeout-min") !== undefined ? num("timeout-min", 0) * 60_000 : null,
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

function basePort(base: string): string {
  const url = new URL(base);
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function checkArgs(args: Args): void {
  const port = basePort(args.base);
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
  if (args.reset && !args.container) {
    throw new Error(
      "--reset needs --container: scripts/sandbox-reset.sh empties the sandbox, and the harness checks " +
        "first that the sandbox is the stack under test. With --container=none it cannot.",
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

/**
 * The canonical path. `realpathSync.native` (realpath(3)) also restores
 * the on-disk letter case, which the JS implementation keeps as typed: on
 * a case-insensitive volume `/users/x/REPO` is the repository too.
 */
function realpathOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `p` is `root` or below it. `p` may not exist yet. */
export function isInside(p: string, root: string): boolean {
  let probe = path.resolve(p);
  const tail: string[] = [];
  // Resolve the deepest existing ancestor so a symlinked or differently
  // cased parent counts.
  for (;;) {
    try {
      probe = path.join(realpathSync.native(probe), ...tail.reverse());
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
  // macOS and Windows volumes are case-insensitive by default; the part of
  // the path that does not exist yet was not canonicalised above.
  const fold = (s: string) => (process.platform === "darwin" || process.platform === "win32" ? s.toLowerCase() : s);
  const rel = path.relative(fold(realpathOr(root)), fold(probe));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ── The stack under test ───────────────────────────────────────────────

/** Environment keys read off the container. Nothing else is read: the
 *  container's environment also holds the OAuth token and API keys. */
const CONDITION_KEYS = [
  "EXTRACTOR_STUB_ALLOWED",
  "CLAUDE_MODEL",
  "EXTRACTION_WRITER",
  "EXTRACTION_REPAIR_ROUNDS",
  "MAX_CLAUDE_CONCURRENCY",
  "CLAUDE_TIMEOUT_MS",
] as const;
type ConditionKey = (typeof CONDITION_KEYS)[number];

/** What the A/B holds equal across arms, as configured on the container. */
export interface StackConditions {
  container: string;
  read_at: string;
  running: boolean;
  /** `Config.Image`, the tag it was started from. */
  image: string | null;
  /** The image id: names the build even when /version says gitSha unknown
   *  (a worktree build). */
  image_id: string | null;
  compose_project: string | null;
  /** Host ports the container publishes. */
  host_ports: string[];
  /** Unset keys are null. Under compose an unset variable is the compose
   *  file's default, which `docker inspect` shows as set. */
  env: Record<ConditionKey, string | null>;
  /** Place lookups (Phase 3a, Check C) change payee and place; only whether
   *  a key is there is read, never its value. */
  google_maps_key_set: boolean;
}

/**
 * `docker inspect` through a template that emits only CONDITION_KEYS and
 * whether GOOGLE_MAPS_API_KEY is non-empty, so no secret ever reaches this
 * process. Null when there is no such container.
 */
export function readContainer(name: string): StackConditions | null {
  const keys = CONDITION_KEYS.map((k) => JSON.stringify(k)).join(" ");
  const fmt = [
    "{{json .State.Running}}",
    "{{json .Config.Image}}",
    "{{json .Image}}",
    '{{json (index .Config.Labels "com.docker.compose.project")}}',
    "{{json .NetworkSettings.Ports}}",
    "{{range .Config.Env}}{{$k := index (split . \"=\") 0}}" +
      `{{if eq $k ${keys}}}{{json .}}{{println}}{{end}}` +
      '{{if eq $k "GOOGLE_MAPS_API_KEY"}}{{if gt (len .) 20}}"GOOGLE_MAPS_API_KEY=<set>"{{println}}{{end}}{{end}}' +
      "{{end}}",
  ].join("\n");
  const r = spawnSync("docker", ["inspect", "--type", "container", "--format", fmt, name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const lines = r.stdout.split("\n");
  const json = (i: number): unknown => {
    try {
      return JSON.parse(lines[i] ?? "null");
    } catch {
      return null;
    }
  };
  const ports = (json(4) ?? {}) as Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  const env = Object.fromEntries(CONDITION_KEYS.map((k) => [k, null])) as Record<ConditionKey, string | null>;
  let mapsKey = false;
  for (const line of lines.slice(5)) {
    if (!line.trim()) continue;
    const kv = JSON.parse(line) as string;
    const eq = kv.indexOf("=");
    const k = kv.slice(0, eq);
    if (k === "GOOGLE_MAPS_API_KEY") mapsKey = true;
    else if ((CONDITION_KEYS as readonly string[]).includes(k)) env[k as ConditionKey] = kv.slice(eq + 1);
  }
  const project = json(3);
  return {
    container: name,
    read_at: new Date().toISOString(),
    running: json(0) === true,
    image: (json(1) as string | null) ?? null,
    image_id: (json(2) as string | null) ?? null,
    compose_project: typeof project === "string" && project ? project : null,
    host_ports: [
      ...new Set(
        Object.values(ports)
          .flatMap((b) => b ?? [])
          .map((b) => b.HostPort)
          .filter((p): p is string => !!p),
      ),
    ].sort(),
    env,
    google_maps_key_set: mapsKey,
  };
}

/** The part of the conditions that must not move between trials. */
function conditionsKey(c: StackConditions | null): string {
  return c ? JSON.stringify({ image_id: c.image_id, env: c.env, maps: c.google_maps_key_set }) : "none";
}

/**
 * Refuse a stack the run must not touch or cannot compare. Throws with the
 * reason; returns the conditions to record (null with --container=none).
 */
export function checkStack(
  args: Pick<Args, "base" | "container" | "allowProduction" | "allowConcurrency" | "reset" | "rescore">,
  read: (name: string) => StackConditions | null = readContainer,
): StackConditions | null {
  if (!args.container) {
    console.error(
      "  warn: --container=none: the stack's model, writer and concurrency are not checked or recorded, " +
        "and nothing confirms --base is a sandbox.",
    );
    return null;
  }
  if (args.container === "receipt-assistant" && !args.allowProduction) {
    throw new Error("REFUSING: 'receipt-assistant' is the production container.");
  }
  const c = read(args.container);
  if (!c) throw new Error(`no container named '${args.container}'. Bring the stack up, or name the one serving --base.`);
  if (!c.running) throw new Error(`container '${args.container}' is not running.`);
  const port = basePort(args.base);
  if (!c.host_ports.includes(port)) {
    throw new Error(
      `container '${args.container}' publishes port(s) ${c.host_ports.join(", ") || "none"}, not ${port}: ` +
        `--base=${args.base} is served by something else. Pass --container=<the one serving it>, ` +
        `or --container=none for a server outside docker.`,
    );
  }
  if (c.env.EXTRACTOR_STUB_ALLOWED !== "1" && !args.allowProduction) {
    throw new Error(
      `REFUSING: '${args.container}' does not have EXTRACTOR_STUB_ALLOWED=1, so it is not a sandbox. ` +
        `Every fixture would be booked in its ledger. Pass --allow-production if that really is what you want.`,
    );
  }
  if (!args.rescore && c.env.MAX_CLAUDE_CONCURRENCY !== "1" && !args.allowConcurrency) {
    throw new Error(
      `'${args.container}' runs MAX_CLAUDE_CONCURRENCY=${c.env.MAX_CLAUDE_CONCURRENCY ?? "(unset: the code default)"}. ` +
        `Accuracy runs hold it at 1: neighbours in one batch extracted in parallel race on dedup, so ` +
        `attach and duplicate outcomes would depend on timing. Recreate the stack with ` +
        `MAX_CLAUDE_CONCURRENCY=1 (scripts/eval-dates.md), or pass --allow-concurrency for a run that is ` +
        `not an arm of the A/B.`,
    );
  }
  if (args.reset) {
    const pgName = process.env.SANDBOX_PG_CONTAINER ?? "receipts-test-postgres";
    const pgc = read(pgName);
    if (!pgc || !pgc.compose_project || pgc.compose_project !== c.compose_project) {
      throw new Error(
        `--reset empties '${pgName}' (compose project ${pgc?.compose_project ?? "none"}), which is not the ` +
          `database of '${args.container}' (project ${c.compose_project ?? "none"}). Refusing to reset one ` +
          `stack and test another.`,
      );
    }
  }
  return c;
}

/**
 * How long a trial may sit still, and how long it may take at most. A run
 * is bounded by the worker's own per-run timeout, after which it errors,
 * so "nothing moved for longer than that" means the stack is stuck; the
 * hard cap only backs that up.
 */
function trialTimeouts(
  args: Pick<Args, "stallMs" | "timeoutMs">,
  c: StackConditions | null,
  fixtures: number,
): { stallMs: number; totalMs: number } {
  const perRun = Number(c?.env.CLAUDE_TIMEOUT_MS) > 0 ? Number(c!.env.CLAUDE_TIMEOUT_MS) : 900_000;
  const conc = Number(c?.env.MAX_CLAUDE_CONCURRENCY) > 0 ? Number(c!.env.MAX_CLAUDE_CONCURRENCY) : 1;
  return {
    stallMs: args.stallMs ?? perRun + 5 * 60_000,
    totalMs: args.timeoutMs ?? Math.ceil(fixtures / conc) * perRun + 15 * 60_000,
  };
}

/** Ends the run early without losing what it has: the report is written
 *  and the exit status is 3. */
class StopRun extends Error {}

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

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One request. Never retried: a POST that is sent twice uploads twice. */
async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 120_000): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new HttpError(`${init?.method ?? "GET"} ${url} → ${r.status}: ${body.slice(0, 500)}`, r.status);
  }
  return r.json() as Promise<T>;
}

/** A failure worth asking again: no answer, a dropped connection, 5xx, 429. */
function transient(e: unknown): boolean {
  return !(e instanceof HttpError) || e.status >= 500 || e.status === 429;
}

/** GET with retries over about 30 s for transient failures. A run that
 *  has spent an hour of quota must not die on one 502. */
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchJson<T>(url);
    } catch (e) {
      if (!transient(e) || attempt >= 5) throw e;
      await sleep(2000 * attempt);
    }
  }
}

/** GET of a binary body, with the same retries. Null on a 404. */
async function getBytes(url: string): Promise<Uint8Array | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new HttpError(`GET ${url} → ${r.status}`, r.status);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (!transient(e) || attempt >= 5) throw e;
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Wait until the stack has nothing in flight: no ingest queued or
 * processing, no batch reconciling. A reset under a running extraction
 * lets that agent write its catalog rows (brand, merchant, place) into
 * the fresh ledger, where the next trial finds them warm; and at
 * concurrency 1 a leftover queue would also hold this trial's uploads
 * back. Waits as long as that work keeps moving; gives up (StopRun) when
 * nothing has changed for `stallMs`.
 */
async function waitForIdle(base: string, stallMs: number, before: string): Promise<void> {
  const start = Date.now();
  let said = false;
  let lastSignature = "";
  let lastMove = Date.now();
  for (;;) {
    type Row = { id: string; status: string };
    const ingests = await getJson<{ items: Row[] }>(`${base}/v1/ingests?status=queued,processing&limit=100`);
    const batches = await getJson<{ items: Row[] }>(`${base}/v1/batches?status=reconciling&limit=100`);
    if (ingests.items.length === 0 && batches.items.length === 0) {
      if (said) console.error(`  idle after ${Math.round((Date.now() - start) / 1000)}s`);
      return;
    }
    const counts = `${ingests.items.length} ingest(s) queued or processing, ${batches.items.length} batch(es) reconciling`;
    if (!said) {
      console.error(`  waiting for the stack to go idle before ${before}: ${counts}`);
      said = true;
    }
    const signature = JSON.stringify([ingests.items.map((i) => [i.id, i.status]), batches.items.map((b) => b.id)]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastMove = Date.now();
    }
    if (Date.now() - lastMove > stallMs) {
      throw new StopRun(
        `the stack's work in flight had not moved for ${Math.round(stallMs / 60_000)} min, so ${before} was not ` +
          `started (${counts})`,
      );
    }
    await sleep(5000);
  }
}

interface CreateBatchResponse {
  batchId: string;
  items: { ingestId: string; filename: string; mime_type: string | null }[];
}

async function postBatch(base: string, files: Prepared[]): Promise<CreateBatchResponse> {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.bytes as BlobPart], { type: f.mime }), f.filename);
  return fetchJson<CreateBatchResponse>(`${base}/v1/ingest/batch`, { method: "POST", body: form }, 600_000);
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

/**
 * Poll until every item is terminal and no batch is busy. Never throws:
 * a failed poll is logged and tried again, and when the trial has to be
 * given up (nothing moved for `stallMs`, `totalMs` passed, or a batch is
 * gone) it returns the last state it saw with the reason, so the items
 * that did finish are still scored.
 */
async function pollBatches(
  base: string,
  ids: string[],
  limits: { stallMs: number; totalMs: number },
): Promise<{ batches: Map<string, ApiBatch>; gaveUp: string | null }> {
  const start = Date.now();
  const last = new Map<string, ApiBatch>();
  let lastLine = "";
  let lastSignature = "";
  let lastMove = Date.now();
  let lastError = "";
  const since = () => `${Math.floor((Date.now() - start) / 1000)}s`;
  for (;;) {
    let gone: string | null = null;
    for (const id of ids) {
      try {
        last.set(id, await getJson<ApiBatch>(`${base}/v1/batches/${id}`));
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) gone = id;
        const msg = (e as Error).message;
        if (msg !== lastError) console.error(`  [${since()}] poll failed, will retry: ${msg}`);
        lastError = msg;
      }
    }
    if (gone) {
      return { batches: last, gaveUp: `batch ${gone} is gone (404): was the stack reset during the trial?` };
    }
    const rows = [...last.values()];
    const items = rows.flatMap((r) => r.items);
    const terminal = items.filter((i) => TERMINAL.has(i.status)).length;
    const busy = rows.filter((r) => BATCH_BUSY.has(r.status)).map((r) => r.status);
    if (rows.length === ids.length) {
      const line =
        `${terminal}/${items.length} terminal` + (terminal === items.length && busy.length ? `, batch ${busy.join(",")}` : "");
      if (line !== lastLine) {
        console.error(`  [${since()}] ${line}`);
        lastLine = line;
      }
      if (terminal === items.length && busy.length === 0) return { batches: last, gaveUp: null };
      const signature = JSON.stringify([rows.map((r) => r.status), items.map((i) => i.status)]);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastMove = Date.now();
      }
    }
    const open = items.filter((i) => !TERMINAL.has(i.status)).map((i) => `${i.filename}: ${i.status}`);
    if (Date.now() - lastMove > limits.stallMs) {
      return {
        batches: last,
        gaveUp:
          `nothing moved for ${Math.round(limits.stallMs / 60_000)} min (--stall-min)` +
          (open.length ? `; still open: ${open.join(", ")}` : lastError ? `; last poll error: ${lastError}` : ""),
      };
    }
    if (Date.now() - start > limits.totalMs) {
      return {
        batches: last,
        gaveUp: `not finished after ${Math.round(limits.totalMs / 60_000)} min (--timeout-min); still open: ${open.join(", ") || "-"}`,
      };
    }
    await sleep(3000);
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
export function readMoney(tx: ApiTransaction): Pick<Extracted, "total_minor" | "currency" | "currencies" | "flow"> {
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
 * Turns, tokens and model of one session JSONL, from `summarizeSession`
 * (src/session-transcript.ts): the parser the server uses to fill
 * `agent_runs` and `measure:turns` uses to report, so the three cannot
 * disagree. Turns are grouped by `message.id` and billed input is fresh +
 * cache read + cache write (see that file). Only the wall time, first to
 * last record timestamp, is read here.
 */
async function summarizeTranscript(jsonlPath: string): Promise<SessionSummary> {
  const s = summarizeSession(jsonlPath);
  let first: number | null = null;
  let last: number | null = null;
  for (const line of (await readFile(jsonlPath, "utf8")).split("\n")) {
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
  }
  return {
    session_id: s.session,
    model_observed: s.model,
    turns: s.turns,
    tool_calls: s.toolCalls,
    billed_input: s.billedInput,
    cache_read: s.cacheRead,
    cache_creation: s.cacheCreation,
    fresh_input: s.freshInput,
    output: s.output,
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

/** The fixture should end `done` with a transaction of its own. */
function expectsOwnTransaction(fx: Fixture): boolean {
  return (
    fx.bucket !== "good_rejects" &&
    fx.bucket !== "duplicate" &&
    [fx.expected_status].flat().every((s) => s === "done")
  );
}

/** Whether the ground truth names a value for the field. Classification,
 *  flow and currency always have one (their defaults). */
function truthHas(fx: Fixture, f: Field): boolean {
  const gt = fx.ground_truth;
  if (f === "date") return gt.date != null;
  if (f === "total") return gt.total_minor != null;
  if (f === "payee") return gt.merchant_tokens.length > 0;
  return true;
}

export function score(
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

  const lenient: Record<Field, boolean | null> = {
    date: date_match,
    total: total_match,
    payee: payee_match,
    classification: classification_match,
    flow: flow_match,
    currency: currency_match,
  };
  const own = expectsOwnTransaction(fx);
  const strict = Object.fromEntries(
    FIELDS.map((f) => [f, lenient[f] ?? (own && truthHas(fx, f) ? false : null)]),
  ) as Record<Field, boolean | null>;
  return {
    date_match,
    total_match,
    payee_match,
    classification_match,
    flow_match,
    currency_match,
    status_match,
    bucket_pass,
    strict,
  };
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

/** Documents of one ingest ($1): those stored at its file path, or that
 *  name it as their source. */
function ownDocumentSql(select: string): string {
  return `SELECT ${select} AS j FROM documents d
           WHERE d.source_ingest_id = $1
              OR EXISTS (SELECT 1 FROM ingests i
                          WHERE i.id = $1 AND i.workspace_id = d.workspace_id AND i.file_path = d.file_path)`;
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
  // The upload's own document: `source_ingest_id` is not set at upload, so
  // an ingest that errored or was attached to a twin is found by its file.
  for (const r of await one(ownDocumentSql("to_jsonb(d.id)"), [ingestId])) docIds.add(r as string);
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

const fieldOf = (s: Scoring, f: Field): boolean | null => s[`${f}_match` as keyof Scoring] as boolean | null;
const strictOf = (s: Scoring, f: Field): boolean | null => s.strict[f];

interface FieldAgg {
  correct: number;
  scored: number;
  accuracy: number;
}

function aggregate(results: FixtureResult[]) {
  const fieldAgg = (pick: (s: Scoring, f: Field) => boolean | null) =>
    Object.fromEntries(
      FIELDS.map((f) => {
        const scored = results.filter((r) => pick(r.scoring, f) !== null);
        const correct = scored.filter((r) => pick(r.scoring, f) === true).length;
        return [f, { correct, scored: scored.length, accuracy: scored.length ? correct / scored.length : 0 }];
      }),
    ) as Record<Field, FieldAgg>;
  const fields = fieldAgg(fieldOf);
  const fieldsStrict = fieldAgg(strictOf);
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
    /** Over the runs that produced a value (#27's convention). */
    fields,
    /** Over every run whose fixture expects the field: nothing extracted
     *  counts as wrong. Compare arms on this one. */
    fields_strict: fieldsStrict,
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
      /** Nothing extracted counts as a fail: an arm that books nothing on a
       *  fixture fails it, it does not drop out (gate G1). */
      strict: Object.fromEntries(FIELDS.map((f) => [f, verdict(rs.map((r) => strictOf(r.scoring, f)))])),
    } as { key: string; bucket: Bucket; trials: number; bucket_pass: Verdict; strict: Record<Field, Verdict> } & Record<
      Field,
      Verdict
    >;
  });
}

// ── Report ─────────────────────────────────────────────────────────────

interface TrialRecord {
  trial: number;
  batch_ids: string[];
  /** Every ingest reached a terminal status and the batch settled. */
  complete: boolean;
  incomplete_reason: string | null;
  /** The stack's conditions read just before this trial. */
  conditions: StackConditions | null;
  aggregate: ReturnType<typeof aggregate>;
}

interface Report {
  run_id: string;
  label: string | null;
  generated_at: string;
  base: string;
  server: unknown;
  /** As read before the first trial; null with --container=none. Under
   *  --rescore, read at rescore time, not when the batches ran. */
  conditions: StackConditions | null;
  manifest: string;
  /** --rescore: the batches scored; the run itself happened earlier. */
  rescore: string[] | null;
  /** Trials asked for. */
  trials: number;
  trials_complete: number;
  /** Every trial asked for finished. */
  complete: boolean;
  /** Why the run ended early, when it did. */
  stopped: string | null;
  /** A fatal error, when there was one. */
  error: string | null;
  timeouts: { stall_ms: number; total_ms: number } | null;
  duration_ms: number;
  skipped: Skipped[];
  /** Over complete trials only. */
  aggregate: ReturnType<typeof aggregate>;
  per_trial: TrialRecord[];
  /** Over complete trials only. */
  majority: ReturnType<typeof majority>;
  /** Every run, complete trials or not (`trial` joins it to per_trial). */
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
  if (!rep.complete) {
    L.push(
      `> **Incomplete: ${rep.trials_complete} of ${rep.trials} trial(s) finished.** ` +
        `${rep.error ? `Fatal error: ${rep.error}` : rep.stopped ?? ""} ` +
        `The aggregates below cover finished trials only; runs of an unfinished trial are listed with their trial number.`,
    );
    L.push("");
  }
  L.push(
    `${rep.generated_at.slice(0, 19)}Z · ${rep.base} · ${rep.trials_complete}/${rep.trials} trial(s) · ` +
      `${(rep.duration_ms / 60000).toFixed(1)} min · manifest \`${path.basename(rep.manifest)}\``,
  );
  if (rep.rescore) {
    L.push(`Rescored from batch(es) ${rep.rescore.map((b) => `\`${b}\``).join(", ")}; server and stack below were read at rescore time.`);
  }
  const srv = rep.server as { gitSha?: string; promptVersion?: string } | null;
  if (srv) L.push(`Server: \`${JSON.stringify(srv)}\``);
  const c = rep.conditions;
  if (c) {
    L.push(
      `Stack: \`${c.container}\` (project ${c.compose_project ?? "—"}, image ${c.image ?? "—"} ` +
        `${(c.image_id ?? "").replace(/^sha256:/, "").slice(0, 12)}) · ` +
        CONDITION_KEYS.filter((k) => k !== "EXTRACTOR_STUB_ALLOWED")
          .map((k) => `${k}=${c.env[k] ?? "unset"}`)
          .join(" · ") +
        ` · GOOGLE_MAPS_API_KEY ${c.google_maps_key_set ? "set" : "unset"}`,
    );
  } else {
    L.push("Stack: not checked (--container=none); model, writer and concurrency unknown.");
  }
  L.push(`Models stamped: ${agg.models_stamped.join(", ") || "—"} · observed: ${agg.models_observed.join(", ") || "—"}`);
  L.push("");
  L.push("## Fields (finished trials)");
  L.push("");
  L.push(
    "Lenient: over the runs that produced the field (#27's convention). " +
      "Strict: over every run whose fixture expects it; nothing extracted counts as wrong.",
  );
  L.push("");
  L.push("| Field | Lenient | Correct / scored | Strict | Correct / expected |");
  L.push("|---|---|---|---|---|");
  for (const f of FIELDS) {
    const a = agg.fields[f];
    const s = agg.fields_strict[f];
    L.push(`| ${f} | ${pct(a)} | ${a.correct} / ${a.scored} | ${pct(s)} | ${s.correct} / ${s.scored} |`);
  }
  L.push("");
  L.push(`Statuses: ${Object.entries(agg.statuses).map(([s, c]) => `${s} ${c}`).join(", ")}`);
  L.push("");
  L.push("## Buckets (finished trials)");
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
  if (rep.trials_complete > 1) {
    L.push("## Per fixture, majority over finished trials (strict)");
    L.push("");
    L.push("A run that booked nothing counts as a fail here. The lenient verdicts are in the JSON.");
    L.push("");
    L.push(`| Fixture | Bucket | Pass | ${FIELDS.join(" | ")} |`);
    L.push(`|---|---|---|${FIELDS.map(() => "---").join("|")}|`);
    for (const m of rep.majority) {
      L.push(`| \`${m.key}\` | \`${m.bucket}\` | ${m.bucket_pass} | ${FIELDS.map((f) => m.strict[f]).join(" | ")} |`);
    }
    L.push("");
  }
  if (rep.per_trial.length > 1 || !rep.complete) {
    L.push("## Trials");
    L.push("");
    L.push("| Trial | Batches | Finished | Date (strict) | Statuses |");
    L.push("|---|---|---|---|---|");
    for (const t of rep.per_trial) {
      const d = t.aggregate.fields_strict.date;
      L.push(
        `| ${t.trial} | ${t.batch_ids.map((b) => `\`${b}\``).join(", ")} | ${t.complete ? "yes" : `no: ${t.incomplete_reason}`} | ` +
          `${d.correct} / ${d.scored} | ${Object.entries(t.aggregate.statuses).map(([s, c]) => `${s} ${c}`).join(", ")} |`,
      );
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
      `| ${r.trial} | \`${r.key}\` | \`${r.bucket}\` | ${r.ingest_status}${r.unfinished ? " (unfinished)" : ""} | ` +
        `${mark(s.classification_match)} ${e.classification ?? ""} | ` +
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
  const pdfs = rep.fixtures.filter((r) => r.pdf_check !== null);
  if (pdfs.length) {
    const count: Record<string, number> = {};
    for (const r of pdfs) count[r.pdf_check!] = (count[r.pdf_check!] ?? 0) + 1;
    L.push(
      `PDF uploads, stored file against the original: ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(", ")} ` +
        `(text_kept: same bytes as uploaded, same pdftotext output; scan_kept: the original has no text layer either; ` +
        `not_found: no document of the upload's own, e.g. attached to its twin).`,
    );
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

/** Run only after checkStack has tied the sandbox to the stack under test
 *  and waitForIdle has seen it quiet. */
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

/** Wait for quiet, reset (if asked), copy, upload. One batch per 50 files. */
async function uploadTrial(
  args: Args,
  trial: number,
  prepared: Ready[],
  tmp: string,
  idleStallMs: number,
): Promise<{ uploaded: Uploaded[]; batchIds: string[]; startedAt: number }> {
  await waitForIdle(args.base, idleStallMs, args.reset ? `the reset for trial ${trial}` : `trial ${trial}`);
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
    const b = await getJson<ApiBatch & { created_at: string }>(`${args.base}/v1/batches/${id}`);
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

type Db = { client: pg.Client; hasRuns: boolean };

/**
 * Find the upload's own document among those the ingest produced (and,
 * with --pg, the one stored at its file path), and check the stored PDF:
 * the same bytes as uploaded, and pdftotext reads from it what it read
 * from the original.
 */
async function checkStoredPdf(
  base: string,
  key: string,
  ingestId: string,
  uploadSha: string | null,
  producedDocs: string[],
  db: Db | null,
  tmp: string,
): Promise<{ docId: string | null; check: PdfCheck }> {
  const byPath = new Set<string>();
  if (db) {
    const r = await db.client.query(ownDocumentSql("d.id"), [ingestId]).catch(() => null);
    for (const row of r?.rows ?? []) byPath.add(row.j as string);
  }
  let own: string | null = null;
  for (const id of new Set([...byPath, ...producedDocs])) {
    const d = await getJson<{ sha256: string; source_ingest_id: string | null }>(`${base}/v1/documents/${id}`).catch(
      () => null,
    );
    if (d && (byPath.has(id) || d.source_ingest_id === ingestId || (uploadSha !== null && d.sha256 === uploadSha))) {
      own = id;
      break;
    }
  }
  if (!own) return { docId: null, check: "not_found" };
  const stored = await getBytes(`${base}/v1/documents/${own}/content`).catch(() => null);
  if (!stored) return { docId: own, check: "not_found" };
  if (uploadSha !== null && sha256Hex(stored) !== uploadSha) return { docId: own, check: "bytes_differ" };
  const text = await pdfText(stored, tmp);
  const original = pdfOriginalText.get(key);
  if (text === null || original === undefined) return { docId: own, check: "unchecked" };
  if (text.trim() !== original.trim()) return { docId: own, check: "changed" };
  return { docId: own, check: original.trim() ? "text_kept" : "scan_kept" };
}

/** Wait for the batches, then read, score and (--dump) dump every fixture. */
async function collectTrial(
  args: Args,
  trial: number,
  run: { uploaded: Uploaded[]; batchIds: string[]; startedAt: number },
  tmp: string,
  db: Db | null,
  limits: { stallMs: number; totalMs: number },
): Promise<{ results: FixtureResult[]; gaveUp: string | null }> {
  const { batches, gaveUp } = await pollBatches(args.base, run.batchIds, limits);
  if (gaveUp) console.error(`  trial ${trial} given up: ${gaveUp}`);
  const items = new Map<string, ApiIngest & { batch_id: string }>();
  for (const [id, b] of batches) for (const it of b.items) items.set(it.id, { ...it, batch_id: id });

  const sessions = args.transcripts
    ? await findSessions(args.transcripts, run.startedAt - 60_000, run.uploaded.map((u) => u.ingestId))
    : new Map<string, string>();

  // Each fixture's transaction, to score a duplicate against its twin's.
  const txOfKey = new Map<string, string | null>();
  const results: FixtureResult[] = [];
  for (const { file: f, sha256, ingestId } of run.uploaded) {
    // Never seen (every poll of its batch failed): scored as nothing.
    const item = items.get(ingestId) ?? {
      id: ingestId,
      filename: f.filename,
      status: "unknown" as IngestStatus,
      classification: null,
      produced: null,
      error: null,
      batch_id: run.batchIds[0] ?? "",
    };
    const unfinished = !TERMINAL.has(item.status);
    const produced = item.produced ?? { transaction_ids: [], document_ids: [] };
    const txId = produced.transaction_ids[0] ?? null;
    txOfKey.set(f.key, txId);
    let extracted = emptyExtracted(item.classification);
    if (txId && item.status === "done") {
      try {
        const tx = await getJson<ApiTransaction>(`${args.base}/v1/transactions/${txId}`);
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

    // A PDF must arrive as uploaded and read as the original did.
    let docId = produced.document_ids[0] ?? null;
    let pdfCheck: PdfCheck | null = null;
    if (f.kind === "pdf" && !unfinished) {
      const c = await checkStoredPdf(args.base, f.key, ingestId, sha256, produced.document_ids, db, tmp);
      pdfCheck = c.check;
      docId = c.docId ?? docId;
    }

    // The run record, once there is one (wave 1): its session id names the
    // transcript even when the prompt no longer carries the ingest id.
    let agentRunId: string | null = null;
    let runSession: string | null = null;
    if (db?.hasRuns) {
      const r = await db.client
        .query(
          "SELECT (to_jsonb(r)->>'id') AS id, (to_jsonb(r)->>'session_id') AS session_id FROM agent_runs r " +
            "WHERE (to_jsonb(r)->>'ingest_id') = $1 ORDER BY (to_jsonb(r)->>'started_at') DESC NULLS LAST LIMIT 1",
          [ingestId],
        )
        .catch(() => null);
      agentRunId = r?.rows[0]?.id ?? null;
      runSession = r?.rows[0]?.session_id ?? null;
    }
    let sessionPath: string | null = null;
    let sessionSource: FixtureResult["session_source"] = null;
    if (args.transcripts && runSession && /^[0-9a-f-]{36}$/i.test(runSession)) {
      const p = path.join(args.transcripts, `${runSession}.jsonl`);
      if (await stat(p).then(() => true, () => false)) {
        sessionPath = p;
        sessionSource = "agent_runs";
      }
    }
    if (!sessionPath && sessions.has(ingestId)) {
      sessionPath = sessions.get(ingestId)!;
      sessionSource = "prompt";
    }
    const session = sessionPath
      ? await summarizeTranscript(sessionPath)
      : null;

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
      unfinished,
      transaction_id: txId,
      document_id: docId,
      pdf_text_layer: pdfCheck === "text_kept" ? true : pdfCheck === "changed" || pdfCheck === "bytes_differ" ? false : null,
      pdf_check: pdfCheck,
      extracted,
      scoring: score(f.fixture, f.kind, item.status, extracted, null, null, false), // replaced below
      session,
      session_source: sessionSource,
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
  return { results, gaveUp };
}

/** What the up-front PDF check found, per fixture key, for --dry-run. */
const pdfChecks = new Map<string, string>();
/** pdftotext of each PDF fixture's original, to compare the stored copy with. */
const pdfOriginalText = new Map<string, string>();

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
  pdfOriginalText.set(p.key, before);
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

  // The stack under test: refuse one that must not be touched, and record
  // what the arms of the A/B hold equal.
  const conditions = checkStack(args);
  const limits = trialTimeouts(args, conditions, prepared.length);
  if (conditions) {
    console.error(
      `  stack:       ${conditions.container} (${conditions.compose_project ?? "no compose project"}) ` +
        CONDITION_KEYS.map((k) => `${k}=${conditions.env[k] ?? "unset"}`).join(" "),
    );
  }
  console.error(
    `  limits:      give a trial up after ${Math.round(limits.stallMs / 60_000)} min without movement, ` +
      `or ${Math.round(limits.totalMs / 60_000)} min in all`,
  );

  const server = await getJson<unknown>(`${args.base}/version`).catch(() => null);
  const db: Db | null = args.pg
    ? await openReadOnly(args.pg).then(async (client) => ({ client, hasRuns: await tableExists(client, "agent_runs") }))
    : null;
  const tmp = await mkdtemp(path.join(tmpdir(), "eval-dates-"));
  const cleanup = async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await db?.client.end().catch(() => {});
  };

  const start = Date.now();
  const all: FixtureResult[] = [];
  const perTrial: TrialRecord[] = [];
  let stopped: string | null = null;
  let fatal: string | null = null;
  await mkdir(args.out, { recursive: true });
  const stem = path.join(args.out, `eval-dates.${args.runId}.report`);

  const buildReport = (): Report => {
    const finished = new Set(perTrial.filter((t) => t.complete).map((t) => t.trial));
    const counted = all.filter((r) => finished.has(r.trial));
    return {
      run_id: args.runId,
      label: args.label,
      generated_at: new Date().toISOString(),
      base: args.base,
      server,
      conditions,
      manifest: args.manifest,
      rescore: args.rescore,
      trials: args.trials,
      trials_complete: finished.size,
      complete: finished.size === args.trials && !stopped && !fatal,
      stopped,
      error: fatal,
      timeouts: { stall_ms: limits.stallMs, total_ms: limits.totalMs },
      duration_ms: Date.now() - start,
      skipped,
      aggregate: aggregate(counted),
      per_trial: perTrial,
      majority: majority(counted),
      fixtures: all,
    };
  };
  // Written after every trial and on every way out, so a failure in trial
  // k (or Ctrl-C) keeps trials 1..k-1, whose rows the next reset erased.
  const writeReport = async (): Promise<Report> => {
    const rep = buildReport();
    await writeAtomic(`${stem}.json`, JSON.stringify(rep, null, 2));
    await writeAtomic(`${stem}.md`, renderMarkdown(rep));
    return rep;
  };
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    stopped =
      "interrupted (Ctrl-C). Batches already uploaded keep running on the stack; the next run waits for them " +
      "before it resets.";
    writeReport()
      .then(() => console.error(`\n${stopped}\nReports: ${stem}.{json,md}`))
      .catch((e) => console.error(`could not write the report: ${(e as Error).message}`))
      .finally(() => cleanup().finally(() => process.exit(130)));
  });

  try {
    for (let t = 1; t <= args.trials; t++) {
      console.error(`\n── trial ${t}/${args.trials}${args.rescore ? ` (rescoring ${args.rescore.join(", ")})` : ""} ──`);
      if (t > 1 && args.container && conditionsKey(readContainer(args.container)) !== conditionsKey(conditions)) {
        throw new StopRun(
          `the stack's image or environment changed after the run started, so trial ${t} would not be ` +
            `comparable with the ones before it`,
        );
      }
      const run = args.rescore
        ? await adoptBatches(args, prepared, args.rescore)
        : await uploadTrial(args, t, prepared, tmp, limits.stallMs);
      const collected = await collectTrial(args, t, run, tmp, db, limits);
      let gaveUp = collected.gaveUp;
      if (!gaveUp && !args.rescore && args.container) {
        if (conditionsKey(readContainer(args.container)) !== conditionsKey(conditions)) {
          gaveUp = "the stack's image or environment changed during the trial";
        }
      }
      all.push(...collected.results);
      perTrial.push({
        trial: t,
        batch_ids: run.batchIds,
        complete: gaveUp === null,
        incomplete_reason: gaveUp,
        conditions: t === 1 ? conditions : args.container ? readContainer(args.container) : null,
        aggregate: aggregate(collected.results),
      });
      const a = perTrial.at(-1)!.aggregate;
      console.error(
        `  trial ${t}: date ${a.fields.date.correct}/${a.fields.date.scored}, total ${a.fields.total.correct}/${a.fields.total.scored}, ` +
          `payee ${a.fields.payee.correct}/${a.fields.payee.scored}, statuses ${JSON.stringify(a.statuses)}`,
      );
      await writeReport();
      if (gaveUp) {
        throw new StopRun(
          `trial ${t} did not finish: ${gaveUp}.` +
            (t + 1 === args.trials
              ? ` Trial ${args.trials} was not run.`
              : t < args.trials
                ? ` Trials ${t + 1}-${args.trials} were not run.`
                : ""),
        );
      }
    }
  } catch (e) {
    if (e instanceof StopRun) stopped = e.message;
    else fatal = e instanceof Error ? e.message : String(e);
  } finally {
    await cleanup();
  }
  if (interrupted) return; // the SIGINT handler writes and exits

  const report = await writeReport();
  const d = report.aggregate.fields.date;
  const ds = report.aggregate.fields_strict.date;
  console.error(`\n${report.complete ? "Done" : "Ended early"} in ${(report.duration_ms / 60000).toFixed(1)} min.`);
  console.error(
    `Date accuracy (finished trials): ${(d.accuracy * 100).toFixed(1)}% (${d.correct}/${d.scored}); ` +
      `strict ${(ds.accuracy * 100).toFixed(1)}% (${ds.correct}/${ds.scored})`,
  );
  console.error(`Reports: ${stem}.{json,md}`);
  if (fatal) {
    console.error(`\nFAILED: ${fatal}`);
    process.exit(1);
  }
  if (stopped) {
    console.error(`\nSTOPPED: ${stopped}`);
    process.exit(3);
  }
  if (args.gate && d.accuracy < 0.9) {
    console.error(`\nGATE FAILED: date accuracy ${(d.accuracy * 100).toFixed(1)}% < 90%`);
    process.exit(1);
  }
}

/** Write via a temporary file, so a reader never sees half a report. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmpFile = `${file}.${process.pid}.tmp`;
  await writeFile(tmpFile, text);
  await rename(tmpFile, file);
}

// Run when executed, not when imported (a later arm-diff script may reuse
// score / readMoney / checkStack).
const invokedAs = process.argv[1] ? realpathOr(process.argv[1]) : "";
if (invokedAs === realpathOr(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
