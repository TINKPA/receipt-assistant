/**
 * Re-derive `fx_rate` + `amount_base_minor` for foreign-currency postings
 * already in the ledger (#184), all of them or a targeted subset.
 *
 * Why it exists: the ingest agent's INSERT template wrote
 * `amount_base_minor = amount_minor` unconditionally, so a ¥13,948.80
 * receipt was counted as $13,948.80 by every query that sums
 * `amount_base_minor` — which is all of `src/routes/reports.ts`, the
 * insights queries, and dedup. `src/fx/normalize.ts` fixes this at
 * ingest time; this script fixes rows already in the ledger, and is the
 * only thing that revisits a posting once it has been written.
 *
 * Usage (inside the receipt-assistant container — has $DATABASE_URL):
 *
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --dry-run
 *     docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts
 *
 * Flags:
 *     --dry-run             Print the before/after table; write nothing.
 *     --workspace UUID      Restrict to one workspace (default: all).
 *
 *   Targeting. With none of these, every foreign-currency posting is
 *   re-derived. With one, only the selected postings are written; every
 *   other posting, including other foreign legs of the same transaction,
 *   keeps the rate and base amount it holds.
 *
 *     --exponent-mismatch   Only currencies whose number of decimals
 *                           differs from the workspace base currency's:
 *                           JPY, KRW, VND, KWD … under a USD base. These
 *                           are the rows written before conversion
 *                           respected minor-unit exponents (a yen amount
 *                           was booked at 1/100 of its value, a dinar
 *                           amount at 10 times). Run this once after
 *                           deploying that fix.
 *     --currency A[,B…]     Only these currencies.
 *     --unconverted         Only postings that still have no `fx_rate`,
 *                           i.e. retry the conversions that failed at
 *                           ingest, without touching anything that
 *                           already converted. Combines with either
 *                           flag above.
 *
 *   Supplying a rate the source does not publish:
 *
 *     --rate N              With exactly one `--currency`: where the rate
 *                           source answers that it publishes no rate for
 *                           that currency on a posting's date (TWD, VND,
 *                           KWD …), use N, the value of one whole unit of
 *                           the currency in the base currency. N is
 *                           recorded in `fx_rates` for that date with
 *                           source `manual`, so the conversion is as
 *                           reproducible as a published one. It is never
 *                           used for a date the source does publish.
 *                           Typical use, after an ingest logged "left
 *                           unconverted":
 *                             --unconverted --currency TWD --rate 0.0312
 *
 * Safety:
 *   - Except under `--unconverted`, runs with `force: true`, so it
 *     re-derives even postings that already carry an `fx_rate`. That is
 *     deliberate: rows written before this module existed could carry a
 *     hand-entered rate from the wrong date (the 2026-02-27 CNY row held
 *     0.1389 against a same-day published 0.14581). One rate policy,
 *     applied uniformly.
 *   - One DB transaction per ledger transaction, so an interrupted run
 *     leaves the ledger balanced.
 *   - Idempotent: a second run recomputes the same numbers from the
 *     same cached rates and writes the same values.
 *   - A currency or date the rate source does not publish is reported as
 *     NOT PUBLISHED and left alone. Re-running will not change that; the
 *     posting needs a rate supplied with `--rate`, or its date corrected.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { normalizeTransactionFx } from "../src/fx/normalize.js";
import { FxRateNotPublishedError, getRate } from "../src/fx/rates.js";
import { POINTS_CURRENCY_SQL_RE } from "../src/points/codes.js";
import {
  currencyExponent,
  formatMinor,
  postingFxRate,
  toBaseMinor,
} from "../src/ledger/money.js";

interface Args {
  dryRun: boolean;
  workspaceId: string | null;
  currencies: string[] | null;
  exponentMismatch: boolean;
  unconverted: boolean;
  /** `--rate`: one whole unit of the single `--currency`, in base units. */
  manualRate: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: false,
    workspaceId: null,
    currencies: null,
    exponentMismatch: false,
    unconverted: false,
    manualRate: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--workspace") out.workspaceId = argv[++i] ?? null;
    else if (a === "--exponent-mismatch") out.exponentMismatch = true;
    else if (a === "--unconverted") out.unconverted = true;
    else if (a === "--rate") {
      const raw = argv[++i] ?? "";
      if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
        throw new Error("--rate takes a positive decimal, e.g. --rate 0.0312");
      }
      out.manualRate = raw;
    } else if (a === "--currency") {
      const list = (argv[++i] ?? "")
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      if (list.length === 0 || list.some((c) => !/^[A-Z]{3}$/.test(c))) {
        throw new Error("--currency takes ISO 4217 codes, e.g. --currency JPY,KRW");
      }
      out.currencies = list;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (out.currencies && out.exponentMismatch) {
    throw new Error("--currency and --exponent-mismatch are alternatives; pass one");
  }
  if (out.manualRate !== null && out.currencies?.length !== 1) {
    throw new Error("--rate needs exactly one --currency to apply to");
  }
  return out;
}

/** One line of the report: a transaction's legs in one foreign currency. */
interface Candidate {
  transaction_id: string;
  workspace_id: string;
  occurred_on: string;
  payee: string | null;
  currency: string;
  base_currency: string;
  /** Sum of the positive legs, in the currency's own minor units. */
  amount_minor: string;
  /** What those legs are booked at in the base currency today. */
  amount_base_minor: string;
}

/**
 * Foreign-currency legs grouped by (transaction, currency), measured on
 * the positive side — enough to print a meaningful before/after line.
 * The normalize pass itself operates on every leg.
 *
 * Points legs are excluded (#206): they also differ from the base
 * currency but have no published rate, and handing one to `getRate()`
 * throws by design. They are backfilled by `src/points/valuation.ts`.
 */
async function findCandidates(args: Args): Promise<Candidate[]> {
  const currencyFilter = args.currencies
    ? sql`AND p.currency IN (${sql.join(
        args.currencies.map((c) => sql`${c}`),
        sql`, `,
      )})`
    : sql``;
  // A leg with no rate only matters if it carries an amount: zero
  // converts to zero at any rate.
  const having = args.unconverted
    ? sql`HAVING COUNT(*) FILTER (WHERE p.fx_rate IS NULL AND p.amount_minor <> 0) > 0`
    : sql`HAVING bool_or(p.amount_minor > 0)`;

  const res = await db.execute(sql`
    SELECT t.id            AS transaction_id,
           t.workspace_id  AS workspace_id,
           t.occurred_on   AS occurred_on,
           t.payee         AS payee,
           p.currency      AS currency,
           w.base_currency AS base_currency,
           COALESCE(SUM(p.amount_minor) FILTER (WHERE p.amount_minor > 0), 0)::text
             AS amount_minor,
           COALESCE(SUM(p.amount_base_minor) FILTER (WHERE p.amount_minor > 0), 0)::text
             AS amount_base_minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN workspaces  w ON w.id = t.workspace_id
     WHERE p.currency <> w.base_currency
       AND p.currency !~ ${POINTS_CURRENCY_SQL_RE}
       ${args.workspaceId ? sql`AND t.workspace_id = ${args.workspaceId}::uuid` : sql``}
       ${currencyFilter}
     GROUP BY t.id, t.workspace_id, t.occurred_on, t.payee, p.currency, w.base_currency
     ${having}
     ORDER BY t.occurred_on, t.id, p.currency
  `);
  const rows = res.rows as unknown as Candidate[];
  // The exponent table lives in TypeScript, so this one filter cannot be
  // pushed into the query.
  return args.exponentMismatch
    ? rows.filter(
        (c) => currencyExponent(c.currency) !== currencyExponent(c.base_currency),
      )
    : rows;
}

interface Outcome {
  /** Published rate, whole unit to whole unit. Null when the pass found
   *  nothing to do for this line and so resolved no rate. */
  rate: number | null;
  /** The multiplier stored on the posting. */
  fxRate: string;
  asOfActual: string;
  /** `manual` when the rate came from `--rate`, not a publication. */
  source: string;
  newBase: bigint;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targeted =
    args.currencies !== null || args.exponentMismatch || args.unconverted;
  const candidates = await findCandidates(args);

  if (candidates.length === 0) {
    console.log(
      targeted
        ? "No postings match the selection — nothing to backfill."
        : "No foreign-currency postings found — nothing to backfill.",
    );
    return;
  }

  const txCount = new Set(candidates.map((c) => c.transaction_id)).size;
  const scope = [
    args.exponentMismatch ? "exponent differs from base" : null,
    args.currencies ? `currency in ${args.currencies.join(",")}` : null,
    args.unconverted ? "no fx_rate yet" : null,
  ].filter(Boolean);
  console.log(
    `Found ${txCount} transaction(s) with foreign-currency postings` +
      (scope.length > 0 ? ` (${scope.join("; ")})` : "") +
      (args.dryRun ? " — dry run, nothing will be written" : ""),
  );
  console.log();
  console.log(
    [
      "date".padEnd(11),
      "payee".padEnd(26),
      "original".padStart(18),
      "rate".padStart(11),
      "fx_rate".padStart(11),
      "as-of".padEnd(11),
      "base (new)".padStart(15),
      "base (old)".padStart(13),
      "delta".padStart(13),
    ].join(" "),
  );

  // A transaction is normalized once, however many currencies it has;
  // its lines are then read back per currency.
  const byTransaction = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byTransaction.get(c.transaction_id) ?? [];
    list.push(c);
    byTransaction.set(c.transaction_id, list);
  }

  const totals = new Map<string, { old: bigint; new: bigint }>();
  let failures = 0;
  let notPublished = 0;

  for (const lines of byTransaction.values()) {
    const first = lines[0]!;
    const onDate = String(first.occurred_on).slice(0, 10);
    const label = (first.payee ?? "—").slice(0, 25);

    // Dry run still resolves the rate (and warms the fx_rates cache);
    // it just skips the UPDATE. That makes the printed table a real
    // preview of what the live run will write, not an estimate.
    const run = (): Promise<Map<string, Outcome>> =>
      args.dryRun
        ? previewOnly(lines, onDate)
        : applyAndReread(lines, {
            force: !args.unconverted,
            // Untargeted runs keep the original behaviour: every foreign
            // leg of the transaction is re-derived.
            currencies: targeted ? lines.map((l) => l.currency) : undefined,
          });

    let outcomes: Map<string, Outcome>;
    try {
      try {
        outcomes = await run();
      } catch (err) {
        // `--rate` applies only here: the source has said it has no rate
        // for this currency on this date. A timeout or a 5xx never
        // reaches this branch, so a manual number cannot shadow a rate
        // that exists and was merely unreachable.
        if (!(err instanceof FxRateNotPublishedError) || args.manualRate === null) {
          throw err;
        }
        if (args.dryRun) {
          outcomes = previewManual(lines, args.manualRate, onDate);
        } else {
          await recordManualRate(err.base, err.quote, err.onDate, args.manualRate);
          outcomes = await run();
        }
      }
    } catch (err) {
      const permanent = err instanceof FxRateNotPublishedError;
      if (permanent) notPublished++;
      else failures++;
      console.error(
        `${onDate.padEnd(11)} ${label.padEnd(26)} ` +
          `${permanent ? "NOT PUBLISHED" : "FAILED"}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }

    for (const c of lines) {
      const o = outcomes.get(c.currency);
      if (!o) continue;
      const oldBase = BigInt(c.amount_base_minor);
      const t = totals.get(c.base_currency) ?? { old: 0n, new: 0n };
      t.old += oldBase;
      t.new += o.newBase;
      totals.set(c.base_currency, t);
      console.log(
        [
          onDate.padEnd(11),
          label.padEnd(26),
          `${c.currency} ${formatMinor(c.amount_minor, c.currency)}`.padStart(18),
          (o.rate === null ? "unchanged" : String(o.rate)).padStart(11),
          o.fxRate.padStart(11),
          (o.source === "manual" ? "manual" : o.asOfActual).padEnd(11),
          `${c.base_currency} ${formatMinor(o.newBase, c.base_currency)}`.padStart(15),
          formatMinor(oldBase, c.base_currency).padStart(13),
          formatMinor(o.newBase - oldBase, c.base_currency).padStart(13),
        ].join(" "),
      );
    }
  }

  console.log();
  for (const [base, t] of totals) {
    console.log(
      `Base-currency total (${base}): ${formatMinor(t.old, base)} → ` +
        `${formatMinor(t.new, base)} (delta ${formatMinor(t.new - t.old, base)})`,
    );
  }
  if (notPublished > 0) {
    console.log(
      `${notPublished} transaction(s) are in a currency or on a date the ` +
        `rate source does not publish. Re-running will not convert them; ` +
        `supply a rate with --unconverted --currency CUR --rate N, or ` +
        `correct the date.`,
    );
  }
  if (failures > 0) {
    console.log(
      `${failures} transaction(s) could not be converted — they keep their ` +
        `current values and can be retried by re-running this script.`,
    );
  }
  if (args.dryRun) console.log("Dry run — no rows were modified.");
}

/** Resolve the rates for a transaction's lines without writing anything. */
async function previewOnly(
  lines: Candidate[],
  onDate: string,
): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const c of lines) {
    const r = await getRate(c.currency, c.base_currency, onDate);
    const fxRate = postingFxRate(c.currency, c.base_currency, r.rate);
    out.set(c.currency, {
      rate: r.rate,
      fxRate,
      asOfActual: r.asOfActual,
      source: r.source,
      newBase: toBaseMinor(c.amount_minor, fxRate),
    });
  }
  return out;
}

/** What `--rate` would write for these lines, without writing it. */
function previewManual(
  lines: Candidate[],
  manualRate: string,
  onDate: string,
): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const c of lines) {
    const fxRate = postingFxRate(c.currency, c.base_currency, manualRate);
    out.set(c.currency, {
      rate: Number(manualRate),
      fxRate,
      asOfActual: onDate,
      source: "manual",
      newBase: toBaseMinor(c.amount_minor, fxRate),
    });
  }
  return out;
}

/**
 * Put a hand-supplied rate where the resolver looks first. From then on
 * it is an ordinary cache hit for that currency and date: this run, the
 * ingest of another receipt from the same day, and any later re-derive
 * all get the same number, labelled `manual` in `metadata.fx`.
 */
async function recordManualRate(
  currency: string,
  baseCurrency: string,
  onDate: string,
  manualRate: string,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fx_rates (as_of, base, quote, rate, as_of_actual, source)
        VALUES (${onDate}::date, ${currency}, ${baseCurrency},
                ${manualRate}::numeric, ${onDate}::date, 'manual')
        ON CONFLICT (as_of, base, quote) DO NOTHING`,
  );
}

/** Normalize for real, then read back what actually landed. */
async function applyAndReread(
  lines: Candidate[],
  opts: { force: boolean; currencies: string[] | undefined },
): Promise<Map<string, Outcome>> {
  const first = lines[0]!;
  const res = await normalizeTransactionFx(
    first.transaction_id,
    first.workspace_id,
    opts,
  );
  const after = await db.execute(
    sql`SELECT currency,
               COALESCE(SUM(amount_base_minor) FILTER (WHERE amount_minor > 0), 0)::text AS b,
               MAX(fx_rate)::text AS r
          FROM postings
         WHERE transaction_id = ${first.transaction_id}::uuid
         GROUP BY currency`,
  );
  const landed = new Map(
    (after.rows as Array<{ currency: string; b: string; r: string | null }>).map(
      (row) => [row.currency, row],
    ),
  );
  const out = new Map<string, Outcome>();
  for (const c of lines) {
    const applied = res.applied.find((a) => a.currency === c.currency);
    const row = landed.get(c.currency);
    out.set(c.currency, {
      rate: applied?.rate ?? null,
      fxRate: applied?.fxRate ?? row?.r ?? "—",
      asOfActual: applied?.asOfActual ?? "—",
      source: applied?.source ?? "—",
      newBase: BigInt(row?.b ?? "0"),
    });
  }
  return out;
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    void pool.end();
    process.exit(1);
  });
