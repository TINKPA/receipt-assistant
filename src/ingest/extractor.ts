/**
 * The extractors: everything that spawns `claude -p` for a document.
 *
 *   defaultClaudeExtractor   legacy ingest (`EXTRACTION_WRITER=agent_sql`).
 *                            The prompt teaches the agent to classify,
 *                            extract, optionally geocode, AND write the
 *                            result directly into the v1 ledger via psql.
 *                            The worker consumes only `stdout` from it;
 *                            everything else (classification, produced
 *                            tx_ids) is read by polling the `ingests` row
 *                            the agent itself updates.
 *   runRecordExtraction      the server writer's ingest (wave 1,
 *                            `server_apply`). The agent hands back an
 *                            extraction record; this finds it, validates
 *                            it, sends it back for repair at most
 *                            `EXTRACTION_REPAIR_ROUNDS` times, and returns
 *                            what the worker stores. It writes nothing.
 *   defaultClaudeReExtractor legacy re-extract.
 *
 * The session id is the CALLER's: the worker and re-extract mint it,
 * write it on the `agent_runs` row, and only then call in here, so a
 * run that fails still names its transcript.
 */
import { statSync } from "node:fs";
import { runClaude, type AgentProfileName } from "../claude.js";
import { getSessionJsonlPath } from "../session-transcript.js";
import { buildExtractorPrompt, type ExtractorPromptContext } from "./prompt.js";
import type { DecodedAttachment } from "./document-read-prompt.js";
import {
  buildReExtractPrompt,
  type ReExtractPromptContext,
} from "./reextract-prompt.js";
import {
  STDOUT_TAIL_MAX_BYTES,
  parseArtefact,
  utf8Tail,
  type ArtefactResult,
  type ArtefactSource,
} from "./contract/artefact.js";
import {
  appendWarnings,
  diffRepair,
  noteRepairRound,
  renderRepairRequest,
  validateArtefact,
  type ChangedField,
  type ValidationError,
  type ValidationOutcome,
  type ValidationWarning,
} from "./contract/validate.js";
import type { ExtractionV1 } from "./contract/v1.js";

// Bumped 300s → 900s in #101 Phase 2 to accommodate the new Phase 2.6
// (WebSearch for CJK domains), Phase 4b (4-tier mechanical fetch with
// curl downloads), and Phase 4c (Read tool per candidate + visual
// scoring). First-time brand resolution legitimately needs the budget;
// cached brands return in seconds via the Case A early-out.
export const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);

/**
 * The model an extraction asks for: `CLAUDE_MODEL` when set, else NULL
 * (the CLI picks its own default). One reading for the spawn and for the
 * run record's `model_requested`, so the two cannot disagree.
 */
export function requestedModel(): string | null {
  return process.env.CLAUDE_MODEL || null;
}

export interface ExtractorInput {
  /** Absolute path on disk — sha256-named, written by the documents service. */
  filePath: string;
  /** MIME type from the multipart upload, if supplied. */
  mimeType: string | null;
  /** Client-provided filename at upload time. Used by stubs and logs. */
  filename: string;
  /** Ingest row id — the agent closes it out on success. */
  ingestId: string;
  /** Workspace scope for SQL inserts. */
  workspaceId: string;
  /** Pre-existing document row id the agent will link. */
  documentId: string;
  /** Owner user id the agent stamps on `transactions.created_by`. */
  userId: string;
  /** Perceptually-near existing documents (#134): pHash distance ≤ 2,
   *  each already linked to a live transaction. Candidate-surfacing
   *  only — the agent compares extracted fields before deciding to
   *  attach. Empty/omitted when the upload has no phash or no close
   *  neighbors. */
  phashNeighbors?: {
    documentId: string;
    transactionId: string;
    distance: number;
  }[];
  /** Server-decoded text of an `.eml` / HTML upload (#261); NULL for
   *  images and PDFs. */
  sourceText?: string | null;
  /** PDF attachments of an `.eml`, already written to the scratch dir. */
  attachments?: DecodedAttachment[];
  /** Session id minted by the worker and already on the run record. */
  sessionId: string;
  /** Called with the rendered prompt's size just before the spawn. */
  onPrompt?: (promptBytes: number) => void;
}

export interface ExtractorResult {
  /** The session id the run used: the one the caller passed in. */
  sessionId: string;
  /** stdout captured from the claude subprocess (the DONE summary line). */
  stdout: string;
  /** The child's exit code: 0 for a real run that returned; NULL when no
   *  process ran (a stub without a `child`). */
  exitCode: number | null;
}

export type Extractor = (input: ExtractorInput) => Promise<ExtractorResult>;

// ── Default impl: spawn `claude -p` ───────────────────────────────────

/**
 * Spawn `claude -p` for the two extraction prompts.
 *
 * The shared `runClaude` in `src/claude.ts` owns the mechanics — prompt
 * on stdin (never argv, see #194), argv-size guard, timeout — and the
 * `extraction` profile there owns what the child may have: five tools,
 * no MCP servers, an allowlisted environment, and a `DATABASE_URL` that
 * logs in as `receipts_agent` instead of the server's own role. This
 * wrapper adds only the output format and the model, and forwards the
 * caller's pre-allocated session id.
 */
async function runExtractorClaude(
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await runClaude(prompt, {
    profile: "extraction",
    args: extractorArgs(),
    sessionId,
    timeoutMs,
  });
  return stdout;
}

/**
 * The caller flags every extraction spawn passes: plain-text output (the
 * final message; never `--json-schema`, see CLAUDE.md pitfall 1) and the
 * model.
 *
 * Pass the model only when CLAUDE_MODEL is set. Both compose files pin
 * it (claude-sonnet-5), so every container run names its model, the
 * prompt stamps that id and the run record's `model_requested` holds
 * it. Unset (a run outside the compose files) the CLI picks its own
 * default, the prompt stamps `EXTRACTION_MODEL = "cli-default"`, which
 * is the truth, `model_requested` is NULL, and the model that answered
 * is still in `model_observed`. A hard-coded fallback here would make
 * the stamp lie whenever the CLI's default moves.
 */
function extractorArgs(): string[] {
  const args = ["--output-format", "text"];
  const model = requestedModel();
  if (model) {
    args.push("--model", model);
  }
  return args;
}

/**
 * Production extractor: spawns `claude -p` under the session id the
 * worker minted (finding the session JSONL relies on the UUID being
 * stable across the lifecycle of one extraction, failures included).
 */
export const defaultClaudeExtractor: Extractor = async (input) => {
  const sessionId = input.sessionId;
  const ctx: ExtractorPromptContext = {
    writer: "agent_sql",
    filePath: input.filePath,
    ingestId: input.ingestId,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    userId: input.userId,
    phashNeighbors: input.phashNeighbors,
    sourceText: input.sourceText,
    attachments: input.attachments,
  };
  const prompt = buildExtractorPrompt(ctx);
  input.onPrompt?.(Buffer.byteLength(prompt, "utf8"));
  // Log the live-transcript path BEFORE spawn so an operator can
  // `tail -f` it mid-run. The agent loop can take 30-900s and may hang,
  // and this line is the only link from an ingest to its transcript
  // short of grepping every JSONL for the ingest id.
  console.log(
    `[claude] extract ingestId=${input.ingestId} sessionId=${sessionId} jsonl=${getSessionJsonlPath(sessionId)}`,
  );
  const stdout = await runExtractorClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  return { sessionId, stdout, exitCode: 0 };
};

// ── Record path (wave 1, EXTRACTION_WRITER=server_apply) ──────────────

/** The repair round's own timeout (plan §5). A resumed turn reads the
 *  conversation from the prompt cache and only re-reads what the errors
 *  name, so it gets far less than a first read. */
export const REPAIR_TIMEOUT_MS = 300_000;
/** The most repair rounds `EXTRACTION_REPAIR_ROUNDS` may ask for. */
export const MAX_REPAIR_ROUNDS = 2;
/** One round, since the P0 probe showed `--resume` keeps the profile's
 *  tools and the cache on the pinned CLI. Set 0 on a CLI where it fails. */
export const DEFAULT_REPAIR_ROUNDS = 1;

let warnedRepairRounds: string | null = null;

/**
 * `EXTRACTION_REPAIR_ROUNDS`, read per run: how many times an invalid
 * record is sent back to its own session before it is stored as invalid.
 * An integer is clamped to 0..2; anything else is the default, said once
 * in the log.
 */
export function extractionRepairRounds(): number {
  const raw = (process.env.EXTRACTION_REPAIR_ROUNDS ?? "").trim();
  if (raw === "") return DEFAULT_REPAIR_ROUNDS;
  const n = Number(raw);
  if (Number.isInteger(n)) return Math.min(MAX_REPAIR_ROUNDS, Math.max(0, n));
  if (warnedRepairRounds !== raw) {
    warnedRepairRounds = raw;
    console.warn(
      `[claude] EXTRACTION_REPAIR_ROUNDS=${JSON.stringify(raw)} is not a whole number; using ${DEFAULT_REPAIR_ROUNDS}`,
    );
  }
  return DEFAULT_REPAIR_ROUNDS;
}

export interface RecordExtractorInput {
  /** Absolute path of the upload, as the agent opens it. */
  filePath: string;
  ingestId: string;
  workspaceId: string;
  documentId: string;
  userId: string;
  /** Server-decoded text of an `.eml` / HTML upload; NULL for images and
   *  PDFs. Rendered inside a per-run random delimiter. */
  sourceText?: string | null;
  /** PDF attachments of an `.eml`, already written to the scratch dir. */
  attachments?: DecodedAttachment[];
  /** Minted by the worker and already on the run record. The first spawn
   *  starts this session and every repair round resumes it, so the run
   *  has one transcript. */
  sessionId: string;
  /** When the document was uploaded. Dates are judged against it, never
   *  against the clock (`validate.ts`). */
  uploadedAt: Date;
  /** Called with the rendered prompt's size just before the first spawn. */
  onPrompt?: (promptBytes: number) => void;
  /** Overrides, for the stub and the checks; production leaves them out. */
  repairRounds?: number;
  timeoutMs?: number;
  repairTimeoutMs?: number;
}

/**
 * How a record run ended, for the worker:
 *
 *   valid        a record passed validation (perhaps after a repair). T1
 *                stores `outcome`; the applier takes `record`.
 *   invalid      a record came back but was still in error after the last
 *                round. T1 stores `outcome` as evidence (`status='invalid'`)
 *                and the ingest errors with `errorText`.
 *   missing      no record anywhere: not in stdout, not in the transcript
 *                (`artefact_missing`). Nothing to store; `stdoutTail` goes
 *                on the run's `agent_report`.
 *   agent_error  the first spawn failed (timeout, auth, quota, a crash):
 *                `error` is what `runClaude` threw, for
 *                `classifyAgentFailure`. Nothing to store.
 */
export type RecordExtractionStatus = "valid" | "invalid" | "missing" | "agent_error";

export interface RecordExtractionResult {
  sessionId: string;
  status: RecordExtractionStatus;
  /** What T1 stores (`records.ts` `insertExtractionRecord`): the last
   *  outcome, its report carrying a note per repair round and the
   *  `repair_changed_unnamed` warnings. Null for missing and agent_error. */
  outcome: ValidationOutcome | null;
  /** `outcome.record` when valid. */
  record: ExtractionV1 | null;
  /** The ```receipt-text block handed back with that outcome's record. */
  rawText: string | null;
  /** Where that record was found: stdout, or the transcript fallback. */
  artefactSource: ArtefactSource | null;
  /** The message went on after the record's closing fence. */
  trailingText: boolean;
  /** Repair rounds spawned (`agent_runs.repair_rounds`). */
  repairRounds: number;
  /** What the repairs changed that no error named; also on the outcome's
   *  report as `repair_changed_unnamed` warnings (gate G2 counts the
   *  money ones). */
  repairChangedUnnamed: ChangedField[];
  /** The end of the last spawn's stdout (≤ 2 KB), for `agent_report`. */
  stdoutTail: { stdout_tail: string } | null;
  /** The run's error class when what the agent handed back is the
   *  problem. Null when valid, and null for agent_error, whose class
   *  comes from `error`. */
  errorClass: "artefact_missing" | "artefact_invalid" | null;
  /** For `ingests.error` / `agent_runs.error`: `extraction record
   *  rejected: <path>: <rule>` or `extraction record missing: …`. */
  errorText: string | null;
  /** A failed spawn: the first one's for agent_error, a repair round's
   *  when that one failed and the earlier record stood. */
  error: unknown;
  /** The rendered prompt's size (`agent_runs.prompt_bytes`). */
  promptBytes: number;
}

function stdoutTailOf(stdout: string): { stdout_tail: string } | null {
  const t = stdout.trim();
  return t === "" ? null : { stdout_tail: utf8Tail(t, STDOUT_TAIL_MAX_BYTES) };
}

/** The transcript's size now, so a repair round's parse skips what the
 *  earlier rounds wrote (their record must not be taken for the new one). */
function transcriptBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** `extraction record rejected: facts.occurred_on: calendar_date (+1 more)`. */
export function recordRejectedText(errors: readonly ValidationError[]): string {
  const first = errors[0];
  if (!first) return "extraction record rejected";
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return `extraction record rejected: ${first.path === "" ? "record" : first.path}: ${first.rule}${more}`;
}

async function runRecordClaude(
  prompt: string,
  session: { sessionId: string } | { resumeSessionId: string },
  timeoutMs: number,
): Promise<string> {
  const profile: AgentProfileName = "extraction_record";
  const { stdout } = await runClaude(prompt, { profile, args: extractorArgs(), timeoutMs, ...session });
  return stdout;
}

/**
 * One ingest under the server writer, up to the record (plan §2, §5): the
 * spawn, the hand-back, validation and the repair rounds. It writes no
 * database row; the worker stores the result (T1) and applies it (T2).
 *
 *   1. Spawn `claude -p` on the record rendering of the prompt
 *      (`writer: 'server_apply'`) with the `extraction_record` profile:
 *      Bash, Read, Write, the Google key, no database. The prompt goes on
 *      stdin; the session id is the worker's.
 *   2. Find the record (`parseArtefact`: stdout, else the transcript's
 *      assistant text) and validate it (`validateArtefact`).
 *   3. While it is invalid and rounds are left, resume the same session
 *      (`runClaude` `resumeSessionId`: `--resume <id>`, the profile's flags
 *      again, the list of problems on stdin, `repairTimeoutMs`), then parse
 *      the new reply only, validate it, and diff it against the record it
 *      replaces (`diffRepair`). A round that hands back no record leaves
 *      the earlier one standing; a round whose spawn fails ends the loop.
 *
 * A missing record is not sent back: there is no field to name, and the
 * plan counts it as its own failure class. A first spawn that fails is
 * not parsed either, even when the transcript holds a record: a run that
 * timed out or crashed did not hand anything back.
 */
export async function runRecordExtraction(input: RecordExtractorInput): Promise<RecordExtractionResult> {
  const sessionId = input.sessionId;
  const transcriptPath = getSessionJsonlPath(sessionId);
  const maxRounds = Math.min(MAX_REPAIR_ROUNDS, Math.max(0, input.repairRounds ?? extractionRepairRounds()));
  const ctx = { uploadedAt: input.uploadedAt };

  const prompt = buildExtractorPrompt({
    writer: "server_apply",
    filePath: input.filePath,
    ingestId: input.ingestId,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    userId: input.userId,
    sourceText: input.sourceText,
    attachments: input.attachments,
  });
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  input.onPrompt?.(promptBytes);
  console.log(
    `[claude] extract-record ingestId=${input.ingestId} sessionId=${sessionId} jsonl=${transcriptPath}`,
  );

  const result: RecordExtractionResult = {
    sessionId,
    status: "agent_error",
    outcome: null,
    record: null,
    rawText: null,
    artefactSource: null,
    trailingText: false,
    repairRounds: 0,
    repairChangedUnnamed: [],
    stdoutTail: null,
    errorClass: null,
    errorText: null,
    error: null,
    promptBytes,
  };

  let stdout: string;
  try {
    stdout = await runRecordClaude(prompt, { sessionId }, input.timeoutMs ?? CLAUDE_TIMEOUT_MS);
  } catch (err) {
    result.error = err;
    result.errorText = err instanceof Error ? err.message : String(err);
    return result;
  }
  result.stdoutTail = stdoutTailOf(stdout);

  let artefact: ArtefactResult = parseArtefact({ stdout, transcriptPath });
  let outcome = validateArtefact(artefact, ctx);
  if (outcome === null) {
    result.status = "missing";
    result.errorClass = "artefact_missing";
    result.errorText = `extraction record missing: ${artefact.ok ? "" : artefact.message}`;
    return result;
  }

  const rounds: { round: number; errors: ValidationError[] }[] = [];
  const unnamed: ValidationWarning[] = [];
  while (outcome.status === "invalid" && result.repairRounds < maxRounds) {
    const round = ++result.repairRounds;
    const errors = outcome.report.errors;
    rounds.push({ round, errors });
    const fromByte = transcriptBytes(transcriptPath);
    console.log(
      `[claude] extract-record repair round ${round}/${maxRounds} ingestId=${input.ingestId} ` +
        `sessionId=${sessionId} errors=${errors.length}`,
    );
    let repaired: string;
    try {
      repaired = await runRecordClaude(
        renderRepairRequest(errors),
        { resumeSessionId: sessionId },
        input.repairTimeoutMs ?? REPAIR_TIMEOUT_MS,
      );
    } catch (err) {
      result.error = err;
      console.warn(
        `[claude] extract-record repair round ${round} failed ingestId=${input.ingestId}: ` +
          `${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
      );
      break;
    }
    result.stdoutTail = stdoutTailOf(repaired);
    const next = parseArtefact({ stdout: repaired, transcriptPath, transcriptFromByte: fromByte });
    const nextOutcome = validateArtefact(next, ctx);
    if (nextOutcome === null) continue; // no record this round; the earlier one stands
    const diff = diffRepair(outcome.parsed, nextOutcome.parsed, errors);
    unnamed.push(...diff.warnings);
    result.repairChangedUnnamed.push(...diff.unnamed);
    artefact = next;
    outcome = nextOutcome;
  }

  for (const r of rounds) noteRepairRound(outcome.report, r.round, r.errors);
  appendWarnings(outcome.report, unnamed);

  result.outcome = outcome;
  result.rawText = artefact.ok ? artefact.receiptText : null;
  result.artefactSource = artefact.source;
  result.trailingText = artefact.ok && artefact.trailingText;
  if (outcome.status === "valid") {
    result.status = "valid";
    result.record = outcome.record;
  } else {
    result.status = "invalid";
    result.errorClass = "artefact_invalid";
    result.errorText = recordRejectedText(outcome.report.errors);
  }
  return result;
}

// ── Re-extract path (Phase 4c of #80 / #91) ────────────────────────────

export interface ReExtractorInput {
  /** Absolute path on disk for the original upload. */
  filePath: string;
  workspaceId: string;
  /** Document row whose `ocr_text` / `ocr_model_version` re-extract refreshes. */
  documentId: string;
  /** Transaction row re-extract UPDATEs in place. */
  transactionId: string;
  /** Owner user id, recorded in `transaction_events`. */
  userId: string;
  /** Pre-decoded plain text of the source, for documents the agent
   *  cannot usefully open on its own — `.eml` bodies (MIME-encoded, with
   *  the itemization usually only in the `text/html` part) and raw HTML
   *  files (#167). NULL for images and PDFs, which the agent reads. */
  ocrText?: string | null;
  /** PDF attachments of an `.eml`, already written to the scratch dir. */
  attachments?: DecodedAttachment[];
  /** Session id minted by re-extract and already on the run record. */
  sessionId: string;
  /** Called with the rendered prompt's size just before the spawn. */
  onPrompt?: (promptBytes: number) => void;
}

export interface ReExtractorResult {
  sessionId: string;
  stdout: string;
}

export type ReExtractor = (input: ReExtractorInput) => Promise<ReExtractorResult>;

/**
 * Re-extract spawn — same shape as `defaultClaudeExtractor` but with
 * the narrower re-extract prompt (no classify, no postings, no place
 * fetch). The agent writes directly to Postgres via psql; this fn
 * just spawns + waits.
 */
export const defaultClaudeReExtractor: ReExtractor = async (input) => {
  const sessionId = input.sessionId;
  const ctx: ReExtractPromptContext = {
    filePath: input.filePath,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    transactionId: input.transactionId,
    userId: input.userId,
    ocrText: input.ocrText ?? null,
    attachments: input.attachments,
  };
  const prompt = buildReExtractPrompt(ctx);
  input.onPrompt?.(Buffer.byteLength(prompt, "utf8"));
  console.log(
    `[claude] re-extract txId=${input.transactionId} sessionId=${sessionId} jsonl=${getSessionJsonlPath(sessionId)}`,
  );
  const stdout = await runExtractorClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  return { sessionId, stdout };
};
