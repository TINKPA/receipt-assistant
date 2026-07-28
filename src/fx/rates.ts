/**
 * FX rate resolution (#184).
 *
 * One job: given (base, quote, date) return the rate that converts 1 unit
 * of `base` into `quote` **as published on that date**. Everything that
 * writes `postings.fx_rate` / `postings.amount_base_minor` goes through
 * here so the whole ledger shares one rate policy and one audit trail.
 *
 * Source is the ECB reference rates via Frankfurter (no API key, has
 * history, publishes the date it actually served). ECB quotes against EUR
 * and Frankfurter does the cross-rate; for CNY→USD that is two ECB legs,
 * which is fine for a personal ledger — these are reference rates, not the
 * card network's settlement rate, and the point is a stable, reproducible,
 * auditable number rather than a to-the-cent match with the statement.
 *
 * Rates are cached in `fx_rates` keyed by the **requested** date, so a
 * repeat lookup is a single point-read and a historical conversion is
 * reproducible forever. One exception, handled below: a request for a very
 * recent date that resolved to an earlier publication is *provisional* —
 * ECB may simply not have published yet today — so it is not cached.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

/** Frankfurter base URL. Read per call, not at module load, so a test can
 *  point it at a dead host to exercise the offline fallback path. */
function fxApiBase(): string {
  return process.env.FX_API_BASE ?? "https://api.frankfurter.dev/v1";
}
const FX_SOURCE = "frankfurter/ecb";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * The upstream is a free public service and it is measurably flaky under
 * a burst: a backfill of ~30 rows saw a Cloudflare 522 and a run of
 * timeouts even though a single cold request from the same container
 * completes in ~120ms. So: retry, and pace consecutive upstream calls.
 *
 * Both matter for the same reason — a rate that fails to resolve leaves
 * a posting counted at 1:1, which is the exact bug this module exists to
 * prevent. Being slow is free; being wrong is not.
 */
const FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [400, 1500];
const MIN_GAP_BETWEEN_FETCHES_MS = 150;

let lastFetchAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How far back the offline fallback will reach for a cached rate when the
 * upstream source is unreachable. 10 days clears any ECB holiday gap
 * (longest is the Christmas/New Year stretch) without silently applying a
 * rate from a different month.
 */
const OFFLINE_FALLBACK_DAYS = 10;

/**
 * A resolved rate plus the provenance needed to explain it in the UI.
 */
export interface ResolvedRate {
  /** 1 unit of `base` in `quote`. */
  rate: number;
  /** Publication date actually used (<= the requested date). */
  asOfActual: string;
  source: string;
}

/** Days between two ISO dates (a - b), calendar days, UTC-safe. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readCache(
  base: string,
  quote: string,
  onDate: string,
): Promise<ResolvedRate | null> {
  const res = await db.execute(
    sql`SELECT rate, as_of_actual, source
          FROM fx_rates
         WHERE as_of = ${onDate}::date
           AND base = ${base}
           AND quote = ${quote}`,
  );
  const row = res.rows[0] as
    | { rate: string; as_of_actual: string; source: string }
    | undefined;
  if (!row) return null;
  return {
    rate: Number(row.rate),
    asOfActual: String(row.as_of_actual).slice(0, 10),
    source: row.source,
  };
}

/**
 * Last resort when the upstream source is unreachable: the newest cached
 * rate for this pair at or before `onDate`, within the fallback window.
 * Returned with its own `asOfActual`, so the staleness is visible rather
 * than laundered into the requested date.
 */
async function readNearestCache(
  base: string,
  quote: string,
  onDate: string,
): Promise<ResolvedRate | null> {
  const res = await db.execute(
    sql`SELECT rate, as_of_actual, source
          FROM fx_rates
         WHERE base = ${base}
           AND quote = ${quote}
           AND as_of <= ${onDate}::date
           AND as_of >= ${onDate}::date - ${sql.raw(String(OFFLINE_FALLBACK_DAYS))}
         ORDER BY as_of DESC
         LIMIT 1`,
  );
  const row = res.rows[0] as
    | { rate: string; as_of_actual: string; source: string }
    | undefined;
  if (!row) return null;
  return {
    rate: Number(row.rate),
    asOfActual: String(row.as_of_actual).slice(0, 10),
    source: `${row.source} (stale)`,
  };
}

async function fetchOnce(
  url: string,
  quote: string,
  onDate: string,
): Promise<ResolvedRate> {
  const gap = Date.now() - lastFetchAt;
  if (gap < MIN_GAP_BETWEEN_FETCHES_MS) {
    await sleep(MIN_GAP_BETWEEN_FETCHES_MS - gap);
  }
  lastFetchAt = Date.now();

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`FX source ${url} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    date?: string;
    rates?: Record<string, number>;
  };
  const rate = body.rates?.[quote];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX source ${url} returned no usable rate for ${quote}`);
  }
  return { rate, asOfActual: body.date ?? onDate, source: FX_SOURCE };
}

async function fetchUpstream(
  base: string,
  quote: string,
  onDate: string,
): Promise<ResolvedRate> {
  const url = `${fxApiBase()}/${onDate}?base=${base}&symbols=${quote}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url, quote, onDate);
    } catch (err) {
      lastErr = err;
      const backoff = RETRY_BACKOFF_MS[attempt];
      if (backoff === undefined) break;
      console.warn(
        `[fx] ${base}→${quote} @ ${onDate} attempt ${attempt + 1} failed ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Resolve `base` → `quote` on `onDate` (ISO `YYYY-MM-DD`).
 *
 * Order: identity → cache → upstream (+cache) → stale cache. Throws only
 * when all four miss, which means a brand-new currency pair encountered
 * while offline; callers treat that as "leave the posting unconverted and
 * retry later" rather than failing the ingest.
 */
export async function getRate(
  base: string,
  quote: string,
  onDate: string,
): Promise<ResolvedRate> {
  if (base === quote) {
    return { rate: 1, asOfActual: onDate, source: "identity" };
  }

  const cached = await readCache(base, quote, onDate);
  if (cached) return cached;

  let resolved: ResolvedRate;
  try {
    resolved = await fetchUpstream(base, quote, onDate);
  } catch (err) {
    const stale = await readNearestCache(base, quote, onDate);
    if (stale) {
      console.warn(
        `[fx] upstream unavailable for ${base}→${quote} @ ${onDate} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to cached rate from ${stale.asOfActual}`,
      );
      return stale;
    }
    throw err;
  }

  // Don't cache a *provisional* answer. Asking for today (or yesterday)
  // before ECB's ~16:00 CET publication resolves to an earlier day; that
  // is the right rate to use right now but the wrong one to freeze, since
  // the real publication lands hours later. Anything older than the
  // publication lag is settled: a gap there is a weekend or holiday and
  // will never fill in.
  const lag = daysBetween(todayIso(), onDate);
  const provisional = resolved.asOfActual < onDate && lag <= 2;
  if (!provisional) {
    await db.execute(
      sql`INSERT INTO fx_rates (as_of, base, quote, rate, as_of_actual, source)
          VALUES (${onDate}::date, ${base}, ${quote}, ${resolved.rate}::numeric,
                  ${resolved.asOfActual}::date, ${resolved.source})
          ON CONFLICT (as_of, base, quote) DO NOTHING`,
    );
  }
  return resolved;
}
