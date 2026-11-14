#!/usr/bin/env tsx
/**
 * probe-cli.ts — what the pinned `claude` CLI does with the features the
 * wave-1 repair round would use, measured on the SANDBOX container.
 *
 * Wave 1 has the extraction agent hand back a record instead of writing
 * SQL. When the record is invalid, the server sends the errors back to the
 * same session once, as `claude -p --resume <session id>` (docs/server-writer.md,
 * "The repair round"). That is
 * only safe and cheap if the CLI behaves a certain way, so this script asks
 * it, with the extraction profile's own flags from `buildClaudeArgs`:
 *
 *   0. model   The container's CLAUDE_MODEL is accepted as `--model` and is
 *              the model the transcript shows. Gating.
 *   1. resume  `-p --resume <sid>` (a) offers exactly the profile's tool list,
 *              (b) carries the conversation, (c) reads the earlier turns from
 *              the prompt cache instead of paying for them again. Gating:
 *              EXTRACTION_REPAIR_ROUNDS stays 0 unless all three hold.
 *              Also recorded, not gated: whether the resumed turns land in
 *              the same session id and file; whether `--session-id` may be
 *              combined with `--resume` (runClaude always passes one), and
 *              with `--fork-session`; and which tool list wins when the
 *              resuming spawn passes a different `--tools`.
 *   2. json    `--output-format json` changes only the envelope: the same
 *              final text, the same prompt size. Information only; the record
 *              run keeps `text`.
 *   3. stream  `--input-format stream-json` takes a second user message on
 *              the same stdin and process. Information only.
 *
 * Every probe runs INSIDE the sandbox app container, through a shim that
 * imports the image's compiled `buildClaudeArgs` / `buildClaudeEnv`, so the
 * flags, environment and CLI are exactly what the server spawns with. The
 * prompts are small; the whole script makes about nine short model calls.
 *
 *   # sandbox up first (from a worktree add --env-file <main checkout>/.env):
 *   #   docker compose -f docker-compose.test.yml up -d --build
 *   npx tsx scripts/probe-cli.ts --out=<private notes>/p0-cli-probes.md
 *
 * Flags (`--key=value`):
 *   --container=<name>   default receipt-assistant-test. The production
 *                        container is refused, as is any container without
 *                        the sandbox's EXTRACTOR_STUB_ALLOWED=1.
 *   --profile=<name>     AGENT_PROFILES key, default extraction.
 *   --out=<file>         also write the Markdown report there.
 *
 * Exit: 0 probes 0 and 1 pass; 1 one of them fails; 2 could not run.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { AGENT_PROFILES, type AgentProfileName } from "../src/claude.js";

// ── Arguments and guards ───────────────────────────────────────────────

function argOf(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
for (const a of process.argv.slice(2)) {
  if (!/^--(container|profile|out)=./.test(a)) {
    console.error(`unknown argument ${JSON.stringify(a)} (flags: --container=, --profile=, --out=)`);
    process.exit(2);
  }
}

const container = argOf("container") ?? "receipt-assistant-test";
const profile = (argOf("profile") ?? "extraction") as AgentProfileName;
const outPath = argOf("out");

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!Object.hasOwn(AGENT_PROFILES, profile)) die(`unknown profile ${profile}`);
if (container === "receipt-assistant") die("REFUSING: 'receipt-assistant' is the production container.");

function docker(args: string[], input?: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const running = docker(["ps", "--format", "{{.Names}}"]);
if (running.code !== 0 || !running.stdout.split("\n").includes(container)) {
  die(`container '${container}' is not running. Bring the sandbox up first (docker-compose.test.yml).`);
}
if (docker(["exec", container, "printenv", "EXTRACTOR_STUB_ALLOWED"]).stdout.trim() !== "1") {
  die(`REFUSING: '${container}' does not have EXTRACTOR_STUB_ALLOWED=1, so it is not the sandbox.`);
}

const cliVersion = docker(["exec", container, "claude", "--version"]).stdout.trim();
const model = docker(["exec", container, "printenv", "CLAUDE_MODEL"]).stdout.trim();
if (!model) die(`CLAUDE_MODEL is not set in '${container}'. The compose files pin it; rebuild the sandbox from this tree.`);
const imageId = docker(["inspect", "--format", "{{.Image}}", container]).stdout.trim();
const profileTools: string[] = [...AGENT_PROFILES[profile].tools];
// The arm-B profile (docs/server-writer.md, "The two writers").
const RECORD_TOOLS = ["Bash", "Read", "Write"];

// ── Running claude in the container ────────────────────────────────────

/**
 * Runs in the container: `claude -p` with the profile's own args and
 * environment from the compiled server code, plus the probe's flags.
 * `tools` replaces the value of the profile's `--tools` (probe 1's
 * cross-check only).
 */
const SHIM = `
import { spawn } from "node:child_process";
const { buildClaudeArgs, buildClaudeEnv } = await import("/app/dist/claude.js");
const spec = JSON.parse(process.argv[1]);
const args = buildClaudeArgs(spec.profile);
if (spec.tools) args[args.indexOf("--tools") + 1] = spec.tools.join(",");
const child = spawn("claude", ["-p", ...args, ...spec.extra], { env: buildClaudeEnv(spec.profile), stdio: "inherit" });
child.on("error", (e) => { console.error(String(e)); process.exit(127); });
child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
`;

interface Spec {
  profile: AgentProfileName;
  tools?: string[];
  extra: string[];
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

interface Event {
  type?: string;
  subtype?: string;
  session_id?: string;
  tools?: string[];
  model?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: Usage;
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
}

interface RunOut {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  events: Event[];
}

function parseEvents(stdout: string): Event[] {
  const out: Event[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      /* partial line */
    }
  }
  return out;
}

function shimArgs(spec: Spec): string[] {
  return ["exec", "-i", container, "node", "--input-type=module", "-e", SHIM, JSON.stringify(spec)];
}

function runOnce(spec: Spec, stdin: string, timeoutMs = 240_000): Promise<RunOut> {
  return new Promise((resolve) => {
    const child = spawn("docker", shimArgs(spec), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, events: parseEvents(stdout) });
    });
  });
}

const streamFlags = ["--output-format", "stream-json", "--verbose"];
const init = (r: RunOut) => r.events.find((e) => e.type === "system" && e.subtype === "init");
const result = (r: RunOut) => r.events.filter((e) => e.type === "result").at(-1);
const firstUsage = (r: RunOut) => r.events.find((e) => e.type === "assistant" && e.message?.usage)?.message?.usage;
const observedModel = (r: RunOut) =>
  r.events.find((e) => e.type === "assistant" && e.message?.model && e.message.model !== "<synthetic>")?.message?.model;
const promptTotal = (u: Usage | undefined) =>
  u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;
const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 240) ?? "";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const fmtUsage = (u: Usage | undefined) =>
  u
    ? `fresh ${u.input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}, output ${u.output_tokens ?? 0}`
    : "no usage";

/** Lines in a session's JSONL inside the container; -1 if there is none. */
function jsonlLines(sessionId: string): number {
  const r = docker(["exec", container, "sh", "-c", `wc -l < /home/node/.claude/projects/-app/${sessionId}.jsonl`]);
  return r.code === 0 ? Number(r.stdout.trim()) : -1;
}

function jsonlFirstPromptTotal(sessionId: string): number | null {
  const r = docker(["exec", container, "cat", `/home/node/.claude/projects/-app/${sessionId}.jsonl`]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    try {
      const rec = JSON.parse(line) as Event;
      if (rec.type === "assistant" && rec.message?.usage) return promptTotal(rec.message.usage);
    } catch {
      /* skip */
    }
  }
  return null;
}

// ── Report ─────────────────────────────────────────────────────────────

const lines: string[] = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};
type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "INFO";
const verdicts: { probe: string; verdict: Verdict; gating: boolean }[] = [];
const verdict = (probe: string, v: Verdict, gating: boolean, detail: string) => {
  verdicts.push({ probe, verdict: v, gating });
  say(`- **${probe}: ${v}**${gating ? "" : " (information only)"}. ${detail}`);
};

say(`# CLI probes for the wave-1 repair round`);
say();
say(`- When: ${new Date().toISOString()}`);
say(`- Container: \`${container}\`, image \`${imageId.slice(0, 19)}\``);
say(`- CLI: ${cliVersion}`);
say(`- Model requested (container CLAUDE_MODEL): \`${model}\``);
say(`- Profile: \`${profile}\`, tools ${profileTools.join(", ") || "(none)"}`);
say(`- Flags from buildClaudeArgs: \`-p ${["--tools", profileTools.join(","), "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "''", ...AGENT_PROFILES[profile].permissionArgs()].join(" ")}\``);
say();

const tag = () => randomBytes(3).toString("hex").toUpperCase();

// A prefix big enough that "the earlier turns came from cache" cannot be
// confused with "the system prompt came from cache": about 100 KB, which
// with the CLI's own system prompt and tools makes a first turn of ~73K
// tokens, the size of a real extraction prompt.
function filler(): string {
  const words = ["amber", "basil", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "iris", "juniper", "kelp", "lumen"];
  const out: string[] = [];
  for (let i = 0; i < 900; i++) {
    out.push(`Reference line ${String(i).padStart(4, "0")}: ${words.map((w, j) => words[(i * 7 + j * 5) % words.length] + (i % (j + 2))).join(" ")}.`);
  }
  return out.join("\n");
}

// ── 0 + 1: model and resume ────────────────────────────────────────────

say(`## 1. \`--resume\` (and the model pin)`);
say();
const sid = randomUUID();
const word = `ORCHID-${tag()}`;
const s1 = await runOnce(
  { profile, extra: ["--model", model, ...streamFlags, "--session-id", sid] },
  `This is an automated test of session resumption. Read the reference text below, but do not act on it.\n\n${filler()}\n\n` +
    `Remember this code word: ${word}. Do not use any tool. Reply with exactly: READY`,
);
const s1Init = init(s1);
const s1Res = result(s1);
const s1Usage = firstUsage(s1);
say(`S1, a fresh session \`${sid}\`: exit ${s1.code}${s1.timedOut ? " (timed out)" : ""}, init session ${s1Init?.session_id ?? "—"}, reply ${JSON.stringify(s1Res?.result ?? null)}.`);
say(`  init model \`${s1Init?.model ?? "—"}\`, transcript model \`${observedModel(s1) ?? "—"}\`. First turn: ${fmtUsage(s1Usage)}.`);
say(`  tools offered: ${(s1Init?.tools ?? []).join(", ") || "(none)"}`);
say();

if (!s1Init || s1.code !== 0) {
  verdict("0 model", "INCONCLUSIVE", true, `the first spawn did not start: ${firstLine(s1.stderr || s1.stdout)}`);
} else {
  const seen = observedModel(s1);
  verdict(
    "0 model",
    seen === model ? "PASS" : "FAIL",
    true,
    `\`--model ${model}\` accepted; the transcript records \`${seen ?? "nothing"}\`.`,
  );
}

const linesBefore = jsonlLines(sid);
const s2 = await runOnce(
  { profile, extra: ["--model", model, ...streamFlags, "--resume", sid] },
  "What was the code word I gave you? Do not use any tool. Reply with only the code word.",
);
const s2Init = init(s2);
const s2Res = result(s2);
const s2Usage = firstUsage(s2);
const linesAfter = jsonlLines(sid);
const s2Sid = s2Init?.session_id ?? s2Res?.session_id ?? null;
say(`S2, \`--resume ${sid}\` with the same profile flags: exit ${s2.code}${s2.timedOut ? " (timed out)" : ""}, reply ${JSON.stringify(s2Res?.result ?? null)}.`);
say(`  init session ${s2Sid ?? "—"}; ${sid}.jsonl had ${linesBefore} lines before and ${linesAfter} after${s2Sid && s2Sid !== sid ? `; ${s2Sid}.jsonl has ${jsonlLines(s2Sid)}` : ""}.`);
say(`  tools offered: ${(s2Init?.tools ?? []).join(", ") || "(none)"}. First turn: ${fmtUsage(s2Usage)}.`);
say(`  S1's first-turn prompt was ${promptTotal(s1Usage)} tokens; S2 read ${s2Usage?.cache_read_input_tokens ?? 0} from cache and wrote ${s2Usage?.cache_creation_input_tokens ?? 0}.`);
say();

if (!s2Init || s2.code !== 0) {
  verdict("1 resume", "INCONCLUSIVE", true, `the resumed spawn did not start: ${firstLine(s2.stderr || s2.stdout)}`);
} else {
  const tools = s2Init.tools ?? [];
  const toolsOk = sameSet(tools, profileTools) && sameSet(tools, s1Init?.tools ?? []);
  const contextOk = (s2Res?.result ?? "").includes(word);
  const cacheOk = (s2Usage?.cache_read_input_tokens ?? 0) >= 0.95 * promptTotal(s1Usage) && promptTotal(s1Usage) > 0;
  verdict(
    "1a resume keeps exactly the profile's tools",
    toolsOk ? "PASS" : "FAIL",
    true,
    toolsOk ? `offered ${tools.join(", ")}.` : `offered ${tools.join(", ") || "(none)"}, profile ${profileTools.join(", ")}.`,
  );
  verdict("1b resume carries the conversation", contextOk ? "PASS" : "FAIL", true, `asked for the code word, got ${JSON.stringify(s2Res?.result ?? null)}.`);
  verdict(
    "1c resume reuses the cache",
    cacheOk ? "PASS" : "FAIL",
    true,
    `first resumed turn read ${s2Usage?.cache_read_input_tokens ?? 0} of S1's ${promptTotal(s1Usage)} prompt tokens from cache (threshold 95%).`,
  );
  verdict(
    "1d resumed turns stay in the same session",
    "INFO",
    false,
    s2Sid === sid
      ? `same session id; the transcript file grew from ${linesBefore} to ${linesAfter} lines, so one run keeps one JSONL.`
      : `the resumed run reported session ${s2Sid}; the server must record it as well as the minted one.`,
  );
}

// S3: --session-id together with --resume (runClaude always passes --session-id).
const s3 = await runOnce(
  { profile, extra: ["--model", model, ...streamFlags, "--resume", sid, "--session-id", sid] },
  "Reply with exactly: S3",
);
const s3Init = init(s3);
verdict(
  "1e `--resume <sid> --session-id <sid>`",
  "INFO",
  false,
  s3.code === 0
    ? `accepted (session ${s3Init?.session_id ?? "?"}, reply ${JSON.stringify(result(s3)?.result ?? null)}).`
    : `refused, exit ${s3.code}: ${firstLine(s3.stderr || s3.stdout)}. A resume spawn must not pass --session-id.`,
);

// S4: fork into a server-minted id.
const forkSid = randomUUID();
const s4 = await runOnce(
  { profile, extra: ["--model", model, ...streamFlags, "--resume", sid, "--fork-session", "--session-id", forkSid] },
  "What was the code word? Do not use any tool. Reply with only the code word.",
);
const s4Init = init(s4);
verdict(
  "1f `--resume <sid> --fork-session --session-id <new>`",
  "INFO",
  false,
  s4.code === 0
    ? `accepted: session ${s4Init?.session_id ?? "?"} (${s4Init?.session_id === forkSid ? "the minted id" : "not the minted id"}), ` +
        `reply ${JSON.stringify(result(s4)?.result ?? null)}, first turn ${fmtUsage(firstUsage(s4))}; ` +
        `original ${sid}.jsonl now ${jsonlLines(sid)} lines, fork ${jsonlLines(forkSid)} lines.`
    : `refused, exit ${s4.code}: ${firstLine(s4.stderr || s4.stdout)}.`,
);

// S5: the resuming spawn names a narrower tool list. Which one is offered?
const s5 = await runOnce(
  { profile, tools: RECORD_TOOLS, extra: ["--model", model, ...streamFlags, "--resume", sid] },
  "Reply with exactly: S5",
);
const s5Tools = init(s5)?.tools ?? null;
verdict(
  "1g resume with a different `--tools`",
  "INFO",
  false,
  s5.code !== 0 || !s5Tools
    ? `could not tell, exit ${s5.code}: ${firstLine(s5.stderr || s5.stdout)}.`
    : sameSet(s5Tools, RECORD_TOOLS)
      ? `offered ${s5Tools.join(", ")}: the resuming spawn's flags decide the tool list, not the session's history. The repair spawn must re-apply the profile.`
      : `offered ${s5Tools.join(", ")}, not the ${RECORD_TOOLS.join(", ")} it was given.`,
);
say();

// ── 2: --output-format json ────────────────────────────────────────────

say(`## 2. \`--output-format json\``);
say();
const token = `ENVELOPE-${tag()}`;
const envPrompt = `Do not use any tool. Reply with exactly this line and nothing else:\n${token}`;
const t1Sid = randomUUID();
const t2Sid = randomUUID();
const t1 = await runOnce({ profile, extra: ["--model", model, "--output-format", "text", "--session-id", t1Sid] }, envPrompt);
const t2 = await runOnce({ profile, extra: ["--model", model, "--output-format", "json", "--session-id", t2Sid] }, envPrompt);
let t2Obj: Record<string, unknown> | null = null;
try {
  t2Obj = JSON.parse(t2.stdout) as Record<string, unknown>;
} catch {
  t2Obj = null;
}
const t1Prompt = jsonlFirstPromptTotal(t1Sid);
const t2Prompt = jsonlFirstPromptTotal(t2Sid);
say(`text: exit ${t1.code}, stdout ${JSON.stringify(t1.stdout.trim().slice(0, 200))}; first-turn prompt ${t1Prompt ?? "?"} tokens.`);
say(`json: exit ${t2.code}, ${t2Obj ? `one object, keys ${Object.keys(t2Obj).join(", ")}; result ${JSON.stringify(t2Obj.result)}` : `not one JSON object: ${JSON.stringify(t2.stdout.slice(0, 200))}`}; first-turn prompt ${t2Prompt ?? "?"} tokens.`);
say();
{
  const sameText = t1.stdout.trim() === token && typeof t2Obj?.result === "string" && (t2Obj.result as string).trim() === token;
  const samePrompt = t1Prompt !== null && t1Prompt === t2Prompt;
  verdict(
    "2 json changes only the envelope",
    t1.code === 0 && t2.code === 0 ? (sameText && samePrompt ? "PASS" : "FAIL") : "INCONCLUSIVE",
    false,
    `same final text: ${sameText ? "yes" : "no"}; same prompt size: ${samePrompt ? "yes" : `no (${t1Prompt} vs ${t2Prompt})`}.`,
  );
}
say();

// ── 3: --input-format stream-json ──────────────────────────────────────

say(`## 3. \`--input-format stream-json\`, a second message`);
say();
const streamWord = `HERON-${tag()}`;
const u = await new Promise<{ code: number | null; results: Event[]; initSid: string | null; stderr: string; timedOut: boolean }>(
  (resolve) => {
    const uSid = randomUUID();
    const child = spawn(
      "docker",
      shimArgs({ profile, extra: ["--model", model, "--input-format", "stream-json", ...streamFlags, "--session-id", uSid] }),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const msg = (text: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    const results: Event[] = [];
    let initSid: string | null = null;
    let buf = "";
    let stderr = "";
    let timedOut = false;
    child.stdin.on("error", () => {});
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e: Event;
        try {
          e = JSON.parse(line) as Event;
        } catch {
          continue;
        }
        if (e.type === "system" && e.subtype === "init") initSid ??= e.session_id ?? null;
        if (e.type === "result") {
          results.push(e);
          if (results.length === 1) child.stdin.write(msg("What was the code word? Do not use any tool. Reply with only the code word."));
          else child.stdin.end();
        }
      }
    });
    child.stdin.write(msg(`Remember this code word: ${streamWord}. Do not use any tool. Reply with exactly: ONE`));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 240_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, results, initSid, stderr, timedOut });
    });
  },
);
say(
  `exit ${u.code}${u.timedOut ? " (timed out)" : ""}; ${u.results.length} result event(s): ` +
    u.results.map((r) => `${JSON.stringify(r.result ?? null)} (session ${r.session_id ?? "?"})`).join(", "),
);
say();
verdict(
  "3 stream-json takes a second message",
  u.results.length >= 2 ? ((u.results[1]?.result ?? "").includes(streamWord) ? "PASS" : "FAIL") : u.code === 0 ? "FAIL" : "INCONCLUSIVE",
  false,
  u.results.length >= 2
    ? `two turns in one process; the second answered ${JSON.stringify(u.results[1]?.result ?? null)}.`
    : `only ${u.results.length} result(s); ${firstLine(u.stderr)}`,
);
say();

// ── Summary ────────────────────────────────────────────────────────────

const gating = verdicts.filter((v) => v.gating);
const failed = gating.filter((v) => v.verdict === "FAIL");
const inconclusive = gating.filter((v) => v.verdict === "INCONCLUSIVE");
say(`## Result`);
say();
say(
  failed.length === 0 && inconclusive.length === 0
    ? "Gating probes pass: a one-round `--resume` repair is safe to enable (EXTRACTION_REPAIR_ROUNDS=1)."
    : `Gating probes did not pass (${[...failed, ...inconclusive].map((v) => `${v.probe}: ${v.verdict}`).join("; ")}): ` +
        "keep EXTRACTION_REPAIR_ROUNDS=0.",
);
if (outPath) writeFileSync(outPath, lines.join("\n") + "\n");
process.exit(failed.length ? 1 : inconclusive.length ? 2 : 0);
