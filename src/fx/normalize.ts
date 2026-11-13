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
 * ## Units
 *
 * The rate source quotes whole units (1 JPY = 0.0065 USD); a posting
 * holds minor units, and currencies disagree on how many of those make a
 * whole one. This pass never multiplies the two directly. It asks
 * `src/ledger/money.ts` for the posting's minor-to-minor multiplier
 * (`postingFxRate`), stores that in `fx_rate`, and derives the base
 * amount from it (`toBaseMinor`). The published rate is kept, as quoted,
 * in `metadata.fx.rates[].rate`.
 *
 * Before that module existed the published rate was multiplied straight
 * into the minor amount, which is right only for a currency with the same
 * number of decimals as the base: 5,000 yen at 0.0065 was booked as 33
 * cents instead of 3,250. `scripts/backfill-fx.ts --exponent-mismatch`
 * repairs rows written that way.
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
 *
 * ## Writes only what changes, and leaves a trail when it overwrites
 *
 * A run that computes the numbers the postings already hold writes
 * nothing: no posting, no `metadata.fx`, and so no version bump on the
 * transaction (the `transactions` trigger bumps it on any UPDATE, which
 * would hand a 412 to a client holding the previous ETag for a change
 * that changed nothing).
 *
 * `fx_rate` and `amount_base_minor` are derived values, so overwriting a
 * pair a posting already carried is a re-derivation in the sense of the
 * three-layer model, and it is logged like every other one: a
 * `derivation_events` row (`entity_type = 'transaction'`) with the
 * postings' before and after, inserted in the same DB transaction as the
 * UPDATE. A first conversion (a posting that had no rate yet) is part of
 * ingest and is recorded by `metadata.fx` alone.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { FxRateNotPublishedError, getRate } from "./rates.js";
import { isPointsCurrency } from "../points/codes.js";
import { fxRatesEqual, postingFxRate, toBaseMinor } from "../ledger/money.js";
import { PROMPT_VERSION } from "../ingest/prompt-contract.js";

/** `derivation_events.model` for this pass: arithmetic, no model. */
const FX_DERIVATION_MODEL = "ts-deterministic";

/**
 * The build's git sha for `derivation_events.prompt_git_sha`.
 *
 * `src/generated/build-info.ts` is written by the build and is not in
 * the repository, and this module is also loaded by scripts run straight
 * from a checkout with `tsx`. A static import would make every one of
 * them fail on a tree that has not been built, for the sake of one audit
 * column; so it is looked up when an event is actually written.
 */
async function buildGitSha(): Promise<string> {
  try {
    const mod = await import("../generated/build-info.js");
    return mod.buildInfo.gitSha;
  } catch {
    return "unknown";
  }
}

interface PostingRow {
  id: string;
  amount_minor: string;
  currency: string;
  fx_rate: string | null;
  amount_base_minor: string | null;
}

export interface NormalizeResult {
  /** `false` when nothing was written: the transaction needed no
   *  conversion, or already held exactly what the pass computed. */
  changed: boolean;
  /** Per-currency rates applied, for logging / backfill reports. */
  applied: Array<{
    currency: string;
    /** Published rate, whole unit to whole unit. */
    rate: number;
    /** What `postings.fx_rate` now holds: the minor-to-minor multiplier. */
    fxRate: string;
    asOfActual: string;
    source: string;
  }>;
}

export interface NormalizeOptions {
  /**
   * Re-derive even when `fx_rate` is already populated. Used by the
   * backfill script, because rows written before this module existed
   * could carry a hand-entered rate from the wrong date. Normal ingest
   * leaves existing rates alone.
   */
  force?: boolean;
  /**
   * Restrict the pass to postings in these currencies. Every other leg,
   * foreign or not, keeps the rate and base amount it holds. This is the
   * backfill script's targeted mode: repair the yen legs without
   * re-deriving the yuan ones.
   */
  currencies?: readonly string[];
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
 * Once any in-scope leg needs work, every in-scope leg is re-derived, so
 * all of a transaction's legs in one currency always share one rate.
 */
export async function normalizeTransactionFx(
  transactionId: string,
  workspaceId: string,
  opts: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const base = await baseCurrencyFor(workspaceId);
  if (!base) return NOOP;

  const header = await db.execute(
    sql`SELECT occurred_on,
               metadata->'fx' AS prior_fx,
               metadata->'fx'->'rates' AS prior_rates
          FROM transactions
         WHERE id = ${transactionId}::uuid
           AND workspace_id = ${workspaceId}::uuid`,
  );
  const headerRow = header.rows[0] as
    | { occurred_on: string; prior_fx: unknown; prior_rates: unknown }
    | undefined;
  const occurredOn = headerRow?.occurred_on;
  if (!occurredOn) return NOOP;
  const onDate = String(occurredOn).slice(0, 10);

  const postingsRes = await db.execute(
    sql`SELECT id, amount_minor, currency, fx_rate, amount_base_minor
          FROM postings
         WHERE transaction_id = ${transactionId}::uuid
         ORDER BY id`,
  );
  const postings = postingsRes.rows as unknown as PostingRow[];
  if (postings.length === 0) return NOOP;

  // Points legs are not foreign currency — they are a different KIND of
  // unit, with no published rate to look up (#206). They are excluded
  // here, before `fx_rate IS NULL` is ever consulted, so that marker
  // keeps meaning exactly one thing in the cash domain: "needs conversion
  // at a published rate". `src/points/valuation.ts` owns these legs;
  // whatever base amount it has already written is respected below.
  const only = opts.currencies ? new Set(opts.currencies) : null;
  const inScope = postings.filter(
    (p) =>
      p.currency !== base &&
      !isPointsCurrency(p.currency) &&
      (only === null || only.has(p.currency)),
  );
  if (inScope.length === 0) return NOOP;
  const needsWork = opts.force
    ? inScope
    : inScope.filter((p) => p.fx_rate === null);
  if (needsWork.length === 0) return NOOP;

  // One rate lookup per distinct currency, not per posting. `fxRate` is
  // the published rate moved onto minor units: the number the posting
  // stores, and the only one a minor amount may be multiplied by.
  const rates = new Map<
    string,
    { rate: number; fxRate: string; asOfActual: string; source: string }
  >();
  for (const currency of new Set(inScope.map((p) => p.currency))) {
    const r = await getRate(currency, base, onDate);
    rates.set(currency, { ...r, fxRate: postingFxRate(currency, base, r.rate) });
  }

  // Round every leg, then settle the residual on the largest converted
  // leg so the deferred balance trigger sees a clean sum-to-zero.
  const converted = postings.map((p) => {
    const r = rates.get(p.currency);
    if (r) {
      return {
        id: p.id,
        baseMinor: toBaseMinor(p.amount_minor, r.fxRate),
        fxRate: r.fxRate as string | null,
      };
    }
    if (p.currency === base) {
      return {
        id: p.id,
        baseMinor: BigInt(p.amount_minor),
        fxRate: null as string | null,
      };
    }
    // A points leg (owned by `src/points/valuation.ts`) or a foreign leg
    // outside `opts.currencies`. Not ours to convert, but it still counts
    // toward the residual — the trigger sums every leg, so measuring
    // against a subset would settle the wrong number onto a cash leg.
    return {
      id: p.id,
      baseMinor: BigInt(p.amount_base_minor ?? "0"),
      fxRate: null as string | null,
    };
  });

  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  const residual = converted.reduce((s, c) => s + c.baseMinor, 0n);
  if (residual !== 0n) {
    let target = converted.find((c) => c.fxRate !== null)!;
    for (const c of converted) {
      if (c.fxRate !== null && abs(c.baseMinor) > abs(target.baseMinor)) target = c;
    }
    target.baseMinor -= residual;
  }

  // What would actually change. A posting is written only when its rate
  // or base amount differs from what it holds.
  const current = new Map(postings.map((p) => [p.id, p]));
  const writes = converted.filter((c) => {
    if (c.fxRate === null) return false;
    const p = current.get(c.id)!;
    return (
      p.fx_rate === null ||
      p.amount_base_minor === null ||
      !fxRatesEqual(p.fx_rate, c.fxRate) ||
      BigInt(p.amount_base_minor) !== c.baseMinor
    );
  });

  // Provenance for the UI and for auditing a surprising number later.
  // `fx_rate` on the posting is the multiplier that was applied to the
  // minor amount; this says *which published rate* it came from, which is
  // the part you need when a converted total looks wrong and you want to
  // tell "bad rate" apart from "bad extraction". `rate` is the rate as
  // the source quoted it (whole units, the number to show a person);
  // `posting_fx_rate` is the same rate on minor units, and differs from
  // it exactly when the two currencies have different decimals. Lives on
  // the transaction rather than the posting so it survives in one read
  // alongside `metadata.extraction`.
  //
  // A targeted run converts some currencies and leaves others alone, so
  // the entries for legs it held are carried over, not dropped.
  const priorRates = Array.isArray(headerRow?.prior_rates)
    ? (headerRow.prior_rates as Array<Record<string, unknown>>)
    : [];

  // Nothing to change and the provenance is already there: a true no-op.
  // (A converted currency with no `metadata.fx` entry still gets one
  // written, so every conversion this pass stands behind is explained.)
  const explained = new Set(
    priorRates.map((r) => r?.currency).filter((c) => typeof c === "string"),
  );
  if (writes.length === 0 && [...rates.keys()].every((c) => explained.has(c))) {
    return NOOP;
  }
  const heldCurrencies = new Set(
    postings.filter((p) => !rates.has(p.currency)).map((p) => p.currency),
  );
  const provenance = {
    applied_at: new Date().toISOString(),
    base_currency: base,
    rates: [
      ...priorRates.filter(
        (r) => typeof r?.currency === "string" && heldCurrencies.has(r.currency),
      ),
      ...[...rates.entries()].map(([currency, r]) => ({
        currency,
        rate: r.rate,
        posting_fx_rate: r.fxRate,
        as_of: onDate,
        as_of_actual: r.asOfActual,
        source: r.source,
      })),
    ],
  };

  // Postings whose existing pair is being replaced, as opposed to
  // converted for the first time: those are the re-derivation to log.
  const rederived = writes.filter((c) => current.get(c.id)!.fx_rate !== null);
  const gitSha = rederived.length > 0 ? await buildGitSha() : "";

  await db.transaction(async (tx) => {
    if (rederived.length > 0) {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const c of rederived) {
        const p = current.get(c.id)!;
        before[c.id] = {
          currency: p.currency,
          amount_minor: p.amount_minor,
          fx_rate: p.fx_rate,
          amount_base_minor: p.amount_base_minor,
        };
        after[c.id] = {
          currency: p.currency,
          amount_minor: p.amount_minor,
          fx_rate: c.fxRate,
          amount_base_minor: c.baseMinor.toString(),
        };
      }
      // Before the UPDATE, in the same transaction, like every other
      // derivation event. To roll a run back, write `before.postings`
      // back onto the postings (all of them at once: the balance trigger
      // checks the transaction as a whole) and `before.metadata_fx` onto
      // `metadata.fx`.
      await tx.execute(
        sql`INSERT INTO derivation_events
              (workspace_id, entity_type, entity_id, prompt_version,
               prompt_git_sha, model, before, after, changed_keys)
            VALUES (${workspaceId}::uuid, 'transaction', ${transactionId},
                    ${PROMPT_VERSION}, ${gitSha}, ${FX_DERIVATION_MODEL},
                    ${JSON.stringify({
                      postings: before,
                      metadata_fx: headerRow?.prior_fx ?? null,
                    })}::jsonb,
                    ${JSON.stringify({
                      postings: after,
                      metadata_fx: provenance,
                    })}::jsonb,
                    ARRAY['postings', 'metadata_fx'])`,
      );
    }
    for (const c of writes) {
      await tx.execute(
        sql`UPDATE postings
               SET fx_rate = ${c.fxRate}::numeric,
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
      fxRate: r.fxRate,
      asOfActual: r.asOfActual,
      source: r.source,
    })),
  };
}

/**
 * Worker-facing wrapper: normalize a batch of transaction ids, never
 * throwing. FX is a correction pass, not a gate — a rate lookup failing
 * (source down, brand-new currency pair, a currency the source does not
 * publish) must not turn a successfully extracted receipt into an ingest
 * error. The posting keeps `fx_rate = NULL` and a base amount equal to
 * its native amount. That state is what `scripts/backfill-fx.ts
 * --unconverted` retries, and what every report counts and discloses in
 * its `fx` block, so a total that includes such a leg says so.
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
          .map(
            (a) =>
              `${a.currency}→base @ ${a.rate} (${a.asOfActual}` +
              `${a.fxRate === String(a.rate) ? "" : `, fx_rate ${a.fxRate}`})`,
          )
          .join(", ");
        console.log(`[fx] normalized transaction ${id}: ${summary}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof FxRateNotPublishedError) {
        // Retrying cannot help: the source has no such rate. Say what
        // will, since nothing sweeps this up later. Both remedies end in
        // the backfill script: editing a transaction's date does not
        // re-run this pass.
        console.warn(
          `[fx] transaction ${id} left unconverted: ${message}. ` +
            `Retrying as it stands will not change that. Either supply ` +
            `a rate: scripts/backfill-fx.ts --unconverted --currency ` +
            `${err.base} --rate <1 ${err.base} in ${err.quote}>; or, if ` +
            `the receipt's date is wrong, correct it and then run ` +
            `scripts/backfill-fx.ts --unconverted (changing the date does ` +
            `not convert it by itself). Reports disclose it as ` +
            `unconverted meanwhile.`,
        );
      } else {
        console.warn(
          `[fx] could not normalize transaction ${id}: ${message} — ` +
            `leaving fx_rate NULL; retry with ` +
            `scripts/backfill-fx.ts --unconverted`,
        );
      }
    }
  }
}
