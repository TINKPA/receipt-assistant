/**
 * Finding the extraction record in what the agent handed back (wave 1,
 * plan §5).
 *
 * The record prompt (4.0) asks the agent to end its final message with an
 * optional ```receipt-text block and exactly one ```json block whose
 * object carries `"contract_version"`, with nothing after it. The server
 * pulls the record out of the run's output; the agent has no channel to
 * push one in, so there is no endpoint, socket or file path for it to
 * choose.
 *
 * Where it looks, in order:
 *
 *   1. stdout. `claude -p --output-format text` prints the final message,
 *      so the record is normally the last ```json block there.
 *   2. The session transcript, when stdout has none (the model kept
 *      talking after the record, or stdout was lost). Only the TEXT
 *      blocks of ASSISTANT messages are read, newest message first: never
 *      a tool result, a tool call's input, a user turn or a thinking
 *      block. Those carry text the agent was shown or wrote to a file,
 *      which is exactly where a document could plant a fake record.
 *
 * Fences are read the way CommonMark reads them, line by line: a block
 * opens with three or more backticks (or tildes) and an info string, and
 * closes on a line of the same character at least as long, with nothing
 * else on it. So a fence-like line INSIDE the receipt text (a printed
 * "```json", say) is receipt text, not a block, and a block left open
 * runs to the end of the message (the output was cut off; its JSON will
 * not parse).
 *
 * Which ```json block counts: the last one whose body mentions
 * `contract_version`. Other JSON blocks (an echoed API response) are
 * passed over. The first such block met from the end is THE record, even
 * when it does not parse: an earlier one would be a draft the agent
 * moved past, and quietly taking it would store a reading the agent did
 * not hand back. The ```receipt-text block is the last one before that
 * json block in the same message (or after it, when there is none
 * before).
 *
 * Caps: the json block 256 KB, the receipt text 64 KB. Over a cap is
 * `size_cap`, which `validate.ts` turns into a bounced record. A record
 * that is nowhere is `artefact_missing`; the caller stores no record and
 * keeps the end of stdout (`stdoutTail`, ≤ 2 KB) on the run.
 */
import { closeSync, openSync, readSync, fstatSync } from "node:fs";

/** Largest json block accepted, in UTF-8 bytes. */
export const ARTEFACT_MAX_BYTES = 256 * 1024;
/** Largest receipt-text block accepted, in UTF-8 bytes. */
export const RECEIPT_TEXT_MAX_BYTES = 64 * 1024;
/** How much of the end of stdout is kept for `agent_runs.agent_report`. */
export const STDOUT_TAIL_MAX_BYTES = 2 * 1024;

/** A transcript larger than this is read from its end only. */
const TRANSCRIPT_READ_MAX_BYTES = 32 * 1024 * 1024;

export type ArtefactSource = "stdout" | "transcript";
export type ArtefactFailureReason = "artefact_missing" | "json_parse" | "size_cap";

export interface ArtefactFound {
  ok: true;
  source: ArtefactSource;
  /** The parsed json block: an object carrying `contract_version`. */
  record: Record<string, unknown>;
  /** The json block's text as handed back. */
  jsonText: string;
  /** The receipt-text block, when one was given. */
  receiptText: string | null;
  /** True when the message went on after the json block. */
  trailingText: boolean;
  /** `{ stdout_tail }` for `agent_runs.agent_report`, or null for empty stdout. */
  stdoutTail: { stdout_tail: string } | null;
}

export interface ArtefactFailure {
  ok: false;
  reason: ArtefactFailureReason;
  /** One sentence; for `json_parse` it carries the parser's own message. */
  message: string;
  /** Which part is at fault, for `size_cap`: the json or the receipt-text block. */
  block: "json" | "receipt-text" | null;
  source: ArtefactSource | null;
  /** The json block's text (absent when the record is missing, and cut to
   *  `ARTEFACT_MAX_BYTES` when it is the oversize part). */
  jsonText: string | null;
  /** UTF-8 size of the offending block, for `size_cap`. */
  bytes: number | null;
  stdoutTail: { stdout_tail: string } | null;
}

export type ArtefactResult = ArtefactFound | ArtefactFailure;

export interface ParseArtefactInput {
  /** Everything the run printed on stdout. */
  stdout: string;
  /** The session transcript (`getSessionJsonlPath`), for the fallback. */
  transcriptPath?: string | null;
  /**
   * Read the transcript from this byte offset on. A repair round resumes
   * the same session, so its transcript also holds the first round; the
   * worker passes the file's size from before the resume, so the old
   * record is never taken for the repaired one.
   */
  transcriptFromByte?: number;
}

// ── Fenced blocks ──────────────────────────────────────────────────────

export interface FencedBlock {
  /** The info string's first word, lower-cased ("json", "receipt-text"). */
  lang: string;
  body: string;
  /** False when the block ran to the end of the text unclosed. */
  closed: boolean;
  /** Character offset of the opening fence line and just past the block. */
  start: number;
  end: number;
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;

/**
 * Every fenced code block in `text`, in order, read line by line as
 * CommonMark does. CRLF line ends are accepted.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: FencedBlock[] = [];
  let offset = 0;
  let open: { char: string; len: number; lang: string; start: number; body: string[] } | null = null;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
        blocks.push({
          lang: open.lang,
          body: open.body.join("\n"),
          closed: true,
          start: open.start,
          end: offset,
        });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const m = OPEN_FENCE.exec(line);
    if (m) {
      open = { char: m[1]![0]!, len: m[1]!.length, lang: (m[2] ?? "").toLowerCase(), start: lineStart, body: [] };
    }
  }
  if (open) {
    blocks.push({ lang: open.lang, body: open.body.join("\n"), closed: false, start: open.start, end: offset });
  }
  return blocks;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The end of `s`, at most `maxBytes` UTF-8 bytes, cut on a character boundary. */
export function utf8Tail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  // Skip continuation bytes so the cut never splits a character.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** The start of `s`, at most `maxBytes` UTF-8 bytes, cut on a character boundary. */
export function utf8Head(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function tailOf(stdout: string): { stdout_tail: string } | null {
  const t = stdout.trim();
  return t === "" ? null : { stdout_tail: utf8Tail(t, STDOUT_TAIL_MAX_BYTES) };
}

const isRecordBlock = (b: FencedBlock) => b.lang === "json" && /\bcontract_version\b/.test(b.body);

type TextScan =
  | { kind: "none" }
  | { kind: "found"; record: Record<string, unknown>; jsonText: string; receiptText: string | null; trailingText: boolean }
  | { kind: "failed"; reason: "json_parse" | "size_cap"; message: string; block: "json" | "receipt-text"; jsonText: string; bytes: number | null };

/**
 * Look for the record in one message's text. `none` when the text holds
 * no ```json block that mentions `contract_version`.
 */
export function scanText(text: string): TextScan {
  const blocks = fencedBlocks(text);
  let idx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isRecordBlock(blocks[i]!)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { kind: "none" };
  const json = blocks[idx]!;
  const jsonBytes = utf8Bytes(json.body);
  if (jsonBytes > ARTEFACT_MAX_BYTES) {
    return {
      kind: "failed",
      reason: "size_cap",
      block: "json",
      message: `the json block is ${jsonBytes} bytes; at most ${ARTEFACT_MAX_BYTES} are allowed`,
      jsonText: utf8Head(json.body, ARTEFACT_MAX_BYTES),
      bytes: jsonBytes,
    };
  }
  const before = blocks.slice(0, idx).filter((b) => b.lang === "receipt-text");
  const after = blocks.slice(idx + 1).filter((b) => b.lang === "receipt-text");
  const rt = before.at(-1) ?? after.at(-1) ?? null;
  if (rt) {
    const rtBytes = utf8Bytes(rt.body);
    if (rtBytes > RECEIPT_TEXT_MAX_BYTES) {
      return {
        kind: "failed",
        reason: "size_cap",
        block: "receipt-text",
        message: `the receipt-text block is ${rtBytes} bytes; at most ${RECEIPT_TEXT_MAX_BYTES} are allowed`,
        jsonText: json.body,
        bytes: rtBytes,
      };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.body);
  } catch (err) {
    return {
      kind: "failed",
      reason: "json_parse",
      block: "json",
      message: `the json block is not valid JSON${json.closed ? "" : " (the block is never closed)"}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      jsonText: json.body,
      bytes: null,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("contract_version" in parsed)) {
    return {
      kind: "failed",
      reason: "json_parse",
      block: "json",
      message: "the json block is not one JSON object with a contract_version key",
      jsonText: json.body,
      bytes: null,
    };
  }
  const trailingText = text.replace(/\r\n?/g, "\n").slice(json.end).trim() !== "";
  return {
    kind: "found",
    record: parsed as Record<string, unknown>,
    jsonText: json.body,
    receiptText: rt ? rt.body : null,
    trailingText,
  };
}

// ── The transcript fallback ────────────────────────────────────────────

function readFrom(path: string, fromByte: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(fromByte, size - TRANSCRIPT_READ_MAX_BYTES, 0);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The text of every assistant message in a session transcript, oldest
 * first, one entry per message. The CLI writes one JSONL line per
 * content block and repeats the message id on each, so the text blocks
 * of one message are joined in order. Tool calls, tool results, user
 * turns, thinking blocks and sidechain (sub-agent) records are skipped.
 * A missing file reads as no messages; a torn line is skipped.
 */
export function assistantTexts(transcriptPath: string, fromByte = 0): string[] {
  let raw: string;
  try {
    raw = readFrom(transcriptPath, fromByte);
  } catch {
    return [];
  }
  const order: string[] = [];
  const byId = new Map<string, string[]>();
  let anon = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== "assistant" || rec.isSidechain === true) continue;
    const msg = rec.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const texts = msg.content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string);
    if (texts.length === 0) continue;
    const id = typeof msg.id === "string" ? msg.id : `_anon_${anon++}`;
    let parts = byId.get(id);
    if (!parts) {
      parts = [];
      byId.set(id, parts);
      order.push(id);
    }
    parts.push(...texts);
  }
  return order.map((id) => byId.get(id)!.join("\n"));
}

// ── Entry point ────────────────────────────────────────────────────────

function fromScan(scan: Exclude<TextScan, { kind: "none" }>, source: ArtefactSource, stdout: string): ArtefactResult {
  if (scan.kind === "found") {
    return {
      ok: true,
      source,
      record: scan.record,
      jsonText: scan.jsonText,
      receiptText: scan.receiptText,
      trailingText: scan.trailingText,
      stdoutTail: tailOf(stdout),
    };
  }
  return {
    ok: false,
    reason: scan.reason,
    message: scan.message,
    block: scan.block,
    source,
    jsonText: scan.jsonText,
    bytes: scan.bytes,
    stdoutTail: tailOf(stdout),
  };
}

/**
 * Find the extraction record a run handed back: stdout first, then the
 * transcript's assistant text from the newest message back. Never throws.
 */
export function parseArtefact(input: ParseArtefactInput): ArtefactResult {
  const fromStdout = scanText(input.stdout);
  if (fromStdout.kind !== "none") return fromScan(fromStdout, "stdout", input.stdout);

  if (input.transcriptPath) {
    const texts = assistantTexts(input.transcriptPath, input.transcriptFromByte ?? 0);
    for (let i = texts.length - 1; i >= 0; i--) {
      const scan = scanText(texts[i]!);
      if (scan.kind !== "none") return fromScan(scan, "transcript", input.stdout);
    }
  }
  return {
    ok: false,
    reason: "artefact_missing",
    message:
      "no ```json block with a contract_version was found in the final output" +
      (input.transcriptPath ? " or in the session transcript" : ""),
    block: null,
    source: null,
    jsonText: null,
    bytes: null,
    stdoutTail: tailOf(input.stdout),
  };
}
