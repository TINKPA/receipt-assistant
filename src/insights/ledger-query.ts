/**
 * ledger-query — how a query written by the Ask model reaches Postgres.
 *
 * The SERVER runs it; the model never does. The Ask child has no tools at
 * all (`AGENT_PROFILES.ask` in `src/claude.ts`), so the only thing a
 * question can make happen is a string arriving here.
 *
 * An earlier version of this file was a command the model ran through
 * Bash, allowlisted by name. On the pinned CLI (2.1.251) that allowlist
 * was not a boundary: the CLI lets its built-in "read-only" commands
 * (`id`, `cat`, `tac`, `du`, …) through in every permission mode, before
 * consulting any allow rule. A question could have read the mounted
 * credentials file and every transcript. Hence no shell.
 *
 * What bounds a query, outermost first:
 *
 *   1. It logs in as `receipts_ro`: SELECT on the tables in `public` and
 *      nothing else (`src/db/agent-roles.ts`). This is the boundary.
 *   2. The server opens `BEGIN TRANSACTION READ ONLY` and runs a query of
 *      its own before the model's text is sent, after which Postgres will
 *      not let the transaction be switched to read-write. That refuses
 *      what privileges alone do not: a role changing its own password or
 *      defaults (`ALTER ROLE` on itself needs no privilege) and creating
 *      large objects.
 *   3. The text is sent as ONE statement over the extended protocol,
 *      which rejects a second statement, as the body of
 *      `DECLARE … CURSOR FOR SELECT … FROM (<text>) q`. Only a query
 *      parses there: no UPDATE, no DO block, no SET, no COPY.
 *   4. Rows come back as one JSON text per row, cut to `MAX_ROW_CHARS` by
 *      Postgres, and only `MAX_ROWS + 1` are fetched, so no result can
 *      exhaust this process's memory however the query is written.
 *   5. A statement timeout the server sets, and a deadline on this side
 *      that ends the backend if the timeout somehow does not fire.
 *   6. One connection per query, closed afterwards: a session-level lock
 *      or setting the query managed to take does not outlive it.
 */
import pg from "pg";
import { RO_ROLE, roleDatabaseUrl } from "../db/agent-roles.js";

/** Enough for an answer, small enough not to flood the model's context. */
export const MAX_ROWS = 200;
/** Per row, as JSON text. Applied by Postgres before the row is sent. */
export const MAX_ROW_CHARS = 4000;
/** Per result. Rows past this are dropped with a note. */
export const MAX_RESULT_CHARS = 24_000;
/** Matches the role's own default (`ROLE_SETTINGS` in agent-roles.ts). */
const STATEMENT_TIMEOUT_MS = 30_000;
/** How long after the statement timeout this side stops waiting. */
const DEADLINE_GRACE_MS = 10_000;

export type LedgerQueryFailure =
  /** Postgres refused or could not run the query. The model can fix this. */
  | "query"
  /** Could not log in as the read-only role. Nothing the model can fix. */
  | "connect"
  /** The connection is not the read-only role. Nothing the model can fix. */
  | "not_read_only"
  /** Neither the statement timeout nor the query returned in time. */
  | "deadline";

export interface LedgerQueryResult {
  ok: boolean;
  /** What the model is shown: the rows and a count line, or `ERROR: …`. */
  text: string;
  /** Rows shown (0 on failure). */
  rowCount: number;
  failure?: LedgerQueryFailure;
}

export interface LedgerQueryOptions {
  /** Defaults to the `receipts_ro` login. The sandbox check passes the
   *  owner URL here to prove the guard refuses it. */
  connectionString?: string;
  /** Lowered by the Ask loop when its own time budget is nearly spent. */
  statementTimeoutMs?: number;
  /** When this side stops waiting and ends the backend. Defaults to the
   *  statement timeout plus a grace period; the sandbox check shortens it
   *  to exercise that path. */
  deadlineMs?: number;
}

function fail(failure: LedgerQueryFailure, message: string): LedgerQueryResult {
  return { ok: false, text: `ERROR: ${message}`, rowCount: 0, failure };
}

/**
 * Run one query from the Ask model and return what to show it.
 *
 * Never throws: every outcome, including "could not connect", is a result
 * the caller can act on.
 */
export async function runLedgerQuery(
  rawSql: string,
  opts: LedgerQueryOptions = {},
): Promise<LedgerQueryResult> {
  // A trailing semicolon is habit, not a second statement.
  const sql = rawSql.trim().replace(/(?:\s*;)+\s*$/, "");
  if (!sql) return fail("query", "empty query");

  // Never 0: to Postgres that means "no timeout".
  const statementTimeoutMs = Math.max(1000, Math.floor(opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS));
  const client = new pg.Client({
    connectionString: opts.connectionString ?? roleDatabaseUrl(RO_ROLE),
    application_name: "ask-ledger-query",
    connectionTimeoutMillis: 10_000,
  });
  // A backend this function terminates makes the client emit 'error';
  // unhandled, that is an uncaught exception in the server.
  client.on("error", () => {});

  try {
    await client.connect();
  } catch (err) {
    return fail("connect", `cannot connect as ${RO_ROLE}: ${(err as Error).message}`);
  }

  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    void endBackend(client);
  }, opts.deadlineMs ?? statementTimeoutMs + DEADLINE_GRACE_MS);

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    // Doubles as the first query of the transaction: from here on Postgres
    // refuses `SET TRANSACTION READ WRITE` and its set_config equivalent.
    const guard = await client.query<{ who: string; su: string; ro: string }>(
      `SELECT session_user AS who,
              current_setting('is_superuser') AS su,
              current_setting('transaction_read_only') AS ro`,
    );
    const { who, su, ro } = guard.rows[0]!;
    if (who !== RO_ROLE || su !== "off" || ro !== "on") {
      return fail(
        "not_read_only",
        `refusing to run as "${who}": Ask queries only run as ${RO_ROLE}, in a read-only transaction`,
      );
    }
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);

    // `name` is what makes node-pg prepare this (the extended protocol),
    // and a prepared statement is one statement: a second one after a
    // semicolon is rejected by Postgres at parse time. Do not drop it.
    // The newlines keep a trailing `-- comment` in the model's text from
    // swallowing the closing parenthesis.
    await client.query({
      name: "ask_declare",
      text:
        `DECLARE ask_q NO SCROLL CURSOR FOR\n` +
        `SELECT left(row_to_json(q)::text, ${MAX_ROW_CHARS}) FROM (\n${sql}\n) q`,
    });
    const fetched = await client.query<[string | null]>({
      text: `FETCH FORWARD ${MAX_ROWS + 1} FROM ask_q`,
      rowMode: "array",
    });

    const lines: string[] = [];
    let chars = 0;
    for (const [json] of fetched.rows.slice(0, MAX_ROWS)) {
      const line = json ?? "null";
      if (chars + line.length > MAX_RESULT_CHARS && lines.length > 0) break;
      lines.push(line.length >= MAX_ROW_CHARS ? `${line}… (row cut at ${MAX_ROW_CHARS} chars)` : line);
      chars += line.length;
    }
    const more = fetched.rows.length > lines.length;
    lines.push(
      more
        ? `(first ${lines.length} rows only; there are more — aggregate in SQL or narrow the query)`
        : `(${lines.length} row${lines.length === 1 ? "" : "s"})`,
    );
    return { ok: true, text: lines.join("\n"), rowCount: lines.length - 1 };
  } catch (err) {
    if (deadlineHit) return fail("deadline", "the query did not finish in time and was ended");
    const e = err as Error & { code?: string; hint?: string };
    // 42601 from the wrapper is what anything other than one SELECT gets.
    const note =
      e.code === "42601"
        ? "\nNOTE: send exactly one SELECT (or WITH … SELECT) per block, with no semicolon inside it; nothing else can run here."
        : "";
    return fail("query", `${e.message}${e.hint ? `\nHINT: ${e.hint}` : ""}${note}`);
  } finally {
    clearTimeout(deadline);
    if (!deadlineHit) {
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    }
  }
}

/**
 * Last resort for a query that outlived its statement timeout. Drop the
 * socket first, which is what unblocks the caller; then end the backend
 * from the owner connection, because Postgres does not notice a client
 * has gone while the backend is busy.
 */
async function endBackend(client: pg.Client): Promise<void> {
  const internals = client as unknown as {
    processID?: number | null;
    connection?: { stream?: { destroy(): void } };
  };
  const pid = internals.processID;
  internals.connection?.stream?.destroy();
  if (!pid) return;
  try {
    // Imported here, not at the top: this module is also loaded by a
    // build-time check that must not need a database.
    const { pool } = await import("../db/client.js");
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE pid = $1 AND usename = $2 AND application_name = 'ask-ledger-query'`,
      [pid, RO_ROLE],
    );
  } catch {
    // Best effort: the role's own statement timeout still applies.
  }
}
