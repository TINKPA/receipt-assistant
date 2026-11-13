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
 * an unreachable source degrading to "leave it for the backfill"
 * instead of failing the ingest, the MAGNITUDE of a zero-decimal (JPY)
 * and a three-decimal (KWD) conversion, a currency the source does not
 * publish failing once and for good instead of being retried, the
 * targeted re-derive leaving other currencies' legs alone, a re-run that
 * changes nothing writing nothing (no version bump), an overwrite being
 * logged in `derivation_events`, the magnitude check that the server runs
 * at boot, a 404 from an endpoint that is not the rate source any more
 * being treated as an outage and not as "not published", and
 * `backfill-fx.ts --rate`: supplying a rate, correcting a mistyped one,
 * and refusing to record one for a published or a future date.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { normalizeTransactionFx } from "../src/fx/normalize.js";
import { FxRateNotPublishedError, getRate } from "../src/fx/rates.js";
import { findMisScaledPostings } from "../src/fx/magnitude-check.js";
import {
  currencyExponent,
  formatMinor,
  postingFxRate,
  toBaseMinor,
} from "../src/ledger/money.js";

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
    console.log(`    ${row.currency} ${formatMinor(row.m!, row.currency!).padStart(12)}  fx=${row.fx ?? "NULL"}  base=${(Number(row.b) / 100).toFixed(2).padStart(12)}`);
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

  console.log("\n── 6b. An overwrite is logged; a re-run that changes nothing writes nothing ──");
  const events = async (id: string): Promise<Array<{ before: { postings: Record<string, { fx_rate: string; amount_base_minor: string }> }; after: { postings: Record<string, { fx_rate: string; amount_base_minor: string }> }; changed_keys: string[] }>> =>
    (await db.execute(sql`SELECT before, after, changed_keys FROM derivation_events WHERE entity_type = 'transaction' AND entity_id = ${id} ORDER BY ran_at`)).rows as never;
  const version = async (id: string): Promise<number> =>
    Number(((await db.execute(sql`SELECT version FROM transactions WHERE id = ${id}::uuid`)).rows[0] as { version: string }).version);
  const ev3 = await events(T3);
  check("the forced overwrite wrote one derivation_events row", ev3.length === 1, `${ev3.length} row(s)`);
  const before3 = Object.values(ev3[0]?.before.postings ?? {});
  const after3 = Object.values(ev3[0]?.after.postings ?? {});
  check("its `before` holds the replaced rate on both legs", before3.length === 2 && before3.every((p) => Number(p.fx_rate) === 0.1389), JSON.stringify(before3.map((p) => p.fx_rate)));
  check("its `after` holds what the postings now carry", after3.length === 2 && after3.some((p) => p.amount_base_minor === (t3.rows[0] as { b: string }).b), JSON.stringify(after3.map((p) => p.amount_base_minor)));
  check("a first conversion is not an overwrite: no event for it", (await events(T1)).length === 0);
  const v3 = await version(T3);
  const res3again = await normalizeTransactionFx(T3, WS, { force: true });
  check("second forced run reports no change", !res3again.changed);
  check("and does not bump the transaction version", (await version(T3)) === v3, `version ${v3} → ${await version(T3)}`);
  check("nor write another event", (await events(T3)).length === 1);

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

  // Everything above uses CNY against a USD base: two currencies with two
  // decimals each, where multiplying a minor amount by the published rate
  // happens to be right. The cases below are the ones where it is not.
  const legs = async (id: string): Promise<Array<{ currency: string; m: string; fx: string | null; b: string }>> =>
    (await db.execute(sql`
      SELECT currency, amount_minor::text AS m, fx_rate::text AS fx, amount_base_minor::text AS b
        FROM postings WHERE transaction_id = ${id}::uuid ORDER BY currency, amount_minor DESC`)).rows as never;

  console.log("\n── 8. Exponents and the one conversion (no database, no network) ──");
  check("JPY has 0 decimals, USD 2, KWD 3", currencyExponent("JPY") === 0 && currencyExponent("USD") === 2 && currencyExponent("KWD") === 3);
  check("a points code has 0", currencyExponent("HYATT_PT") === 0);
  check("JPY→USD 0.0065 is 0.65 cents per yen", postingFxRate("JPY", "USD", 0.0065) === "0.65");
  check("KWD→USD 3.25 is 0.325 cents per fils", postingFxRate("KWD", "USD", 3.25) === "0.325");
  check("CNY→USD is the published rate unchanged", postingFxRate("CNY", "USD", 0.14658) === "0.14658");
  check("USD→JPY 155.03 is 1.5503 yen per cent", postingFxRate("USD", "JPY", 155.03) === "1.5503");
  check("¥5,000 at 0.0065 is 3,250 cents, not 33", toBaseMinor(5000, postingFxRate("JPY", "USD", 0.0065)) === 3250n);
  check("12.500 KWD at 3.25 is 4,063 cents, not 40,625", toBaseMinor(12500, postingFxRate("KWD", "USD", 3.25)) === 4063n);
  check("opposite legs convert to opposite amounts", toBaseMinor(5, "1.7") === 9n && toBaseMinor(-5, "1.7") === -9n);
  let refused = false;
  try { postingFxRate("HYATT_PT", "USD", 1.7); } catch { refused = true; }
  check("a points code is refused, not converted", refused);

  console.log("\n── 9. Zero-decimal magnitude: ¥5,000 through the real pass, live rate ──");
  const T5 = "00000000-0000-0000-0000-00000000a005";
  const jpy = await getRate("JPY", "USD", "2026-04-18");
  await writeLikeAgent(T5, "2026-04-18", "Tokyo Bookshop", 5000, "JPY", acc);
  const res5 = await normalizeTransactionFx(T5, WS);
  await assertBalanced(T5);
  const t5 = (await legs(T5))[0]!;
  const base5 = Number(t5.b);
  const wrong5 = Math.round(5000 * jpy.rate);
  console.log(`    published ${jpy.rate} → fx_rate ${t5.fx} → base ${base5} (the old formula gave ${wrong5})`);
  check("changed flag set", res5.changed);
  // Independent of the code under test: at any rate the yen has traded
  // at in decades, ¥5,000 is somewhere between $12 and $75.
  check("base is dollars, not cents: between $12 and $75", base5 >= 1200 && base5 <= 7500, `got ${(base5 / 100).toFixed(2)}`);
  check("base = round(yen × published rate × 100)", Math.abs(base5 - 5000 * jpy.rate * 100) <= 1, `got ${base5}`);
  check("fx_rate is the published rate × 100", Math.abs(Number(t5.fx) - jpy.rate * 100) < 1e-9, `fx_rate=${t5.fx}`);
  check("stored row obeys base = round(minor × fx_rate)", base5 === Math.round(5000 * Number(t5.fx)));
  const meta5 = (await db.execute(sql`SELECT metadata->'fx'->'rates'->0 AS r FROM transactions WHERE id = ${T5}::uuid`)).rows[0] as { r: { rate: number; posting_fx_rate: string } };
  check("metadata.fx keeps the rate as published", meta5.r.rate === jpy.rate, JSON.stringify(meta5.r));
  check("metadata.fx names the posting multiplier too", Number(meta5.r.posting_fx_rate) === Number(t5.fx), `posting_fx_rate=${meta5.r.posting_fx_rate}`);

  console.log("\n── 10. Three-decimal magnitude: 12.500 KWD (rate seeded; the source has no KWD) ──");
  const T6 = "00000000-0000-0000-0000-00000000a006";
  await db.execute(sql`
    INSERT INTO fx_rates (as_of, base, quote, rate, as_of_actual, source)
    VALUES ('2026-04-20', 'KWD', 'USD', 3.25, '2026-04-20', 'smoke-fx seed')
    ON CONFLICT (as_of, base, quote) DO NOTHING`);
  await writeLikeAgent(T6, "2026-04-20", "Kuwait City Cafe", 12500, "KWD", acc);
  await normalizeTransactionFx(T6, WS);
  await assertBalanced(T6);
  const t6 = (await legs(T6))[0]!;
  check("12.500 KWD at 3.25 is $40.63", Number(t6.b) === 4063, `got ${t6.b}`);
  check("fx_rate is the published rate ÷ 10", Number(t6.fx) === 0.325, `fx_rate=${t6.fx}`);

  console.log("\n── 11. A currency the source does not publish fails once, permanently ──");
  // A 404 is believed only from an endpoint that can still produce a
  // rate it must have, so the first one costs a second request: the
  // probe (EUR→USD on a settled date). Counted apart from the request
  // for the rate itself.
  const realFetch = globalThis.fetch;
  let rateCalls = 0;
  let probeCalls = 0;
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    if (String(a[0]).includes("base=EUR&symbols=USD")) probeCalls++; else rateCalls++;
    return realFetch(...a);
  }) as typeof fetch;
  let notPublished: unknown = null;
  try { await getRate("TWD", "USD", "2026-04-18"); } catch (e) { notPublished = e; }
  check("TWD→USD rejects as not published", notPublished instanceof FxRateNotPublishedError, notPublished instanceof Error ? notPublished.message : String(notPublished));
  check("after exactly one request for the rate (no retries)", rateCalls === 1, `${rateCalls} request(s)`);
  check("and one probe that the source is still the source", probeCalls === 1, `${probeCalls} probe(s)`);
  const T7 = "00000000-0000-0000-0000-00000000a007";
  await writeLikeAgent(T7, "2026-04-18", "Taipei Night Market", 35000, "TWD", acc);
  rateCalls = 0;
  probeCalls = 0;
  await normalizeFxSafely([T7], WS);
  globalThis.fetch = realFetch;
  const t7 = (await legs(T7))[0]!;
  check("the ingest path survives it", true);
  check("again one request, not three", rateCalls === 1, `${rateCalls} request(s)`);
  check("the probe is remembered, not repeated per receipt", probeCalls === 0, `${probeCalls} probe(s)`);
  check("posting left unconverted (fx_rate NULL, base = native)", t7.fx === null && t7.b === "35000");

  console.log("\n── 11b. A 404 from an endpoint that is not the source any more is an outage ──");
  // Every request answers 404, the probe included: a moved API or a
  // mistyped FX_API_BASE. That says nothing about any one currency, so
  // it must be retried and covered by a nearby cached rate like a
  // timeout, not written off as "not published".
  process.env.FX_API_BASE = "http://fx-moved.invalid/v1";
  let movedCalls = 0;
  globalThis.fetch = (async () => {
    movedCalls++;
    return new Response('{"message":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // 2026-04-19 is not cached; the day before is (section 1).
  const stale = await getRate("CNY", "USD", "2026-04-19").catch((e: unknown) => e);
  check("a pair with a rate cached nearby falls back to it", !(stale instanceof Error) && (stale as { source: string }).source.endsWith("(stale)") && Math.abs((stale as { rate: number }).rate - r1.rate) < 1e-12, stale instanceof Error ? stale.message : JSON.stringify(stale));
  check("after retrying (three rate requests, three probes)", movedCalls === 6, `${movedCalls} request(s)`);
  const moved = await getRate("TWD", "USD", "2026-04-17").catch((e: unknown) => e);
  check("a pair with nothing cached fails as an outage", moved instanceof Error && !(moved instanceof FxRateNotPublishedError), moved instanceof Error ? moved.message : String(moved));
  globalThis.fetch = realFetch;
  if (origBase === undefined) delete process.env.FX_API_BASE; else process.env.FX_API_BASE = origBase;

  console.log("\n── 12. Targeted re-derive repairs the yen legs and leaves the yuan legs alone ──");
  const T8 = "00000000-0000-0000-0000-00000000a008";
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, created_by)
      VALUES (${T8}::uuid, ${WS}::uuid, '2026-04-18'::date, 'Two-currency folio', 'posted', ${USER}::uuid)`);
    for (const [account, amount, currency] of [
      [acc.expense, 100000, "CNY"], [acc.card, -100000, "CNY"],
      [acc.expense, 5000, "JPY"], [acc.card, -5000, "JPY"],
    ] as const) {
      await tx.execute(sql`
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        VALUES (gen_random_uuid(), ${T8}::uuid, ${WS}::uuid, ${account}::uuid, ${amount}, ${currency}, ${amount})`);
    }
  });
  await normalizeTransactionFx(T8, WS);
  // Put the yuan legs on a rate no publication ever printed, so a
  // re-derive of them would be visible, and put the yen legs back the way
  // the pre-exponent formula wrote them: published rate, 1/100 the value.
  await db.execute(sql`UPDATE postings SET fx_rate = 0.1389, amount_base_minor = ROUND(amount_minor * 0.1389) WHERE transaction_id = ${T8}::uuid AND currency = 'CNY'`);
  await db.execute(sql`UPDATE postings SET fx_rate = ${jpy.rate}::numeric, amount_base_minor = ROUND(amount_minor * ${jpy.rate}::numeric) WHERE transaction_id = ${T8}::uuid AND currency = 'JPY'`);
  await dump(T8, "before (yen legs at the pre-fix magnitude, yuan legs hand-rated):");
  // What the server's boot check sees at this point: yen legs holding
  // the published rate as their multiplier. The yuan legs are not a
  // finding (same decimals as the base), whatever their rate.
  const misBefore = await findMisScaledPostings();
  check("magnitude check flags the two yen legs", misBefore.length === 1 && misBefore[0]!.currency === "JPY" && misBefore[0]!.postings === 2 && misBefore[0]!.transactions === 1, JSON.stringify(misBefore));
  const res8 = await normalizeTransactionFx(T8, WS, { force: true, currencies: ["JPY"] });
  await dump(T8, "after --currency JPY:");
  await assertBalanced(T8);
  const t8 = await legs(T8);
  const cny8 = t8.filter((l) => l.currency === "CNY");
  const jpy8 = t8.filter((l) => l.currency === "JPY");
  check("only JPY was re-derived", res8.changed && res8.applied.length === 1 && res8.applied[0]!.currency === "JPY");
  check("yuan legs untouched", cny8.every((l) => Number(l.fx) === 0.1389) && cny8[0]!.b === "13890" && cny8[1]!.b === "-13890");
  check("yen legs repaired", jpy8[0]!.b === String(base5) && jpy8[1]!.b === String(-base5), `got ${jpy8.map((l) => l.b).join(" / ")}`);
  const meta8 = (await db.execute(sql`SELECT metadata->'fx'->'rates' AS r FROM transactions WHERE id = ${T8}::uuid`)).rows[0] as { r: Array<{ currency: string }> };
  check("metadata.fx still lists both currencies", meta8.r.map((x) => x.currency).sort().join(",") === "CNY,JPY", JSON.stringify(meta8.r.map((x) => x.currency)));
  check("magnitude check is clean after the repair", (await findMisScaledPostings()).length === 0);
  const ev8 = await events(T8);
  check("the repair is logged, yen legs only", ev8.length === 1 && Object.values(ev8[0]!.before.postings).length === 2 && Object.values(ev8[0]!.before.postings).every((p) => Number(p.fx_rate) === jpy.rate), JSON.stringify(ev8.map((e) => Object.values(e.before.postings).map((p) => p.fx_rate))));

  console.log("\n── 13. backfill-fx.ts --rate: supply, mistype, correct ──");
  // The script is the only way a hand-supplied rate gets in, so it is
  // run as the operator runs it. T7 is the unconverted NT$350.00 from
  // section 11.
  const backfill = (...args: string[]): string => {
    try {
      return execFileSync("npx", ["tsx", "scripts/backfill-fx.ts", "--workspace", WS, ...args], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      return `EXIT≠0 ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
  };
  const twdRate = async (): Promise<{ rate: string; source: string } | undefined> =>
    (await db.execute(sql`SELECT rate::text AS rate, source FROM fx_rates WHERE as_of = '2026-04-18' AND base = 'TWD' AND quote = 'USD'`)).rows[0] as never;
  const t7base = async (): Promise<string> => (await legs(T7))[0]!.b;

  const dry = backfill("--unconverted", "--currency", "TWD", "--rate", "0.0312", "--dry-run");
  check("dry run previews $10.92 and records nothing", dry.includes("10.92") && (await twdRate()) === undefined && (await t7base()) === "35000", dry.split("\n").find((l) => l.includes("TWD")) ?? dry);

  backfill("--unconverted", "--currency", "TWD", "--rate", "3.12"); // the typo: 100 times too high
  check("a mistyped rate converts NT$350.00 to $1,092.00", (await t7base()) === "109200", `base=${await t7base()}`);
  check("and is on record as a manual rate", Number((await twdRate())?.rate) === 3.12 && (await twdRate())?.source === "manual", JSON.stringify(await twdRate()));

  const retry = backfill("--unconverted", "--currency", "TWD", "--rate", "0.0312");
  check("--unconverted no longer selects it, and says how to correct it", retry.includes("No postings match") && retry.includes("--date YYYY-MM-DD") && (await t7base()) === "109200", retry.trim().split("\n").slice(-1)[0]);

  const noDate = backfill("--currency", "TWD", "--rate", "0.0312");
  check("without --date the recorded rate is kept, and the output says so", noDate.includes("was kept") && Number((await twdRate())?.rate) === 3.12 && (await t7base()) === "109200", noDate.split("\n").find((l) => l.includes("↳")) ?? noDate);

  const v7 = await version(T7);
  const fixed = backfill("--currency", "TWD", "--date", "2026-04-18", "--rate", "0.0312");
  check("naming the date replaces the manual rate", Number((await twdRate())?.rate) === 0.0312 && (await twdRate())?.source === "manual", JSON.stringify(await twdRate()));
  check("and re-derives the posting: NT$350.00 is $10.92", (await t7base()) === "1092", `base=${await t7base()}; ${fixed.split("\n").find((l) => l.includes("↳")) ?? ""}`);
  await assertBalanced(T7);
  check("the correction is logged with the wrong amount in `before`", (await events(T7)).some((e) => Object.values(e.before.postings).some((p) => p.amount_base_minor === "109200")));
  check("and bumps the version once", (await version(T7)) === v7 + 1, `version ${v7} → ${await version(T7)}`);

  const rerun = backfill("--currency", "TWD", "--date", "2026-04-18", "--rate", "0.0312");
  check("re-running the correction changes nothing", rerun.includes("unchanged") && (await version(T7)) === v7 + 1 && (await t7base()) === "1092", rerun.split("\n").find((l) => l.includes("TWD")) ?? rerun);

  const jpyBefore = (await legs(T5))[0]!;
  const pub = backfill("--currency", "JPY", "--date", "2026-04-18", "--rate", "0.01");
  const jpyRow = (await db.execute(sql`SELECT rate::text AS rate, source FROM fx_rates WHERE as_of = '2026-04-18' AND base = 'JPY' AND quote = 'USD'`)).rows[0] as { rate: string; source: string };
  check("a published rate is never replaced by --rate", Number(jpyRow.rate) === jpy.rate && jpyRow.source !== "manual" && (await legs(T5))[0]!.b === jpyBefore.b, JSON.stringify(jpyRow));
  check("and the output says the number was not used", pub.includes("--rate not used"), pub.split("\n").find((l) => l.includes("↳")) ?? pub);

  const T9 = "00000000-0000-0000-0000-00000000a009";
  const farFuture = `${new Date().getUTCFullYear() + 3}-01-15`;
  await writeLikeAgent(T9, farFuture, "Mis-dated receipt", 5000, "JPY", acc);
  const fut = backfill("--unconverted", "--currency", "JPY", "--date", farFuture, "--rate", "0.0065");
  const futRow = (await db.execute(sql`SELECT 1 FROM fx_rates WHERE as_of = ${farFuture}::date AND base = 'JPY'`)).rows.length;
  check("--rate is not recorded for a date in the future", futRow === 0 && (await legs(T9))[0]!.fx === null && fut.includes("dated in the future"), fut.split("\n").find((l) => l.includes("future")) ?? fut);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); void pool.end(); process.exit(1); });
