/**
 * Database roles for the two `claude -p` agents.
 *
 * The server's own pool keeps connecting as whatever `DATABASE_URL` says
 * (the owner of the schema). That URL is in neither child's environment.
 * What reaches the database on an agent's behalf logs in as:
 *
 *   extraction / re-extract  →  `receipts_agent`  the child's own
 *                               `DATABASE_URL` (see `src/claude.ts`)
 *   Ask                      →  `receipts_ro`     used by the SERVER to run
 *                               the SQL the model writes; the Ask child
 *                               has no tools and no database URL at all
 *                               (see `src/insights/ledger-query.ts`)
 *
 * What each role may do is decided HERE, in `AGENT_GRANTS`, and nowhere
 * else. Migration 0041 creates the roles and applies the list as it stood
 * when it was written; `syncAgentRoles()` re-applies the current list at
 * every boot. So changing what the agent may touch is an edit to this file
 * and a deploy — not a new migration.
 *
 * Privileges are the boundary for whatever arrives through these logins.
 * The prompts still tell the agents what to do, but an instruction is not
 * a control: a receipt email is text written by a stranger and it lands
 * inside the extraction prompt. They are NOT a boundary around the
 * extraction agent as a whole, which has a shell and can reach the owner
 * login by other means: see "What this does not bound" in CLAUDE.md.
 *
 * ── Policy for tables added later ──────────────────────────────────────
 *
 *   receipts_ro     Reads every table in `public`. A new table is readable
 *                   as soon as it exists (default privileges cover tables
 *                   the migration role creates; boot re-grants for all of
 *                   them). It can never be written. A table that must not
 *                   be readable goes in `RO_DENY_TABLES`.
 *
 *   receipts_agent  Gets nothing by default. A new table is invisible to
 *                   the extraction agent until it is listed in
 *                   `AGENT_GRANTS`. Two things keep that from being silent:
 *                   `scripts/check-agent-grants.ts` runs in `npm run build`
 *                   and fails when a statement in the prompt templates is
 *                   not covered by this list, and boot logs every table
 *                   the role cannot touch.
 */
import pg from "pg";

/** Role the extraction and re-extract agents connect as. */
export const AGENT_ROLE = "receipts_agent";
/** Role the Ask agent connects as. */
export const RO_ROLE = "receipts_ro";

export type AgentDbRole = typeof AGENT_ROLE | typeof RO_ROLE;

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/receipts";

/**
 * Where each role's password comes from. The value in the environment
 * wins; the fallback exists so `npx tsx src/server.ts` works on a laptop
 * with no setup. Both compose files pass the variables through, so a
 * deployment overrides the fallback by setting them in `.env`.
 *
 * These passwords separate the roles from each other. They are not what
 * keeps an agent out of the owner connection: the agent already knows its
 * own password, and it never needs the other one.
 */
const ROLE_PASSWORD: Record<AgentDbRole, { env: string; devDefault: string }> = {
  [AGENT_ROLE]: { env: "RECEIPTS_AGENT_DB_PASSWORD", devDefault: "receipts_agent_dev" },
  [RO_ROLE]: { env: "RECEIPTS_RO_DB_PASSWORD", devDefault: "receipts_ro_dev" },
};

export function rolePasswordEnvName(role: AgentDbRole): string {
  return ROLE_PASSWORD[role].env;
}

function rolePassword(role: AgentDbRole): { value: string; isDefault: boolean } {
  const fromEnv = process.env[ROLE_PASSWORD[role].env];
  if (fromEnv && fromEnv.length > 0) return { value: fromEnv, isDefault: false };
  return { value: ROLE_PASSWORD[role].devDefault, isDefault: true };
}

/**
 * The connection string an agent child gets as its `DATABASE_URL`: same
 * host, port and database as the server's, with the role and its password
 * swapped in.
 */
export function roleDatabaseUrl(
  role: AgentDbRole,
  base: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): string {
  const url = new URL(base);
  url.username = role;
  // Percent-encode it ourselves. The URL setter escapes some characters
  // but leaves `%` alone, so a password containing one came out as a
  // string libpq rejects ("invalid percent-encoded token") or, worse,
  // decodes to a different password. encodeURIComponent leaves nothing
  // for the setter to reinterpret.
  url.password = encodeURIComponent(rolePassword(role).value);
  return url.toString();
}

// ── The allowlist ──────────────────────────────────────────────────────

export interface TableGrant {
  /** May INSERT rows. */
  insert?: true;
  /**
   * Columns the role may UPDATE. Column-level on purpose: the agent needs
   * to stamp `transactions.metadata`, and that must not also let it set
   * `deleted_at` or `status` on every row in the ledger. Columns holding a
   * user's decision (`custom_name`, `user_chose_at`, `narration`) are
   * never listed, which is what makes the Layer 3 rule in CLAUDE.md hold
   * at the server instead of in a prompt.
   */
  update?: readonly string[];
}

/**
 * Everything `receipts_agent` may do, derived from the SQL in the prompt
 * templates (`src/ingest/prompt.ts`, `items-sql.ts`, `reextract-prompt.ts`,
 * `brand-icon-prompt.ts`, `brand-icon-pipeline.md`). Every table listed is
 * readable; `insert` and `update` are what the entry adds.
 *
 * There is no DELETE anywhere in the templates, so none is granted. Tables
 * that are not listed cannot be read at all.
 *
 * `scripts/check-agent-grants.ts` parses the rendered prompts and fails
 * the build when they use something this list does not allow.
 */
export const AGENT_GRANTS: Readonly<Record<string, TableGrant>> = {
  // Account ids are resolved inline. INSERT + updated_at exist for one
  // statement: the points-programme account upsert (#206).
  accounts: { insert: true, update: ["updated_at"] },
  brand_assets: {
    insert: true,
    update: [
      "last_seen_at",
      "agent_relevance",
      "agent_notes",
      "extraction_version",
      "retired_at",
      // Not in a template SET list. The procedure says to record
      // dimensions "if you can", and the agent has filled them in with a
      // follow-up UPDATE; one production run corrected `content_type` in
      // the same statement, and refusing a column takes the whole UPDATE
      // (the relevance judgment included) down with it.
      "width",
      "height",
      "content_type",
    ],
  },
  // No `user_chose_at`: the icon a user picked stays picked.
  brands: {
    insert: true,
    update: ["name", "domain", "parent_id", "preferred_asset_id", "metadata", "updated_at"],
  },
  document_links: { insert: true },
  // No `file_path`, `sha256`, `kind` or `deleted_at`.
  documents: {
    update: [
      "source_ingest_id",
      "ocr_text",
      "ocr_model_version",
      "message_id",
      "source_meta",
      "updated_at",
    ],
  },
  ingests: { update: ["status", "classification", "produced", "error", "completed_at"] },
  // `updated_at` is the ON CONFLICT no-op that makes RETURNING id work.
  merchants: { insert: true, update: ["updated_at"] },
  owned_items: { insert: true, update: ["retired_at", "condition", "notes", "updated_at"] },
  place_photos: { insert: true },
  place_snapshots: { insert: true },
  // No `custom_name`, no `metadata`. `lat` / `lng` are not in the
  // template's DO UPDATE list; the agent has included them when refreshing
  // a place from the same Google response, which is harmless.
  places: {
    insert: true,
    update: [
      "last_seen_at",
      "hit_count",
      "raw_response",
      "display_name_en",
      "display_name_zh",
      "display_name_zh_locale",
      "display_name_zh_source",
      "display_name_zh_is_native",
      "primary_type",
      "primary_type_display_zh",
      "maps_type_label_zh",
      "types",
      "formatted_address_en",
      "formatted_address_zh",
      "postal_code",
      "country_code",
      "business_status",
      "business_hours",
      "time_zone",
      "rating",
      "user_rating_count",
      "national_phone_number",
      "website_uri",
      "google_maps_uri",
      "lat",
      "lng",
    ],
  },
  // Insert only. A posting that exists cannot be changed or removed.
  postings: { insert: true },
  // No `custom_name`.
  products: {
    insert: true,
    update: [
      "canonical_name",
      "brand_id",
      "item_class",
      "first_purchased_on",
      "last_purchased_on",
      "purchase_count",
      "total_spent_minor",
      "updated_at",
    ],
  },
  transaction_events: { insert: true },
  // Re-extract retires the previous run; nothing else is ever updated.
  transaction_items: { insert: true, update: ["retired_at"] },
  transaction_parties: { insert: true },
  // The soft Layer 3 fields plus what ingest stamps afterwards. Not
  // `status`, `deleted_at`, `narration`, `trip_id`, `merchant_id`.
  transactions: {
    insert: true,
    update: ["occurred_on", "occurred_at", "payee", "metadata", "place_id", "version", "updated_at"],
  },
};

/** Tables `receipts_ro` must not read. Empty today; a table that holds a
 *  credential belongs here in the same change that creates it. */
export const RO_DENY_TABLES: readonly string[] = [];

/**
 * Per-role session defaults. Guard rails (a runaway query, a forgotten
 * transaction), not part of the boundary: a role can change them for its
 * own session, and Postgres lets any role `ALTER ROLE` itself, which also
 * covers its own password. Such a change lasts until the next boot, when
 * `syncAgentRoles` puts both back. The extraction agent can therefore lock
 * itself out until a restart; the Ask path cannot, because the server runs
 * its SQL inside a read-only transaction (`src/insights/ledger-query.ts`).
 */
export const ROLE_SETTINGS: Readonly<Record<AgentDbRole, Readonly<Record<string, string>>>> = {
  [AGENT_ROLE]: {
    statement_timeout: "120s",
    idle_in_transaction_session_timeout: "300s",
  },
  [RO_ROLE]: {
    default_transaction_read_only: "on",
    statement_timeout: "30s",
    idle_in_transaction_session_timeout: "60s",
  },
};

/**
 * The functions that create a large object. EXECUTE on them is PUBLIC's by
 * default and is revoked: a role with no write privilege on any table
 * could otherwise still write to the database (and fill its disk).
 * `lo_import` is not here because it is superuser-only already.
 */
export const LARGE_OBJECT_CREATORS = [
  "pg_catalog.lo_creat(integer)",
  "pg_catalog.lo_create(oid)",
  "pg_catalog.lo_from_bytea(oid, bytea)",
] as const;

// ── Applying it ────────────────────────────────────────────────────────

/** How long the boot-time sync waits for any one lock before giving up. */
const SYNC_LOCK_TIMEOUT = "10s";
/** SQLSTATE lock_not_available: what `lock_timeout` raises. */
const LOCK_NOT_AVAILABLE = "55P03";

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`agent-roles: refusing identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

type Queryable = Pick<pg.ClientBase, "query">;

async function publicRelations(db: Queryable): Promise<Map<string, Set<string>>> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')`,
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set());
    out.get(r.table_name)!.add(r.column_name);
  }
  return out;
}

export interface AgentRoleSyncReport {
  /** Roles still on the built-in development password. */
  defaultPasswords: AgentDbRole[];
  /** Manifest entries that name a table or column the schema lacks. */
  skipped: string[];
  /** Tables in `public` the extraction role has no access to. */
  agentCannotSee: string[];
}

/**
 * Make the two roles match this file: create them if a restore dropped
 * them (roles live in the cluster, not in a database dump), set their
 * passwords from the environment, drop any membership they were given,
 * then replace their privileges with exactly `AGENT_GRANTS` /
 * SELECT-everything.
 *
 * One transaction, so a running agent never sees a half-applied set.
 * Needs a connection that owns the tables and may alter roles — today
 * that is the server's own, a superuser. Every lock wait is bounded
 * (`SYNC_LOCK_TIMEOUT`); when one runs out this throws
 * `AgentRoleSyncBlockedError` and the roles stay as the previous boot
 * left them.
 */
export async function syncAgentRoles(pool: pg.Pool): Promise<AgentRoleSyncReport> {
  const report: AgentRoleSyncReport = { defaultPasswords: [], skipped: [], agentCannotSee: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Nothing below may wait without end. Two things here can be blocked
    // by a session logged in as one of the agent roles: the advisory lock
    // on the next line (any role may take one, and the key is in a public
    // repository), and ALTER ROLE, which waits behind a role's own
    // uncommitted ALTER ROLE. Postgres does not notice a dead client while
    // a backend sleeps, so such a session can outlive the agent that
    // opened it. This runs in front of `app.listen`: an unbounded wait
    // here was a server that never came up and logged nothing.
    await client.query(`SET LOCAL lock_timeout = '${SYNC_LOCK_TIMEOUT}'`);
    // Two servers booting against one database would otherwise race each
    // other's catalog updates ("tuple concurrently updated").
    await client.query("SELECT pg_advisory_xact_lock(hashtext('receipts.agent_roles'))");

    for (const role of [AGENT_ROLE, RO_ROLE] as const) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${ident(role)}`);
      const pw = rolePassword(role);
      if (pw.isDefault) report.defaultPasswords.push(role);
      // A utility statement takes no bind parameters, so let the server
      // quote the literal instead of doing it by hand.
      const stmt = await client.query<{ sql: string }>(
        `SELECT format(
           'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
           $1::text, $2::text) AS sql`,
        [role, pw.value],
      );
      await client.query(stmt.rows[0]!.sql);
      for (const [name, value] of Object.entries(ROLE_SETTINGS[role])) {
        await client.query(`ALTER ROLE ${ident(role)} SET ${ident(name)} = '${value.replace(/'/g, "''")}'`);
      }
    }

    // A membership is a second way to hold privileges, and NOINHERIT only
    // means it takes a `SET ROLE` to use one. Neither role should be a
    // member of anything.
    const memberships = await client.query<{ sql: string }>(
      `SELECT format('REVOKE %I FROM %I GRANTED BY %I', g.rolname, m.rolname, gr.rolname) AS sql
         FROM pg_auth_members am
         JOIN pg_roles g  ON g.oid  = am.roleid
         JOIN pg_roles m  ON m.oid  = am.member
         JOIN pg_roles gr ON gr.oid = am.grantor
        WHERE m.rolname = ANY($1::text[])`,
      [[AGENT_ROLE, RO_ROLE]],
    );
    for (const row of memberships.rows) await client.query(row.sql);

    const both = `${ident(AGENT_ROLE)}, ${ident(RO_ROLE)}`;
    // Creating a large object needs no table privilege, only EXECUTE on
    // these, which PUBLIC holds by default. Nothing in this application
    // uses large objects; the owner connection is unaffected.
    await client.query(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(", ")} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${both}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${both}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${both}`);
    const onDatabase = await client.query<{ revoke: string; grant: string }>(
      `SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) AS revoke,
              format('GRANT CONNECT ON DATABASE %I TO ${both}', current_database()) AS grant`,
    );
    await client.query(onDatabase.rows[0]!.revoke);
    await client.query(onDatabase.rows[0]!.grant);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${ident(RO_ROLE)}`,
    );

    const relations = await publicRelations(client);

    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ident(RO_ROLE)}`);
    for (const table of RO_DENY_TABLES) {
      if (relations.has(table)) {
        await client.query(`REVOKE ALL ON ${ident(table)} FROM ${ident(RO_ROLE)}`);
      }
    }

    for (const [table, grant] of Object.entries(AGENT_GRANTS)) {
      const columns = relations.get(table);
      if (!columns) {
        report.skipped.push(table);
        continue;
      }
      const tablePrivs = ["SELECT", ...(grant.insert ? ["INSERT"] : [])];
      await client.query(`GRANT ${tablePrivs.join(", ")} ON ${ident(table)} TO ${ident(AGENT_ROLE)}`);
      const updatable = (grant.update ?? []).filter((col) => {
        if (columns.has(col)) return true;
        report.skipped.push(`${table}.${col}`);
        return false;
      });
      if (updatable.length > 0) {
        await client.query(
          `GRANT UPDATE (${updatable.map(ident).join(", ")}) ON ${ident(table)} TO ${ident(AGENT_ROLE)}`,
        );
      }
    }

    await client.query("COMMIT");
    report.agentCannotSee = [...relations.keys()].filter((t) => !(t in AGENT_GRANTS)).sort();
    return report;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      throw new AgentRoleSyncBlockedError(
        `agent role sync gave up after waiting ${SYNC_LOCK_TIMEOUT} for a lock, so the roles keep the ` +
          `passwords and privileges they had`,
      );
    }
    // The failing statement may be the ALTER ROLE that carries a password;
    // pg puts no SQL text in `message`, and nothing else is forwarded.
    throw new Error(`agent role sync failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

/** The sync could not get a lock in time. Another session holds it. */
export class AgentRoleSyncBlockedError extends Error {}

/**
 * End every session logged in as one of the agent roles, and say which.
 *
 * For boot, after the sync was blocked. At that point this server has
 * started no agent yet, so a session under either role belongs to a
 * process that no longer exists: Postgres keeps a backend alive while it
 * sleeps or waits, long after the client that opened it was killed. Such
 * a session is the only thing an agent role can put in the sync's way.
 */
export async function endAgentRoleSessions(db: Queryable): Promise<string[]> {
  // Materialized first: the planner is free to evaluate WHERE conditions
  // in any order, and pg_terminate_backend must only ever see these rows.
  const { rows } = await db.query<{ who: string }>(
    `WITH leftover AS MATERIALIZED (
       SELECT pid, usename, state, backend_start
         FROM pg_stat_activity
        WHERE usename = ANY($1::text[]) AND pid <> pg_backend_pid()
     )
     SELECT format('pid %s (%s, %s, connected %s ago)', pid, usename, state,
                   date_trunc('second', now() - backend_start)) AS who,
            pg_terminate_backend(pid) AS ended
       FROM leftover`,
    [[AGENT_ROLE, RO_ROLE]],
  );
  return rows.map((r) => r.who);
}

/**
 * Log in as each role with the exact URL an agent child is handed.
 *
 * The sync above can succeed while that URL does not work: it sets the
 * password with one piece of code and the URL is built by another. A
 * password containing `%` did exactly that, and the first anyone would
 * have heard of it was every extraction failing at its first psql call.
 * Returns one line per role that cannot log in; empty means both can.
 */
export async function verifyAgentLogins(): Promise<string[]> {
  const problems: string[] = [];
  for (const role of [AGENT_ROLE, RO_ROLE] as const) {
    const client = new pg.Client({
      connectionString: roleDatabaseUrl(role),
      connectionTimeoutMillis: 10_000,
    });
    // A connection that dies between queries emits 'error'; unhandled,
    // that would take the server down from a diagnostic.
    client.on("error", () => {});
    try {
      await client.connect();
      const { rows } = await client.query<{ who: string; su: string }>(
        `SELECT session_user AS who, current_setting('is_superuser') AS su`,
      );
      const { who, su } = rows[0]!;
      if (who !== role || su !== "off") {
        problems.push(`${role}: its URL logs in as ${who} (superuser=${su})`);
      }
    } catch (err) {
      problems.push(`${role}: cannot log in with the URL the agents are given — ${(err as Error).message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
  return problems;
}

// ── Checking it ────────────────────────────────────────────────────────

/**
 * Compare what the two roles can actually do against this file. Returns
 * one line per difference; empty means the database matches.
 *
 * Asks the server (`has_table_privilege` and friends) rather than reading
 * ACL arrays, so a privilege that reaches a role through PUBLIC or through
 * a membership is counted too.
 */
export async function auditAgentRoles(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const relations = await publicRelations(db);

  const attrs = await db.query<{
    rolname: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconfig: string[] | null;
    member_of: string[] | null;
    can_create: boolean;
    can_temp: boolean;
    db_create: boolean;
  }>(
    `SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
            r.rolconfig,
            (SELECT array_agg(g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = r.oid) AS member_of,
            has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create,
            has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS can_temp,
            has_database_privilege(r.oid, current_database(), 'CREATE') AS db_create
       FROM pg_roles r WHERE r.rolname = ANY($1::text[])`,
    [[AGENT_ROLE, RO_ROLE]],
  );
  for (const role of [AGENT_ROLE, RO_ROLE] as const) {
    const a = attrs.rows.find((r) => r.rolname === role);
    if (!a) {
      problems.push(`${role}: role does not exist`);
      continue;
    }
    for (const flag of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"] as const) {
      if (a[flag]) problems.push(`${role}: ${flag} is set`);
    }
    if (a.member_of?.length) problems.push(`${role}: member of ${a.member_of.join(", ")}`);
    if (a.can_create) problems.push(`${role}: may CREATE in schema public`);
    if (a.can_temp) problems.push(`${role}: may create temporary tables`);
    if (a.db_create) problems.push(`${role}: may CREATE schemas in this database`);
    for (const [name, value] of Object.entries(ROLE_SETTINGS[role])) {
      if (!a.rolconfig?.includes(`${name}=${value}`)) {
        problems.push(`${role}: setting ${name}=${value} is not in effect`);
      }
    }
  }
  if (problems.some((p) => p.endsWith("role does not exist"))) return problems;

  const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
  const tablePrivs = await db.query<{ role: string; relname: string; priv: string; held: boolean }>(
    `SELECT r.rolname AS role, c.relname, p.priv, has_table_privilege(r.oid, c.oid, p.priv) AS held
       FROM pg_roles r
       CROSS JOIN pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($2::text[]) AS p(priv)
      WHERE r.rolname = ANY($1::text[])
        AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')`,
    [[AGENT_ROLE, RO_ROLE], [...TABLE_PRIVS]],
  );
  for (const row of tablePrivs.rows) {
    let expected: boolean;
    if (row.role === RO_ROLE) {
      expected = row.priv === "SELECT" && !RO_DENY_TABLES.includes(row.relname);
    } else {
      const grant = AGENT_GRANTS[row.relname];
      expected = !!grant && (row.priv === "SELECT" || (row.priv === "INSERT" && !!grant.insert));
    }
    if (row.held !== expected) {
      problems.push(`${row.role}: ${row.held ? "has" : "lacks"} ${row.priv} on ${row.relname}`);
    }
  }

  const colPrivs = await db.query<{ role: string; relname: string; attname: string; priv: string; held: boolean }>(
    `SELECT r.rolname AS role, c.relname, a.attname, p.priv,
            has_column_privilege(r.oid, c.oid, a.attnum, p.priv) AS held
       FROM pg_roles r
       CROSS JOIN pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest(ARRAY['UPDATE', 'INSERT']) AS p(priv)
      WHERE r.rolname = ANY($1::text[])
        AND n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')`,
    [[AGENT_ROLE, RO_ROLE]],
  );
  for (const row of colPrivs.rows) {
    let expected = false;
    if (row.role === AGENT_ROLE) {
      const grant = AGENT_GRANTS[row.relname];
      expected =
        row.priv === "INSERT" ? !!grant?.insert : !!grant?.update?.includes(row.attname);
    }
    if (row.held !== expected) {
      problems.push(
        `${row.role}: ${row.held ? "has" : "lacks"} ${row.priv} on ${row.relname}.${row.attname}`,
      );
    }
  }

  for (const [table, grant] of Object.entries(AGENT_GRANTS)) {
    const columns = relations.get(table);
    if (!columns) {
      problems.push(`AGENT_GRANTS lists ${table}, which is not a table in public`);
      continue;
    }
    for (const col of grant.update ?? []) {
      if (!columns.has(col)) problems.push(`AGENT_GRANTS lists ${table}.${col}, which does not exist`);
    }
  }

  const other = await db.query<{ role: string; what: string }>(
    `SELECT r.rolname AS role, 'USAGE on schema ' || n.nspname AS what
       FROM pg_roles r CROSS JOIN pg_namespace n
      WHERE r.rolname = ANY($1::text[])
        AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND has_schema_privilege(r.oid, n.oid, 'USAGE')
     UNION ALL
     SELECT r.rolname, 'EXECUTE on ' || p.oid::regprocedure::text
       FROM pg_roles r CROSS JOIN pg_proc p
      WHERE r.rolname = ANY($1::text[])
        AND p.pronamespace = 'pg_catalog'::regnamespace
        AND p.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'lo_import', 'lo_export',
                          'lo_creat', 'lo_create', 'lo_from_bytea')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
    [[AGENT_ROLE, RO_ROLE]],
  );
  for (const row of other.rows) problems.push(`${row.role}: has ${row.what}`);

  return problems.sort();
}
