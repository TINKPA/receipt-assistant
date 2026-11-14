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
 * routes an upload here (see `pickPath` in worker.ts):
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
 *     "escaped_s": 60,                // also start a process in a session
 *                                     // of its own, as CLI 2.1.251's Bash
 *                                     // tool runs every command, that lives
 *                                     // this many seconds (0..3600) with its
 *                                     // own stdio; the group kill does not
 *                                     // reach it, the timeout's descendant
 *                                     // sweep does
 *     "ignore_term": true,            // child and (escaped) grandchildren
 *                                     // ignore SIGTERM, so only the SIGKILL
 *                                     // step ends them
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
 *
 * RECORD MODE (wave 1, the server writer). A file with a top-level
 * `record` key instead of `terminal` stands in for the agent of
 * `EXTRACTION_WRITER=server_apply`, and takes that path whatever the
 * variable says (a `terminal` file always takes the legacy one). It writes
 * nothing itself: its child prints the record the way the agent ends its
 * final message, and the worker then runs the real parser, validator,
 * repair round, T1 and applier on that stdout (`runRecordExtraction` with
 * `recordStubSpawn` in place of `claude -p`).
 * {
 *   "__stub__": true,
 *   "record": { "contract_version": 1, … },  // printed in a ```json block;
 *                                     // a string is printed verbatim (to
 *                                     // hand back JSON that does not parse),
 *                                     // null prints no block at all
 *                                     // (artefact_missing)
 *   "receipt_text": "…",              // optional ```receipt-text block
 *   "repair_record": { … },           // what a repair round (`--resume`)
 *                                     // prints, same forms as `record`;
 *                                     // absent: the round hands back nothing
 *   "repair_receipt_text": "…",       // optional, with repair_record
 *   "email_meta": {                   // optional: what the server's MIME
 *     "message_id": "<…>",            // parse would have read off an .eml
 *     "from": "…", "subject": "…",    // (a stub file is JSON, so it has
 *     "date": "<ISO-8601>"            // none). Feeds the pre-spawn
 *   },                                // Message-ID check and the stamp
 *   "phash": "0123456789abcdef",      // optional: stamped on the upload's
 *                                     // document before the neighbour scan,
 *                                     // as an image upload would carry one
 *   "child": { … },                   // optional, as above: the printing
 *                                     // child sleeps (or fails, or times
 *                                     // out) first, on every spawn
 *   "pause_after_record_s": 30        // optional (0..600): wait between the
 *                                     // record's storage (T1) and its apply
 *                                     // (T2), so a check can kill the
 *                                     // server in between
 * }
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { newId } from "../http/uuid.js";
import { runAgentChild } from "../claude.js";
import { bareMessageId, type DecodedEmailHeaders } from "../routes/documents.service.js";
import { CLAUDE_TIMEOUT_MS, type Extractor, type RecordSpawn } from "./extractor.js";

interface StubChild {
  sleep_s?: number;
  exit_code?: number;
  grandchild_s?: number;
  escaped_s?: number;
  ignore_term?: boolean;
  timeout_ms?: number;
}

/**
 * The `escaped_s` helper, run by `node -e` in the child's group: it starts
 * `/bin/sh` in a new session (`detached`, which is setsid) with stdio of
 * its own, and stays its parent until it ends, the way the CLI stays the
 * parent of a running Bash tool command. Fixed text: the file supplies
 * only the integers, as environment variables.
 */
const ESCAPED_HELPER_JS = [
  'const { spawn } = require("node:child_process");',
  'if (process.env.STUB_IGNORE_TERM === "1") process.on("SIGTERM", () => {});',
  'const c = spawn("/bin/sh", ["-c", "if [ \\"$STUB_IGNORE_TERM\\" = 1 ]; then trap \\"\\" TERM; fi; sleep \\"$STUB_ESCAPED_S\\""],',
  '  { detached: true, stdio: "ignore" });',
  'console.log("STUB ESCAPED pid=" + c.pid);',
  'c.on("exit", () => process.exit(0));',
].join("\n");

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

/** Stub files are read whole and JSON-parsed; anything larger is an
 *  ordinary upload. */
const STUB_MAX_BYTES = 16_384;

/** The parsed instruction file, or null when the file is not one (not
 *  JSON, larger than 16 KB, or no `"__stub__": true`). */
async function readStubJson(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const buf = await readFile(absPath);
    if (buf.length > STUB_MAX_BYTES) return null;
    const parsed = JSON.parse(buf.toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { __stub__?: unknown }).__stub__ === true
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
 * starts a background `sleep` (the grandchild) and a process in a session
 * of its own (the escaped one), sleeps, and exits with a chosen status.
 * Only integers from the file reach the script, and they travel as
 * environment variables, never spliced into it.
 */
async function runStubChild(
  c: StubChild,
  sessionId: string,
  opts: { print?: string; timeoutMs?: number } = {},
): Promise<string> {
  const sleepS = boundedInt(c.sleep_s, 0, 3600, 1, "sleep_s");
  const exitCode = boundedInt(c.exit_code, 0, 255, 0, "exit_code");
  const grandchildS = boundedInt(c.grandchild_s, 0, 3600, 0, "grandchild_s");
  const escapedS = boundedInt(c.escaped_s, 0, 3600, 0, "escaped_s");
  const timeoutMs = Math.min(
    boundedInt(c.timeout_ms, 1, CLAUDE_TIMEOUT_MS, CLAUDE_TIMEOUT_MS, "timeout_ms"),
    opts.timeoutMs ?? CLAUDE_TIMEOUT_MS,
  );
  // Record mode: after the sleep the child copies its stdin (the fenced
  // record) to stdout, as the agent's final message ends up there.
  const print = opts.print !== undefined;
  const script = [
    'if [ "$STUB_IGNORE_TERM" = 1 ]; then trap "" TERM; fi',
    'if [ "$STUB_GRANDCHILD_S" -gt 0 ]; then sleep "$STUB_GRANDCHILD_S" & fi',
    'if [ "$STUB_ESCAPED_S" -gt 0 ]; then "$STUB_NODE" -e "$STUB_ESCAPED_JS" & fi',
    'echo "STUB CHILD pid=$$ sleeping $STUB_SLEEP_S s"',
    'sleep "$STUB_SLEEP_S"',
    ...(print ? ["cat"] : []),
    'exit "$STUB_EXIT_CODE"',
  ].join("\n");
  return runAgentChild("/bin/sh", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      STUB_SLEEP_S: String(sleepS),
      STUB_EXIT_CODE: String(exitCode),
      STUB_GRANDCHILD_S: String(grandchildS),
      STUB_ESCAPED_S: String(escapedS),
      STUB_NODE: process.execPath,
      STUB_ESCAPED_JS: ESCAPED_HELPER_JS,
      STUB_IGNORE_TERM: c.ignore_term ? "1" : "0",
    },
    input: opts.print ?? "",
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

// ── Record mode (the server writer) ────────────────────────────────────

/** A record stub, read and checked (see RECORD MODE in the header). */
export interface RecordStub {
  /** Printed by the first spawn: an object as JSON, a string verbatim,
   *  null as no block at all. */
  record: unknown;
  receiptText: string | null;
  /** Printed by a repair round; undefined: the round hands back nothing. */
  repairRecord: unknown;
  repairReceiptText: string | null;
  /** What the server's MIME parse would have read off an email. */
  email: DecodedEmailHeaders | null;
  /** Stamped on the document before the pHash neighbour scan. */
  phash: string | null;
  child: StubChild;
  /** Seconds between T1 and T2 (0 = none). */
  pauseAfterRecordS: number;
}

/** What a stub file asks for: the legacy path, the record path, or
 *  nothing (not a stub). */
export type StubMode = { mode: "legacy" } | { mode: "record"; stub: RecordStub };

const PHASH_RE = /^[0-9a-f]{16}$/;

function optionalText(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`stub-extractor: ${name} must be a string`);
  return v;
}

function stubEmail(v: unknown): DecodedEmailHeaders | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("stub-extractor: email_meta must be an object");
  const m = v as Record<string, unknown>;
  return {
    messageId: bareMessageId(optionalText(m.message_id, "email_meta.message_id")),
    from: optionalText(m.from, "email_meta.from"),
    subject: optionalText(m.subject, "email_meta.subject"),
    date: optionalText(m.date, "email_meta.date"),
  };
}

/**
 * Which path a stub upload takes, read from the file itself: `record`
 * present is the server writer's stub, anything else the legacy one. Null
 * when the file is not a stub. Throws on a record stub whose fields are
 * malformed (the worker errors that ingest).
 */
export async function readStubMode(absPath: string): Promise<StubMode | null> {
  const ins = await readStubJson(absPath);
  if (!ins) return null;
  if (!Object.hasOwn(ins, "record")) return { mode: "legacy" };
  const phash = optionalText(ins.phash, "phash");
  if (phash !== null && !PHASH_RE.test(phash)) throw new Error("stub-extractor: phash must be 16 lower-case hex digits");
  const child = ins.child ?? {};
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error("stub-extractor: child must be an object");
  }
  return {
    mode: "record",
    stub: {
      record: ins.record,
      receiptText: optionalText(ins.receipt_text, "receipt_text"),
      repairRecord: ins.repair_record,
      repairReceiptText: optionalText(ins.repair_receipt_text, "repair_receipt_text"),
      email: stubEmail(ins.email_meta),
      phash,
      child: { sleep_s: 0, ...(child as StubChild) },
      pauseAfterRecordS: boundedInt(ins.pause_after_record_s, 0, 600, 0, "pause_after_record_s"),
    },
  };
}

/** A fence long enough for `body`: one backtick more than its longest run. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The end of the final message a record stub "writes": an optional
 *  receipt-text block, then the record, as the prompt asks the agent to. */
export function stubFinalMessage(record: unknown, receiptText: string | null, label: string): string {
  const out = [`STUB record run (${label}): no model was asked.`];
  if (receiptText !== null) {
    const f = fenceFor(receiptText);
    out.push("", `${f}receipt-text`, receiptText, f);
  }
  if (record !== undefined && record !== null) {
    const body = typeof record === "string" ? record : JSON.stringify(record, null, 1);
    const f = fenceFor(body);
    out.push("", `${f}json`, body, f);
  }
  return out.join("\n") + "\n";
}

/**
 * The `RecordSpawn` of a record stub: each spawn runs the stub's child
 * through the same supervisor as `claude -p`, and the child prints the
 * record (the first spawn) or the repair record (a `--resume`). The
 * prompt is not used; the worker still renders it, so a record stub
 * exercises the record rendering too.
 */
export function recordStubSpawn(stub: RecordStub): RecordSpawn {
  return async (_prompt, session, timeoutMs) => {
    const resume = "resumeSessionId" in session;
    const id = resume ? session.resumeSessionId : session.sessionId;
    const print = resume
      ? stubFinalMessage(stub.repairRecord, stub.repairReceiptText, "repair round")
      : stubFinalMessage(stub.record, stub.receiptText, "first read");
    return runStubChild(stub.child, id, { print, timeoutMs });
  };
}
