/**
 * Phase 2 extractor — spawns `claude -p` with a prompt that teaches
 * the agent to classify, extract, optionally geocode, AND write the
 * result directly into the v1 ledger via psql. The worker consumes
 * only `sessionId` from this module; everything else (classification,
 * produced tx_ids) is read by polling the `ingests` row the agent
 * itself updates.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
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
}

export interface ExtractorResult {
  /** Langfuse session id pre-allocated before spawn. */
  sessionId: string;
  /** stdout captured from the claude subprocess (the DONE summary line). */
  stdout: string;
}

export type Extractor = (input: ExtractorInput) => Promise<ExtractorResult>;

// ── Default impl: spawn `claude -p` ───────────────────────────────────

function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // These quirks poison nested CLI sessions — carry forward from Phase 1.
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function runClaude(
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--session-id",
      sessionId,
    ];
    const child = spawn("claude", args, {
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err || out || `claude -p exited ${code}`));
      } else {
        resolve(out);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
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
  };
  const prompt = buildExtractorPrompt(ctx);
  const stdout = await runClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
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
  };
  const prompt = buildReExtractPrompt(ctx);
  const stdout = await runClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  return { sessionId, stdout };
};
