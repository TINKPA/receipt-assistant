/**
 * One-shot backfill: canonicalize the merchant for every transaction
 * that landed before Phase 2.5 of the extractor prompt (#64) and stamp
 * `transactions.merchant_id` accordingly.
 *
 * Usage (inside the receipt-assistant container — has $DATABASE_URL and
 * a logged-in Claude CLI):
 *
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-merchants.ts
 *
 * Flags:
 *     --dry-run   Print what would be written; touch nothing.
 *     --limit N   Process at most N transactions (default: all).
 *     --batch N   Payees per Claude call (default: 40).
 *     --workspace UUID    Restrict to one workspace (default: all).
 *
 * Safety:
 *   - The script never overwrites a transaction that already has a
 *     merchant_id (i.e. anything ingested AFTER #64). Only NULL rows
 *     are touched.
 *   - UPSERT into merchants uses (workspace_id, brand_id) — re-runs are
 *     idempotent.
 *   - All UPDATEs happen in one BEGIN/COMMIT per batch so an interrupted
 *     run leaves the DB consistent.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

interface Args {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  workspaceId: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: null, batchSize: 40, workspaceId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10) || null;
    else if (a === "--batch") out.batchSize = parseInt(argv[++i] ?? "0", 10) || 40;
    else if (a === "--workspace") out.workspaceId = argv[++i] ?? null;
  }
  return out;
}

interface PendingRow {
  txn_id: string;
  workspace_id: string;
  payee: string;
  category_hint: string | null;
}

interface Classification {
  canonical_name: string;
  brand_id: string;
  category: string | null;
}

const BRAND_RE = /^[a-z0-9-]+$/;
const VALID_CATEGORIES = new Set([
  "Food & Drinks",
  "Transportation",
  "Shopping",
  "Travel",
  "Entertainment",
  "Health",
  "Services",
]);

function buildPrompt(rows: Array<{ payee: string; hint: string | null }>): string {
  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.payee} || ${r.hint ?? "(no hint)"}`,
  );
  return `You are a receipt-merchant canonicalization step. For each input below, emit one JSON object on its own line with exactly these keys:
  canonical_name : display name without store ID / location suffix / punctuation
  brand_id       : kebab-case stable identifier, ASCII lowercase + digits + dashes; regex ^[a-z0-9-]+$
  category       : one of "Food & Drinks", "Transportation", "Shopping", "Travel", "Entertainment", "Health", "Services"

The SAME brand MUST collapse to the SAME brand_id across every input (e.g. "Costco", "Costco #479", "COSTCO WHOLESALE" → all "costco").

Category mapping hint (use the hint after "||" + your own knowledge):
  dining/cafe/groceries/bakery   → "Food & Drinks"
  retail/department/apparel     → "Shopping"
  gas/transit/parking/rideshare → "Transportation"
  pharmacy/medical/dental       → "Health"
  shipping/subscriptions/utilities/rent/laundry → "Services"
  concerts/movies/streaming     → "Entertainment"
  hotel/flight/cruise           → "Travel"

Output ONLY the JSON lines (one per input, in order), no commentary, no markdown fences.

Inputs:
${lines.join("\n")}`;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--model", "sonnet"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function parseClassifications(
  raw: string,
  inputs: Array<{ payee: string; hint: string | null }>,
): Array<Classification | null> {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Array<Classification | null> = [];
  for (let i = 0; i < inputs.length; i++) {
    const line = lines[i];
    if (!line) {
      out.push(null);
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<Classification>;
      if (
        typeof obj.canonical_name !== "string" ||
        typeof obj.brand_id !== "string" ||
        !BRAND_RE.test(obj.brand_id) ||
        (obj.category != null && !VALID_CATEGORIES.has(obj.category))
      ) {
        out.push(null);
        continue;
      }
      out.push({
        canonical_name: obj.canonical_name,
        brand_id: obj.brand_id,
        category: obj.category ?? null,
      });
    } catch {
      out.push(null);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill] dry_run=${args.dryRun} limit=${args.limit ?? "∞"} batch=${args.batchSize} workspace=${args.workspaceId ?? "all"}`,
  );

  // Pull every transaction missing merchant_id and not voided.
  const wsFilter = args.workspaceId
    ? sql`AND t.workspace_id = ${args.workspaceId}::uuid`
    : sql``;
  const limitClause = args.limit ? sql`LIMIT ${args.limit}` : sql``;
  const pending = (
    await db.execute(sql`
      SELECT t.id::text          AS txn_id,
             t.workspace_id::text AS workspace_id,
             COALESCE(NULLIF(t.payee, ''), '(unknown)') AS payee,
             t.metadata->>'category_hint' AS category_hint
        FROM transactions t
       WHERE t.merchant_id IS NULL
         AND t.status <> 'voided'
         ${wsFilter}
       ORDER BY t.created_at ASC
       ${limitClause}
    `)
  ).rows as unknown as PendingRow[];

  console.log(`[backfill] ${pending.length} transactions missing merchant_id`);
  if (pending.length === 0) return;

  // Dedup by (workspace, payee, hint). One Claude call covers each
  // unique key; results are then fanned back out to every txn sharing it.
  const uniqueByKey = new Map<
    string,
    { workspace_id: string; payee: string; hint: string | null; txn_ids: string[] }
  >();
  for (const row of pending) {
    const key = `${row.workspace_id}::${row.payee}::${row.category_hint ?? ""}`;
    let entry = uniqueByKey.get(key);
    if (!entry) {
      entry = {
        workspace_id: row.workspace_id,
        payee: row.payee,
        hint: row.category_hint,
        txn_ids: [],
      };
      uniqueByKey.set(key, entry);
    }
    entry.txn_ids.push(row.txn_id);
  }
  const uniques = [...uniqueByKey.values()];
  console.log(`[backfill] ${uniques.length} distinct payee+hint groups`);

  const classifications = new Map<string, Classification>();
  for (let i = 0; i < uniques.length; i += args.batchSize) {
    const slice = uniques.slice(i, i + args.batchSize);
    const inputs = slice.map((s) => ({ payee: s.payee, hint: s.hint }));
    const prompt = buildPrompt(inputs);
    console.log(
      `[backfill] LLM batch ${i / args.batchSize + 1} / ${Math.ceil(uniques.length / args.batchSize)} (${slice.length} payees)`,
    );
    const raw = await runClaude(prompt);
    const parsed = parseClassifications(raw, inputs);
    for (let j = 0; j < slice.length; j++) {
      const c = parsed[j];
      if (!c) {
        console.warn(`[backfill] skip: failed to classify ${JSON.stringify(slice[j].payee)}`);
        continue;
      }
      const key = `${slice[j].workspace_id}::${slice[j].payee}::${slice[j].hint ?? ""}`;
      classifications.set(key, c);
    }
  }

  // Write phase. One BEGIN/COMMIT per workspace+brand bucket — keeps
  // each merchant + its associated UPDATEs atomic without locking the
  // whole table.
  const stats = { merchants_touched: 0, txns_updated: 0, skipped: 0 };
  for (const u of uniques) {
    const key = `${u.workspace_id}::${u.payee}::${u.hint ?? ""}`;
    const c = classifications.get(key);
    if (!c) {
      stats.skipped += u.txn_ids.length;
      continue;
    }
    if (args.dryRun) {
      console.log(
        `[dry] payee=${u.payee.padEnd(28)} → brand=${c.brand_id} cat=${c.category} (${u.txn_ids.length} txns)`,
      );
      stats.merchants_touched += 1;
      stats.txns_updated += u.txn_ids.length;
      continue;
    }
    await db.execute(sql`BEGIN`);
    try {
      const ins = (
        await db.execute(sql`
          INSERT INTO merchants (workspace_id, brand_id, canonical_name, category)
          VALUES (${u.workspace_id}::uuid, ${c.brand_id}, ${c.canonical_name}, ${c.category})
          ON CONFLICT (workspace_id, brand_id) DO UPDATE
            SET updated_at = NOW()
          RETURNING id::text AS id
        `)
      ).rows as unknown as Array<{ id: string }>;
      const merchantId = ins[0]?.id;
      if (!merchantId) throw new Error("UPSERT returned no id");
      const ids = u.txn_ids;
      await db.execute(sql`
        UPDATE transactions
           SET merchant_id = ${merchantId}::uuid,
               updated_at  = NOW()
         WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`)})
      `);
      await db.execute(sql`COMMIT`);
      stats.merchants_touched += 1;
      stats.txns_updated += ids.length;
    } catch (err) {
      await db.execute(sql`ROLLBACK`);
      console.error(
        `[backfill] write failed for ${u.payee}: ${err instanceof Error ? err.message : err}`,
      );
      stats.skipped += u.txn_ids.length;
    }
  }

  console.log(
    `[backfill] done — merchants=${stats.merchants_touched} txns_updated=${stats.txns_updated} skipped=${stats.skipped}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
