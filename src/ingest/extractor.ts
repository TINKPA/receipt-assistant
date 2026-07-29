/**
 * Phase 2 extractor — spawns `claude -p` with a prompt that teaches
 * the agent to classify, extract, optionally geocode, AND write the
 * result directly into the v1 ledger via psql. The worker consumes
 * only `sessionId` from this module; everything else (classification,
 * produced tx_ids) is read by polling the `ingests` row the agent
 * itself updates.
 */
import { randomUUID } from "crypto";
import { runClaude } from "../claude.js";
import { getSessionJsonlPath } from "../langfuse.js";
import { buildExtractorPrompt, type ExtractorPromptContext } from "./prompt.js";
import {
  buildReExtractPrompt,
  type ReExtractPromptContext,
} from "./reextract-prompt.js";

// Bumped 300s → 900s in #101 Phase 2 to accommodate the new Phase 2.6
// (WebSearch for CJK domains), Phase 4b (4-tier mechanical fetch with
// curl downloads), and Phase 4c (Read tool per candidate + visual
// scoring). First-time brand resolution legitimately needs the budget;
// cached brands return in seconds via the Case A early-out.
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);

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
}

export interface ExtractorResult {
  /** Langfuse session id pre-allocated before spawn. */
  sessionId: string;
  /** stdout captured from the claude subprocess (the DONE summary line). */
  stdout: string;
}

export type Extractor = (input: ExtractorInput) => Promise<ExtractorResult>;

// ── Default impl: spawn `claude -p` ───────────────────────────────────

/**
 * Spawn `claude -p` for the two extraction prompts.
 *
 * The shared `runClaude` in `src/claude.ts` owns the mechanics — prompt
 * on stdin (never argv, see #194), argv-size guard, env scrubbing,
 * timeout. This wrapper adds only the flags both extraction prompts
 * want and forwards the caller's pre-allocated session id.
 */
async function runExtractorClaude(
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const args = ["--output-format", "text", "--dangerously-skip-permissions"];
  // Only pin the model when CLAUDE_MODEL is explicitly set. Unset (the
  // mini today) means the CLI picks its own default, and the prompt
  // stamps `EXTRACTION_MODEL = "cli-default"` — which is the truth.
  // Passing a hard-coded "sonnet" here would silently downgrade the
  // model that has actually been running.
  if (process.env.CLAUDE_MODEL) {
    args.push("--model", process.env.CLAUDE_MODEL);
  }
  const { stdout } = await runClaude(prompt, { args, sessionId, timeoutMs });
  return stdout;
}

/**
 * Production extractor: spawns `claude -p` with a pre-allocated session
 * id (invariant from root CLAUDE.md — Langfuse's JSONL discovery relies
 * on the UUID being stable across the lifecycle of one extraction).
 */
export const defaultClaudeExtractor: Extractor = async (input) => {
  const sessionId = randomUUID();
  const ctx: ExtractorPromptContext = {
    filePath: input.filePath,
    ingestId: input.ingestId,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    userId: input.userId,
    phashNeighbors: input.phashNeighbors,
  };
  const prompt = buildExtractorPrompt(ctx);
  // Log the live-transcript path BEFORE spawn so an operator can
  // `tail -f` it mid-run. The agent loop can take 30-900s and may hang;
  // Langfuse only ingests on exit, so without this line there is no
  // way to see what the agent is doing in real time.
  console.log(
    `[claude] extract ingestId=${input.ingestId} sessionId=${sessionId} jsonl=${getSessionJsonlPath(sessionId)}`,
  );
  const stdout = await runExtractorClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  return { sessionId, stdout };
};

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
  const sessionId = randomUUID();
  const ctx: ReExtractPromptContext = {
    filePath: input.filePath,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    transactionId: input.transactionId,
    userId: input.userId,
    ocrText: input.ocrText ?? null,
  };
  const prompt = buildReExtractPrompt(ctx);
  console.log(
    `[claude] re-extract txId=${input.transactionId} sessionId=${sessionId} jsonl=${getSessionJsonlPath(sessionId)}`,
  );
  const stdout = await runExtractorClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  return { sessionId, stdout };
};
