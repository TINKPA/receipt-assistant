/**
 * measure-ingest-turns.ts — token/turn accounting for a Claude Code session
 * JSONL, for #227.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 *
 * #227 was filed against numbers that were roughly 2× too large, because
 * the measurement counted JSONL records as turns. It is worth being
 * explicit about the trap, because it is invisible and it looks right:
 *
 *   Claude Code writes ONE JSONL LINE PER CONTENT BLOCK of an assistant
 *   message (`thinking`, then `text`, then `tool_use`), and stamps AN
 *   IDENTICAL COPY OF THE SAME `usage` OBJECT on every one of those lines.
 *
 * So counting `type:"assistant"` records counts each real API turn 1–3×,
 * and summing `usage` across them double- or triple-counts the bill. In
 * production the record:turn ratio runs 2.0–2.6.
 *
 * Verified on session 2d8659bf (T-Mobile receipt PDF): 24 assistant
 * records, 10 distinct `message.id`, 0 ids whose records carry differing
 * usage, 0 content blocks repeated within an id. Langfuse's own API on
 * the same trace independently reports 10 generations.
 *
 * This script groups by `message.id`, which is correct by construction.
 * `src/langfuse.ts` groups by usage identity instead — a heuristic, but
 * one that agrees with `message.id` on every session measured so far.
 * If this script and a Langfuse trace ever disagree on turn count, that
 * heuristic is where to look first.
 *
 * The second trap, inherited from #227: `billed input` is
 * `input_tokens + cache_read + cache_creation`. Cache WRITES are billed,
 * and on this workload turn 1 writes the entire ~84K-token prompt.
 * Dropping that bucket undercounts by 5.5–12.9%.
 *
 * ── What it reports ────────────────────────────────────────────────────
 *
 * Per session: real turns, tool calls, turns that made no tool call,
 * billed input split three ways, output, the prompt's token cost, and
 * the share of the whole bill that prompt represents (turns × prompt,
 * because the prompt is re-read from cache on every single turn).
 *
 * CLI — `--key=value` only, same convention as eval-dates.ts. A bare
 * `--key` binds to `true`, so the space form fails silently.
 *   --session=<id|path>   Session id or JSONL path. Repeatable, or comma-separated.
 *   --dir=<path>          Where to look for `<id>.jsonl`. Default: the
 *                         Claude Code projects dir for this cwd.
 *   --last=<n>            Instead of --session, take the N most recently
 *                         modified JSONLs in --dir.
 *   --turns               Print the per-turn table (tokens + tool command head).
 *   --json                Emit JSON instead of the text report.
 *
 * Run: `npm run measure:turns -- --last=6 --turns`
 *
 * Production JSONLs live on the mini, not here:
 *   scp mini:Developer/receipt-assistant-data/claude/projects/-app/<id>.jsonl /tmp/j/
 *   npm run measure:turns -- --dir=/tmp/j --last=6
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import { getSessionJsonlPath } from "../src/langfuse.js";

// ── Types ──────────────────────────────────────────────────────────────

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Turn {
  id: string;
  usage: Usage;
  tools: { name: string; head: string }[];
  text: string;
  thinkingChars: number;
  stopReason?: string;
}

interface SessionReport {
  session: string;
  rawAssistantRecords: number;
  turns: number;
  toolCalls: number;
  turnsWithoutToolCall: number;
  promptChars: number;
  promptTokens: number;
  billedInput: number;
  freshInput: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  promptShare: number;
  detail: Turn[];
}

// ── Parsing ────────────────────────────────────────────────────────────

/** All three buckets are billed. See the header note. */
function billedInput(u: Usage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** The most identifying string in a tool call, for the per-turn table. */
function toolHead(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? "";
  return String(v).replace(/\s+/g, " ").trim();
}

function analyze(jsonlPath: string): SessionReport {
  const lines = readFileSync(jsonlPath, "utf8").split("\n");

  const byId = new Map<string, Turn>();
  let rawAssistantRecords = 0;
  let promptChars = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line on a still-running session is not an error
    }

    // The first user message IS the extractor prompt.
    if (promptChars === 0 && rec.type === "user") {
      const c = rec.message?.content;
      promptChars = typeof c === "string" ? c.length : JSON.stringify(c ?? "").length;
    }

    if (rec.type !== "assistant") continue;
    rawAssistantRecords++;

    const msg = rec.message ?? {};
    // One API turn = one message.id. Records without one are synthetic.
    const id: string = msg.id ?? `_noid_${rawAssistantRecords}`;

    let turn = byId.get(id);
    if (!turn) {
      // Take usage from the FIRST record of this id only — the copies that
      // follow are the same object, and adding them is exactly the bug.
      turn = {
        id,
        usage: msg.usage ?? {},
        tools: [],
        text: "",
        thinkingChars: 0,
        stopReason: msg.stop_reason,
      };
      byId.set(id, turn);
    }
    if (msg.stop_reason) turn.stopReason = msg.stop_reason;

    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (b.type === "tool_use") {
        turn.tools.push({ name: b.name ?? "?", head: toolHead(b.input) });
      } else if (b.type === "text" && b.text) {
        turn.text += (turn.text ? " " : "") + b.text.replace(/\s+/g, " ");
      } else if (b.type === "thinking") {
        turn.thinkingChars += (b.thinking ?? "").length;
      }
    }
  }

  const detail = [...byId.values()];
  const sum = (f: (u: Usage) => number) => detail.reduce((a, t) => a + f(t.usage), 0);

  const billed = sum(billedInput);
  // The prompt is written to cache on turn 1, so turn 1's cache_creation is
  // its token cost. It is then re-read on every subsequent turn.
  const promptTokens = detail[0]?.usage.cache_creation_input_tokens ?? 0;

  return {
    session: path.basename(jsonlPath, ".jsonl"),
    rawAssistantRecords,
    turns: detail.length,
    toolCalls: detail.reduce((a, t) => a + t.tools.length, 0),
    turnsWithoutToolCall: detail.filter((t) => t.tools.length === 0).length,
    promptChars,
    promptTokens,
    billedInput: billed,
    freshInput: sum((u) => u.input_tokens ?? 0),
    cacheRead: sum((u) => u.cache_read_input_tokens ?? 0),
    cacheCreation: sum((u) => u.cache_creation_input_tokens ?? 0),
    output: sum((u) => u.output_tokens ?? 0),
    promptShare: billed > 0 ? (detail.length * promptTokens) / billed : 0,
    detail,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
) as Record<string, string>;

function resolveSessions(): string[] {
  const dir = argv.dir ?? path.dirname(getSessionJsonlPath("x"));

  if (argv.last) {
    const n = Number(argv.last);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--last must be a positive number, got ${JSON.stringify(argv.last)}`);
    }
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, n);
  }

  if (!argv.session) {
    throw new Error("Pass --session=<id|path> (repeatable, or comma-separated) or --last=<n>.");
  }
  return argv.session
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes("/") || s.endsWith(".jsonl") ? s : path.join(dir, `${s}.jsonl`)));
}

const n = (x: number) => x.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;

const reports = resolveSessions().map(analyze);

if (argv.json === "true") {
  // Drop `detail` unless asked — it is large and rarely diffed.
  const out = reports.map(({ detail, ...rest }) =>
    argv.turns === "true" ? { ...rest, detail } : rest,
  );
  console.log(JSON.stringify(out, null, 2));
} else {
  const w = (s: string, k: number) => s.padEnd(k);
  const r = (s: string, k: number) => s.padStart(k);

  console.log(
    "\n" +
      w("session", 10) +
      r("raw recs", 9) +
      r("turns", 7) +
      r("calls", 7) +
      r("no-tool", 9) +
      r("billed in", 13) +
      r("output", 9) +
      r("prompt tok", 12) +
      r("prompt", 8),
  );
  for (const s of reports) {
    console.log(
      w(s.session.slice(0, 8), 10) +
        r(n(s.rawAssistantRecords), 9) +
        r(n(s.turns), 7) +
        r(n(s.toolCalls), 7) +
        r(n(s.turnsWithoutToolCall), 9) +
        r(n(s.billedInput), 13) +
        r(n(s.output), 9) +
        r(n(s.promptTokens), 12) +
        r(pct(s.promptShare), 8),
    );
  }

  const billed = reports.map((s) => s.billedInput).sort((a, b) => a - b);
  if (billed.length > 1) {
    const mid = Math.floor(billed.length / 2);
    const median =
      billed.length % 2 ? billed[mid] : Math.round((billed[mid - 1] + billed[mid]) / 2);
    console.log(`\n  median billed input: ${n(median)} over ${billed.length} sessions`);
  }

  for (const s of reports) {
    const ratio = s.turns ? (s.rawAssistantRecords / s.turns).toFixed(1) : "n/a";
    console.log(
      `\n${s.session}\n` +
        `  ${n(s.rawAssistantRecords)} JSONL records → ${n(s.turns)} real turns (${ratio}× — see header note)\n` +
        `  billed input ${n(s.billedInput)} = fresh ${n(s.freshInput)} + cache_read ${n(s.cacheRead)} + cache_create ${n(s.cacheCreation)}\n` +
        `  prompt ${n(s.promptChars)} chars ≈ ${n(s.promptTokens)} tokens ` +
        `(${(s.promptChars / (s.promptTokens || 1)).toFixed(2)} chars/token), ` +
        `re-read ${n(s.turns)}× = ${pct(s.promptShare)} of the bill`,
    );

    if (argv.turns === "true") {
      for (const [i, t] of s.detail.entries()) {
        const head = t.tools.length
          ? `${t.tools[0].name} ${t.tools[0].head.slice(0, 96)}` +
            (t.tools.length > 1 ? ` (+${t.tools.length - 1})` : "")
          : `-- no tool -- ${t.text.slice(0, 96)}`;
        console.log(
          `    ${r(String(i + 1), 3)} ` +
            `${r(n(t.usage.cache_read_input_tokens ?? 0), 9)} rd ` +
            `${r(n(t.usage.cache_creation_input_tokens ?? 0), 7)} wr ` +
            `${r(n(t.usage.output_tokens ?? 0), 6)} out  ${head}`,
        );
      }
    }
  }
  console.log("");
}
