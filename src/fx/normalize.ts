/**
 * Convert a transaction's foreign-currency postings into the workspace
 * base currency (#184).
 *
 * ## Why this exists as a separate pass
 *
 * The ingest agent writes its own SQL (see `src/ingest/prompt.ts`), and
 * its INSERT template hard-coded `amount_base_minor = amount_minor` for
 * every posting regardless of currency. Every non-USD receipt therefore
 * landed with `fx_rate = NULL` and a base amount that treated 1 CNY as
 * 1 USD — which silently inflated every report that sums
 * `amount_base_minor` (all of `src/routes/reports.ts`, the insights
 * queries, and the dedup totals).
 *
 * The fix deliberately does *not* teach the agent to do FX. An LLM has no
 * reliable rate source, and putting an HTTP call in the extraction prompt
 * makes an already long agent turn longer and flakier. Instead the agent
 * writes the receipt's own numbers (which it can read off the paper) and
 * the worker normalizes afterwards — the same "don't trust the agent,
 * verify and self-heal" shape as the #125 / #133 / #134 guards it sits
 * next to in `src/ingest/worker.ts`.
 *
 * ## Balance safety
 *
 * `postings_balance_ck` (drizzle/0001) is a DEFERRABLE constraint trigger
 * that requires `SUM(amount_base_minor) = 0` per transaction at COMMIT.
 * Scaling every leg by the same rate preserves that in exact arithmetic,
 * but independent rounding can leave a ±1-minor-unit residual on a
 * transaction with three or more legs. We therefore round each leg, then
 * push the whole residual onto the largest converted leg before writing.
 * All legs update inside one transaction so the trigger sees the finished
 * state.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getRate } from "./rates.js";

interface PostingRow {
  id: string;
  amount_minor: string;
  currency: string;
  fx_rate: string | null;
}

export interface NormalizeResult {
  /** `false` when the transaction needed no conversion — see `NOOP`. */
  changed: boolean;
  /** Per-currency rates applied, for logging / backfill reports. */
  applied: Array<{
    currency: string;
    rate: number;
    asOfActual: string;
    source: string;
  }>;
}

const NOOP: NormalizeResult = { changed: false, applied: [] };

async function baseCurrencyFor(workspaceId: string): Promise<string | null> {
  const res = await db.execute(
    sql`SELECT base_currency FROM workspaces WHERE id = ${workspaceId}::uuid`,
  );
  const row = res.rows[0] as { base_currency: string } | undefined;
  return row?.base_currency ?? null;
}

/**
 * Fill in `fx_rate` + `amount_base_minor` for every posting of
 * `transactionId` whose currency differs from the workspace base
 * currency.
 *
 * @param force  Re-derive even when `fx_rate` is already populated. Used
 *               by the backfill script, because rows written before this
 *               module existed could carry a hand-entered rate from the
 *               wrong date. Normal ingest leaves existing rates alone.
 */
export async function normalizeTransactionFx(
  transactionId: string,
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<NormalizeResult> {
  const base = await baseCurrencyFor(workspaceId);
  if (!base) return NOOP;

  const header = await db.execute(
    sql`SELECT occurred_on FROM transactions
         WHERE id = ${transactionId}::uuid
           AND workspace_id = ${workspaceId}::uuid`,
  );
  const occurredOn = (header.rows[0] as { occurred_on: string } | undefined)
    ?.occurred_on;
  if (!occurredOn) return NOOP;
  const onDate = String(occurredOn).slice(0, 10);

  const postingsRes = await db.execute(
    sql`SELECT id, amount_minor, currency, fx_rate
          FROM postings
         WHERE transaction_id = ${transactionId}::uuid
         ORDER BY id`,
  );
  const postings = postingsRes.rows as unknown as PostingRow[];
  if (postings.length === 0) return NOOP;

  const foreign = postings.filter((p) => p.currency !== base);
  if (foreign.length === 0) return NOOP;
  const needsWork = opts.force
    ? foreign
    : foreign.filter((p) => p.fx_rate === null);
  if (needsWork.length === 0) return NOOP;

  // One rate lookup per distinct currency, not per posting.
  const rates = new Map<
    string,
    { rate: number; asOfActual: string; source: string }
  >();
  for (const currency of new Set(foreign.map((p) => p.currency))) {
    rates.set(currency, await getRate(currency, base, onDate));
  }

  // Round every leg, then settle the residual on the largest converted
  // leg so the deferred balance trigger sees a clean sum-to-zero.
  const converted = postings.map((p) => {
    const minor = BigInt(p.amount_minor);
    if (p.currency === base) {
      return { id: p.id, baseMinor: minor, rate: null as number | null };
    }
    const r = rates.get(p.currency)!;
    return {
      id: p.id,
      baseMinor: BigInt(Math.round(Number(minor) * r.rate)),
      rate: r.rate as number | null,
    };
  });

  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  const residual = converted.reduce((s, c) => s + c.baseMinor, 0n);
  if (residual !== 0n) {
    let target = converted.find((c) => c.rate !== null)!;
    for (const c of converted) {
      if (c.rate !== null && abs(c.baseMinor) > abs(target.baseMinor)) target = c;
    }
    target.baseMinor -= residual;
  }

  // Provenance for the UI and for auditing a surprising number later.
  // `fx_rate` on the posting says *what* rate was used; this says *which
  // published rate* it was, which is the part you need when a converted
  // total looks wrong and you want to tell "bad rate" apart from "bad
  // extraction". Lives on the transaction rather than the posting so it
  // survives in one read alongside `metadata.extraction`.
  const provenance = {
    applied_at: new Date().toISOString(),
    base_currency: base,
    rates: [...rates.entries()].map(([currency, r]) => ({
      currency,
      rate: r.rate,
      as_of: onDate,
      as_of_actual: r.asOfActual,
      source: r.source,
    })),
  };

  await db.transaction(async (tx) => {
    for (const c of converted) {
      if (c.rate === null) continue;
      await tx.execute(
        sql`UPDATE postings
               SET fx_rate = ${c.rate}::numeric,
                   amount_base_minor = ${c.baseMinor.toString()}::bigint
             WHERE id = ${c.id}::uuid`,
      );
    }
    await tx.execute(
      sql`UPDATE transactions
             SET metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{fx}',
                   ${JSON.stringify(provenance)}::jsonb,
                   true)
           WHERE id = ${transactionId}::uuid
             AND workspace_id = ${workspaceId}::uuid`,
    );
  });

  return {
    changed: true,
    applied: [...rates.entries()].map(([currency, r]) => ({
      currency,
      rate: r.rate,
      asOfActual: r.asOfActual,
      source: r.source,
    })),
  };
}

/**
 * Worker-facing wrapper: normalize a batch of transaction ids, never
 * throwing. FX is a correction pass, not a gate — a rate lookup failing
 * (source down, brand-new currency pair) must not turn a successfully
 * extracted receipt into an ingest error. The posting keeps `fx_rate =
 * NULL`, which is exactly the marker the backfill script looks for.
 */
export async function normalizeFxSafely(
  transactionIds: string[],
  workspaceId: string,
): Promise<void> {
  for (const id of transactionIds) {
    try {
      const res = await normalizeTransactionFx(id, workspaceId);
      if (res.changed) {
        const summary = res.applied
          .map((a) => `${a.currency}→base @ ${a.rate} (${a.asOfActual})`)
          .join(", ");
        console.log(`[fx] normalized transaction ${id}: ${summary}`);
      }
    } catch (err) {
      console.warn(
        `[fx] could not normalize transaction ${id}: ` +
          `${err instanceof Error ? err.message : String(err)} — ` +
          `leaving fx_rate NULL for the backfill pass`,
      );
    }
  }
}
