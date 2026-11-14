#!/usr/bin/env tsx
/**
 * check-agent-grants.ts — the extraction agent's database allowlist must
 * cover exactly what its prompts tell it to do.
 *
 * WHY THIS EXISTS
 *
 * The extraction agent connects as `receipts_agent`, which may touch only
 * what `AGENT_GRANTS` (`src/db/agent-roles.ts`) lists. The agent's
 * instructions are SQL templates inside prose. If someone adds a
 * statement to a template and forgets the grant, the agent meets
 * "permission denied" in production — and on an enrichment branch the
 * prompt tells it to shrug errors off and move on, so the feature would
 * simply stop happening with nothing failing anywhere.
 *
 * This runs in `npm run build` (prebuild) so that mistake stops the build
 * instead. No database, no network: it renders the prompts and reads them.
 *
 * WHAT IT CHECKS
 *
 *   1. Every INSERT / UPDATE-column / table read in the rendered ingest
 *      prompt, the re-extract prompt and `brand-icon-pipeline.md` is
 *      allowed by AGENT_GRANTS.
 *   2. No template uses DELETE, TRUNCATE or DDL.
 *   3. Every grant in AGENT_GRANTS is used by a template, or is listed in
 *      `NOT_IN_A_TEMPLATE` below with the reason it exists. A grant nobody
 *      can explain is a grant that should go.
 *   4. Every table and column AGENT_GRANTS names exists in `src/schema`.
 *   5. Every table and column in the Ask prompt's schema digest exists in
 *      `src/schema`, and every view it names is created by a migration.
 *   6. The record rendering of the ingest prompt (wave 1, `writer:
 *      'server_apply'`), whose agent has no database at all, contains no SQL
 *      and nothing that reaches for a database or a tool it was not given:
 *      no statement the reader above can find, no uppercase INSERT, UPDATE,
 *      DELETE, CREATE, ALTER or DROP, and no `psql`, `DATABASE_URL`,
 *      `WebSearch`, logo.dev key or Google place-record endpoint. Rendered
 *      with decoded email text and an attachment so every branch of it is
 *      read. It is not part of the grant tables: nothing it says may need
 *      a grant.
 *
 * It is a reader of prose, not a SQL parser. It errs toward seeing a
 * statement where there is only a mention; if it ever trips on a sentence,
 * reword the sentence or teach it here.
 *
 *   npm run check:agent-grants            check (exit 1 on a violation)
 *   npm run check:agent-grants -- --list  also print the derived table
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "../src/schema/index.js";
import { AGENT_GRANTS } from "../src/db/agent-roles.js";
import { ASK_SCHEMA_DIGEST } from "../src/insights/ask.js";
import { buildExtractorPrompt } from "../src/ingest/prompt.js";
import { buildReExtractPrompt } from "../src/ingest/reextract-prompt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Grants no template statement accounts for. Each needs a reason; an
 * entry that stops being true should be deleted along with its grant.
 */
const NOT_IN_A_TEMPLATE: Record<string, string> = {
  "brands.parent_id":
    "4a-ter tells the agent in prose to upsert a seller's brand row and \"set parent_id\"; there is no SQL template for it.",
  "brand_assets.width":
    "The icon procedure says to record dimensions \"if you can\"; the agent has done it as a follow-up UPDATE.",
  "brand_assets.height": "As width.",
  "brand_assets.content_type":
    "As width: one production run corrected it in the same UPDATE as its relevance judgment, and a refused column fails the whole statement.",
  "places.lat":
    "Not in the template's DO UPDATE list; the agent has added it when refreshing a place from the same Google response.",
  "places.lng": "As lat.",
};

// ── Schema, from the drizzle definitions ───────────────────────────────

const TABLES = new Map<string, Set<string>>();
for (const value of Object.values(schema)) {
  if (is(value, PgTable)) {
    const cfg = getTableConfig(value);
    TABLES.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
}

/**
 * Views exist only in migration SQL, not in the drizzle schema. A template
 * that reads one needs a grant like any table, so they have to be known
 * here or `FROM some_view` would pass as prose.
 */
const VIEWS = new Set<string>();
{
  const dir = path.join(HERE, "..", "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const m of sql.matchAll(
      /\b(CREATE(?:\s+OR\s+REPLACE)?(?:\s+MATERIALIZED)?|DROP(?:\s+MATERIALIZED)?)\s+VIEW\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) {
      if (/^DROP/i.test(m[1]!)) VIEWS.delete(m[2]!);
      else VIEWS.add(m[2]!);
    }
  }
}

/** A table or a view: anything a statement can name after FROM. */
function isRelation(name: string): boolean {
  return TABLES.has(name) || VIEWS.has(name);
}

/**
 * How a table name may be written: bare, quoted, or schema-qualified. The
 * keywords around it are matched in any case — the templates happen to be
 * uppercase today, and a lowercase `update transactions set status …`
 * added later must not walk past this check.
 *
 * Case-insensitive matching also reads prose ("update the row and set
 * …"). So a lowercase statement only counts when it names a real table;
 * an uppercase one that names something unknown is still reported, as
 * before.
 */
const NAME = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`;
const isUpper = (keyword: string) => keyword === keyword.toUpperCase();

// ── What the templates use ─────────────────────────────────────────────

interface Usage {
  select: boolean;
  insert: boolean;
  update: Set<string>;
}
const used = new Map<string, Usage>();
const violations: string[] = [];
let recordPromptClean = false;

function usage(table: string): Usage {
  let u = used.get(table);
  if (!u) {
    u = { select: false, insert: false, update: new Set() };
    used.set(table, u);
  }
  return u;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Where a SET list ends: the first WHERE / FROM / RETURNING / `;` that is
 *  not inside parentheses (a subquery has its own FROM). */
function setListEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth <= 0 && (ch === ";" || /^(?:WHERE|FROM|RETURNING)\b/i.test(text.slice(i, i + 10)))) {
      if (ch === ";" || !/[A-Za-z0-9_]/.test(text[i - 1] ?? " ")) return i;
    }
  }
  return text.length;
}

/** Column names assigned in a SET list (text after `SET`). */
function setColumns(afterSet: string): string[] {
  const clause = afterSet.slice(0, setListEnd(afterSet));
  const cols: string[] = [];
  for (const part of splitTopLevel(clause)) {
    const m = /^[\s<]*(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?\s*=(?!=)/i.exec(part);
    if (m) cols.push(m[1]!.toLowerCase());
  }
  return cols;
}

function scan(source: string, text: string): void {
  // Same-line string literals and dollar-quoted payloads are data, and a
  // comma or `=` inside one would derail the SET-list reader. Same-line
  // only: the prose mentions a lone `$items$`, and pairing that with the
  // next one would swallow the SQL in between.
  const sql = text
    .replace(/\$([a-z_]*)\$[^\n$]*\$\1\$/g, "''")
    .replace(/'[^'\n]*'/g, "''");

  for (const m of sql.matchAll(new RegExp(String.raw`\b(INSERT\s+INTO)\s+${NAME}`, "gi"))) {
    const table = m[2]!.toLowerCase();
    if (!TABLES.has(table)) {
      if (isUpper(m[1]!)) violations.push(`${source}: INSERT INTO ${table} — not a table in src/schema`);
      continue;
    }
    usage(table).insert = true;
    // An upsert's DO UPDATE belongs to this INSERT: look ahead to the end
    // of the statement.
    const rest = sql.slice(m.index! + m[0].length);
    const stmtEnd = rest.search(/;|\bINSERT\s+INTO\b/i);
    const stmt = stmtEnd === -1 ? rest : rest.slice(0, stmtEnd);
    const upsert = /\bDO\s+UPDATE\s+SET\b/i.exec(stmt);
    if (upsert) {
      for (const col of setColumns(stmt.slice(upsert.index + upsert[0].length))) {
        usage(table).update.add(col);
      }
    }
  }

  for (const m of sql.matchAll(
    new RegExp(String.raw`\b(UPDATE)\s+(?:ONLY\s+)?${NAME}(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s+SET\b`, "gi"),
  )) {
    const table = m[2]!.toLowerCase();
    if (/\bDO\s*$/i.test(sql.slice(Math.max(0, m.index! - 8), m.index!))) continue;
    if (!TABLES.has(table)) {
      if (isUpper(m[1]!)) violations.push(`${source}: UPDATE ${table} — not a table in src/schema`);
      continue;
    }
    const cols = setColumns(sql.slice(m.index! + m[0].length));
    if (cols.length === 0) {
      violations.push(`${source}: UPDATE ${table} — could not read the SET list`);
    }
    for (const col of cols) usage(table).update.add(col);
  }

  for (const m of sql.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN)\s+${NAME}`, "gi"))) {
    // CTE names and prose ("FROM the receipt") are simply not relations.
    const name = m[1]!.toLowerCase();
    if (isRelation(name)) usage(name).select = true;
  }

  for (const m of sql.matchAll(new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${NAME}`, "gi"))) {
    const name = m[1]!.toLowerCase();
    if (isRelation(name)) violations.push(`${source}: DELETE FROM ${name} — the agent role has no DELETE`);
  }
  for (const m of sql.matchAll(
    new RegExp(
      String.raw`\b(TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${NAME}`,
      "gi",
    ),
  )) {
    // Lowercase and naming nothing real is prose ("…create table rows…").
    // CREATE TABLE never names an existing table, so it is always SQL.
    if (isUpper(m[1]!) || isRelation(m[2]!.toLowerCase()) || /^create/i.test(m[1]!)) {
      violations.push(`${source}: ${m[1]!.toUpperCase().replace(/\s+/g, " ")} ${m[2]} — the agent role has no DDL`);
    }
  }
}

/**
 * Scan a text twice: once with `--` comments removed, once with only the
 * comment markers removed. The points-account upsert is taught as a
 * commented-out block the agent is told to swap in, so comment text can
 * be a real statement; but a SET list with a prose comment in the middle
 * only reads cleanly with the prose gone. The union sees both.
 */
function scanBothWays(source: string, text: string): void {
  scan(source, text.replace(/--[^\n]*/g, ""));
  scan(source, text.replace(/^(\s*)--\s?/gm, "$1"));
}

const ctx = {
  writer: "agent_sql" as const,
  filePath: "/data/uploads/x.pdf",
  ingestId: "00000000-0000-7000-8000-0000000000a1",
  workspaceId: "00000000-0000-7000-8000-0000000000a2",
  documentId: "00000000-0000-7000-8000-0000000000a3",
  userId: "00000000-0000-7000-8000-0000000000a4",
  transactionId: "00000000-0000-7000-8000-0000000000a5",
};
scanBothWays("ingest prompt", buildExtractorPrompt({ ...ctx, phashNeighbors: [] }));
scanBothWays("re-extract prompt", buildReExtractPrompt(ctx));
scanBothWays(
  "brand-icon-pipeline.md",
  readFileSync(path.join(HERE, "..", "src", "ingest", "brand-icon-pipeline.md"), "utf8"),
);

// ── 1. templates ⊆ grants ──────────────────────────────────────────────

for (const [table, u] of used) {
  const grant = AGENT_GRANTS[table];
  if (!grant) {
    violations.push(
      VIEWS.has(table)
        ? `templates read the view ${table}; receipts_agent has no grant on it (AGENT_GRANTS lists tables only). ` +
            `Read the table underneath it, or extend src/db/agent-roles.ts to grant on views`
        : `templates use ${table}, which AGENT_GRANTS does not list`,
    );
    continue;
  }
  if (u.insert && !grant.insert) violations.push(`templates INSERT INTO ${table}; AGENT_GRANTS has no insert for it`);
  for (const col of u.update) {
    if (!TABLES.get(table)!.has(col)) {
      violations.push(`templates UPDATE ${table}.${col}, which is not a column in src/schema`);
    } else if (!grant.update?.includes(col)) {
      violations.push(`templates UPDATE ${table}.${col}; AGENT_GRANTS does not allow that column`);
    }
  }
}

// ── 3. grants ⊆ templates (or explained) ───────────────────────────────

const unexplained = new Set(Object.keys(NOT_IN_A_TEMPLATE));
for (const [table, grant] of Object.entries(AGENT_GRANTS)) {
  const u = used.get(table);
  if (!u) {
    violations.push(`AGENT_GRANTS lists ${table}, which no template touches`);
    continue;
  }
  if (grant.insert && !u.insert) violations.push(`AGENT_GRANTS allows INSERT INTO ${table}; no template does that`);
  for (const col of grant.update ?? []) {
    const key = `${table}.${col}`;
    if (u.update.has(col)) continue;
    if (key in NOT_IN_A_TEMPLATE) unexplained.delete(key);
    else violations.push(`AGENT_GRANTS allows UPDATE ${key}; no template sets it and NOT_IN_A_TEMPLATE has no reason for it`);
  }
}
for (const key of unexplained) {
  violations.push(`NOT_IN_A_TEMPLATE explains ${key}, which is not (or no longer) an unexplained grant — delete the entry`);
}

// ── 4. grants name real things ─────────────────────────────────────────

for (const [table, grant] of Object.entries(AGENT_GRANTS)) {
  const cols = TABLES.get(table);
  if (!cols) {
    violations.push(`AGENT_GRANTS lists ${table}, which is not a table in src/schema`);
    continue;
  }
  for (const col of grant.update ?? []) {
    if (!cols.has(col)) violations.push(`AGENT_GRANTS lists ${table}.${col}, which is not a column in src/schema`);
  }
}

// ── 5. the Ask digest names real things ────────────────────────────────
//
// The Ask model has no tools: a name that is wrong here is a query that
// fails, and a turn spent, on every question that touches it.

const digestTables = new Set(ASK_SCHEMA_DIGEST.filter((t) => t.viewOf === undefined).map((t) => t.table));
for (const entry of ASK_SCHEMA_DIGEST) {
  if (entry.viewOf !== undefined) {
    // A view has no drizzle definition to read columns from. What can be
    // checked without a database: a migration creates it, and the table
    // whose columns the digest says it has is itself in the digest.
    // `check-agent-sandbox` selects those columns through the view on a
    // real database.
    if (!VIEWS.has(entry.table)) {
      violations.push(`Ask schema digest lists the view ${entry.table}, which no migration in drizzle/ creates`);
    }
    if (!digestTables.has(entry.viewOf)) {
      violations.push(
        `Ask schema digest says ${entry.table} has the columns of ${entry.viewOf}, which the digest does not list`,
      );
    }
    if (entry.columns.length > 0) {
      violations.push(
        `Ask schema digest gives the view ${entry.table} columns of its own; it is printed with the columns of ${entry.viewOf}`,
      );
    }
    continue;
  }
  const cols = TABLES.get(entry.table);
  if (!cols) {
    violations.push(`Ask schema digest lists ${entry.table}, which is not a table in src/schema`);
    continue;
  }
  for (const c of entry.columns) {
    const name = typeof c === "string" ? c : c[0];
    if (!cols.has(name)) violations.push(`Ask schema digest lists ${entry.table}.${name}, which does not exist`);
  }
}

// ── 6. the record rendering has no SQL ─────────────────────────────────
//
// Its agent runs with no DATABASE_URL (the `extraction_record` profile), so
// a statement or a psql call in its prompt is not a grant problem but a
// prompt that contradicts its own profile: an instruction the agent cannot
// carry out, and the first thing a turned agent would go looking around for.

{
  const recordPrompt = buildExtractorPrompt({
    ...ctx,
    writer: "server_apply",
    filePath: "/data/uploads/x.eml",
    phashNeighbors: [],
    sourceText: "From: Example <orders@example.com>\nSubject: Receipt\n\nWidget 1 $1.00\nTotal $1.00",
    attachments: [{ path: "/tmp/x/attachment-1.pdf", filename: "invoice.pdf", bytes: 1 }],
  });
  const before = violations.length;
  const saved = new Map(used);
  used.clear();
  scanBothWays("record prompt", recordPrompt);
  for (const [table, u] of used) {
    if (u.insert || u.update.size > 0) {
      violations.push(`record prompt: writes ${table} — the record rendering's agent has no database`);
    }
  }
  used.clear();
  for (const [k, v] of saved) used.set(k, v);
  // A FROM or JOIN naming a table is a read the agent cannot run either,
  // but prose ("from the receipt") reads the same; the forbidden words
  // below catch any real statement first.
  const forbidden: Array<[RegExp, string]> = [
    [/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/, "an uppercase SQL write or DDL keyword"],
    [/\bpsql\b/i, "psql"],
    [/DATABASE_URL/, "DATABASE_URL"],
    [/\bWebSearch\b/i, "WebSearch"],
    [/LOGODEV/i, "the logo.dev key"],
    [/places\.googleapis\.com/i, "the Google place-record endpoint (the server fetches places)"],
  ];
  for (const [re, what] of forbidden) {
    const m = re.exec(recordPrompt);
    if (m) {
      const line = recordPrompt.slice(0, m.index).split("\n").length;
      const text = recordPrompt.split("\n")[line - 1]!.trim().slice(0, 100);
      violations.push(`record prompt, line ${line}: ${what} ("${text}")`);
    }
  }
  if (violations.length === before) recordPromptClean = true;
}

// ── Report ─────────────────────────────────────────────────────────────

if (process.argv.includes("--list")) {
  console.log("What the prompt templates do, by table:\n");
  for (const table of [...used.keys()].sort()) {
    const u = used.get(table)!;
    const verbs = ["SELECT", ...(u.insert ? ["INSERT"] : [])].join(", ");
    console.log(`  ${table.padEnd(22)} ${verbs}`);
    if (u.update.size > 0) console.log(`  ${"".padEnd(22)} UPDATE (${[...u.update].sort().join(", ")})`);
  }
  const untouched = [...TABLES.keys()].filter((t) => !used.has(t)).sort();
  console.log(`\nNever touched by a template: ${untouched.join(", ")}\n`);
}

if (violations.length > 0) {
  console.error(`check-agent-grants: ${violations.length} problem(s)\n`);
  for (const v of [...new Set(violations)]) console.error(`  ✗ ${v}`);
  console.error(
    "\nThe extraction agent's database rights (src/db/agent-roles.ts) and its prompts disagree.\n" +
      "Change whichever one is wrong; they ship together.",
  );
  process.exit(1);
}
console.log(
  `check-agent-grants: OK — ${used.size} tables used by the templates, all covered by AGENT_GRANTS; ` +
    `the Ask digest's ${ASK_SCHEMA_DIGEST.length} relations and their columns exist; ` +
    `the record prompt has no SQL${recordPromptClean ? "" : " (NOT CHECKED)"}.`,
);
