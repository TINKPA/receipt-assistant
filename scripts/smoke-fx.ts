/**
 * smoke-fx.ts — end-to-end check of #184 FX normalization.
 *
 * Runs against a real Postgres (real migrations, real deferred balance
 * trigger) and the real Frankfurter API. It seeds transactions written
 * exactly the way the buggy ingest template wrote them —
 * `amount_base_minor = amount_minor`, `fx_rate` absent — and asserts the
 * repair, rather than testing `normalizeTransactionFx` against a mock of
 * itself.
 *
 * Point it at a THROWAWAY database. It writes into a fixed test
 * workspace and does not clean up after itself, so the tables can be
 * inspected once the run finishes.
 *
 *   docker run -d --name ra-fx-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=receipts -p 55432:5432 docker.io/postgres:17
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/receipts \
 *     npx tsx scripts/migrate.ts
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/receipts \
 *     npx tsx scripts/smoke-fx.ts
 *
 * Covered: live rate lookup, weekend fallback to the prior publication,
 * the rate cache, the defect + its repair, idempotency, base-currency
 * receipts left untouched, `force` re-deriving a stale hand-entered rate,
 * and an unreachable source degrading to "leave it for the backfill"
 * instead of failing the ingest.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { normalizeTransactionFx } from "../src/fx/normalize.js";
import { getRate } from "../src/fx/rates.js";

const WS = "00000000-0000-0000-0000-0000000000ff";
const USER = "00000000-0000-0000-0000-0000000000fe";

async function seed(): Promise<{ expense: string; card: string }> {
  await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${USER}::uuid, 'fx@test.local', 'FX Test') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO workspaces (id, name, base_currency, owner_id) VALUES (${WS}::uuid, 'FX Test WS', 'USD', ${USER}::uuid) ON CONFLICT DO NOTHING`);
  const exp = "00000000-0000-0000-0000-00000000e001";
  const card = "00000000-0000-0000-0000-00000000e002";
  await db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (${exp}::uuid, ${WS}::uuid, 'Other', 'expense', 'USD') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (${card}::uuid, ${WS}::uuid, 'Credit Card', 'liability', 'USD') ON CONFLICT DO NOTHING`);
  return { expense: exp, card };
}

/** Write a transaction exactly the way the buggy agent template did. */
async function writeLikeAgent(
  id: string, occurredOn: string, payee: string, totalMinor: number, currency: string,
  accounts: { expense: string; card: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, created_by)
      VALUES (${id}::uuid, ${WS}::uuid, ${occurredOn}::date, ${payee}, 'posted', ${USER}::uuid)`);
    await tx.execute(sql`
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      VALUES (gen_random_uuid(), ${id}::uuid, ${WS}::uuid, ${accounts.expense}::uuid, ${totalMinor}, ${currency}, ${totalMinor})`);
    await tx.execute(sql`
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      VALUES (gen_random_uuid(), ${id}::uuid, ${WS}::uuid, ${accounts.card}::uuid, ${-totalMinor}, ${currency}, ${-totalMinor})`);
  });
}

async function dump(id: string, label: string): Promise<void> {
  const r = await db.execute(sql`
    SELECT amount_minor::text AS m, currency, fx_rate::text AS fx, amount_base_minor::text AS b
      FROM postings WHERE transaction_id = ${id}::uuid ORDER BY amount_minor DESC`);
  const meta = await db.execute(sql`SELECT metadata->'fx' AS fx FROM transactions WHERE id = ${id}::uuid`);
  console.log(`  ${label}`);
  for (const row of r.rows as Array<Record<string, string>>) {
    console.log(`    ${row.currency} ${(Number(row.m) / 100).toFixed(2).padStart(12)}  fx=${row.fx ?? "NULL"}  base=${(Number(row.b) / 100).toFixed(2).padStart(12)}`);
  }
  const fx = (meta.rows[0] as { fx: unknown } | undefined)?.fx;
  if (fx) console.log(`    metadata.fx = ${JSON.stringify(fx)}`);
}

async function assertBalanced(id: string): Promise<void> {
  const r = await db.execute(sql`SELECT COALESCE(SUM(amount_base_minor),0)::text AS s FROM postings WHERE transaction_id = ${id}::uuid`);
  const s = Number((r.rows[0] as { s: string }).s);
  if (s !== 0) throw new Error(`UNBALANCED: sum(amount_base_minor) = ${s}`);
  console.log("    ✓ postings still balance (sum(amount_base_minor) = 0)");
}

async function main(): Promise<void> {
  const acc = await seed();
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log("\n── 1. Rate lookup against live Frankfurter ──");
  const r1 = await getRate("CNY", "USD", "2026-04-18");
  check("CNY→USD @ 2026-04-18 resolves", Math.abs(r1.rate - 0.14658) < 1e-5, `rate=${r1.rate}`);
  check("weekend falls back to prior publication", r1.asOfActual === "2026-04-17", `as_of_actual=${r1.asOfActual}`);
  check("identity rate for same currency", (await getRate("USD", "USD", "2026-04-18")).rate === 1);

  console.log("\n── 2. Rate is cached (second call must not re-fetch) ──");
  const cachedRow = await db.execute(sql`SELECT rate::text AS r, as_of_actual::text AS a, source FROM fx_rates WHERE as_of='2026-04-18' AND base='CNY' AND quote='USD'`);
  check("fx_rates row written", cachedRow.rows.length === 1, JSON.stringify(cachedRow.rows[0]));
  const origBase = process.env.FX_API_BASE;
  process.env.FX_API_BASE = "http://127.0.0.1:9/nope"; // unreachable
  const r2 = await getRate("CNY", "USD", "2026-04-18");
  check("cache hit survives unreachable upstream", Math.abs(r2.rate - r1.rate) < 1e-12);
  if (origBase === undefined) delete process.env.FX_API_BASE; else process.env.FX_API_BASE = origBase;

  console.log("\n── 3. The production defect, reproduced then repaired ──");
  const T1 = "00000000-0000-0000-0000-00000000a001";
  await writeLikeAgent(T1, "2026-04-18", "广州金铭物业管理有限公司", 1394880, "CNY", acc);
  await dump(T1, "before (as the agent wrote it):");
  const res = await normalizeTransactionFx(T1, WS);
  await dump(T1, "after normalize:");
  await assertBalanced(T1);
  const after = await db.execute(sql`SELECT amount_base_minor::text AS b, fx_rate::text AS fx FROM postings WHERE transaction_id=${T1}::uuid AND amount_minor>0`);
  const gotBase = Number((after.rows[0] as { b: string }).b);
  check("changed flag set", res.changed);
  check("base amount ≈ $2,044.62", Math.abs(gotBase - 204462) <= 1, `got ${(gotBase / 100).toFixed(2)}`);
  check("fx_rate persisted", (after.rows[0] as { fx: string | null }).fx !== null);

  console.log("\n── 4. Idempotent: re-running must not double-convert ──");
  await normalizeTransactionFx(T1, WS);
  const again = await db.execute(sql`SELECT amount_base_minor::text AS b FROM postings WHERE transaction_id=${T1}::uuid AND amount_minor>0`);
  check("second run is a no-op", Number((again.rows[0] as { b: string }).b) === gotBase);

  console.log("\n── 5. USD receipts are left completely alone ──");
  const T2 = "00000000-0000-0000-0000-00000000a002";
  await writeLikeAgent(T2, "2026-07-14", "Kartek Auto", 79616, "USD", acc);
  const res2 = await normalizeTransactionFx(T2, WS);
  const usdAfter = await db.execute(sql`SELECT amount_base_minor::text AS b, fx_rate::text AS fx FROM postings WHERE transaction_id=${T2}::uuid AND amount_minor>0`);
  check("no conversion attempted", !res2.changed);
  check("base stays 79616", Number((usdAfter.rows[0] as { b: string }).b) === 79616);
  check("fx_rate stays NULL", (usdAfter.rows[0] as { fx: string | null }).fx === null);

  console.log("\n── 6. force:true re-derives a stale hand-entered rate ──");
  const T3 = "00000000-0000-0000-0000-00000000a003";
  await writeLikeAgent(T3, "2026-02-27", "上海深享网络科技有限公司", 14880000, "CNY", acc);
  await db.execute(sql`UPDATE postings SET fx_rate = 0.1389, amount_base_minor = ROUND(amount_minor * 0.1389) WHERE transaction_id = ${T3}::uuid`);
  await dump(T3, "before (stale 0.1389 rate):");
  const res3 = await normalizeTransactionFx(T3, WS);
  check("without force: skipped", !res3.changed);
  const res3f = await normalizeTransactionFx(T3, WS, { force: true });
  await dump(T3, "after force:");
  await assertBalanced(T3);
  const t3 = await db.execute(sql`SELECT amount_base_minor::text AS b FROM postings WHERE transaction_id=${T3}::uuid AND amount_minor>0`);
  check("with force: re-derived", res3f.changed);
  check("base ≈ $21,696.53 (0.14581)", Math.abs(Number((t3.rows[0] as { b: string }).b) - 2169653) <= 2, `got ${(Number((t3.rows[0] as { b: string }).b) / 100).toFixed(2)}`);

  console.log("\n── 7. Unreachable source + no cache ⇒ posting left NULL, no crash ──");
  const T4 = "00000000-0000-0000-0000-00000000a004";
  await writeLikeAgent(T4, "2026-06-15", "Tokyo Store", 500000, "JPY", acc);
  process.env.FX_API_BASE = "http://127.0.0.1:9/nope";
  const { normalizeFxSafely } = await import("../src/fx/normalize.js");
  await normalizeFxSafely([T4], WS);
  if (origBase === undefined) delete process.env.FX_API_BASE; else process.env.FX_API_BASE = origBase;
  const t4 = await db.execute(sql`SELECT fx_rate::text AS fx FROM postings WHERE transaction_id=${T4}::uuid AND amount_minor>0`);
  check("survives failure without throwing", true);
  check("fx_rate left NULL for the backfill pass", (t4.rows[0] as { fx: string | null }).fx === null);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); void pool.end(); process.exit(1); });
