/**
 * ledger-query — the one command the Ask agent may run.
 *
 *   node dist/insights/ledger-query.js "SELECT …"
 *
 * Sends the argument to Postgres as a single query string and prints the
 * rows. That is all it does, which is the point: the Ask agent used to be
 * given `psql`, and psql is a shell (`\!`, `\copy … to program`, `\o |cmd`,
 * `-f <file>`). This has no meta-commands, reads no files and writes
 * nowhere but stdout.
 *
 * It connects with whatever `DATABASE_URL` it is handed — in the Ask
 * child that is the `receipts_ro` login (see `AGENT_PROFILES.ask` in
 * `src/claude.ts`). What stops a write is that role's privileges: SELECT
 * and nothing else. As a second check this refuses to run at all on a
 * connection that is not read-only by default, so pointing it at the
 * owner URL by mistake fails loudly instead of quietly working.
 *
 * Exit codes: 0 rows printed · 1 the query failed · 2 usage or connection
 * · 3 the connection is not a read-only role.
 */
import pg from "pg";

/** Enough for an answer, small enough not to flood the model's context. */
const MAX_ROWS = 200;
const MAX_CELL_CHARS = 2000;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = text.replace(/\s*\n\s*/g, " ⏎ ");
  return oneLine.length > MAX_CELL_CHARS
    ? `${oneLine.slice(0, MAX_CELL_CHARS)}… (${oneLine.length} chars)`
    : oneLine;
}

async function main(): Promise<number> {
  const sql = process.argv.slice(2).join(" ").trim();
  if (!sql) {
    console.error('usage: ledger-query "<one SQL statement>"');
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ledger-query: DATABASE_URL is not set");
    return 2;
  }

  const client = new pg.Client({
    connectionString,
    application_name: "ask-ledger-query",
    // Print what Postgres sent. The default parsers turn a DATE into a JS
    // Date in the local zone, which can move it by a day on the way out.
    types: { getTypeParser: () => (raw: string) => raw } as unknown as pg.CustomTypesConfig,
  });
  try {
    await client.connect();
  } catch (err) {
    console.error(`ledger-query: cannot connect: ${(err as Error).message}`);
    return 2;
  }

  try {
    const guard = await client.query<{ ro: string; su: string; who: string }>(
      `SELECT current_setting('default_transaction_read_only') AS ro,
              current_setting('is_superuser') AS su,
              current_user AS who`,
    );
    const { ro, su, who } = guard.rows[0]!;
    if (ro !== "on" || su !== "off") {
      console.error(
        `ledger-query: refusing to run as "${who}" — this connection is not a read-only role`,
      );
      return 3;
    }

    const out = await client.query({ text: sql, rowMode: "array" });
    const results = (Array.isArray(out) ? out : [out]) as pg.QueryArrayResult<unknown[]>[];
    for (const res of results) {
      if (!res.fields || res.fields.length === 0) {
        console.log(res.command ?? "OK");
        continue;
      }
      console.log(res.fields.map((f) => f.name).join(" | "));
      for (const row of res.rows.slice(0, MAX_ROWS)) {
        console.log(row.map(cell).join(" | "));
      }
      console.log(
        res.rows.length > MAX_ROWS
          ? `(first ${MAX_ROWS} of ${res.rows.length} rows — narrow the query or aggregate)`
          : `(${res.rows.length} row${res.rows.length === 1 ? "" : "s"})`,
      );
    }
    return 0;
  } catch (err) {
    const e = err as Error & { hint?: string; position?: string };
    console.error(`ERROR: ${e.message}${e.hint ? `\nHINT: ${e.hint}` : ""}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ledger-query: ${(err as Error).message}`);
    process.exit(2);
  },
);
