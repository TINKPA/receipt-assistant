/**
 * Test-only extractor (#134/#135 hardening): executes a JSON
 * instruction file instead of spawning `claude -p`, so sandbox tests
 * can (a) place the pipeline into agent-misbehavior terminal states
 * deterministically — the worker guards' negative paths are otherwise
 * untestable because a real agent can't be made to lie on demand —
 * and (b) seed ledger rows in milliseconds for the L3b reconcile
 * matrix instead of paying a 2-minute extraction per seed.
 *
 * SAFETY GATE — two conditions, both required, before the worker
 * routes an upload here (see `pickExtractor` in worker.ts):
 *   1. env `EXTRACTOR_STUB_ALLOWED=1` — set ONLY in
 *      docker-compose.test.yml. Production compose never sets it.
 *   2. the uploaded file parses as JSON whose top-level key
 *      `__stub__` is true.
 * On production a stray stub file therefore goes to the real agent,
 * which classifies it `unsupported`. No data path exists from prod
 * uploads into this module.
 *
 * Instruction shape (the uploaded file's content):
 * {
 *   "__stub__": true,
 *   "child": {                        // optional: run a fake agent process
 *                                     // first, through the same supervisor
 *                                     // as `claude -p` (src/claude.ts
 *                                     // runAgentChild): own process group,
 *                                     // group kill on timeout, settle on close
 *     "sleep_s": 30,                  // how long the child runs (0..3600)
 *     "exit_code": 0,                 // its exit status; non-zero fails the
 *                                     // run like a crashed agent (0..255)
 *     "grandchild_s": 60,             // also start a background `sleep` of
 *                                     // this many seconds (0..3600), which
 *                                     // may outlive the child itself
 *     "ignore_term": true,            // child and grandchild ignore SIGTERM,
 *                                     // so only the SIGKILL step ends them
 *     "timeout_ms": 5000              // this run's timeout; default and
 *                                     // ceiling CLAUDE_TIMEOUT_MS
 *   },
 *   When the child times out or exits non-zero the stub stops there, as a
 *   dead agent would: nothing below is written and the run fails with the
 *   same error text a real run gets.
 *   "write_transaction": {            // optional ledger seed
 *     "payee": "...", "occurred_on": "YYYY-MM-DD",
 *     "total_minor": 1234, "currency": "USD",
 *     "pl_account_type": "expense",   // optional: "income" books the
 *                                     // total_minor leg on an income
 *                                     // account instead (default expense)
 *     "metadata": { ... },            // merged over {source:'stub'}
 *     "link_document": true           // document_links row to $DOC
 *   },
 *   "terminal": {                     // required — what the "agent" reports
 *     "status": "done"|"near_dup"|"unsupported"|"error",
 *     "classification": "receipt_image",
 *     "transaction_ids": ["$TX"],     // "$TX" → seeded txn id
 *     "document_ids": ["$DOC"],       // "$DOC" → the upload's document id
 *     "error": null
 *   }
 * }
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { newId } from "../http/uuid.js";
import { runAgentChild } from "../claude.js";
import { CLAUDE_TIMEOUT_MS, type Extractor } from "./extractor.js";

interface StubChild {
  sleep_s?: number;
  exit_code?: number;
  grandchild_s?: number;
  ignore_term?: boolean;
  timeout_ms?: number;
}

interface StubInstructions {
  __stub__: true;
  child?: StubChild;
  write_transaction?: {
    payee: string;
    occurred_on: string;
    total_minor: number;
    currency?: string;
    pl_account_type?: "expense" | "income";
    metadata?: Record<string, unknown>;
    link_document?: boolean;
  };
  terminal: {
    status: "done" | "near_dup" | "unsupported" | "error";
    classification?: string;
    transaction_ids?: string[];
    document_ids?: string[];
    error?: string | null;
  };
}

/** True when the file at absPath is a stub instruction file. Bounded:
 *  never JSON-parses more than 16 KB. */
export async function isStubFile(absPath: string): Promise<boolean> {
  try {
    const buf = await readFile(absPath);
    if (buf.length > 16_384) return false;
    const parsed = JSON.parse(buf.toString("utf8")) as { __stub__?: unknown };
    return parsed.__stub__ === true;
  } catch {
    return false;
  }
}

/** A bounded integer from the instruction file, or the fallback. Rejects
 *  anything else rather than interpolating it into a shell. */
function boundedInt(v: unknown, lo: number, hi: number, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`stub-extractor: child.${name} must be an integer in ${lo}..${hi}`);
  }
  return v;
}

/**
 * Run the fake agent: `/bin/sh` that optionally ignores SIGTERM, optionally
 * starts a background `sleep` (the grandchild), sleeps, and exits with a
 * chosen status. Only integers from the file reach the script, and they travel
 * as environment variables, never spliced into it.
 */
async function runStubChild(c: StubChild, sessionId: string): Promise<void> {
  const sleepS = boundedInt(c.sleep_s, 0, 3600, 1, "sleep_s");
  const exitCode = boundedInt(c.exit_code, 0, 255, 0, "exit_code");
  const grandchildS = boundedInt(c.grandchild_s, 0, 3600, 0, "grandchild_s");
  const timeoutMs = boundedInt(c.timeout_ms, 1, CLAUDE_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, "timeout_ms");
  const script = [
    'if [ "$STUB_IGNORE_TERM" = 1 ]; then trap "" TERM; fi',
    'if [ "$STUB_GRANDCHILD_S" -gt 0 ]; then sleep "$STUB_GRANDCHILD_S" & fi',
    'echo "STUB CHILD pid=$$ sleeping $STUB_SLEEP_S s"',
    'sleep "$STUB_SLEEP_S"',
    'exit "$STUB_EXIT_CODE"',
  ].join("\n");
  await runAgentChild("/bin/sh", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      STUB_SLEEP_S: String(sleepS),
      STUB_EXIT_CODE: String(exitCode),
      STUB_GRANDCHILD_S: String(grandchildS),
      STUB_IGNORE_TERM: c.ignore_term ? "1" : "0",
    },
    input: "",
    timeoutMs,
    sessionId,
  });
}

export const stubFileExtractor: Extractor = async (input) => {
  const raw = await readFile(input.filePath, "utf8");
  const ins = JSON.parse(raw) as StubInstructions;
  if (ins.__stub__ !== true || !ins.terminal) {
    throw new Error("stub-extractor: file is not a valid stub instruction");
  }

  // Throws exactly as `runClaude` would on a timeout or a non-zero exit;
  // the worker then fails the run and the ingest the same way.
  if (ins.child) await runStubChild(ins.child, input.sessionId);

  let seededTxId: string | null = null;
  if (ins.write_transaction) {
    const w = ins.write_transaction;
    const currency = w.currency ?? "USD";
    // Which kind of account carries the `total_minor` leg. Anything but
    // the two known values is rejected rather than interpolated.
    const plType = w.pl_account_type ?? "expense";
    if (plType !== "expense" && plType !== "income") {
      throw new Error(`stub-extractor: unknown pl_account_type ${String(plType)}`);
    }
    // Resolve one P&L + one liability account; the sandbox seed
    // workspace always has an expense and a liability account.
    const acct = await db.execute(
      sql`SELECT
            (SELECT id FROM accounts WHERE workspace_id = ${input.workspaceId}::uuid AND type = ${plType}::account_type ORDER BY name LIMIT 1) AS expense,
            (SELECT id FROM accounts WHERE workspace_id = ${input.workspaceId}::uuid AND type = 'liability' ORDER BY name LIMIT 1) AS liability`,
    );
    const { expense, liability } = acct.rows[0] as {
      expense: string | null;
      liability: string | null;
    };
    if (!expense || !liability) {
      throw new Error(`stub-extractor: workspace has no ${plType}/liability accounts`);
    }
    seededTxId = newId();
    const metadata = { source: "stub", ...(w.metadata ?? {}) };
    await db.execute(sql`
      WITH tx AS (
        INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, source_ingest_id, metadata, created_by)
        VALUES (${seededTxId}::uuid, ${input.workspaceId}::uuid, ${w.occurred_on}::date, ${w.payee}, 'posted',
                ${input.ingestId}::uuid, ${JSON.stringify(metadata)}::jsonb, ${input.userId}::uuid)
        RETURNING id
      ),
      p1 AS (
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        SELECT gen_random_uuid(), tx.id, ${input.workspaceId}::uuid, ${expense}::uuid, ${w.total_minor}, ${currency}, ${w.total_minor} FROM tx
      ),
      p2 AS (
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        SELECT gen_random_uuid(), tx.id, ${input.workspaceId}::uuid, ${liability}::uuid, ${-w.total_minor}, ${currency}, ${-w.total_minor} FROM tx
      )
      SELECT 1`);
    if (w.link_document) {
      await db.execute(sql`
        INSERT INTO document_links (document_id, transaction_id)
        VALUES (${input.documentId}::uuid, ${seededTxId}::uuid)
        ON CONFLICT DO NOTHING`);
    }
  }

  const resolveIds = (ids: string[] | undefined): string[] =>
    (ids ?? []).map((x) => {
      switch (x) {
        case "$TX":
          return seededTxId ?? x;
        case "$DOC":
          return input.documentId;
        default:
          return x;
      }
    });
  const t = ins.terminal;
  const produced = {
    transaction_ids: resolveIds(t.transaction_ids),
    document_ids: resolveIds(t.document_ids ?? ["$DOC"]),
    receipt_ids: [] as string[],
  };
  await db.execute(sql`
    UPDATE ingests
       SET status = ${t.status}::ingest_status,
           classification = ${t.classification ?? "receipt_image"},
           produced = ${JSON.stringify(produced)}::jsonb,
           error = ${t.error ?? null},
           completed_at = NOW()
     WHERE id = ${input.ingestId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid`);

  return {
    sessionId: input.sessionId,
    stdout: `STUB ingest=${input.ingestId} terminal=${t.status} tx=${seededTxId ?? "-"}`,
    exitCode: ins.child ? 0 : null,
  };
};
