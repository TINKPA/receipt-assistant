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
 * `contract_version`, found by reading back from the END of the message
 * (`findRecordBlock`), so a transcribed line of bare backticks that throws
 * the forward pairing out cannot hide the record or put a block planted
 * in the document in its place. An opener the forward read places inside
 * a closed receipt-text block is transcription and is passed over. Other
 * JSON blocks (an echoed API response) are passed over too. The first
 * such block met from the end is THE record, even when it does not
 * parse: an earlier one would be a draft the agent moved past, and
 * quietly taking it would store a reading the agent did not hand back.
 * The ```receipt-text block is the last one before that json block in the
 * same message (or after it, when there is none before); when the forward
 * pairing was thrown out before the record, it is re-paired from the end
 * (`receiptTextFor`). The prompt asks for a receipt-text fence longer
 * than any backtick run inside it, which keeps the forward read in step.
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
  /** The receipt-text block handed back with a record that did not parse
   *  (null when there was none, or it was the oversize part). */
  receiptText: string | null;
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

/**
 * What Postgres cannot store: U+0000, which no `text` or `jsonb` value can
 * hold (22021 / 22P05), and a lone UTF-16 surrogate, which `jsonb` refuses
 * as an escape and `text` would get as a replacement character anyway.
 */
const PG_UNSAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `s` with U+0000 removed and every lone surrogate replaced by U+FFFD:
 * text that came from a model or a document, made storable. Without it
 * one such character in a record, a receipt text, a decoded email or a
 * stdout tail makes every insert that carries it fail, and the evidence
 * with it.
 */
export function pgSafeText(s: string): string {
  return s.replace(PG_UNSAFE, (c) => (c === "\u0000" ? "" : "\uFFFD"));
}

/** Whether `s` holds anything `pgSafeText` would change. */
export function hasPgUnsafe(s: string): boolean {
  PG_UNSAFE.lastIndex = 0;
  const found = PG_UNSAFE.test(s);
  PG_UNSAFE.lastIndex = 0;
  return found;
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
  return t === "" ? null : { stdout_tail: pgSafeText(utf8Tail(t, STDOUT_TAIL_MAX_BYTES)) };
}

const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

type TextScan =
  | { kind: "none" }
  | { kind: "found"; record: Record<string, unknown>; jsonText: string; receiptText: string | null; trailingText: boolean }
  | {
      kind: "failed";
      reason: "json_parse" | "size_cap";
      message: string;
      block: "json" | "receipt-text";
      jsonText: string;
      bytes: number | null;
      /** The receipt-text block that came with the failed record, when it was within its cap. */
      receiptText: string | null;
    };

interface RecordBlock {
  /** Line index of the ```json opener. */
  line: number;
  body: string;
  closed: boolean;
  /** Character offset just past the block. */
  end: number;
  /** The forward-read block that swallowed the opener, if one did. */
  host: FencedBlock | null;
}

/**
 * The record block, found from the END of the message: the last ```json
 * opener whose block (up to its first closing fence) mentions
 * `contract_version`. The record is the last thing in the message, so
 * reading back from the end finds it however the fences before it pair
 * up. Reading forward does not: a transcribed line of bare backticks
 * closes the receipt-text block early, the agent's own closing fence then
 * opens a block that swallows the record, and a ```json block planted in
 * the document becomes "the last record" in its place.
 *
 * One exception keeps forward pairing in charge: an opener the forward
 * read places INSIDE a properly closed receipt-text block is transcribed
 * text, not a record, and the scan goes on back past it. So a document
 * that carries a record-like block, transcribed inside a fence the agent
 * made long enough, is never mistaken for the agent's record.
 */
function findRecordBlock(lines: string[], starts: number[], textLength: number, blocks: FencedBlock[]): RecordBlock | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPEN_FENCE.exec(lines[i]!);
    if (!m || (m[2] ?? "").toLowerCase() !== "json") continue;
    const char = m[1]![0]!;
    const len = m[1]!.length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = CLOSE_FENCE.exec(lines[j]!);
      if (c && c[1]![0] === char && c[1]!.length >= len) break;
    }
    const body = lines.slice(i + 1, j).join("\n");
    if (!/\bcontract_version\b/.test(body)) continue;
    const pos = starts[i]!;
    const host = blocks.find((b) => b.start < pos && pos < b.end) ?? null;
    if (host && host.lang === "receipt-text" && host.closed) continue;
    const closed = j < lines.length;
    return { line: i, body, closed, end: closed ? starts[j]! + lines[j]!.length + 1 : textLength + 1, host };
  }
  return null;
}

/**
 * The receipt-text block that goes with the record block: normally the
 * last one the forward read found before it (or, when none, after it).
 * When the forward read lost step before the record (the record's opener
 * sits inside a block it opened on the agent's own closing fence, or
 * inside a receipt-text block that never closed), the block is re-paired
 * from the end instead: from the nearest receipt-text opener before the
 * record to the last bare fence line between the two.
 */
function receiptTextFor(rec: RecordBlock, lines: string[], starts: number[], blocks: FencedBlock[]): FencedBlock | null {
  if (rec.host) {
    let open = -1;
    for (let k = rec.line - 1; k >= 0; k--) {
      const m = OPEN_FENCE.exec(lines[k]!);
      if (m && (m[2] ?? "").toLowerCase() === "receipt-text") {
        open = k;
        break;
      }
    }
    if (open >= 0) {
      let close = rec.line;
      for (let k = rec.line - 1; k > open; k--) {
        if (CLOSE_FENCE.test(lines[k]!)) {
          close = k;
          break;
        }
      }
      return {
        lang: "receipt-text",
        body: lines.slice(open + 1, close).join("\n"),
        closed: close < rec.line,
        start: starts[open]!,
        end: starts[close]!,
      };
    }
  }
  const pos = starts[rec.line]!;
  const before = blocks.filter((b) => b.lang === "receipt-text" && b.end <= pos);
  const after = blocks.filter((b) => b.lang === "receipt-text" && b.start >= rec.end - 1);
  return before.at(-1) ?? after.at(-1) ?? null;
}

/**
 * Look for the record in one message's text. `none` when the text holds
 * no ```json block that mentions `contract_version`.
 */
export function scanText(text: string): TextScan {
  const norm = text.replace(/\r\n?/g, "\n");
  const lines = norm.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const blocks = fencedBlocks(norm);
  const json = findRecordBlock(lines, starts, norm.length, blocks);
  if (!json) return { kind: "none" };
  const jsonBytes = utf8Bytes(json.body);
  if (jsonBytes > ARTEFACT_MAX_BYTES) {
    return {
      kind: "failed",
      reason: "size_cap",
      block: "json",
      message: `the json block is ${jsonBytes} bytes; at most ${ARTEFACT_MAX_BYTES} are allowed`,
      jsonText: utf8Head(json.body, ARTEFACT_MAX_BYTES),
      bytes: jsonBytes,
      receiptText: null,
    };
  }
  const rt = receiptTextFor(json, lines, starts, blocks);
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
        receiptText: null,
      };
    }
  }
  const receiptText = rt ? pgSafeText(rt.body) : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.body);
  } catch (err) {
    return {
      kind: "failed",
      reason: "json_parse",
      block: "json",
      // V8 quotes a stretch of the text it choked on: model text, made storable.
      message: pgSafeText(
        `the json block is not valid JSON${json.closed ? "" : " (the block is never closed)"}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      jsonText: pgSafeText(json.body),
      bytes: null,
      receiptText,
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
      receiptText,
    };
  }
  const trailingText = norm.slice(json.end).trim() !== "";
  return {
    kind: "found",
    record: parsed as Record<string, unknown>,
    jsonText: json.body,
    receiptText,
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
    receiptText: scan.receiptText,
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
    receiptText: null,
    stdoutTail: tailOf(input.stdout),
  };
}
