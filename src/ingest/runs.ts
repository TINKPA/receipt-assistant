/**
 * Run records: the server's own account of every `claude -p` run it
 * starts for a document (`agent_runs`, migration 0042). The only writer
 * of that table.
 *
 * What a row is for: which model really answered, how many turns and
 * tokens a run cost, how it ended and why, and the session id that names
 * its transcript, kept even when the run died before the agent wrote a
 * line. See `src/schema/agent_runs.ts` for the columns and the lifecycle.
 *
 * Writing a run record must never be what breaks an extraction. Starting
 * one is part of the claim (the ingest does not move to `processing`
 * without it, see the worker); finishing one is best effort, and a row
 * left `running` by a failed finish is abandoned at the next boot.
 */
import os from "os";
import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentRuns, ingests, type agentRunOutcomeEnum } from "../schema/index.js";
import { buildInfo } from "../generated/build-info.js";
import { PROMPT_VERSION } from "./prompt-contract.js";
import { ClaudeRunError, claudeCliVersion } from "../claude.js";
import { requestedModel } from "./extractor.js";
import { summarizeSessionById } from "../session-transcript.js";
import { publicErrorMessage } from "../http/problem.js";
import { newId } from "../http/uuid.js";

export type RunOutcome = (typeof agentRunOutcomeEnum.enumValues)[number];
export type RunWriter = "agent_sql" | "server_apply" | "stub";
export type RunTrigger = "upload" | "retry" | "api";
/** The classes P1 writes; `src/schema/agent_runs.ts` lists the rest. */
export type RunErrorClass =
  | "auth"
  | "quota"
  | "overloaded"
  | "timeout"
  | "spawn"
  | "crash"
  | "agent_reported"
  | "guard"
  | "no_closeout"
  | "apply"
  | "config";

/** This process, as `agent_runs.worker_id`. */
export const WORKER_ID = `${os.hostname()}:${process.pid}`;

const ERROR_MAX = 2000;
const STDOUT_TAIL_MAX = 2000;

/**
 * The text of a failure as it may be stored on an ingest or run row and
 * sent on the SSE stream. A failed query's message is the statement plus
 * its bound values, so that one is replaced by the caller-safe sentence;
 * the full error is already in the server log. Everything else (timeouts,
 * auth failures, guard messages) is kept, because `category` and
 * `retryable` are derived from it at read time.
 */
export function ingestErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Failed query:") ? publicErrorMessage(err) : message;
}

let warnedWriter: string | null = null;

/**
 * The writer an agent run uses, from `EXTRACTION_WRITER`, read per run.
 *
 * Only `agent_sql` exists yet: the server writer (`server_apply`) is wave
 * 1's next phase. Until it lands, any other value runs `agent_sql` and is
 * said so once in the log, so the run record always names the writer that
 * actually wrote.
 */
export function extractionWriter(): "agent_sql" {
  const raw = (process.env.EXTRACTION_WRITER ?? "").trim();
  if (raw !== "" && raw !== "agent_sql" && warnedWriter !== raw) {
    warnedWriter = raw;
    console.warn(
      `[agent-runs] EXTRACTION_WRITER=${JSON.stringify(raw)} is not available in this build; ` +
        `running agent_sql`,
    );
  }
  return "agent_sql";
}

/**
 * Which class a failed agent run belongs to. A `ClaudeRunError` says
 * timeout and spawn failures outright; an exit is classed from the CLI's
 * own message, the way the ingest categories are.
 */
export function classifyAgentFailure(err: unknown): RunErrorClass {
  if (err instanceof ClaudeRunError) {
    if (err.kind === "timeout") return "timeout";
    if (err.kind === "spawn") return "spawn";
  }
  const m = err instanceof Error ? err.message : String(err);
  if (/per-argument kernel limit|\bE2BIG\b|\bENOENT\b|\bEACCES\b/.test(m)) return "spawn";
  if (/cannot be passed in args|needs a value/.test(m)) return "config";
  if (/timed out after/i.test(m)) return "timeout";
  if (/failed to authenticate|oauth|\b401\b|invalid api key|authentication_error|\/login\b/i.test(m)) {
    return "auth";
  }
  if (/session limit|usage limit|limit reached|resets \d/i.test(m)) return "quota";
  if (/overloaded|\b529\b|\b429\b|rate.?limit/i.test(m)) return "overloaded";
  return "crash";
}

function exitOf(err: unknown): { exitCode: number | null; exitSignal: string | null } {
  return err instanceof ClaudeRunError
    ? { exitCode: err.exitCode, exitSignal: err.signal }
    : { exitCode: null, exitSignal: null };
}

/** The end of a run's stdout, for `agent_report`. */
export function stdoutTail(stdout: string): { stdout_tail: string } | null {
  const t = stdout.trim();
  return t === "" ? null : { stdout_tail: t.slice(-STDOUT_TAIL_MAX) };
}

export interface RunHandle {
  runId: string;
  sessionId: string;
}

interface RunInsert {
  kind: "ingest" | "re_extract";
  workspaceId: string;
  writer: RunWriter;
  trigger: RunTrigger;
  ingestId?: string | null;
  documentId?: string | null;
  transactionId?: string | null;
  before?: unknown;
}

async function runValues(r: RunInsert, handle: RunHandle) {
  // A stub run spawns no CLI and asks for no model; recording the
  // server's CLI and `CLAUDE_MODEL` on it would say something that did
  // not happen.
  const agent = r.writer !== "stub";
  const now = new Date();
  return {
    id: handle.runId,
    workspaceId: r.workspaceId,
    kind: r.kind,
    status: "running" as const,
    ingestId: r.ingestId ?? null,
    documentId: r.documentId ?? null,
    transactionId: r.transactionId ?? null,
    trigger: r.trigger,
    writer: r.writer,
    sessionId: handle.sessionId,
    workerId: WORKER_ID,
    promptVersion: PROMPT_VERSION,
    promptGitSha: buildInfo.gitSha,
    modelRequested: agent ? requestedModel() : null,
    cliVersion: agent ? await claudeCliVersion() : null,
    queuedAt: now,
    startedAt: now,
    before: r.before ?? null,
  };
}

/**
 * T0 of an ingest: in ONE transaction, insert the run `running` with a
 * session id minted here, and move the ingest to `processing` pointing
 * `current_run_id` at it. Throws when either write fails; the caller
 * then errors the ingest without spawning.
 */
export async function startIngestRun(p: {
  ingestId: string;
  workspaceId: string;
  documentId: string;
  writer: RunWriter;
  trigger: RunTrigger;
}): Promise<RunHandle> {
  const handle: RunHandle = { runId: newId(), sessionId: randomUUID() };
  const values = await runValues(
    {
      kind: "ingest",
      workspaceId: p.workspaceId,
      writer: p.writer,
      trigger: p.trigger,
      ingestId: p.ingestId,
      documentId: p.documentId,
    },
    handle,
  );
  await db.transaction(async (tx) => {
    await tx.insert(agentRuns).values(values);
    await tx
      .update(ingests)
      .set({
        status: "processing",
        currentRunId: handle.runId,
        documentId: sql`COALESCE(${ingests.documentId}, ${p.documentId}::uuid)`,
      })
      .where(and(eq(ingests.id, p.ingestId), eq(ingests.workspaceId, p.workspaceId)));
  });
  return handle;
}

/** A re-extract run, inserted `running` just before the spawn, with the
 *  snapshot of the transaction it is about to change. */
export async function startReExtractRun(p: {
  workspaceId: string;
  documentId: string;
  transactionId: string;
  before: unknown;
}): Promise<RunHandle> {
  const handle: RunHandle = { runId: newId(), sessionId: randomUUID() };
  await db.insert(agentRuns).values(
    await runValues(
      {
        kind: "re_extract",
        workspaceId: p.workspaceId,
        writer: "agent_sql",
        trigger: "api",
        documentId: p.documentId,
        transactionId: p.transactionId,
        before: p.before,
      },
      handle,
    ),
  );
  return handle;
}

export interface RunFinish {
  outcome: RunOutcome;
  errorClass?: RunErrorClass | null;
  /** Stored at most 2000 chars, after `ingestErrorText`. */
  error?: unknown;
  /** The child's exit code; NULL when it was signalled or none ran. */
  exitCode?: number | null;
  exitSignal?: string | null;
  promptBytes?: number | null;
  produced?: unknown;
  agentReport?: unknown;
  result?: unknown;
  derivationEventId?: string | null;
}

/** The finish fields for a run whose agent failed (`err` from the spawn). */
export function agentFailure(err: unknown, extra: Partial<RunFinish> = {}): RunFinish {
  return {
    outcome: "agent_error",
    errorClass: classifyAgentFailure(err),
    error: err,
    ...exitOf(err),
    ...extra,
  };
}

/**
 * Mark a run `finished` with how it ended, plus the turns, tokens and
 * model its transcript records (`summarizeSession`). Never throws: a run
 * whose finish could not be written stays `running` and is abandoned at
 * the next boot, which is the honest record of "nobody saw it end".
 */
export async function finishRun(handle: RunHandle, f: RunFinish): Promise<void> {
  try {
    const s = summarizeSessionById(handle.sessionId);
    const error =
      f.error === undefined || f.error === null
        ? null
        : (typeof f.error === "string" ? f.error : ingestErrorText(f.error)).slice(0, ERROR_MAX);
    const updated = await db
      .update(agentRuns)
      .set({
        status: "finished",
        finishedAt: new Date(),
        outcome: f.outcome,
        errorClass: f.errorClass ?? null,
        error,
        exitCode: f.exitCode ?? null,
        exitSignal: f.exitSignal ?? null,
        promptBytes: f.promptBytes ?? null,
        produced: f.produced ?? null,
        agentReport: f.agentReport ?? null,
        result: f.result ?? null,
        derivationEventId: f.derivationEventId ?? null,
        modelObserved: s?.model ?? null,
        turns: s?.turns ?? null,
        toolCalls: s?.toolCalls ?? null,
        inputTokens: s?.freshInput ?? null,
        cacheReadTokens: s?.cacheRead ?? null,
        cacheCreationTokens: s?.cacheCreation ?? null,
        outputTokens: s?.output ?? null,
        transcriptBytes: s?.transcriptBytes ?? null,
      })
      .where(and(eq(agentRuns.id, handle.runId), eq(agentRuns.status, "running")))
      .returning({ id: agentRuns.id });
    if (updated.length === 0) {
      console.warn(`[agent-runs] run ${handle.runId} was not running; finish (${f.outcome}) not recorded`);
    }
  } catch (err) {
    console.error(`[agent-runs] could not finish run ${handle.runId} (${f.outcome}):`, err);
  }
}

/**
 * Boot: every run still `running` belongs to a process that is gone (the
 * queue is in memory until the durable queue lands), so it becomes
 * `abandoned` / `interrupted`. Class `crash`, because nothing marked a
 * clean shutdown. Runs on the caller's executor so the worker can do it
 * in the same transaction that errors the ingests those runs owned.
 */
export async function abandonInterruptedRuns(
  executor: Pick<typeof db, "execute">,
): Promise<{ ingest: number; re_extract: number }> {
  const res = await executor.execute(sql`
    UPDATE agent_runs
       SET status = 'abandoned',
           outcome = 'interrupted',
           error_class = 'crash',
           error = 'server restarted while the run was in flight',
           finished_at = now()
     WHERE status = 'running'
    RETURNING kind`);
  const counts = { ingest: 0, re_extract: 0 };
  for (const r of res.rows as Array<{ kind: "ingest" | "re_extract" }>) counts[r.kind] += 1;
  return counts;
}
