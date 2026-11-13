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
 *   5. Every table and column in the Ask prompt's schema digest exists.
 *
 * It is a reader of prose, not a SQL parser. It errs toward seeing a
 * statement where there is only a mention; if it ever trips on a sentence,
 * reword the sentence or teach it here.
 *
 *   npm run check:agent-grants            check (exit 1 on a violation)
 *   npm run check:agent-grants -- --list  also print the derived table
 */
import { readFileSync } from "node:fs";
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

// ── What the templates use ─────────────────────────────────────────────

interface Usage {
  select: boolean;
  insert: boolean;
  update: Set<string>;
}
const used = new Map<string, Usage>();
const violations: string[] = [];

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
    else if (depth <= 0 && (ch === ";" || /^(?:WHERE|FROM|RETURNING)\b/.test(text.slice(i, i + 10)))) {
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
    const m = /^[\s<]*(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?\s*=(?!=)/.exec(part);
    if (m) cols.push(m[1]!);
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

  for (const m of sql.matchAll(/\bINSERT INTO\s+"?([a-z_][a-z0-9_]*)"?/g)) {
    const table = m[1]!;
    if (!TABLES.has(table)) {
      violations.push(`${source}: INSERT INTO ${table} — not a table in src/schema`);
      continue;
    }
    usage(table).insert = true;
    // An upsert's DO UPDATE belongs to this INSERT: look ahead to the end
    // of the statement.
    const rest = sql.slice(m.index! + m[0].length);
    const stmtEnd = rest.search(/;|\bINSERT INTO\b/);
    const stmt = stmtEnd === -1 ? rest : rest.slice(0, stmtEnd);
    const upsert = /\bDO UPDATE\s+SET\b/.exec(stmt);
    if (upsert) {
      for (const col of setColumns(stmt.slice(upsert.index + upsert[0].length))) {
        usage(table).update.add(col);
      }
    }
  }

  for (const m of sql.matchAll(
    /\bUPDATE\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s+SET\b/g,
  )) {
    const table = m[1]!;
    if (/\bDO\s*$/.test(sql.slice(Math.max(0, m.index! - 8), m.index!))) continue;
    if (!TABLES.has(table)) {
      violations.push(`${source}: UPDATE ${table} — not a table in src/schema`);
      continue;
    }
    const cols = setColumns(sql.slice(m.index! + m[0].length));
    if (cols.length === 0) {
      violations.push(`${source}: UPDATE ${table} — could not read the SET list`);
    }
    for (const col of cols) usage(table).update.add(col);
  }

  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_][a-z0-9_]*)"?/g)) {
    // CTE names and prose ("FROM the receipt") are simply not tables.
    if (TABLES.has(m[1]!)) usage(m[1]!).select = true;
  }

  for (const m of sql.matchAll(/\bDELETE FROM\s+"?([a-z_][a-z0-9_]*)"?/g)) {
    if (TABLES.has(m[1]!)) violations.push(`${source}: DELETE FROM ${m[1]} — the agent role has no DELETE`);
  }
  for (const m of sql.matchAll(
    /\b(TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE)\s+"?([a-z_][a-z0-9_]*)"?/g,
  )) {
    violations.push(`${source}: ${m[1]} ${m[2]} — the agent role has no DDL`);
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
    violations.push(`templates use ${table}, which AGENT_GRANTS does not list`);
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

for (const entry of ASK_SCHEMA_DIGEST) {
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
    `Ask digest columns exist.`,
);
