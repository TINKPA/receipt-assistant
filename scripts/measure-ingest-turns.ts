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
 * usage, 0 content blocks repeated within an id. Langfuse (since removed)
 * independently reported 10 generations for the same session.
 *
 * The parser lives in `src/session-transcript.ts::summarizeSession`, which
 * the server also runs after every extraction to fill `agent_runs` (turns,
 * tokens, the observed model). One parser, so the run records and this
 * report cannot drift apart. It groups by `message.id`, which is correct
 * by construction.
 *
 * The second trap, inherited from #227: `billed input` is
 * `input_tokens + cache_read + cache_creation`. Cache WRITES are billed,
 * and on this workload turn 1 writes the entire ~84K-token prompt.
 * Dropping that bucket undercounts by 5.5–12.9%.
 *
 * ── What it reports ────────────────────────────────────────────────────
 *
 * Per session: the model that answered, real turns, tool calls, turns
 * that made no tool call, billed input split three ways, output, the
 * prompt's token cost, and the share of the whole bill that prompt
 * represents (turns × prompt, because the prompt is re-read from cache on
 * every single turn).
 *
 * CLI — `--key=value` only, same convention as eval-dates.ts. A bare
 * `--key` binds to `true`, so the space form fails silently.
 *   --session=<id|path>   Session id or JSONL path. Repeatable, or comma-separated.
 *   --dir=<path>          Where to look for `<id>.jsonl`. Default: the
 *                         Claude Code projects dir for this cwd.
 *   --last=<n>            Instead of --session, take the N most recently
 *                         modified JSONLs in --dir (of --kind, when given).
 *   --kind=<k>            Only sessions of this kind: `ingest` or
 *                         `re_extract`, read from the prompt's first words.
 *                         Ask and ad-hoc sessions in the same directory are
 *                         `other`.
 *   --turns               Print the per-turn table (tokens + tool command head).
 *   --json                Emit JSON instead of the text report.
 *
 * Run: `npm run measure:turns -- --last=6 --kind=ingest --turns`
 *
 * Production transcripts are on the host that runs production, under
 * ~/Developer/receipt-assistant-data/claude/projects/-app (CLAUDE.md,
 * "Agent transcripts"). Point --dir there, or at a copy of them:
 *   npm run measure:turns -- --dir=$HOME/Developer/receipt-assistant-data/claude/projects/-app --last=6
 * The same numbers are on each run's `agent_runs` row.
 */
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import {
  getSessionJsonlPath,
  summarizeSession,
  type SessionKind,
  type SessionSummary,
} from "../src/session-transcript.js";

// ── CLI ────────────────────────────────────────────────────────────────

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
) as Record<string, string>;

const KINDS: readonly SessionKind[] = ["ingest", "re_extract", "other"];
const kind = argv.kind as SessionKind | undefined;
if (kind !== undefined && !KINDS.includes(kind)) {
  throw new Error(`--kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(argv.kind)}`);
}

function resolveSessions(): SessionSummary[] {
  const dir = argv.dir ?? path.dirname(getSessionJsonlPath("x"));
  const ofKind = (s: SessionSummary) => kind === undefined || s.kind === kind;

  if (argv.last) {
    const n = Number(argv.last);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--last must be a positive number, got ${JSON.stringify(argv.last)}`);
    }
    const newestFirst = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    // Kind is read from the file, so read newest first until N match.
    const out: SessionSummary[] = [];
    for (const f of newestFirst) {
      if (out.length >= n) break;
      const s = summarizeSession(f);
      if (ofKind(s)) out.push(s);
    }
    return out;
  }

  if (!argv.session) {
    throw new Error("Pass --session=<id|path> (repeatable, or comma-separated) or --last=<n>.");
  }
  return argv.session
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes("/") || s.endsWith(".jsonl") ? s : path.join(dir, `${s}.jsonl`)))
    .map((f) => summarizeSession(f))
    .filter(ofKind);
}

const n = (x: number) => x.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;

const reports = resolveSessions();

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
      w("model", 18) +
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
        w(s.model ?? "-", 18) +
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
      `\n${s.session}  (${s.kind}, ${s.model ?? "no model answered"})\n` +
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
