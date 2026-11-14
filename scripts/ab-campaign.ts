/**
 * ab-campaign.ts — the unattended runner of the wave-1 A/B (plan §12;
 * docs/server-writer.md, "A/B comparison"). Sandbox only. Night-run recipe
 * and what each output is: scripts/ab-campaign.md.
 *
 * A campaign runs, in order, a list of work items and remembers which are
 * done in `<out>/campaign.json`, so running it again with the same --id
 * resumes at the first unfinished one:
 *
 *   units   (trial t, arm A|B): arm A is `agent_sql`, arm B `server_apply`.
 *           Odd trials run A then B, even trials B then A. For each unit
 *           the sandbox app container is recreated (never rebuilt) with
 *           EXTRACTION_WRITER for the arm, MAX_CLAUDE_CONCURRENCY=1 and
 *           EXTRACTION_REPAIR_ROUNDS=1; the runner waits for the boot line
 *           naming that writer, checks that /version is the commit the
 *           campaign recorded, resets the ledger (scripts/sandbox-reset.sh),
 *           runs scripts/eval-dates.ts on the unit's fixtures with --dump,
 *           then scripts/check-ledger.ts with no allow list and, in arm B,
 *           scripts/check-projection-replay.ts --records. Every output is
 *           saved under `<out>/units/<unit>/attempt-<n>/`.
 *           Fixtures per trial: a `c1` manifest runs its `good` (and
 *           `good_rejects`) fixtures in trials 1-2 and its hard buckets in
 *           1-3; a `c2` manifest runs every fixture in trials 1-3. A
 *           duplicate pair runs together, as often as the member that
 *           needs more.
 *   c5      legacy re-extract on 3 arm-B transactions, each first given a
 *           user edit (payee, which sets `user_edited`, and narration) and
 *           a manual item through the API, then re-extracted twice: the
 *           outcome, Layer 3 kept, and one derivation_events row per run
 *           (gate G9). It reuses the ledger the last B unit left when
 *           nothing has touched the sandbox since; otherwise it runs its
 *           own small B unit first (3 extractions).
 *   c3:*    scripts/eval-dedup.ts (gate G5): the stub matrix in each writer
 *           mode (stub-A, stub-B), a8 at concurrency 3 (a8-c3), b2 b3 b4
 *           with the model under server_apply (claude-B), and `race` three
 *           times on a reset sandbox under each writer (race-B, race-A) at
 *           --race-concurrency, for "B >= A on race".
 *   c4      scripts/check-apply-extraction.ts --disposable on a throwaway
 *           Postgres of its own (docker run, removed afterwards). No model.
 *
 * An infrastructure failure voids a trial pair: the moment a run ends with
 * error_class quota, overloaded or auth, or the app log shows a 429, a
 * rate-limit or a usage-limit line, the runner interrupts the step, stops
 * the sandbox app (so its queue stops calling the API: the token also
 * serves the owner's other agents), marks the unit and its pair void, and
 * stops. The next run redoes both units of that trial from their reset.
 * A unit interrupted any other way (Ctrl-C, a crash, a killed process) is
 * redone from its reset too.
 *
 * Refuses: any other stack than the sandbox (container receipt-assistant-test
 * of compose project receipts-test, image receipt-assistant:sandbox,
 * EXTRACTOR_STUB_ALLOWED=1, API on 127.0.0.1:3001; port 3000 and the
 * production containers are never addressed), an image whose /version is
 * not the campaign's commit (or says `unknown`), an `.env` that sets
 * EXTRACTION_WRITER or MAX_CLAUDE_CONCURRENCY (production reads it too),
 * an --out inside a checkout, and a second runner on the same --out.
 *
 * When it ends, for any reason after it touched the stack, it recreates the
 * sandbox app quiet: the default writer (agent_sql), concurrency 1, one
 * repair round, no stand-in. It leaves the ledger as the last step left it.
 *
 * CLI — `--key=value`, or a bare `--flag`. `--uploads-dir` and `--set`
 * apply to the `--manifest` before them (before any, to all):
 *   --id=<id>               Campaign id; names --out. Default a new one. Pass
 *                           the same id to resume.
 *   --out=<dir>             Default <notes>/2026-11-13_design_wave1/ab/<id>.
 *                           Private: it holds dumps of real receipts.
 *   --manifest=<path>       Repeatable. Default the C1 manifest (set c1) and
 *                           the private C2 manifest (set c2).
 *   --uploads-dir=<dir>     Sources of the manifest before it, as eval-dates
 *                           takes them. Default eval-dates's default.
 *   --set=c1|c2             Trial and gating rules of that manifest (above;
 *                           diff-arms gates every c2 fixture and the c1
 *                           `good` ones). Default c1 for the first manifest,
 *                           c2 for the others.
 *   --trials=<n>            Trials to run, 1-3. Default 3. Fixed when the
 *                           campaign begins; a resume refuses another value.
 *   --steps=<list>          Any of units,c5,c3,c4 (default all), or single
 *                           items: t2-B, c3:race-A, …; an unknown name is
 *                           refused.
 *   --stop-after=<when>     HH:MM (the next such local time, refused when
 *                           that is more than 16 h away, as when the night's
 *                           command is re-run the next morning) or
 *                           YYYY-MM-DDTHH:MM (local). No item starts after
 *                           it, nor one whose run the median of the finished
 *                           items of its kind says cannot end by then. The
 *                           run stops cleanly (exit 3) and resumes on the
 *                           next invocation.
 *   --race-concurrency=<n>  MAX_CLAUDE_CONCURRENCY for c3:race-*. Default 6,
 *                           the sandbox's normal value (the plan's "race at
 *                           normal concurrency": two copies in flight at
 *                           once). Fixed when the campaign begins, like
 *                           --trials, so race-A and race-B run alike.
 *   --c5-keys=<k1,k2,k3>    Fixtures whose arm-B transactions c5 edits.
 *                           Default the first three `good` ones that booked.
 *   --dedup-manifest=<path> eval-dedup's --claude-manifest (its default).
 *   --env-file=<path>       Compose --env-file (the token and keys). Default
 *                           ~/Developer/receipt-assistant/.env. Never read
 *                           here beyond checking two variable names.
 *   --transcripts=<dir>     Session JSONL of the sandbox (eval-dates's default).
 *   --sha=<git sha>         Expected image commit; default whatever /version
 *                           says on the first run (recorded, then enforced).
 *   --throwaway-prefix=<p>  Name prefix of c4's throwaway Postgres container
 *                           (default ra-ab-c4; a container of that name is
 *                           replaced, then removed with its volume).
 *   --stand-in-claude=<f>   REHEARSAL: copy this executable over `claude` in
 *                           the app container after every recreate, so
 *                           nothing the campaign runs can reach a model. The
 *                           campaign is marked a rehearsal for good.
 *   --plan                  Print every unit and step with its estimated
 *                           extractions and tokens; touch nothing.
 *
 * Exit: 0 every selected item done; 3 stopped before that (--stop-after,
 * or an item failed: see campaign.md); 4 stopped on an outage (pair void);
 * 1 refused or a fatal error; 130 interrupted.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isInside, readContainer, type StackConditions } from "./eval-dates.js";

// ── Constants ──────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME = homedir();

/** The one stack a campaign may touch (docker-compose.test.yml). */
const SANDBOX = {
  base: "http://127.0.0.1:3001",
  pg: "postgresql://postgres:postgres@127.0.0.1:5433/receipts",
  app: "receipt-assistant-test",
  db: "receipts-test-postgres",
  project: "receipts-test",
  image: "receipt-assistant:sandbox",
  service: "receipt-assistant",
  compose: path.join(REPO_ROOT, "docker-compose.test.yml"),
  port: "3001",
} as const;

const NOTES = path.join(HOME, "Documents/10_Projects/2026_Dev_ReceiptAssistant/notes/2026-11-13_design_wave1");
const DEFAULT_C1 = path.join(REPO_ROOT, "scripts/eval-dates.fixtures.json");
const DEFAULT_C2 = path.join(NOTES, "ab-manifest-c2.json");
const DEFAULT_UPLOADS = process.env.UPLOADS_DIR ?? path.join(HOME, "Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads");

/** What the plan's §12.2 estimates per run: arm A about 0.9M billed input,
 *  arm B about 0.6M; wall time from the P0 and P3 runs. Rough. */
const EST = {
  tokens: { A: 900_000, B: 600_000, reextract: 900_000 },
  minutes: { A: 3, B: 1.5, reextract: 3 },
};

/** Run errors that void a trial pair (plan §12.1: an infrastructure error). */
const OUTAGE_CLASSES = ["quota", "overloaded", "auth"];
/** App-log lines that do the same, in the words `classifyAgentFailure`
 *  (`src/ingest/runs.ts`) reads for quota, overloaded and auth. The
 *  agent_runs look cannot see a run whose rows a reset has emptied (c3's
 *  race rounds reset between rounds), so the log must catch all three. A
 *  bare "429" or "529" is too common a number to stop on by itself, so it
 *  needs an HTTP or error word near it. */
const OUTAGE_LOG_RE =
  /rate[ _-]?limit|too many requests|usage limit|session limit|limit reached|overloaded|failed to authenticate|authentication_error|oauth access token is invalid|oauth session expired|(?:status|error|code|http)\D{0,20}\b(?:429|529|401)\b|\b(?:429|529)\b\D{0,20}(?:too many|rate|overloaded)/i;

type Arm = "A" | "B";
const WRITER: Record<Arm, "agent_sql" | "server_apply"> = { A: "agent_sql", B: "server_apply" };

const C3_PARTS = [
  { part: "stub-A", arm: "A", claude: false, args: [] as string[] },
  { part: "stub-B", arm: "B", claude: false, args: [] as string[] },
  { part: "a8-c3", arm: "B", claude: false, args: ["--only=a8"], concurrency: 3 },
  { part: "claude-B", arm: "B", claude: true, args: ["--only=b2,b3,b4"] },
  { part: "race-B", arm: "B", claude: true, args: ["--only=race", "--repeat=3", "--reset-between"], race: true },
  { part: "race-A", arm: "A", claude: true, args: ["--only=race", "--repeat=3", "--reset-between"], race: true },
] as const satisfies readonly {
  part: string;
  arm: Arm;
  claude: boolean;
  args: readonly string[];
  concurrency?: number;
  race?: boolean;
}[];
type C3Part = (typeof C3_PARTS)[number];

// ── CLI ────────────────────────────────────────────────────────────────

type SetName = "c1" | "c2";
interface ManifestSpec {
  path: string;
  uploadsDir: string;
  set: SetName;
  label: string;
}

const VALUE_FLAGS = [
  "id", "out", "manifest", "uploads-dir", "set", "trials", "steps", "stop-after", "race-concurrency",
  "c5-keys", "dedup-manifest", "env-file", "transcripts", "sha", "stand-in-claude", "throwaway-prefix",
] as const;
const BARE_FLAGS = ["plan"] as const;

function parseArgs(argv: string[]) {
  const single: Record<string, string> = {};
  const manifests: { path: string; uploadsDir?: string; set?: SetName }[] = [];
  let defaultUploads: string | null = null;
  let plan = false;
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unexpected argument ${JSON.stringify(a)}: flags are --key=value or a bare --flag`);
    const [, k, v] = m as unknown as [string, string, string | undefined];
    if ((BARE_FLAGS as readonly string[]).includes(k)) {
      if (v !== undefined) throw new Error(`--${k} takes no value`);
      plan = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(k)) throw new Error(`unknown flag --${k}`);
    if (v === undefined || v === "") throw new Error(`--${k} needs a value: --${k}=<value>`);
    if (k === "manifest") manifests.push({ path: path.resolve(v) });
    else if (k === "uploads-dir") {
      if (manifests.length) manifests.at(-1)!.uploadsDir = path.resolve(v);
      else defaultUploads = path.resolve(v);
    } else if (k === "set") {
      if (v !== "c1" && v !== "c2") throw new Error(`--set is c1 or c2, got ${JSON.stringify(v)}`);
      if (!manifests.length) throw new Error("--set applies to the --manifest before it");
      manifests.at(-1)!.set = v;
    } else {
      if (single[k] !== undefined) throw new Error(`--${k} given twice`);
      single[k] = v;
    }
  }
  const int = (k: string, dflt: number, lo: number, hi: number) => {
    const v = single[k];
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${k} must be an integer ${lo}..${hi}`);
    return n;
  };
  const id = single.id ?? `ab-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(2).toString("hex")}`;
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) throw new Error("--id may hold letters, digits, '.', '_' and '-' only");
  const stopAfter = single["stop-after"] ?? null;
  if (stopAfter !== null && !/^(?:\d{4}-\d{2}-\d{2}T)?([01]\d|2[0-3]):[0-5]\d$/.test(stopAfter)) {
    throw new Error("--stop-after is HH:MM or YYYY-MM-DDTHH:MM, 24-hour local time");
  }
  const steps = single.steps ? single.steps.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (steps) {
    const known = new Set(["units", "c3", "c4", "c5", ...workItems(3).map((i) => i.id)]);
    const unknown = steps.filter((x) => !known.has(x));
    if (unknown.length) throw new Error(`--steps names nothing called ${unknown.join(", ")} (known: ${[...known].join(", ")})`);
  }
  return {
    id,
    idGiven: single.id !== undefined,
    out: path.resolve(single.out ?? path.join(NOTES, "ab", id)),
    manifests: manifests.map((m, i): ManifestSpec => ({
      path: m.path,
      uploadsDir: m.uploadsDir ?? defaultUploads ?? DEFAULT_UPLOADS,
      set: m.set ?? (i === 0 ? "c1" : "c2"),
      label: "",
    })),
    defaultUploads,
    trials: int("trials", 3, 1, 3),
    trialsGiven: single.trials !== undefined,
    steps,
    stopAfter,
    raceConcurrency: int("race-concurrency", 6, 1, 6),
    raceConcurrencyGiven: single["race-concurrency"] !== undefined,
    c5Keys: single["c5-keys"] ? single["c5-keys"].split(",").map((s) => s.trim()).filter(Boolean) : null,
    dedupManifest: single["dedup-manifest"] ? path.resolve(single["dedup-manifest"]) : null,
    envFile: path.resolve(single["env-file"] ?? path.join(HOME, "Developer/receipt-assistant/.env")),
    transcripts: single.transcripts ? path.resolve(single.transcripts) : null,
    sha: single.sha ?? null,
    standIn: single["stand-in-claude"] ? path.resolve(single["stand-in-claude"]) : null,
    throwawayPrefix: single["throwaway-prefix"] ?? "ra-ab-c4",
    plan,
  };
}
type Args = ReturnType<typeof parseArgs>;

// ── Fixtures ───────────────────────────────────────────────────────────

/** A manifest entry as eval-dates reads it; only the fields used here. */
interface Entry {
  key?: string;
  sha256?: string;
  stored_path?: string;
  document_id?: string;
  bucket: string;
  ground_truth: { duplicate_of?: string } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface PlannedFixture {
  key: string;
  label: string;
  set: SetName;
  bucket: string;
  /** Trials 1..n run it. */
  trials: number;
  /** Gate G1 (a) holds every arm-B regression on it against arm B. */
  gated: boolean;
  /** Absolute source, or null when missing. */
  source: string | null;
  missing: string | null;
  entry: Entry;
}

const keyOf = (e: Entry): string => e.key ?? e.document_id ?? (e.sha256 ? e.sha256.slice(0, 12) : "?");

/** Every fixture of every manifest, with its trials, gating and source. */
async function planFixtures(specs: ManifestSpec[]): Promise<PlannedFixture[]> {
  const out: PlannedFixture[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const entries = JSON.parse(await readFile(spec.path, "utf8")) as Entry[];
    if (!Array.isArray(entries)) throw new Error(`${spec.path} is not a JSON array of fixtures`);
    let names: string[] = [];
    try {
      names = await readdir(spec.uploadsDir);
    } catch {
      names = [];
    }
    for (const e of entries) {
      const key = keyOf(e);
      if (seen.has(key)) throw new Error(`fixture key ${key} appears twice across the manifests; keys must be unique`);
      seen.add(key);
      let source: string | null = null;
      let missing: string | null = null;
      if (e.stored_path) {
        const p = path.join(spec.uploadsDir, e.stored_path);
        if (existsSync(p)) source = p;
        else missing = "source file not found";
      } else if (e.sha256) {
        const hits = names.filter((n) => n.split(".")[0]!.toLowerCase() === e.sha256!.toLowerCase());
        if (hits.length === 1) source = path.join(spec.uploadsDir, hits[0]!);
        else missing = hits.length ? "ambiguous source" : "no file by its sha256";
      } else missing = "no sha256 or stored_path";
      const hard = e.bucket.startsWith("hard_");
      out.push({
        key,
        label: spec.label,
        set: spec.set,
        bucket: e.bucket,
        trials: spec.set === "c2" || hard ? 3 : 2,
        gated: spec.set === "c2" || e.bucket === "good",
        source,
        missing,
        entry: e,
      });
    }
  }
  // A duplicate pair runs together, as often as the member that needs more.
  const byKey = new Map(out.map((f) => [f.key, f]));
  for (const f of out) {
    const twin = f.entry.ground_truth?.duplicate_of;
    const t = twin ? byKey.get(twin) : undefined;
    if (t) f.trials = t.trials = Math.max(f.trials, t.trials);
  }
  return out;
}

/**
 * The trial's manifest, every source reached through `<out>/sources/`
 * (symlinks), so fixtures of several manifests with several uploads
 * directories go up in ONE batch per unit, as eval-dates takes them.
 * Keys and upload names are unchanged.
 */
async function writeTrialManifest(
  out: string,
  fixtures: PlannedFixture[],
  trial: number,
  file = path.join(out, "manifests", `t${trial}.json`),
): Promise<{ manifest: string; sources: string; count: number }> {
  const sources = path.join(out, "sources");
  const entries: Entry[] = [];
  for (const f of fixtures) {
    if (f.trials < trial || !f.source) continue;
    const rel = path.join(f.label, path.basename(f.source));
    const link = path.join(sources, rel);
    await mkdir(path.dirname(link), { recursive: true });
    await rm(link, { force: true });
    await symlink(f.source, link);
    const { sha256: _sha, ...rest } = f.entry;
    entries.push({ ...rest, key: f.key, stored_path: rel });
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(entries, null, 2));
  return { manifest: file, sources, count: entries.length };
}

// ── State ──────────────────────────────────────────────────────────────

type ItemStatus = "pending" | "running" | "done" | "void" | "failed" | "interrupted";

interface Attempt {
  n: number;
  dir: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: ItemStatus;
  reason: string | null;
  results: Record<string, unknown>;
}

interface ItemState {
  status: ItemStatus;
  attempts: Attempt[];
}

interface CampaignState {
  version: 1;
  id: string;
  created_at: string;
  /** The image's commit (/version gitSha) and id; every unit must run it. */
  sha: string;
  image_id: string | null;
  /** The checkout the runner ran from, at the first run. */
  checkout_head: string | null;
  rehearsal: { stand_in_sha256: string } | null;
  trials: number;
  manifests: (ManifestSpec & { sha256: string; keys: string[] })[];
  race_concurrency: number;
  items: Record<string, ItemState>;
  /** Trial pairs voided by an outage, with why. */
  voids: { at: string; trial: number | null; item: string; reason: string; voided: string[] }[];
  /** What the sandbox ledger holds now, when a done unit left it there. */
  ledger: { item: string; arm: Arm; container_id: string; at: string } | null;
  stopped: { at: string; kind: "outage" | "stop-after" | "failed" | "interrupted"; reason: string } | null;
  log: { at: string; what: string }[];
}

interface WorkItem {
  id: string;
  kind: "unit" | "c5" | "c3" | "c4";
  trial?: number;
  arm?: Arm;
  part?: C3Part;
}

function workItems(trials: number): WorkItem[] {
  const items: WorkItem[] = [];
  for (let t = 1; t <= trials; t++) {
    const order: Arm[] = t % 2 === 1 ? ["A", "B"] : ["B", "A"];
    for (const arm of order) items.push({ id: `t${t}-${arm}`, kind: "unit", trial: t, arm });
  }
  // c5 right after the units: the last unit is B on an odd number of
  // trials, and c5 can then use its ledger without extracting anything.
  items.push({ id: "c5", kind: "c5" });
  for (const part of C3_PARTS) items.push({ id: `c3:${part.part}`, kind: "c3", part });
  items.push({ id: "c4", kind: "c4" });
  return items;
}

function selected(item: WorkItem, steps: string[] | null): boolean {
  if (!steps) return true;
  return steps.some((s) =>
    s === item.id || (s === "units" && item.kind === "unit") || (s === "c3" && item.kind === "c3") || s === item.kind,
  );
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const now = () => new Date().toISOString();

// ── Shell ──────────────────────────────────────────────────────────────

function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: opts.env ?? process.env, input: opts.input, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * eval-dates's dump (`src/ingest/apply/fingerprint.ts`), check-ledger and
 * check-projection-replay --records run from this checkout against rows
 * the image wrote, and diff-arms reads their output: the checkout's `src/`
 * (working tree included) must be the image commit's. Scripts and docs
 * may differ.
 */
function checkCheckout(sha: string): void {
  const r = sh("git", ["-C", REPO_ROOT, "diff", "--quiet", sha, "--", "src"]);
  if (r.code === 0) return;
  if (r.code === 1) {
    throw new Refusal(
      `this checkout's src/ differs from the image's commit ${sha.slice(0, 12)}: run from a checkout of that commit, or rebuild the sandbox from this one (a new campaign)`,
    );
  }
  throw new Refusal(`cannot compare this checkout with the image's commit ${sha.slice(0, 12)}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
}

function mustSh(cmd: string, args: string[], what: string, opts: { env?: NodeJS.ProcessEnv } = {}): string {
  const r = sh(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${what}: ${cmd} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  return r.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── The sandbox ────────────────────────────────────────────────────────

class Refusal extends Error {}
/** A failure of the stack itself: nothing after it can be trusted. */
class StackFailure extends Error {}
/** An outage (quota, overload, auth, rate limit): the pair is void. */
class Outage extends Error {}
class Interrupted extends Error {}

/** The compose file must be the sandbox's: pinned project, own image. */
function checkComposeFile(): void {
  if (path.basename(SANDBOX.compose) !== "docker-compose.test.yml") throw new Refusal("not the sandbox compose file");
  const text = readFileSync(SANDBOX.compose, "utf8");
  for (const needle of [`name: ${SANDBOX.project}`, `container_name: ${SANDBOX.app}`, `image: ${SANDBOX.image}`]) {
    if (!text.includes(needle)) throw new Refusal(`${SANDBOX.compose} does not say "${needle}"; refusing to drive it`);
  }
}

/** Production reads the same `.env`: a writer or concurrency set there
 *  would move it too. Only the two names are looked for. */
function checkEnvFile(envFile: string): void {
  if (!existsSync(envFile)) {
    throw new Refusal(`--env-file ${envFile} does not exist; compose would start the sandbox without the token`);
  }
  const bad = readFileSync(envFile, "utf8")
    .split("\n")
    .map((l) => /^\s*(?:export\s+)?(EXTRACTION_WRITER|MAX_CLAUDE_CONCURRENCY)\s*=/.exec(l)?.[1])
    .filter(Boolean);
  if (bad.length) {
    throw new Refusal(`${envFile} sets ${bad.join(", ")}, which production reads too. Take it out; the campaign sets both per run.`);
  }
}

/** The app container, refused unless it is the sandbox's. */
function checkApp(): StackConditions {
  const c = readContainer(SANDBOX.app);
  if (!c) throw new StackFailure(`no container ${SANDBOX.app}; bring the sandbox up (scripts/ab-campaign.md)`);
  if (c.compose_project !== SANDBOX.project) throw new Refusal(`${SANDBOX.app} is in compose project ${c.compose_project}, not ${SANDBOX.project}`);
  if (c.image !== SANDBOX.image) throw new Refusal(`${SANDBOX.app} runs image ${c.image}, not ${SANDBOX.image}`);
  if (c.env.EXTRACTOR_STUB_ALLOWED !== "1") throw new Refusal(`${SANDBOX.app} lacks EXTRACTOR_STUB_ALLOWED=1: not a sandbox`);
  if (c.running && !c.host_ports.includes(SANDBOX.port)) throw new Refusal(`${SANDBOX.app} does not publish ${SANDBOX.port}`);
  return c;
}

function containerId(name: string): string | null {
  const r = sh("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", name]);
  return r.code === 0 ? r.stdout.trim() : null;
}

function imageId(ref: string): string | null {
  const r = sh("docker", ["image", "inspect", "--format", "{{.Id}}", ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<{ status: number; json: T | null; headers: Headers }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = null;
  }
  return { status: r.status, json, headers: r.headers };
}

async function serverVersion(): Promise<{ gitSha?: string; gitShortSha?: string } | null> {
  try {
    const r = await getJson<{ gitSha?: string; gitShortSha?: string }>(`${SANDBOX.base}/version`, 5000);
    return r.status === 200 ? r.json : null;
  } catch {
    return null;
  }
}

/** Compose's environment for one recreate: ours wins over the shell's. */
function composeEnv(over: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["EXTRACTION_WRITER", "MAX_CLAUDE_CONCURRENCY", "EXTRACTION_REPAIR_ROUNDS", "GIT_SHA", "GIT_SHORT_SHA", "GIT_BRANCH"]) {
    delete env[k];
  }
  return { ...env, ...over };
}

interface StackConfig {
  /** null: the compose default (agent_sql). */
  arm: Arm | null;
  concurrency: number;
}

/**
 * Recreate the app container from the existing image (never a build) with
 * the arm's writer, then wait for the boot line naming it and check the
 * image is the campaign's commit.
 */
async function recreate(cfg: StackConfig, ctx: Ctx): Promise<StackConditions> {
  const over: Record<string, string> = {
    MAX_CLAUDE_CONCURRENCY: String(cfg.concurrency),
    EXTRACTION_REPAIR_ROUNDS: "1",
  };
  if (cfg.arm) over.EXTRACTION_WRITER = WRITER[cfg.arm];
  const writer = cfg.arm ? WRITER[cfg.arm] : "agent_sql";
  ctx.say(`recreate ${SANDBOX.app}: writer ${writer}, concurrency ${cfg.concurrency}, repair rounds 1`);
  ctx.touched = true;
  mustSh(
    "docker",
    ["compose", "-f", SANDBOX.compose, "--env-file", ctx.args.envFile, "up", "-d", "--no-build", "--no-deps", "--force-recreate", SANDBOX.service],
    "recreating the sandbox app",
    { env: composeEnv(over) },
  );
  // The boot line names the writer (src/server.ts).
  const want = new RegExp(
    `Ingest worker ready \\(concurrency ${cfg.concurrency}, writer ${writer}` + (writer === "server_apply" ? ", repair rounds 1\\)" : "\\)"),
  );
  const deadline = Date.now() + 180_000;
  for (;;) {
    // A recreate is a new container: its log starts at this boot.
    const logs = sh("docker", ["logs", SANDBOX.app]);
    if (want.test(logs.stdout + logs.stderr)) break;
    if (Date.now() > deadline) throw new StackFailure(`no boot line matching ${want} within 3 min of the recreate`);
    await sleep(2000);
  }
  // The worker's boot line comes before the HTTP server listens.
  let v = await serverVersion();
  for (let i = 0; !v?.gitSha && i < 30; i++) {
    await sleep(2000);
    v = await serverVersion();
  }
  if (!v?.gitSha) throw new StackFailure("/version did not answer within a minute of the boot line");
  if (v.gitSha !== ctx.state.sha) {
    throw new StackFailure(`the sandbox runs ${v.gitSha}, not the campaign's ${ctx.state.sha}: the image was rebuilt. A campaign runs one build.`);
  }
  const c = checkApp();
  if (ctx.state.image_id && c.image_id !== ctx.state.image_id) {
    throw new StackFailure(`the sandbox image is ${c.image_id}, not the campaign's ${ctx.state.image_id}`);
  }
  const expect: Record<string, string> = {
    EXTRACTION_WRITER: writer,
    MAX_CLAUDE_CONCURRENCY: String(cfg.concurrency),
    EXTRACTION_REPAIR_ROUNDS: "1",
    EXTRACTOR_STUB_ALLOWED: "1",
  };
  for (const [k, v2] of Object.entries(expect)) {
    if (c.env[k as keyof StackConditions["env"]] !== v2) {
      throw new StackFailure(`after the recreate ${k}=${c.env[k as keyof StackConditions["env"]]}, expected ${v2}`);
    }
  }
  if (!c.google_maps_key_set && !ctx.state.rehearsal) {
    ctx.say("warn: GOOGLE_MAPS_API_KEY is not set in the sandbox; the plan holds it present in both arms (payee, place)");
  }
  if (ctx.args.standIn) installStandIn(ctx);
  return c;
}

/** REHEARSAL: the stand-in over `claude`, first on the app's PATH. */
function installStandIn(ctx: Ctx): void {
  const dest = "/usr/local/sbin/claude";
  mustSh("docker", ["cp", ctx.args.standIn!, `${SANDBOX.app}:${dest}`], "copying the stand-in claude");
  mustSh("docker", ["exec", "-u", "0", SANDBOX.app, "chmod", "755", dest], "making the stand-in executable");
  const which = sh("docker", ["exec", SANDBOX.app, "sh", "-c", "command -v claude"]).stdout.trim();
  if (which !== dest) throw new StackFailure(`the stand-in is not first on the app's PATH (claude resolves to ${which})`);
  ctx.say("stand-in claude installed: nothing in this step can reach a model");
}

/** Back to the quiet state: default writer, concurrency 1, no stand-in. */
async function restoreQuiet(ctx: Ctx): Promise<void> {
  try {
    const saved = ctx.args.standIn;
    ctx.args.standIn = null;
    await recreate({ arm: null, concurrency: 1 }, ctx);
    ctx.args.standIn = saved;
    ctx.say("sandbox left quiet: writer agent_sql, concurrency 1 (ledger as the last step left it)");
  } catch (e) {
    ctx.say(`could not leave the sandbox quiet: ${(e as Error).message}`);
  }
}

async function waitIdle(ctx: Ctx, stallMs = 20 * 60_000): Promise<void> {
  let lastSig = "";
  let lastMove = Date.now();
  for (;;) {
    const i = await getJson<{ items: { id: string; status: string }[] }>(`${SANDBOX.base}/v1/ingests?status=queued,processing&limit=100`).catch(() => null);
    const b = await getJson<{ items: { id: string }[] }>(`${SANDBOX.base}/v1/batches?status=reconciling&limit=100`).catch(() => null);
    if (i?.status === 200 && b?.status === 200) {
      if (i.json!.items.length === 0 && b.json!.items.length === 0) return;
      const sig = JSON.stringify([i.json!.items, b.json!.items]);
      if (sig !== lastSig) {
        lastSig = sig;
        lastMove = Date.now();
      }
    }
    if (Date.now() - lastMove > stallMs) throw new StackFailure("the sandbox's work in flight has not moved for 20 min");
    await sleep(3000);
  }
}

async function resetLedger(ctx: Ctx, log: string): Promise<void> {
  await waitIdle(ctx);
  const r = sh(path.join(SCRIPT_DIR, "sandbox-reset.sh"), []);
  await appendFile(log, `$ scripts/sandbox-reset.sh\n${r.stdout}${r.stderr}\n(exit ${r.code})\n`);
  if (r.code !== 0) throw new StackFailure(`scripts/sandbox-reset.sh exited ${r.code} (see ${log})`);
  ctx.state.ledger = null;
  await ctx.save();
}

// ── Outage watch ───────────────────────────────────────────────────────

/** Looks for the run errors and log lines that void a pair. */
class OutageWatch {
  private client: pg.Client | null = null;
  constructor(private readonly since: Date) {}

  async check(): Promise<string | null> {
    try {
      if (!this.client) {
        this.client = new pg.Client({ connectionString: SANDBOX.pg, options: "-c default_transaction_read_only=on" });
        await this.client.connect();
      }
      const r = await this.client.query(
        `SELECT kind::text AS kind, error_class::text AS error_class, count(*)::int AS n
           FROM agent_runs WHERE started_at >= $1 AND error_class::text = ANY($2)
          GROUP BY 1, 2`,
        [this.since, OUTAGE_CLASSES],
      );
      if (r.rows.length) {
        return `agent run(s) ended with ${r.rows.map((x) => `${x.error_class} (${x.kind}) x${x.n}`).join(", ")}`;
      }
    } catch (e) {
      // The table is emptied by a reset and the stack may be restarting:
      // a failed look is not an outage.
      await this.close();
      void e;
    }
    // 30 s of margin for a container clock behind the host's.
    const logs = sh("docker", ["logs", "--since", new Date(this.since.getTime() - 30_000).toISOString(), SANDBOX.app]);
    const line = (logs.stdout + "\n" + logs.stderr).split("\n").find((l) => OUTAGE_LOG_RE.test(l));
    if (line) return `the app log shows: ${line.trim().slice(0, 200)}`;
    return null;
  }

  async close(): Promise<void> {
    await this.client?.end().catch(() => {});
    this.client = null;
  }
}

// ── Child scripts ──────────────────────────────────────────────────────

interface ChildResult {
  code: number | null;
  outage: string | null;
}

/**
 * Run a script of this repository (tsx), its output teed to `log`, with
 * the outage watch every 15 s when given. On an outage, or when the
 * campaign is interrupted, the child gets one SIGINT (eval-dates then
 * writes its report) and, after 2 min, SIGKILL.
 */
async function runScript(
  ctx: Ctx,
  script: string,
  args: string[],
  log: string,
  watch: OutageWatch | null,
): Promise<ChildResult> {
  await appendFile(log, `$ npx tsx scripts/${script} ${args.join(" ")}\n`);
  const out = createWriteStream(log, { flags: "a" });
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", path.join(SCRIPT_DIR, script), ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  ctx.child = child;
  child.stdout!.on("data", (b: Buffer) => {
    out.write(b);
    process.stderr.write(b);
  });
  child.stderr!.on("data", (b: Buffer) => {
    out.write(b);
    process.stderr.write(b);
  });
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let outage: string | null = null;
  let stopping = false;
  let interruptSeen: number | null = null;
  let lastWatch = 0;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    ctx.say(`stopping ${script}: ${why}`);
    child.kill("SIGINT");
    setTimeout(() => child.kill("SIGKILL"), 120_000).unref();
  };
  for (;;) {
    const settled = await Promise.race([done.then(() => true), sleep(5_000).then(() => false)]);
    if (settled) break;
    // A Ctrl-C in the terminal reaches the child too (same process group),
    // and eval-dates exits at once on a second SIGINT, before its report:
    // forward one only if the child is still running 10 s later.
    if (ctx.interrupted) {
      interruptSeen ??= Date.now();
      if (Date.now() - interruptSeen > 10_000) stop("the campaign was interrupted");
    }
    if (watch && !outage && Date.now() - lastWatch >= 15_000) {
      lastWatch = Date.now();
      outage = await watch.check();
      if (outage) stop(outage);
    }
  }
  const code = await done;
  ctx.child = null;
  await new Promise<void>((r) => out.end(r));
  await appendFile(log, `(exit ${code})\n\n`);
  if (watch && !outage) outage = await watch.check();
  return { code, outage };
}

/** One check script, output to a file; the exit code is the verdict. */
async function runCheck(ctx: Ctx, script: string, args: string[], file: string): Promise<number | null> {
  const r = await runScript(ctx, script, args, file, null);
  return r.code;
}

// ── Items ──────────────────────────────────────────────────────────────

interface Ctx {
  args: Args;
  state: CampaignState;
  fixtures: PlannedFixture[];
  save: () => Promise<void>;
  say: (s: string) => void;
  touched: boolean;
  interrupted: boolean;
  child: ChildProcess | null;
}

function stopStackForOutage(ctx: Ctx, reason: string): void {
  ctx.say(`OUTAGE: ${reason}. Stopping ${SANDBOX.app} so its queue stops calling the API.`);
  sh("docker", ["stop", "-t", "30", SANDBOX.app]);
}

/** eval-dates on one unit's fixtures, then check-ledger and (B) --records. */
async function runUnit(ctx: Ctx, item: WorkItem, attempt: Attempt): Promise<Record<string, unknown>> {
  const arm = item.arm!;
  const trial = item.trial!;
  const dir = attempt.dir;
  const log = path.join(dir, "unit.log");
  const tm = await writeTrialManifest(ctx.args.out, ctx.fixtures, trial);
  await recreate({ arm, concurrency: 1 }, ctx);
  await resetLedger(ctx, log);
  const since = new Date();
  const watch = new OutageWatch(since);
  const runId = `${ctx.state.id}-${item.id}-a${attempt.n}`;
  const evalArgs = [
    `--manifest=${tm.manifest}`,
    `--uploads-dir=${tm.sources}`,
    `--run-id=${runId}`,
    `--label=${ctx.state.id} ${item.id} (arm ${arm}, attempt ${attempt.n})`,
    `--out=${dir}`,
    `--dump=${path.join(dir, "dump")}`,
    `--pg=${SANDBOX.pg}`,
    `--base=${SANDBOX.base}`,
    `--container=${SANDBOX.app}`,
    ...(ctx.args.transcripts ? [`--transcripts=${ctx.args.transcripts}`] : []),
  ];
  const ev = await runScript(ctx, "eval-dates.ts", evalArgs, path.join(dir, "eval-dates.log"), watch);
  await watch.close();
  if (ev.outage) throw new Outage(ev.outage);
  if (ctx.interrupted) throw new Interrupted("interrupted during eval-dates");
  const results: Record<string, unknown> = {
    fixtures: tm.count,
    eval_dates_exit: ev.code,
    run_id: runId,
    report: path.join(dir, `eval-dates.${runId}.report.json`),
    dump: path.join(dir, "dump", runId, "t1"),
  };
  results.check_ledger_exit = await runCheck(ctx, "check-ledger.ts", [`--pg=${SANDBOX.pg}`], path.join(dir, "check-ledger.txt"));
  if (arm === "B") {
    results.replay_records_exit = await runCheck(
      ctx,
      "check-projection-replay.ts",
      [`--pg=${SANDBOX.pg}`, "--records"],
      path.join(dir, "replay-records.txt"),
    );
  }
  const logs = sh("docker", ["logs", "--since", since.toISOString(), SANDBOX.app]);
  await writeFile(path.join(dir, "app.log"), logs.stdout + logs.stderr);
  if (ev.code !== 0) {
    throw new StackFailure(`eval-dates exited ${ev.code} (see ${path.join(dir, "eval-dates.log")}); the unit is redone on the next run`);
  }
  ctx.state.ledger = { item: item.id, arm, container_id: containerId(SANDBOX.app) ?? "", at: now() };
  return results;
}

/** eval-dedup under one writer and concurrency, on a reset sandbox. */
async function runC3(ctx: Ctx, item: WorkItem, attempt: Attempt): Promise<Record<string, unknown>> {
  const part = item.part!;
  const dir = attempt.dir;
  const concurrency = "race" in part && part.race ? ctx.state.race_concurrency : "concurrency" in part ? part.concurrency : 1;
  await recreate({ arm: part.arm, concurrency }, ctx);
  await resetLedger(ctx, path.join(dir, "step.log"));
  const json = path.join(dir, "eval-dedup.json");
  const args = [
    `--base=${SANDBOX.base}`,
    `--pg=${SANDBOX.pg}`,
    `--writer=${WRITER[part.arm]}`,
    ...part.args,
    ...(part.claude ? ["--with-claude"] : []),
    ...(part.claude && ctx.args.dedupManifest ? [`--claude-manifest=${ctx.args.dedupManifest}`] : []),
    `--json=${json}`,
  ];
  const watch = part.claude ? new OutageWatch(new Date()) : null;
  const r = await runScript(ctx, "eval-dedup.ts", args, path.join(dir, "eval-dedup.log"), watch);
  await watch?.close();
  if (r.outage) throw new Outage(r.outage);
  if (ctx.interrupted) throw new Interrupted("interrupted during eval-dedup");
  let summary: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(await readFile(json, "utf8")) as { passed: number; total: number; results: { name: string; pass: boolean }[] };
    const byCase: Record<string, { pass: number; runs: number }> = {};
    for (const x of j.results) {
      byCase[x.name] ??= { pass: 0, runs: 0 };
      byCase[x.name]!.runs++;
      if (x.pass) byCase[x.name]!.pass++;
    }
    summary = { passed: j.passed, total: j.total, cases: byCase };
  } catch {
    summary = null;
  }
  // 0 every case passed, 1 a case failed (a result), 2 the harness could not run.
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`eval-dedup exited ${r.code} (see ${path.join(dir, "eval-dedup.log")})`);
  }
  return { writer: WRITER[part.arm], concurrency, eval_dedup_exit: r.code, json, summary };
}

/** check-apply-extraction on a throwaway Postgres of its own. */
async function runC4(ctx: Ctx, attempt: Attempt): Promise<Record<string, unknown>> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/.test(ctx.args.throwawayPrefix)) throw new Error("--throwaway-prefix: lower-case letters, digits, '.', '_', '-'");
  const name = `${ctx.args.throwawayPrefix}-${sha256(ctx.state.id).slice(0, 8)}`;
  const log = path.join(attempt.dir, "check-apply-extraction.txt");
  sh("docker", ["rm", "-f", "-v", name]);
  mustSh(
    "docker",
    ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=receipts", "-p", "127.0.0.1::5432", "postgres:17"],
    "starting the throwaway Postgres",
  );
  try {
    const deadline = Date.now() + 90_000;
    while (sh("docker", ["exec", name, "psql", "-U", "postgres", "-d", "receipts", "-tAc", "SELECT 1"]).stdout.trim() !== "1") {
      if (Date.now() > deadline) throw new Error("the throwaway Postgres did not come up");
      await sleep(1000);
    }
    const port = /:(\d+)\s*$/.exec(mustSh("docker", ["port", name, "5432/tcp"], "reading its port").trim().split("\n")[0]!)?.[1];
    if (!port) throw new Error("no host port for the throwaway Postgres");
    const code = await runCheck(
      ctx,
      "check-apply-extraction.ts",
      ["--disposable", `--db=postgresql://postgres:postgres@127.0.0.1:${port}/receipts`],
      log,
    );
    const text = await readFile(log, "utf8");
    const passed = /(\d+)\s*\/\s*(\d+)\s+(?:passed|fixtures)/i.exec(text);
    return { exit: code, log, summary: passed ? `${passed[1]}/${passed[2]}` : null };
  } finally {
    sh("docker", ["rm", "-f", "-v", name]);
  }
}

interface C5Target {
  key: string | null;
  transaction_id: string;
  document_id: string;
}

/** c5's three arm-B transactions: from the last B unit's ledger when it is
 *  still in place, else from a small B unit of its own. */
async function c5Targets(ctx: Ctx, attempt: Attempt, client: pg.Client): Promise<{ targets: C5Target[]; source: string }> {
  const want = ctx.args.c5Keys;
  const dir = attempt.dir;
  let report: string | null = null;
  let source: string;
  const reuse =
    ctx.state.ledger?.arm === "B" &&
    ctx.state.items[ctx.state.ledger.item]?.status === "done" &&
    ctx.state.ledger.container_id === containerId(SANDBOX.app);
  if (reuse) {
    const last = ctx.state.items[ctx.state.ledger!.item]!.attempts.at(-1)!;
    report = String(last.results.report);
    source = `the ledger ${ctx.state.ledger!.item} left`;
    ctx.say(`c5 uses ${source}`);
    ctx.touched = true;
    if (ctx.args.standIn) installStandIn(ctx);
  } else {
    // Its own small B unit: the chosen fixtures, or the first three good ones.
    const pool = ctx.fixtures.filter((f) => f.source && (want ? want.includes(f.key) : f.bucket === "good" && !f.entry.ground_truth?.duplicate_of));
    const pick = (want ? want.map((k) => pool.find((f) => f.key === k)).filter((f): f is PlannedFixture => !!f) : pool).slice(0, 3);
    if (pick.length < 3) throw new Error(`c5 needs 3 runnable fixtures, found ${pick.length}`);
    const manifest = path.join(dir, "c5-manifest.json");
    const tm = await writeTrialManifest(ctx.args.out, pick.map((f) => ({ ...f, trials: 1 })), 1, manifest);
    await recreate({ arm: "B", concurrency: 1 }, ctx);
    await resetLedger(ctx, path.join(dir, "step.log"));
    const runId = `${ctx.state.id}-c5-a${attempt.n}`;
    const watch = new OutageWatch(new Date());
    const ev = await runScript(
      ctx,
      "eval-dates.ts",
      [
        `--manifest=${manifest}`,
        `--uploads-dir=${tm.sources}`,
        `--run-id=${runId}`,
        `--label=${ctx.state.id} c5 setup (arm B)`,
        `--out=${dir}`,
        `--base=${SANDBOX.base}`,
        `--container=${SANDBOX.app}`,
        `--pg=${SANDBOX.pg}`,
      ],
      path.join(dir, "eval-dates.log"),
      watch,
    );
    await watch.close();
    if (ev.outage) throw new Outage(ev.outage);
    if (ctx.interrupted) throw new Interrupted("interrupted during the c5 setup");
    report = path.join(dir, `eval-dates.${runId}.report.json`);
    source = "a B unit of its own";
  }
  // The ledger is about to be edited: no later step may take it as a unit's.
  ctx.state.ledger = null;
  await ctx.save();
  const rep = JSON.parse(await readFile(report, "utf8")) as {
    fixtures: { key: string; bucket: string; ingest_status: string; transaction_id: string | null }[];
  };
  const order = want ?? rep.fixtures.filter((f) => f.bucket === "good").map((f) => f.key);
  const targets: C5Target[] = [];
  for (const key of order) {
    if (targets.length === 3) break;
    const f = rep.fixtures.find((x) => x.key === key && x.ingest_status === "done" && x.transaction_id);
    if (!f) continue;
    // A live server-written row with exactly one live document.
    const r = await client.query(
      `SELECT t.id, (SELECT array_agg(d.id) FROM document_links dl JOIN documents d ON d.id = dl.document_id
                       WHERE dl.transaction_id = t.id AND d.deleted_at IS NULL) AS docs
         FROM transactions t
        WHERE t.id = $1 AND t.deleted_at IS NULL AND t.metadata->'extraction'->>'writer' = 'server_apply'`,
      [f.transaction_id],
    );
    const docs = (r.rows[0]?.docs ?? []) as string[];
    if (r.rows.length && docs.length === 1) targets.push({ key, transaction_id: f.transaction_id!, document_id: docs[0]! });
  }
  if (targets.length < 3) throw new Error(`c5 found ${targets.length} usable arm-B transactions (needs 3) in ${report}`);
  return { targets, source };
}

const C5_ITEM = "C5 manual line";
const C5_NARRATION = "C5: a user note re-extract must keep";

/** Gate G9: legacy re-extract on arm-B rows after a user edit. */
async function runC5(ctx: Ctx, attempt: Attempt): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: SANDBOX.pg, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    const { targets, source } = await c5Targets(ctx, attempt, client);
    const since = new Date();
    const watch = new OutageWatch(since);
    const per: Record<string, unknown>[] = [];
    const state = async (t: C5Target, editedPayee: string) => {
      const r = await client.query(
        `SELECT t.payee = $2 AS payee_kept, t.narration = $3 AS narration_kept,
                COALESCE((t.metadata->'user_edited'->>'payee')::boolean, false) AS flag_kept,
                (SELECT count(*) FROM transaction_items i WHERE i.transaction_id = t.id AND i.source = 'manual'
                    AND i.retired_at IS NULL AND i.raw_name = $4)::int AS manual_live,
                (SELECT count(*) FROM derivation_events e WHERE e.entity_type = 'document' AND e.entity_id = $5)::int AS events
           FROM transactions t WHERE t.id = $1`,
        [t.transaction_id, editedPayee, C5_NARRATION, C5_ITEM, t.document_id],
      );
      return r.rows[0] as { payee_kept: boolean; narration_kept: boolean; flag_kept: boolean; manual_live: number; events: number };
    };
    for (const t of targets) {
      // The user's edit: payee (a soft Layer 3 field: sets user_edited),
      // narration (hard Layer 3), and a manual line.
      const got = await getJson<{ payee: string | null }>(`${SANDBOX.base}/v1/transactions/${t.transaction_id}`);
      const etag = got.headers.get("etag");
      if (got.status !== 200 || !etag) throw new Error(`GET transaction → ${got.status}`);
      const editedPayee = `${got.json?.payee ?? "Payee"} (edited)`;
      const patch = await fetch(`${SANDBOX.base}/v1/transactions/${t.transaction_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json", "If-Match": etag },
        body: JSON.stringify({ payee: editedPayee, narration: C5_NARRATION }),
      });
      if (patch.status !== 200) throw new Error(`PATCH transaction → ${patch.status}: ${(await patch.text()).slice(0, 300)}`);
      const item = await fetch(`${SANDBOX.base}/v1/transactions/${t.transaction_id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ raw_name: C5_ITEM, line_total_minor: 0, item_class: "other" }] }),
      });
      if (item.status !== 201) throw new Error(`POST items → ${item.status}: ${(await item.text()).slice(0, 300)}`);
      const before = await state(t, editedPayee);
      const runs: Record<string, unknown>[] = [];
      for (let n = 1; n <= 2; n++) {
        if (ctx.interrupted) throw new Interrupted("interrupted during c5");
        ctx.say(`c5: re-extract ${n}/2 of ${t.key ?? t.transaction_id.slice(0, 8)}`);
        const startedAt = Date.now();
        const res = await fetch(`${SANDBOX.base}/v1/documents/${t.document_id}/re-extract?transaction_id=${t.transaction_id}`, {
          method: "POST",
          signal: AbortSignal.timeout(20 * 60_000),
        });
        const body = (await res.json().catch(() => null)) as { outcome?: string; changed_keys?: string[]; type?: string } | null;
        const outage = await watch.check();
        if (outage) throw new Outage(outage);
        const after = await state(t, editedPayee);
        runs.push({
          http: res.status,
          outcome: body?.outcome ?? body?.type ?? null,
          changed_keys: body?.changed_keys ?? null,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          layer3_kept: after.payee_kept && after.narration_kept && after.flag_kept && after.manual_live === 1,
          derivation_events_added: after.events - (n === 1 ? before.events : (runs[0]!.events_after as number)),
          events_after: after.events,
        });
      }
      per.push({ key: t.key, transaction_id: t.transaction_id, document_id: t.document_id, runs });
    }
    await watch.close();
    const pass = per.every((p) => {
      const [r1, r2] = p.runs as { outcome: string; layer3_kept: boolean; derivation_events_added: number }[];
      return (
        r1!.outcome === "written" && r2!.outcome === "no_change" &&
        r1!.layer3_kept && r2!.layer3_kept &&
        r1!.derivation_events_added === 1 && r2!.derivation_events_added === 1
      );
    });
    const result = { source, transactions: per, g9_pass: pass };
    await writeFile(path.join(attempt.dir, "c5.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Stop-after ─────────────────────────────────────────────────────────

/** A bare HH:MM further away than this is refused: it is most likely the
 *  night's command re-run after its stop time, which would run the
 *  campaign through the day on the shared token. */
const STOP_AFTER_MAX_HOURS = 16;

/** --stop-after as a local instant: YYYY-MM-DDTHH:MM as given, HH:MM the
 *  next such time after `from`. */
function resolveStopAfter(when: string, from: Date): Date {
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(when);
  if (full) {
    const [, y, mo, d, h, mi] = full.map(Number) as [number, number, number, number, number, number];
    const at = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (at.getTime() <= from.getTime()) throw new Refusal(`--stop-after=${when} is already past`);
    return at;
  }
  const [h, m] = when.split(":").map(Number) as [number, number];
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  const hours = (d.getTime() - from.getTime()) / 3_600_000;
  if (hours > STOP_AFTER_MAX_HOURS) {
    throw new Refusal(
      `--stop-after=${when} is ${hours.toFixed(1)} h from now (${d.toLocaleString()}): pass it as YYYY-MM-DDTHH:MM if that is meant`,
    );
  }
  return d;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Why the item must not start now, or null. */
function stopAfterSays(ctx: Ctx, item: WorkItem, deadline: Date | null): string | null {
  if (!deadline) return null;
  const t = Date.now();
  if (t >= deadline.getTime()) return `it is past --stop-after (${deadline.toLocaleTimeString()})`;
  // Like with like: a stub matrix takes a minute, a race round a quarter
  // of an hour.
  const kindOf = (w: WorkItem) =>
    w.kind !== "c3" ? w.kind : w.part && "race" in w.part && w.part.race ? "c3 race" : w.part?.claude ? "c3 claude" : "c3 stub";
  const byId = new Map(workItems(ctx.state.trials).map((w) => [w.id, w]));
  const durations = Object.entries(ctx.state.items)
    .filter(([id, s]) => byId.has(id) && kindOf(byId.get(id)!) === kindOf(item) && s.status === "done")
    .map(([, s]) => s.attempts.at(-1)!.duration_ms ?? 0);
  const m = median(durations);
  if (m !== null && t + m > deadline.getTime()) {
    return `the median of the finished ${item.kind === "unit" ? "units" : `${kindOf(item)} steps`} (${Math.round(m / 60_000)} min) would end after --stop-after (${deadline.toLocaleTimeString()})`;
  }
  return null;
}

// ── Plan ───────────────────────────────────────────────────────────────

function printPlan(args: Args, fixtures: PlannedFixture[], trials: number): void {
  const L: string[] = [];
  L.push(`Campaign ${args.id}: plan only, nothing runs`);
  L.push(`  out: ${args.out}`);
  for (const spec of args.manifests) {
    const fs = fixtures.filter((f) => f.label === spec.label);
    const missing = fs.filter((f) => !f.source).length;
    L.push(
      `  ${spec.label} (set ${spec.set}): ${fs.length} entries, ${fs.length - missing} runnable` +
        (missing ? `, ${missing} without a source (skipped)` : "") +
        `, ${fs.filter((f) => f.gated).length} gated for G1 (a)`,
    );
  }
  const perTrial = (t: number) => fixtures.filter((f) => f.source && f.trials >= t).length;
  let ext = 0;
  let tok = 0;
  let min = 0;
  L.push("");
  L.push("  item        writer        extractions   ~billed input   ~minutes");
  for (const item of workItems(trials)) {
    if (!selected(item, args.steps)) continue;
    let n = 0;
    let note = "";
    let tokens = 0;
    let minutes = 0;
    if (item.kind === "unit") {
      n = perTrial(item.trial!);
      tokens = n * EST.tokens[item.arm!];
      minutes = n * EST.minutes[item.arm!] + 3;
    } else if (item.kind === "c5") {
      n = 3;
      note = "0 when it reuses the last B unit's ledger; plus 6 re-extracts";
      tokens = 3 * EST.tokens.B + 6 * EST.tokens.reextract;
      minutes = 3 * EST.minutes.B + 6 * EST.minutes.reextract;
    } else if (item.kind === "c3") {
      const p = item.part!;
      n = p.part === "claude-B" ? 5 : "race" in p && p.race ? 6 : 0;
      note = p.part === "claude-B" ? "b2 2, b3 1, b4 2" : "race" in p && p.race ? "race x3, 2 copies each" : "stubs, no model";
      tokens = n * EST.tokens[p.arm];
      minutes = n ? n * EST.minutes[p.arm] + 10 : 3;
    } else {
      note = "throwaway Postgres, no model";
      minutes = 2;
    }
    ext += n;
    tok += tokens;
    min += minutes;
    const writer = item.kind === "unit" || item.kind === "c3" ? WRITER[(item.arm ?? item.part!.arm) as Arm] : item.kind === "c5" ? "server_apply" : "-";
    L.push(
      `  ${item.id.padEnd(11)} ${writer.padEnd(13)} ${String(n).padStart(11)}   ${(tokens / 1e6).toFixed(1).padStart(11)}M   ${String(Math.round(minutes)).padStart(8)}` +
        (note ? `   (${note})` : ""),
    );
  }
  L.push("");
  L.push(`  total: about ${ext} extractions + 6 re-extracts, ~${(tok / 1e6).toFixed(0)}M billed input, ~${(min / 60).toFixed(1)} h`);
  L.push(`  per-run estimates from plan §12.2 (A ~${EST.tokens.A / 1e6}M, B ~${EST.tokens.B / 1e6}M) and the P0/P3 runs; rough.`);
  if (args.standIn) L.push("  REHEARSAL (--stand-in-claude): every spawn reaches the stand-in; no model is called and no quota is spent.");
  console.log(L.join("\n"));
}

// ── Summary ────────────────────────────────────────────────────────────

/** campaign.md: statuses, attempts, durations and exit codes; no values. */
function renderSummary(state: CampaignState): string {
  const L: string[] = [];
  L.push(`# A/B campaign ${state.id}${state.rehearsal ? " (REHEARSAL: stand-in claude, no model)" : ""}`);
  L.push("");
  L.push(`Image ${state.sha.slice(0, 12)} · trials ${state.trials} · race concurrency ${state.race_concurrency} · created ${state.created_at.slice(0, 16)}Z`);
  if (state.stopped) L.push(`\n**Stopped** (${state.stopped.kind}) at ${state.stopped.at.slice(0, 19)}Z: ${state.stopped.reason}`);
  L.push("");
  L.push("| Item | Status | Attempts | Last duration | Results |");
  L.push("|---|---|---|---|---|");
  for (const [id, s] of Object.entries(state.items)) {
    const a = s.attempts.at(-1);
    const r = a?.results ?? {};
    const res = Object.entries(r)
      .filter(([k]) => /exit|count|fixtures|pass|summary/.test(k))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
    L.push(
      `| ${id} | ${s.status} | ${s.attempts.length} | ${a?.duration_ms ? `${Math.round(a.duration_ms / 60_000)} min` : "-"} | ${res.slice(0, 300)}${a?.reason ? ` (${a.reason.slice(0, 200)})` : ""} |`,
    );
  }
  if (state.voids.length) {
    L.push("");
    L.push("## Voided");
    for (const v of state.voids) L.push(`- ${v.at.slice(0, 19)}Z ${v.item}: ${v.reason} (void: ${v.voided.join(", ")})`);
  }
  L.push("");
  L.push("Gates: `npx tsx scripts/diff-arms.ts --campaign=<this directory>`.");
  return L.join("\n") + "\n";
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  for (const root of [REPO_ROOT, path.dirname(sh("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim() || REPO_ROOT)]) {
    if (isInside(args.out, root)) throw new Refusal(`--out=${args.out} is inside a checkout (${root}); it will hold dumps of real receipts`);
  }
  const stateFile = path.join(args.out, "campaign.json");
  let state: CampaignState | null = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as CampaignState) : null;
  if (state && !args.idGiven) throw new Refusal(`${args.out} holds campaign ${state.id}: pass --id=${state.id} to resume it`);

  // Manifests: given, or the recorded ones on a resume, or the defaults.
  if (!args.manifests.length) {
    args.manifests = state
      ? state.manifests.map((m) => ({ path: m.path, uploadsDir: m.uploadsDir, set: m.set, label: m.label }))
      : [
          { path: DEFAULT_C1, uploadsDir: args.defaultUploads ?? DEFAULT_UPLOADS, set: "c1", label: "" },
          ...(existsSync(DEFAULT_C2) ? [{ path: DEFAULT_C2, uploadsDir: args.defaultUploads ?? DEFAULT_UPLOADS, set: "c2" as const, label: "" }] : []),
        ];
  }
  args.manifests.forEach((m, i) => {
    m.label = m.label || `m${i + 1}-${m.set}`;
  });
  const fixtures = await planFixtures(args.manifests);
  const trials = state?.trials ?? args.trials;

  if (args.plan) {
    printPlan(args, fixtures, trials);
    return 0;
  }

  checkComposeFile();
  checkEnvFile(args.envFile);
  checkApp();

  await mkdir(args.out, { recursive: true });
  // One runner per campaign.
  const lock = path.join(args.out, "campaign.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Refusal(`another runner (pid ${pid}) holds ${lock}`);
  }
  writeFileSync(lock, String(process.pid));

  const manifestRecord = async () =>
    Promise.all(
      args.manifests.map(async (m) => ({
        ...m,
        sha256: sha256(await readFile(m.path)),
        keys: fixtures.filter((f) => f.label === m.label).map((f) => f.key),
      })),
    );
  const standInSha = args.standIn ? sha256(readFileSync(args.standIn)) : null;
  if (!state) {
    const v = await serverVersion();
    if (!v?.gitSha) throw new Refusal(`${SANDBOX.base}/version does not answer; bring the sandbox up first`);
    if (v.gitSha === "unknown") {
      throw new Refusal("the sandbox image says gitSha unknown: build it with GIT_SHA, GIT_SHORT_SHA and GIT_BRANCH set (scripts/ab-campaign.md)");
    }
    if (args.sha && !v.gitSha.startsWith(args.sha)) throw new Refusal(`the sandbox runs ${v.gitSha}, not --sha=${args.sha}`);
    checkCheckout(v.gitSha);
    state = {
      version: 1,
      id: args.id,
      created_at: now(),
      sha: v.gitSha,
      image_id: imageId(SANDBOX.image),
      checkout_head: sh("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]).stdout.trim() || null,
      rehearsal: standInSha ? { stand_in_sha256: standInSha } : null,
      trials,
      manifests: await manifestRecord(),
      race_concurrency: args.raceConcurrency,
      items: {},
      voids: [],
      ledger: null,
      stopped: null,
      log: [],
    };
  } else {
    if (state.id !== args.id) throw new Refusal(`${stateFile} is campaign ${state.id}, not ${args.id}`);
    if (!!state.rehearsal !== !!standInSha) {
      throw new Refusal(state.rehearsal ? "this campaign is a rehearsal: pass the same --stand-in-claude" : "a real campaign cannot take a stand-in");
    }
    if (state.rehearsal && state.rehearsal.stand_in_sha256 !== standInSha) throw new Refusal("--stand-in-claude is not the file the rehearsal began with");
    if (args.sha && !state.sha.startsWith(args.sha)) throw new Refusal(`this campaign runs ${state.sha}, not --sha=${args.sha}`);
    if (args.trialsGiven && args.trials !== state.trials) {
      throw new Refusal(`this campaign runs ${state.trials} trial(s); --trials=${args.trials} would make it another campaign`);
    }
    if (args.raceConcurrencyGiven && args.raceConcurrency !== state.race_concurrency) {
      throw new Refusal(`this campaign races at concurrency ${state.race_concurrency}; --race-concurrency=${args.raceConcurrency} would make race-A and race-B differ`);
    }
    checkCheckout(state.sha);
    // Ground-truth corrections are allowed (diff-arms rescores with the
    // current truth); a different set of fixtures is a different campaign.
    const rec = await manifestRecord();
    for (const m of rec) {
      const old = state.manifests.find((o) => o.label === m.label);
      if (!old || old.path !== m.path || JSON.stringify(old.keys) !== JSON.stringify(m.keys)) {
        throw new Refusal(`the fixtures of ${m.label} (${m.path}) are not the ones this campaign began with`);
      }
      if (old.sha256 !== m.sha256) state.log.push({ at: now(), what: `${m.label} changed since the last run (ground truth?); diff-arms scores with the current one` });
    }
    state.manifests = rec;
    state.stopped = null;
    for (const [id, st] of Object.entries(state.items)) {
      if (st.status !== "running") continue;
      // The runner died during it (killed, crashed): redone from its reset.
      st.status = "interrupted";
      const a = st.attempts.at(-1);
      if (a) {
        a.status = "interrupted";
        a.reason = "the runner stopped during it";
      }
      state.log.push({ at: now(), what: `${id} was running when the last runner stopped; it is redone` });
    }
  }
  for (const item of workItems(state.trials)) state.items[item.id] ??= { status: "pending", attempts: [] };
  await writeAtomic(
    path.join(args.out, "fixtures.json"),
    JSON.stringify(
      fixtures.map(({ entry, ...f }) => ({ ...f, ground_truth: entry.ground_truth, expected_status: entry.expected_status })),
      null,
      2,
    ),
  );

  const logFile = path.join(args.out, "campaign.log");
  const ctx: Ctx = {
    args,
    state,
    fixtures,
    touched: false,
    interrupted: false,
    child: null,
    save: async () => {
      await writeAtomic(stateFile, JSON.stringify(ctx.state, null, 2));
      await writeAtomic(path.join(args.out, "campaign.md"), renderSummary(ctx.state));
    },
    say: (s: string) => {
      const line = `[${new Date().toLocaleTimeString()}] ${s}`;
      console.error(line);
      void appendFile(logFile, line + "\n").catch(() => {});
    },
  };
  let signals = 0;
  const onSignal = () => {
    signals++;
    ctx.interrupted = true;
    ctx.say(signals === 1 ? "interrupt: finishing the step's report, then stopping" : "second interrupt: stopping now");
    if (signals > 1) {
      ctx.child?.kill("SIGKILL");
      ctx.state.stopped = { at: now(), kind: "interrupted", reason: "interrupted twice" };
      void ctx.save().finally(() => {
        rm(lock, { force: true }).finally(() => process.exit(130));
      });
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deadline = args.stopAfter ? resolveStopAfter(args.stopAfter, new Date()) : null;
  ctx.say(
    `campaign ${state.id}: image ${state.sha.slice(0, 12)}, ${state.trials} trial(s), out ${args.out}` +
      (deadline ? `, stop after ${deadline.toLocaleString()}` : "") +
      (state.rehearsal ? " (REHEARSAL)" : ""),
  );
  await ctx.save();

  let exit = 0;
  try {
    for (const item of workItems(state.trials)) {
      if (!selected(item, args.steps)) continue;
      const st = state.items[item.id]!;
      if (st.status === "done") continue;
      if (ctx.interrupted) throw new Interrupted("interrupted");
      const why = stopAfterSays(ctx, item, deadline);
      if (why) {
        state.stopped = { at: now(), kind: "stop-after", reason: `${item.id} not started: ${why}` };
        ctx.say(`stop: ${state.stopped.reason}`);
        exit = 3;
        break;
      }
      const n = st.attempts.length + 1;
      const kindDir = item.kind === "unit" ? "units" : "steps";
      const attempt: Attempt = {
        n,
        dir: path.join(args.out, kindDir, item.id.replace(":", "-"), `attempt-${n}`),
        started_at: now(),
        finished_at: null,
        duration_ms: null,
        status: "running",
        reason: null,
        results: {},
      };
      await mkdir(attempt.dir, { recursive: true });
      st.attempts.push(attempt);
      st.status = "running";
      state.log.push({ at: now(), what: `start ${item.id} attempt ${n}` });
      await ctx.save();
      ctx.say(`── ${item.id} (attempt ${n}) ──`);
      const t0 = Date.now();
      try {
        attempt.results =
          item.kind === "unit"
            ? await runUnit(ctx, item, attempt)
            : item.kind === "c3"
              ? await runC3(ctx, item, attempt)
              : item.kind === "c4"
                ? await runC4(ctx, attempt)
                : await runC5(ctx, attempt);
        attempt.status = st.status = "done";
      } catch (e) {
        const msg = (e as Error).message;
        attempt.reason = msg;
        if (e instanceof Outage) {
          attempt.status = st.status = "void";
          stopStackForOutage(ctx, msg);
          const voided = [item.id];
          if (item.kind === "unit") {
            // The trial pair: the other arm of this trial, if it ran.
            const other = `t${item.trial}-${item.arm === "A" ? "B" : "A"}`;
            const os = state.items[other];
            if (os && os.status === "done") {
              os.status = "void";
              os.attempts.at(-1)!.status = "void";
              os.attempts.at(-1)!.reason = `voided with ${item.id}: ${msg}`;
              voided.push(other);
            }
          }
          state.voids.push({ at: now(), trial: item.trial ?? null, item: item.id, reason: msg, voided });
          state.stopped = { at: now(), kind: "outage", reason: `${item.id}: ${msg}` };
          exit = 4;
        } else if (e instanceof Interrupted || ctx.interrupted) {
          attempt.status = st.status = "interrupted";
          state.stopped = { at: now(), kind: "interrupted", reason: `${item.id}: ${msg}` };
          exit = 130;
        } else if (e instanceof StackFailure || e instanceof Refusal || item.kind === "unit") {
          attempt.status = st.status = "failed";
          state.stopped = { at: now(), kind: "failed", reason: `${item.id}: ${msg}` };
          exit = e instanceof Refusal ? 1 : 3;
        } else {
          // A step's own tool failed: record it and go on to the next item.
          attempt.status = st.status = "failed";
          ctx.say(`${item.id} failed: ${msg}`);
          exit = 3;
        }
      } finally {
        attempt.finished_at = now();
        attempt.duration_ms = Date.now() - t0;
        await writeFile(path.join(attempt.dir, "attempt.json"), JSON.stringify(attempt, null, 2)).catch(() => {});
        state.log.push({ at: now(), what: `${item.id} attempt ${n}: ${attempt.status}` });
        await ctx.save();
      }
      ctx.say(`${item.id}: ${attempt.status}${attempt.reason ? ` (${attempt.reason})` : ""} in ${Math.round(attempt.duration_ms! / 60_000)} min`);
      if (state.stopped) break;
    }
  } finally {
    if (ctx.touched) await restoreQuiet(ctx);
    await ctx.save();
    await rm(lock, { force: true });
  }
  const pending = workItems(state.trials).filter((i) => selected(i, args.steps) && state!.items[i.id]!.status !== "done");
  ctx.say(
    pending.length
      ? `${pending.length} item(s) not done: ${pending.map((i) => `${i.id} (${state!.items[i.id]!.status})`).join(", ")}`
      : "every selected item is done",
  );
  ctx.say(`summary: ${path.join(args.out, "campaign.md")}`);
  if (exit === 0 && pending.length) exit = 3;
  return exit;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
