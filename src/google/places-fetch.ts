/**
 * TS port of the dual-language Google Places v1 fetch that lives in
 * `src/ingest/prompt.ts:213-265` (Phase 3c).
 *
 * The ingest agent does this fetch inside its own `claude -p` session
 * via `curl`. Refresh (#91) needs the same envelope from server-side
 * TypeScript so an admin can re-pull a stale place without spawning
 * an agent.
 *
 * Envelope contract — must match what the ingest prompt writes into
 * `places.raw_response` (Phase 3c → Phase 4 upsert):
 *
 *   {
 *     "v1": {
 *       "en":    <full v1 Place Details body, English>,
 *       "zh-CN": <full v1 Place Details body, Chinese>
 *     },
 *     "fetched_at": "<ISO 8601>"
 *   }
 *
 * Anything that consumes `places.raw_response` already knows this shape
 * (notably `src/projection/derive.ts ::projectPlace` and the older
 * `scripts/backfill-multilingual-places.ts`). Refresh stays
 * shape-compatible so downstream code path is identical to ingest.
 *
 * Field mask `*` mirrors the agent's call — we keep everything so the
 * cached body is the authoritative copy and re-projection can lift
 * new columns out without a re-fetch.
 */

const V1_BASE = "https://places.googleapis.com/v1";

interface FetchOpts {
  /** Per-request timeout (ms). Default 10s. The agent path uses no
   *  explicit timeout — refresh runs synchronously inside an HTTP
   *  request, so we cap it. */
  timeoutMs?: number;
  /** Override for tests; production reads `GOOGLE_MAPS_API_KEY` from env. */
  apiKey?: string;
}

export interface PlaceV1Envelope {
  v1: {
    en: unknown;
    "zh-CN": unknown;
  };
  fetched_at: string;
}

export class GooglePlacesError extends Error {
  constructor(
    public readonly status: number,
    public readonly googlePlaceId: string,
    public readonly languageCode: string,
    public readonly body: string,
  ) {
    super(
      `Google Places v1 returned ${status} for ${googlePlaceId} (${languageCode}): ${body.slice(0, 200)}`,
    );
    this.name = "GooglePlacesError";
  }
}

export class GooglePlacesApiKeyMissing extends Error {
  constructor() {
    super(
      "GOOGLE_MAPS_API_KEY is not set — refresh cannot fetch Google Places v1",
    );
    this.name = "GooglePlacesApiKeyMissing";
  }
}

async function fetchOne(
  googlePlaceId: string,
  languageCode: "en" | "zh-CN",
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const url = `${V1_BASE}/places/${encodeURIComponent(googlePlaceId)}?languageCode=${languageCode}`;
  const resp = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "*",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GooglePlacesError(resp.status, googlePlaceId, languageCode, body);
  }
  return resp.json();
}

/**
 * Fetch `places/{googlePlaceId}` twice (en + zh-CN) and return the
 * envelope ready to be written to `places.raw_response`.
 *
 * Does NOT touch the database. Caller (refreshPlace) is responsible
 * for inserting the `place_snapshots` row and updating `places`.
 */
export async function fetchPlaceV1Dual(
  googlePlaceId: string,
  opts: FetchOpts = {},
): Promise<PlaceV1Envelope> {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new GooglePlacesApiKeyMissing();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Sequential, not parallel. Two reasons:
  // 1. Google's per-request rate limits are friendlier when paced.
  // 2. If the en call already 404s on a bad place_id, we save one
  //    quota unit by short-circuiting.
  const en = await fetchOne(googlePlaceId, "en", apiKey, timeoutMs);
  const zh = await fetchOne(googlePlaceId, "zh-CN", apiKey, timeoutMs);

  return {
    v1: {
      en,
      "zh-CN": zh,
    },
    fetched_at: new Date().toISOString(),
  };
}
