import path from "path";
import os from "os";
import { readFileSync, statSync } from "fs";

/**
 * Resolve where Claude Code writes the JSONL transcript for a given
 * `--session-id`. The CLI mangles CWD by replacing "/" and "_" with "-"
 * and writes to `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl`.
 * Stable across host mode (`$HOME=/Users/…`) and container (`/home/node`).
 *
 * This file is the only trace of a `claude -p` run: every prompt, tool
 * call, tool result and per-turn `usage` block. It survives because
 * `~/.claude` is bind-mounted to the host and the image pins
 * `cleanupPeriodDays` high in managed settings (see Dockerfile) — the
 * CLI's default would delete it after 30 days.
 */
export function getSessionJsonlPath(sessionId: string): string {
  const mangledCwd = process.cwd().replace(/[/_]/g, "-");
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    mangledCwd,
    `${sessionId}.jsonl`,
  );
}

// ── Turn and token accounting ─────────────────────────────────────────
//
// One parser for a session transcript, shared by the server (which fills
// `agent_runs` after every run) and `scripts/measure-ingest-turns.ts`, so
// the two can never disagree about what a turn or a billed token is.
//
// Two traps, both found the hard way (#227):
//
//   1. Claude Code writes ONE JSONL LINE PER CONTENT BLOCK of an assistant
//      message (`thinking`, then `text`, then `tool_use`), and stamps AN
//      IDENTICAL COPY OF THE SAME `usage` OBJECT on every one of those
//      lines. Counting `type:"assistant"` records counts each real API turn
//      1–3×, and summing `usage` across them double- or triple-counts the
//      bill (the record:turn ratio runs 2.0–2.6 in production). A turn is
//      therefore one `message.id`, and its usage is taken from the FIRST
//      record carrying that id.
//
//   2. Billed input is `input_tokens + cache_read + cache_creation`. Cache
//      WRITES are billed, and turn 1 writes the whole prompt; dropping that
//      bucket undercounts by 5.5–12.9% on this workload.

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TranscriptTurn {
  id: string;
  usage: TranscriptUsage;
  tools: { name: string; head: string }[];
  text: string;
  thinkingChars: number;
  stopReason?: string;
  model?: string;
}

/** What produced a transcript, read from its first user message. */
export type SessionKind = "ingest" | "re_extract" | "other";

export interface SessionSummary {
  /** The file's basename without `.jsonl`: the session id. */
  session: string;
  kind: SessionKind;
  /** The model that answered most turns. Turns the CLI synthesises itself
   *  (an auth failure's error message, model `<synthetic>`) do not count;
   *  NULL when no real model answered at all. */
  model: string | null;
  rawAssistantRecords: number;
  turns: number;
  toolCalls: number;
  turnsWithoutToolCall: number;
  promptChars: number;
  /** Turn 1's cache write, which is the prompt's token cost. */
  promptTokens: number;
  billedInput: number;
  freshInput: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  /** turns × prompt tokens over billed input: the prompt is re-read from
   *  cache on every turn. */
  promptShare: number;
  transcriptBytes: number;
  detail: TranscriptTurn[];
}

/**
 * How a transcript's first user message starts, per kind. These are the
 * opening words of `buildExtractorPrompt` (src/ingest/prompt.ts; both its
 * legacy and its record rendering start this way) and
 * `buildReExtractPrompt` (src/ingest/reextract-prompt.ts); a prompt that
 * changes its first sentence must be added here, or its sessions count as
 * `other`. Only the measuring script filters on kind; the server knows
 * the kind of every run it starts.
 */
const KIND_PREFIXES: ReadonlyArray<[SessionKind, string]> = [
  ["ingest", "You are a v1 double-entry ledger extractor"],
  ["re_extract", "You are re-running extraction on a previously-ingested receipt"],
];

const SYNTHETIC_MODEL = "<synthetic>";

/** All three buckets are billed. See the note above. */
export function billedInputOf(u: TranscriptUsage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** The most identifying string in a tool call, for a per-turn table. */
function toolHead(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? "";
  return String(v).replace(/\s+/g, " ").trim();
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .join(" ");
  }
  return "";
}

/**
 * Read one session transcript and count its turns, tool calls, tokens
 * and model. Throws when the file cannot be read; a torn last line (a
 * session still being written) is skipped, not an error.
 */
export function summarizeSession(jsonlPath: string): SessionSummary {
  const raw = readFileSync(jsonlPath, "utf8");
  const lines = raw.split("\n");

  const byId = new Map<string, TranscriptTurn>();
  let rawAssistantRecords = 0;
  let promptChars = 0;
  let kind: SessionKind | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line on a still-running session is not an error
    }

    // The first user message IS the prompt.
    if (promptChars === 0 && rec.type === "user") {
      const c = rec.message?.content;
      promptChars = typeof c === "string" ? c.length : JSON.stringify(c ?? "").length;
      const text = userText(c).trimStart();
      kind = KIND_PREFIXES.find(([, prefix]) => text.startsWith(prefix))?.[0] ?? "other";
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
        model: typeof msg.model === "string" ? msg.model : undefined,
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
  const sum = (f: (u: TranscriptUsage) => number) =>
    detail.reduce((a, t) => a + f(t.usage), 0);

  const billed = sum(billedInputOf);
  const promptTokens = detail[0]?.usage.cache_creation_input_tokens ?? 0;

  const modelTurns = new Map<string, number>();
  for (const t of detail) {
    if (!t.model || t.model === SYNTHETIC_MODEL) continue;
    modelTurns.set(t.model, (modelTurns.get(t.model) ?? 0) + 1);
  }
  let model: string | null = null;
  for (const [m, n] of modelTurns) {
    if (model === null || n > modelTurns.get(model)!) model = m;
  }

  return {
    session: path.basename(jsonlPath, ".jsonl"),
    kind: kind ?? "other",
    model,
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
    transcriptBytes: statSync(jsonlPath).size,
    detail,
  };
}

/**
 * `summarizeSession` for a session id, or null when its transcript does
 * not exist (nothing was spawned, the CLI failed before writing, or the
 * run was a stub) or cannot be read. Never throws: a run record is still
 * worth writing without its token counts.
 */
export function summarizeSessionById(sessionId: string): SessionSummary | null {
  const p = getSessionJsonlPath(sessionId);
  try {
    if (!statSync(p).isFile()) return null;
    return summarizeSession(p);
  } catch {
    return null;
  }
}
