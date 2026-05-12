/**
 * Background enrichment for `merchants` rows (#64).
 *
 * On a poll loop the worker picks up rows with `enrichment_status='pending'`
 * and calls Google Places Find-Place-From-Text with the canonical name,
 * lifting `place_id`, `formatted_address`, `lat`, `lng` onto the row.
 *
 * Why Find-Place-From-Text and not Geocoding: the merchant is a *brand*,
 * not a street address. The Phase 3 receipt-side prompt already uses
 * Geocoding when the receipt prints a full address; this worker covers
 * the case where the merchant page needs a hero map without a per-receipt
 * address (chain merchants in particular).
 *
 * Photos are intentionally not fetched in this pass — they require a
 * second Place Details + Place Photos hop, eat extra quota, and need a
 * caching/proxy layer. The merchant page already has a category-color
 * fallback hero (frontend #33). Photos land in a follow-up.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

const FIND_PLACE_URL =
  "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";

interface PlacesCandidate {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
}

interface PlacesResponse {
  status:
    | "OK"
    | "ZERO_RESULTS"
    | "INVALID_REQUEST"
    | "OVER_QUERY_LIMIT"
    | "REQUEST_DENIED"
    | "UNKNOWN_ERROR";
  candidates?: PlacesCandidate[];
  error_message?: string;
}

interface MerchantRow {
  id: string;
  canonical_name: string;
  enrichment_status: string;
}

async function findPlace(query: string, apiKey: string): Promise<PlacesCandidate | null> {
  const url = new URL(FIND_PLACE_URL);
  url.searchParams.set("input", query);
  url.searchParams.set("inputtype", "textquery");
  url.searchParams.set(
    "fields",
    "place_id,name,formatted_address,geometry",
  );
  url.searchParams.set("key", apiKey);
  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    throw new Error(`Places HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as PlacesResponse;
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status !== "OK") {
    throw new Error(
      `Places status=${body.status}${body.error_message ? `: ${body.error_message}` : ""}`,
    );
  }
  return body.candidates?.[0] ?? null;
}

/**
 * Enrich a single merchant. Idempotent and safe to call concurrently
 * (the UPDATE always touches a single row), but the caller should
 * guarantee no duplicate in-flight requests per merchant — see the
 * poll loop below for the SKIP-LOCKED pattern.
 */
export async function enrichMerchant(
  merchantId: string,
  apiKey: string,
): Promise<"success" | "not_found" | "failed"> {
  const result = await db.execute(
    sql`SELECT id, canonical_name, enrichment_status::text AS enrichment_status
          FROM merchants
         WHERE id = ${merchantId}::uuid`,
  );
  const merchant = result.rows[0] as unknown as MerchantRow | undefined;
  if (!merchant) return "failed";

  try {
    const cand = await findPlace(merchant.canonical_name, apiKey);
    if (!cand) {
      await db.execute(sql`
        UPDATE merchants
           SET enrichment_status = 'not_found',
               enrichment_attempted_at = NOW(),
               updated_at = NOW()
         WHERE id = ${merchantId}::uuid
      `);
      return "not_found";
    }
    const lat = cand.geometry?.location?.lat ?? null;
    const lng = cand.geometry?.location?.lng ?? null;
    await db.execute(sql`
      UPDATE merchants
         SET enrichment_status = 'success',
             enrichment_attempted_at = NOW(),
             place_id = ${cand.place_id ?? null},
             address  = ${cand.formatted_address ?? null},
             lat      = ${lat},
             lng      = ${lng},
             updated_at = NOW()
       WHERE id = ${merchantId}::uuid
    `);
    return "success";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[merchant-enrichment] ${merchantId} failed: ${message}`,
    );
    await db.execute(sql`
      UPDATE merchants
         SET enrichment_status = 'failed',
             enrichment_attempted_at = NOW(),
             updated_at = NOW()
       WHERE id = ${merchantId}::uuid
    `);
    return "failed";
  }
}

/**
 * Pick up to `limit` merchants needing enrichment and process them.
 * Picks `pending` rows unconditionally and `failed` rows that haven't
 * been retried in the last hour.
 */
export async function runEnrichmentBatch(
  apiKey: string,
  limit = 10,
): Promise<{ processed: number; success: number; not_found: number; failed: number }> {
  const rows = (
    await db.execute(sql`
      SELECT id FROM merchants
       WHERE enrichment_status = 'pending'
          OR (enrichment_status = 'failed'
              AND (enrichment_attempted_at IS NULL
                   OR enrichment_attempted_at < NOW() - INTERVAL '1 hour'))
       ORDER BY created_at ASC
       LIMIT ${limit}
    `)
  ).rows as Array<{ id: string }>;

  const totals = { processed: 0, success: 0, not_found: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await enrichMerchant(row.id, apiKey);
    totals.processed += 1;
    totals[outcome] += 1;
  }
  return totals;
}

/**
 * Wire a background poller into the process. Returns the timer handle
 * so the caller can `clearInterval` on shutdown.
 *
 * Polls every `intervalMs` (default 30s). Silently no-ops when
 * `GOOGLE_MAPS_API_KEY` is unset, so dev environments without a key
 * don't crash on startup.
 */
export function startMerchantEnrichmentLoop(opts: {
  apiKey?: string;
  intervalMs?: number;
  batchSize?: number;
} = {}): NodeJS.Timeout | null {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.log(
      "[merchant-enrichment] GOOGLE_MAPS_API_KEY unset — enrichment loop disabled",
    );
    return null;
  }
  const interval = opts.intervalMs ?? 30_000;
  const limit = opts.batchSize ?? 10;
  console.log(
    `[merchant-enrichment] polling every ${interval}ms, batch size ${limit}`,
  );
  // Run once on boot so newly-applied migrations get processed without
  // waiting for the first tick.
  void runEnrichmentBatch(apiKey, limit).catch((err) => {
    console.error("[merchant-enrichment] initial batch failed:", err);
  });
  return setInterval(() => {
    runEnrichmentBatch(apiKey, limit).catch((err) => {
      console.error("[merchant-enrichment] batch failed:", err);
    });
  }, interval);
}
