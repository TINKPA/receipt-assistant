/**
 * One-shot backfill: re-derive `fx_rate` + `amount_base_minor` for every
 * posting whose currency differs from its workspace's base currency (#184).
 *
 * Why it is needed: the ingest agent's INSERT template wrote
 * `amount_base_minor = amount_minor` unconditionally, so a ¥13,948.80
 * receipt was counted as $13,948.80 by every query that sums
 * `amount_base_minor` — which is all of `src/routes/reports.ts`, the
 * insights queries, and dedup. `src/fx/normalize.ts` now fixes this at
 * ingest time; this script fixes the rows already in the ledger.
 *
 * Usage (inside the receipt-assistant container — has $DATABASE_URL):
 *
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --dry-run
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts
 *
 * Flags:
 *     --dry-run   Print the before/after table; write nothing.
 *     --workspace UUID    Restrict to one workspace (default: all).
 *
 * Safety:
 *   - Runs with `force: true`, so it re-derives even postings that
 *     already carry an `fx_rate`. That is deliberate: rows written
 *     before this module existed could carry a hand-entered rate from
 *     the wrong date (the 2026-02-27 CNY row held 0.1389 against a
 *     same-day published 0.14581). One rate policy, applied uniformly.
 *   - One DB transaction per ledger transaction, so an interrupted run
 *     leaves the ledger balanced.
 *   - Idempotent: a second run recomputes the same numbers from the
 *     same cached rates and writes the same values.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { normalizeTransactionFx } from "../src/fx/normalize.js";

interface Args {
  dryRun: boolean;
  workspaceId: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, workspaceId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--workspace") out.workspaceId = argv[++i] ?? null;
  }
  return out;
}

interface Candidate {
  transaction_id: string;
  workspace_id: string;
  occurred_on: string;
  payee: string | null;
  currency: string;
  base_currency: string;
  amount_minor: string;
  amount_base_minor: string | null;
  fx_rate: string | null;
}

/**
 * Expense-side (positive) foreign-currency postings, one row per
 * transaction — enough to print a meaningful before/after line. The
 * normalize pass itself operates on every leg.
 */
async function findCandidates(workspaceId: string | null): Promise<Candidate[]> {
  const res = await db.execute(sql`
    SELECT t.id            AS transaction_id,
           t.workspace_id  AS workspace_id,
           t.occurred_on   AS occurred_on,
           t.payee         AS payee,
           p.currency      AS currency,
           w.base_currency AS base_currency,
           p.amount_minor::text      AS amount_minor,
           p.amount_base_minor::text AS amount_base_minor,
           p.fx_rate::text           AS fx_rate
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN workspaces  w ON w.id = t.workspace_id
     WHERE p.currency <> w.base_currency
       AND p.amount_minor > 0
       ${workspaceId ? sql`AND t.workspace_id = ${workspaceId}::uuid` : sql``}
     ORDER BY t.occurred_on
  `);
  return res.rows as unknown as Candidate[];
}

function money(minor: string | number | null, dp = 2): string {
  if (minor === null) return "—";
  return (Number(minor) / 100).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await findCandidates(args.workspaceId);

  if (candidates.length === 0) {
    console.log("No foreign-currency postings found — nothing to backfill.");
    return;
  }

  console.log(
    `Found ${candidates.length} foreign-currency transaction(s)` +
      (args.dryRun ? " (dry run — nothing will be written)" : ""),
  );
  console.log();
  console.log(
    [
      "date".padEnd(11),
      "payee".padEnd(26),
      "original".padStart(15),
      "rate".padStart(10),
      "as-of".padEnd(12),
      "base (new)".padStart(13),
      "base (old)".padStart(13),
      "delta".padStart(13),
    ].join(" "),
  );

  let totalOld = 0;
  let totalNew = 0;
  let failures = 0;

  for (const c of candidates) {
    const onDate = String(c.occurred_on).slice(0, 10);
    const label = (c.payee ?? "—").slice(0, 25);
    const oldBase = Number(c.amount_base_minor ?? 0);

    try {
      // Dry run still resolves the rate (and warms the fx_rates cache);
      // it just skips the UPDATE. That makes the printed table a real
      // preview of what the live run will write, not an estimate.
      const result = args.dryRun
        ? await previewOnly(c, onDate)
        : await applyAndReread(c, onDate);

      totalOld += oldBase;
      totalNew += result.newBase;
      console.log(
        [
          onDate.padEnd(11),
          label.padEnd(26),
          `${c.currency} ${money(c.amount_minor)}`.padStart(15),
          result.rate.toFixed(5).padStart(10),
          result.asOfActual.padEnd(12),
          `${c.base_currency} ${money(result.newBase)}`.padStart(13),
          money(oldBase).padStart(13),
          money(result.newBase - oldBase).padStart(13),
        ].join(" "),
      );
    } catch (err) {
      failures++;
      console.error(
        `${onDate.padEnd(11)} ${label.padEnd(26)} FAILED: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  console.log();
  console.log(
    `Base-currency total: ${money(totalOld)} → ${money(totalNew)} ` +
      `(delta ${money(totalNew - totalOld)})`,
  );
  if (failures > 0) {
    console.log(
      `${failures} transaction(s) could not be converted — they keep their ` +
        `current values and can be retried by re-running this script.`,
    );
  }
  if (args.dryRun) console.log("Dry run — no rows were modified.");
}

/** Resolve the rate for a candidate without writing anything. */
async function previewOnly(
  c: Candidate,
  onDate: string,
): Promise<{ rate: number; asOfActual: string; newBase: number }> {
  const { getRate } = await import("../src/fx/rates.js");
  const r = await getRate(c.currency, c.base_currency, onDate);
  return {
    rate: r.rate,
    asOfActual: r.asOfActual,
    newBase: Math.round(Number(c.amount_minor) * r.rate),
  };
}

/** Normalize for real, then read back what actually landed. */
async function applyAndReread(
  c: Candidate,
  onDate: string,
): Promise<{ rate: number; asOfActual: string; newBase: number }> {
  const res = await normalizeTransactionFx(c.transaction_id, c.workspace_id, {
    force: true,
  });
  const applied = res.applied.find((a) => a.currency === c.currency);
  const after = await db.execute(
    sql`SELECT amount_base_minor::text AS b, fx_rate::text AS r
          FROM postings
         WHERE transaction_id = ${c.transaction_id}::uuid
           AND currency = ${c.currency}
           AND amount_minor > 0
         LIMIT 1`,
  );
  const row = after.rows[0] as { b: string | null; r: string | null };
  return {
    rate: applied?.rate ?? Number(row?.r ?? 0),
    asOfActual: applied?.asOfActual ?? onDate,
    newBase: Number(row?.b ?? 0),
  };
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    void pool.end();
    process.exit(1);
  });
