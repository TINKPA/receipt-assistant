/**
 * smoke-points.ts — end-to-end check of #206 points-as-currency.
 *
 * Runs against a real Postgres, so it exercises the real migrations, the
 * real currency-shape CHECK constraints, the real partial unique index
 * the extraction agent upserts against, and the real deferred balance
 * trigger. It writes the ledger exactly the way the extraction prompt
 * tells the agent to write it, then asserts the worker's valuation pass
 * turns the placeholder into a real base amount.
 *
 * Point it at a THROWAWAY database. It writes into a fixed test workspace
 * and does not clean up, so the tables can be inspected afterwards.
 *
 *   docker run -d --rm --name ra-points-test -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=receipts -p 55432:5432 docker.io/postgres:16
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/receipts \
 *     npx tsx scripts/migrate.ts
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/receipts \
 *     npx tsx scripts/smoke-points.ts
 *
 * Covered: the namespace CHECK constraints, the agent's inline account
 * upsert, a 40,500-point award stay valued at the seeded rate, the
 * unvalued-programme state and its recovery, idempotency, `force`
 * re-valuation, a mixed points+cash folio, the #184 FX regression check,
 * and the two structural guarantees that keep the FX marker intact.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import {
  valueTransactionPoints,
  valuePointsSafely,
} from "../src/points/valuation.js";
import { normalizeTransactionFx } from "../src/fx/normalize.js";
import { getRate } from "../src/fx/rates.js";
import { getSummaryReport, getNetWorthReport } from "../src/routes/reports.js";

const WS = "00000000-0000-0000-0000-0000000000ef";
const USER = "00000000-0000-0000-0000-0000000000ee";
const EXPENSE = "00000000-0000-0000-0000-00000000f001";
const CARD = "00000000-0000-0000-0000-00000000f002";

async function seed(): Promise<void> {
  await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${USER}::uuid, 'points@test.local', 'Points Test') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO workspaces (id, name, base_currency, owner_id) VALUES (${WS}::uuid, 'Points Test WS', 'USD', ${USER}::uuid) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (${EXPENSE}::uuid, ${WS}::uuid, 'Travel', 'expense', 'USD') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (${CARD}::uuid, ${WS}::uuid, 'Credit Card', 'liability', 'USD') ON CONFLICT DO NOTHING`);
  // The 0039 seed only reaches workspaces that existed when it ran, so
  // give this test workspace the same unconfirmed Hyatt valuation.
  await db.execute(sql`
    INSERT INTO points_valuations (workspace_id, currency, quote, effective_from, minor_per_point, source, note)
    VALUES (${WS}::uuid, 'HYATT_PT', 'USD', DATE '2000-01-01', 1.7, 'issue-206-example', 'UNCONFIRMED')
    ON CONFLICT DO NOTHING`);
}

/**
 * Write a ledger transaction exactly the way the Phase 4a template tells
 * the agent to: the document's own numbers, `amount_base_minor =
 * amount_minor` as a placeholder, no `fx_rate`, and the points asset
 * account created inline by the same upsert the prompt spells out.
 */
async function writeLikeAgent(opts: {
  id: string;
  occurredOn: string;
  payee: string;
  totalMinor: number;
  currency: string;
  programmeName?: string;
  /** Optional second cash leg pair, e.g. a resort fee on an award stay. */
  cash?: { minor: number; currency: string };
}): Promise<void> {
  const isPoints = opts.currency.endsWith("_PT");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, created_by)
      VALUES (${opts.id}::uuid, ${WS}::uuid, ${opts.occurredOn}::date, ${opts.payee}, 'posted', ${USER}::uuid)`);

    let creditId = CARD;
    if (isPoints) {
      const up = await tx.execute(sql`
        INSERT INTO accounts (id, workspace_id, name, type, subtype, currency)
        VALUES (gen_random_uuid(), ${WS}::uuid, ${opts.programmeName ?? opts.currency}, 'asset', 'points', ${opts.currency})
        ON CONFLICT (workspace_id, currency) WHERE subtype = 'points'
          DO UPDATE SET updated_at = NOW()
        RETURNING id`);
      creditId = (up.rows[0] as { id: string }).id;
    }

    await tx.execute(sql`
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      VALUES (gen_random_uuid(), ${opts.id}::uuid, ${WS}::uuid, ${EXPENSE}::uuid, ${opts.totalMinor}, ${opts.currency}, ${opts.totalMinor})`);
    await tx.execute(sql`
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      VALUES (gen_random_uuid(), ${opts.id}::uuid, ${WS}::uuid, ${creditId}::uuid, ${-opts.totalMinor}, ${opts.currency}, ${-opts.totalMinor})`);

    if (opts.cash) {
      await tx.execute(sql`
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        VALUES (gen_random_uuid(), ${opts.id}::uuid, ${WS}::uuid, ${EXPENSE}::uuid, ${opts.cash.minor}, ${opts.cash.currency}, ${opts.cash.minor})`);
      await tx.execute(sql`
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        VALUES (gen_random_uuid(), ${opts.id}::uuid, ${WS}::uuid, ${CARD}::uuid, ${-opts.cash.minor}, ${opts.cash.currency}, ${-opts.cash.minor})`);
    }

    // The prompt makes the agent force the deferred triggers here rather
    // than at COMMIT; do the same so a failure points at this write.
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  });
}

async function legs(
  id: string,
): Promise<Array<{ m: string; currency: string; fx: string | null; b: string }>> {
  const r = await db.execute(sql`
    SELECT amount_minor::text AS m, currency, fx_rate::text AS fx, amount_base_minor::text AS b
      FROM postings WHERE transaction_id = ${id}::uuid ORDER BY amount_minor DESC`);
  return r.rows as unknown as Array<{
    m: string;
    currency: string;
    fx: string | null;
    b: string;
  }>;
}

async function dump(id: string, label: string): Promise<void> {
  console.log(`  ${label}`);
  for (const row of await legs(id)) {
    console.log(
      `    ${row.currency.padEnd(9)} ${row.m.padStart(10)}  fx=${(row.fx ?? "NULL").padEnd(12)} base=${row.b.padStart(10)}`,
    );
  }
  const meta = await db.execute(
    sql`SELECT metadata->'points' AS p FROM transactions WHERE id = ${id}::uuid`,
  );
  const p = (meta.rows[0] as { p: unknown } | undefined)?.p;
  if (p) console.log(`    metadata.points = ${JSON.stringify(p)}`);
}

async function sumBase(id: string): Promise<number> {
  const r = await db.execute(
    sql`SELECT COALESCE(SUM(amount_base_minor),0)::text AS s FROM postings WHERE transaction_id = ${id}::uuid`,
  );
  return Number((r.rows[0] as { s: string }).s);
}

async function main(): Promise<void> {
  await seed();
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };
  const rejects = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      console.log(`  ✗ ${label} — expected a rejection, got success`);
      failures++;
      return false;
    } catch {
      console.log(`  ✓ ${label}`);
      return true;
    }
  };

  console.log("\n── 1. The currency namespace is enforced by the database ──");
  await rejects("a lowercase / malformed points code is rejected", () =>
    db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (gen_random_uuid(), ${WS}::uuid, 'bad', 'asset', 'hyatt_pt')`),
  );
  await rejects("a 4-letter cash-shaped code is rejected", () =>
    db.execute(sql`INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES (gen_random_uuid(), ${WS}::uuid, 'bad', 'asset', 'USDX')`),
  );
  await rejects("a points code cannot enter the FX rate cache", () =>
    db.execute(sql`INSERT INTO fx_rates (as_of, base, quote, rate, as_of_actual, source) VALUES (DATE '2026-07-01', 'HYATT_PT', 'USD', 1.7, DATE '2026-07-01', 'bogus')`),
  );
  await rejects("getRate() refuses a points currency outright", () =>
    getRate("HYATT_PT", "USD", "2026-07-01"),
  );

  console.log("\n── 2. A 40,500-point award stay, written as the agent writes it ──");
  const T1 = "00000000-0000-0000-0000-00000000b001";
  await writeLikeAgent({
    id: T1, occurredOn: "2026-07-05", payee: "Hyatt Regency Maui",
    totalMinor: 40500, currency: "HYATT_PT", programmeName: "World of Hyatt points",
  });
  await dump(T1, "before (agent placeholder):");
  const r1 = await valueTransactionPoints(T1, WS);
  await dump(T1, "after the valuation pass:");
  const l1 = await legs(T1);
  check("transaction is denominated in points, not $0", l1[0]!.currency === "HYATT_PT" && l1[0]!.m === "40500");
  check("base = 40500 × 1.7 = $688.50", l1[0]!.b === "68850", `got ${l1[0]!.b}`);
  check("fx_rate carries the valuation, not a market rate", Number(l1[0]!.fx) === 1.7);
  check("still balances (sum base = 0)", (await sumBase(T1)) === 0);
  check("provenance flags the number as unconfirmed", r1.applied[0]?.confirmed === false);

  console.log("\n── 3. Idempotency and re-valuation ──");
  await valueTransactionPoints(T1, WS);
  check("second run is a no-op", (await legs(T1))[0]!.b === "68850");
  await db.execute(sql`
    INSERT INTO points_valuations (workspace_id, currency, quote, effective_from, minor_per_point, source, confirmed_at, note)
    VALUES (${WS}::uuid, 'HYATT_PT', 'USD', DATE '2026-07-01', 2.0, 'owner', NOW(), 'confirmed by owner')
    ON CONFLICT DO NOTHING`);
  const r3 = await valueTransactionPoints(T1, WS, { force: true });
  const l3 = await legs(T1);
  check("a newer effective valuation wins under force", l3[0]!.b === "81000", `got ${l3[0]!.b}`);
  check("confirmed valuation is reported as confirmed", r3.applied[0]?.confirmed === true);
  check("still balances after re-valuation", (await sumBase(T1)) === 0);

  console.log("\n── 4. An unconfigured programme is visible, not a silent $0 ──");
  await db.execute(sql`INSERT INTO points_programmes (code, name) VALUES ('BONVOY_PT', 'Marriott Bonvoy points') ON CONFLICT DO NOTHING`);
  const T2 = "00000000-0000-0000-0000-00000000b002";
  await writeLikeAgent({
    id: T2, occurredOn: "2026-06-11", payee: "Courtyard Long Beach",
    totalMinor: 35000, currency: "BONVOY_PT", programmeName: "Marriott Bonvoy points",
  });
  const r4 = await valueTransactionPoints(T2, WS);
  const l4 = await legs(T2);
  check("the stay is still recorded in points", l4[0]!.m === "35000" && l4[0]!.currency === "BONVOY_PT");
  check("base is 0 with an explicit 0 rate, not NULL", l4[0]!.b === "0" && Number(l4[0]!.fx) === 0);
  check("reported as unvalued", r4.unvalued.includes("BONVOY_PT"));
  await db.execute(sql`
    INSERT INTO points_valuations (workspace_id, currency, quote, effective_from, minor_per_point, source, confirmed_at)
    VALUES (${WS}::uuid, 'BONVOY_PT', 'USD', DATE '2000-01-01', 0.8, 'owner', NOW())`);
  await valueTransactionPoints(T2, WS); // no force — a 0 rate is re-tried
  check("configuring a valuation later picks it up without force", (await legs(T2))[0]!.b === "28000", `got ${(await legs(T2))[0]!.b}`);

  console.log("\n── 5. Mixed folio: award room + a cash resort fee ──");
  const T3 = "00000000-0000-0000-0000-00000000b003";
  await writeLikeAgent({
    id: T3, occurredOn: "2026-07-20", payee: "Andaz Maui",
    totalMinor: 30000, currency: "HYATT_PT", programmeName: "World of Hyatt points",
    cash: { minor: 7500, currency: "USD" },
  });
  await valuePointsSafely([T3], WS);
  await normalizeTransactionFx(T3, WS);
  await dump(T3, "after both passes:");
  const l5 = await legs(T3);
  const pointsLeg = l5.find((x) => x.currency === "HYATT_PT" && Number(x.m) > 0)!;
  const cashLeg = l5.find((x) => x.currency === "USD" && Number(x.m) > 0)!;
  check("points leg valued at 2.0 → $600.00", pointsLeg.b === "60000", `got ${pointsLeg.b}`);
  check("cash leg untouched at $75.00", cashLeg.b === "7500" && cashLeg.fx === null);
  check("whole transaction balances", (await sumBase(T3)) === 0);

  console.log("\n── 6. #184 REGRESSION: a non-USD cash receipt still converts ──");
  const T4 = "00000000-0000-0000-0000-00000000b004";
  await writeLikeAgent({ id: T4, occurredOn: "2026-04-18", payee: "广州金铭物业管理有限公司", totalMinor: 1394880, currency: "CNY" });
  await valuePointsSafely([T4], WS); // must be a complete no-op
  const r6 = await normalizeTransactionFx(T4, WS);
  await dump(T4, "after both passes:");
  const l6 = await legs(T4);
  check("FX conversion still happens", r6.changed);
  check("base ≈ $2,044.62 at the published 2026-04-17 rate", Math.abs(Number(l6[0]!.b) - 204462) <= 2, `got ${l6[0]!.b}`);
  check("fx_rate came from the ECB feed", r6.applied[0]?.source.includes("frankfurter") === true);
  check("balances", (await sumBase(T4)) === 0);

  console.log("\n── 7. The FX marker still means exactly one thing ──");
  const unconverted = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
     WHERE t.workspace_id = ${WS}::uuid
       AND p.currency <> 'USD'
       AND p.currency !~ '^[A-Z][A-Z0-9]{1,12}_PT$'
       AND p.fx_rate IS NULL`);
  check(
    "no cash posting is left with fx_rate NULL",
    (unconverted.rows[0] as { n: number }).n === 0,
    `${(unconverted.rows[0] as { n: number }).n} left`,
  );
  const pointsNull = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
     WHERE t.workspace_id = ${WS}::uuid
       AND p.currency ~ '^[A-Z][A-Z0-9]{1,12}_PT$'
       AND p.fx_rate IS NULL`);
  check(
    "no points posting is left with fx_rate NULL either",
    (pointsNull.rows[0] as { n: number }).n === 0,
    `${(pointsNull.rows[0] as { n: number }).n} left`,
  );

  console.log("\n── 8. Reports state how points and cash combine ──");
  // Add an unvalued programme so the disclosure has one to report.
  await db.execute(sql`INSERT INTO points_programmes (code, name) VALUES ('AA_PT', 'American Airlines miles') ON CONFLICT DO NOTHING`);
  const T5 = "00000000-0000-0000-0000-00000000b005";
  await writeLikeAgent({ id: T5, occurredOn: "2026-07-22", payee: "American Airlines", totalMinor: 25000, currency: "AA_PT", programmeName: "American Airlines miles" });
  await valuePointsSafely([T5], WS);

  const summary = await getSummaryReport({ workspaceId: WS });
  console.log(`  policy: ${summary.points.policy.slice(0, 72)}…`);
  console.log(`  ${JSON.stringify({ ...summary.points, policy: undefined })}`);
  check("summary discloses points inside its totals", summary.points.included_in_totals);
  check(
    "points spend counted in grand total",
    summary.points.base_minor === 81000 + 28000 + 60000,
    `points base ${summary.points.base_minor}, grand total ${summary.grand_total_minor}`,
  );
  check("unvalued AA_PT stay is counted, not hidden", summary.points.unvalued_transaction_count === 1);
  check(
    "AA_PT reported with no valuation",
    summary.points.programmes.find((p) => p.currency === "AA_PT")?.valuation_exists === false,
  );
  check(
    "unconfirmed portion is reported",
    typeof summary.points.unconfirmed_base_minor === "number",
    `${summary.points.unconfirmed_base_minor}`,
  );

  // The single safety property that matters most for the owner: money
  // derived from a valuation nobody has signed off on is reported as
  // such, not folded anonymously into the total.
  await db.execute(sql`
    INSERT INTO points_valuations (workspace_id, currency, quote, effective_from, minor_per_point, source, note)
    VALUES (${WS}::uuid, 'AA_PT', 'USD', DATE '2000-01-01', 1.4, 'issue-206-example', 'UNCONFIRMED')`);
  await valueTransactionPoints(T5, WS);
  const summary2 = await getSummaryReport({ workspaceId: WS });
  check(
    "an unconfirmed valuation's contribution is quantified",
    summary2.points.unconfirmed_base_minor === 35000,
    `$${(summary2.points.unconfirmed_base_minor / 100).toFixed(2)} of $${(summary2.points.base_minor / 100).toFixed(2)} points spend`,
  );

  const nw = await getNetWorthReport({ workspaceId: WS });
  const pointsAcctInBalances = nw.by_account.some((a) => a.name.includes("points"));
  console.log(`  net worth policy: ${nw.points.policy.slice(0, 72)}…`);
  check("points accounts excluded from net-worth balances", !pointsAcctInBalances);
  check("…but reported in the disclosure", nw.points.programmes.length >= 2, `${nw.points.programmes.length} programmes`);
  check("net worth marks points as NOT included", nw.points.included_in_totals === false);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    void pool.end();
    process.exit(1);
  });
