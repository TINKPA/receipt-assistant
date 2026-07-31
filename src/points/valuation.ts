/**
 * Value a transaction's loyalty-points postings in the workspace base
 * currency (#206).
 *
 * ## Why this is a separate pass from FX, not a branch inside it
 *
 * `src/fx/normalize.ts` and this module do the same *shape* of work —
 * fill `fx_rate` + `amount_base_minor` after the extraction agent has
 * written the document's own numbers — but they answer different
 * questions from different authorities:
 *
 *   FX      "what was 1 CNY worth on 2026-04-12?"   ECB publication
 *   points  "what is 1 Hyatt point worth to me?"    the owner's judgement
 *
 * Merging them would put a made-up number and a published number behind
 * one code path, and the first time someone loosened a filter a points
 * code would be handed to the FX resolver. Keeping them apart makes the
 * separation checkable: the two passes select **disjoint sets of
 * postings** by currency shape (`src/points/codes.ts`), and
 * `getRate()` in `src/fx/rates.ts` throws outright if it is ever handed a
 * points code.
 *
 * ## The `fx_rate` marker, and why this pass does not reuse it
 *
 * In the cash domain `fx_rate IS NULL` means "needs conversion at a
 * published rate" — it is what `scripts/backfill-fx.ts` looks for. That
 * meaning is untouched here, because the FX pass never selects a points
 * leg. Within the *points* domain the column carries its own three-state
 * marker:
 *
 *   NULL      the valuation pass has not run on this leg yet; the base
 *             amount is still the agent's placeholder and must not be
 *             trusted (this is the points backfill marker)
 *   0         the pass ran and found NO valuation configured for the
 *             programme → base 0, and the leg is reported as `unvalued`
 *   > 0       base = round(points × rate), with provenance on the
 *             transaction's `metadata.points`
 *
 * Zero is re-tryable: adding a valuation and re-running picks those legs
 * back up without `force`. Zero is also honest — base *is* 0 for those
 * legs — and it is unambiguous, which a second NULL state would not be.
 *
 * ## Balance safety
 *
 * `postings_balance_ck` requires every posting to have a non-null
 * `amount_base_minor` and the per-transaction sum to be 0 at COMMIT. A
 * points pair scales by one rate so it stays balanced in exact
 * arithmetic; independent rounding on 3+ legs can leave a ±1 residual, so
 * the whole residual is pushed onto the largest points leg before
 * writing. Cash legs are never touched — the FX pass owns those, and the
 * residual is measured against their values as they stand.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { isPointsCurrency } from "./codes.js";

interface PostingRow {
  id: string;
  amount_minor: string;
  currency: string;
  fx_rate: string | null;
  amount_base_minor: string | null;
}

export interface ResolvedValuation {
  /** Points currency, e.g. `HYATT_PT`. */
  currency: string;
  /** Base-currency minor units per one point. */
  minorPerPoint: number;
  effectiveFrom: string;
  source: string;
  /** `false` when the owner has not signed off on the number yet. */
  confirmed: boolean;
}

export interface ValuePointsResult {
  changed: boolean;
  applied: ResolvedValuation[];
  /** Programme codes seen on this transaction with no valuation row. */
  unvalued: string[];
}

const NOOP: ValuePointsResult = { changed: false, applied: [], unvalued: [] };

async function baseCurrencyFor(workspaceId: string): Promise<string | null> {
  const res = await db.execute(
    sql`SELECT base_currency FROM workspaces WHERE id = ${workspaceId}::uuid`,
  );
  const row = res.rows[0] as { base_currency: string } | undefined;
  return row?.base_currency ?? null;
}

/**
 * The valuation in force for `currency` on `onDate`: the newest row whose
 * `effective_from` is on or before that date. Returns `null` when the
 * programme has no valuation configured at all — the caller must treat
 * that as a visible `unvalued` state, never as "worth nothing".
 */
export async function resolvePointsValuation(
  workspaceId: string,
  currency: string,
  quote: string,
  onDate: string,
): Promise<ResolvedValuation | null> {
  const res = await db.execute(
    sql`SELECT effective_from, minor_per_point, source, confirmed_at
          FROM points_valuations
         WHERE workspace_id = ${workspaceId}::uuid
           AND currency = ${currency}
           AND quote = ${quote}
           AND effective_from <= ${onDate}::date
         ORDER BY effective_from DESC
         LIMIT 1`,
  );
  const row = res.rows[0] as
    | {
        effective_from: string;
        minor_per_point: string;
        source: string;
        confirmed_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    currency,
    minorPerPoint: Number(row.minor_per_point),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    source: row.source,
    confirmed: row.confirmed_at !== null,
  };
}

/**
 * Fill `fx_rate` + `amount_base_minor` for every points posting of
 * `transactionId`.
 *
 * @param force  Re-derive even legs that already carry a rate. Used after
 *               the owner confirms or changes a valuation, to re-value
 *               history that was priced at the old number.
 */
export async function valueTransactionPoints(
  transactionId: string,
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<ValuePointsResult> {
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
    sql`SELECT id, amount_minor, currency, fx_rate, amount_base_minor
          FROM postings
         WHERE transaction_id = ${transactionId}::uuid
         ORDER BY id`,
  );
  const postings = postingsRes.rows as unknown as PostingRow[];
  if (postings.length === 0) return NOOP;

  const pointsLegs = postings.filter((p) => isPointsCurrency(p.currency));
  if (pointsLegs.length === 0) return NOOP;

  // `fx_rate = 0` means "ran, no valuation configured" — always re-tried,
  // so configuring a valuation later picks the leg up without `force`.
  const needsWork = opts.force
    ? pointsLegs
    : pointsLegs.filter((p) => p.fx_rate === null || Number(p.fx_rate) === 0);
  if (needsWork.length === 0) return NOOP;

  // One valuation lookup per distinct programme, not per posting.
  const valuations = new Map<string, ResolvedValuation | null>();
  for (const currency of new Set(pointsLegs.map((p) => p.currency))) {
    valuations.set(
      currency,
      await resolvePointsValuation(workspaceId, currency, base, onDate),
    );
  }

  // Cash legs keep whatever they hold (the FX pass owns them); points
  // legs get the new value. The residual is measured across everything so
  // the deferred balance trigger sees a clean sum-to-zero.
  const priced = postings.map((p) => {
    const minor = BigInt(p.amount_minor);
    if (!isPointsCurrency(p.currency)) {
      return {
        id: p.id,
        baseMinor: BigInt(p.amount_base_minor ?? "0"),
        rate: null as number | null,
        isPoints: false,
      };
    }
    const v = valuations.get(p.currency) ?? null;
    const rate = v?.minorPerPoint ?? 0;
    return {
      id: p.id,
      baseMinor: BigInt(Math.round(Number(minor) * rate)),
      rate,
      isPoints: true,
    };
  });

  const abs = (v: bigint): bigint => (v < 0n ? -v : v);
  const residual = priced.reduce((s, c) => s + c.baseMinor, 0n);
  if (residual !== 0n) {
    const pointsPriced = priced.filter((c) => c.isPoints);
    let target = pointsPriced[0]!;
    for (const c of pointsPriced) {
      if (abs(c.baseMinor) > abs(target.baseMinor)) target = c;
    }
    target.baseMinor -= residual;
  }

  const applied: ResolvedValuation[] = [];
  const unvalued: string[] = [];
  for (const [currency, v] of valuations) {
    if (v) applied.push(v);
    else unvalued.push(currency);
  }

  // Provenance on the transaction, mirroring `metadata.fx` (#184). This
  // is what answers "why is this stay $688.50?" a year from now, and it
  // is where `confirmed: false` is recorded per applied valuation so a
  // report can say how much of a total rests on an unconfirmed number.
  const provenance = {
    applied_at: new Date().toISOString(),
    base_currency: base,
    valuations: applied.map((v) => ({
      currency: v.currency,
      minor_per_point: v.minorPerPoint,
      effective_from: v.effectiveFrom,
      source: v.source,
      confirmed: v.confirmed,
    })),
    unvalued,
  };

  await db.transaction(async (tx) => {
    for (const c of priced) {
      if (!c.isPoints) continue;
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
                   '{points}',
                   ${JSON.stringify(provenance)}::jsonb,
                   true)
           WHERE id = ${transactionId}::uuid
             AND workspace_id = ${workspaceId}::uuid`,
    );
  });

  return { changed: true, applied, unvalued };
}

/**
 * Worker-facing wrapper: value a batch of transaction ids, never
 * throwing. Same contract as `normalizeFxSafely` — valuation is a
 * correction pass, not a gate. A failure leaves `fx_rate NULL` on the
 * points legs, which is the marker a re-run looks for.
 */
export async function valuePointsSafely(
  transactionIds: string[],
  workspaceId: string,
): Promise<void> {
  for (const id of transactionIds) {
    try {
      const res = await valueTransactionPoints(id, workspaceId);
      if (!res.changed) continue;
      const parts = res.applied.map(
        (v) =>
          `${v.currency}→base @ ${v.minorPerPoint}/pt` +
          `${v.confirmed ? "" : " (UNCONFIRMED)"}`,
      );
      if (res.unvalued.length > 0) {
        parts.push(`unvalued: ${res.unvalued.join(", ")}`);
      }
      console.log(`[points] valued transaction ${id}: ${parts.join(", ")}`);
    } catch (err) {
      console.warn(
        `[points] could not value transaction ${id}: ` +
          `${err instanceof Error ? err.message : String(err)} — ` +
          `leaving fx_rate NULL for a later pass`,
      );
    }
  }
}
