/**
 * Google "Find Place from Text": a free-text query to the one place it
 * most likely names. The server calls it with its own key; no agent does.
 *
 * `src/enrichment/merchants.ts` has an older private copy that also asks
 * for geometry; this one returns only what a caller needs to go on to
 * `fetchPlaceV1Dual`.
 */
const FIND_PLACE_URL = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";

export interface FoundPlace {
  googlePlaceId: string;
  name: string | null;
  formattedAddress: string | null;
  /** Where it is, when Google says. */
  lat: number | null;
  lng: number | null;
}

export class FindPlaceError extends Error {
  constructor(public readonly reason: string) {
    super(`Google Find Place failed: ${reason}`);
    this.name = "FindPlaceError";
  }
}

/** The best candidate for `query`, or null when Google has none. */
export async function findPlaceByText(
  query: string,
  opts: {
    apiKey?: string;
    timeoutMs?: number;
    language?: string;
    /** Prefer places within `radiusM` of this point (a bias, not a filter). */
    locationBias?: { lat: number; lng: number; radiusM: number } | null;
  } = {},
): Promise<FoundPlace | null> {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new FindPlaceError("GOOGLE_MAPS_API_KEY is not set");
  const url = new URL(FIND_PLACE_URL);
  url.searchParams.set("input", query);
  url.searchParams.set("inputtype", "textquery");
  url.searchParams.set("fields", "place_id,name,formatted_address,geometry");
  if (opts.language) url.searchParams.set("language", opts.language);
  if (opts.locationBias) {
    const b = opts.locationBias;
    url.searchParams.set("locationbias", `circle:${Math.round(b.radiusM)}@${b.lat.toFixed(6)},${b.lng.toFixed(6)}`);
  }
  url.searchParams.set("key", apiKey);
  let resp: globalThis.Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  } catch (err) {
    // Never the URL: it carries the key.
    throw new FindPlaceError(err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`) ? "timed out" : "network error");
  }
  if (!resp.ok) throw new FindPlaceError(`HTTP ${resp.status}`);
  const body = (await resp.json()) as {
    status?: string;
    candidates?: {
      place_id?: string;
      name?: string;
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }[];
  };
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status !== "OK") throw new FindPlaceError(`status ${body.status ?? "missing"}`);
  const c = body.candidates?.[0];
  if (!c?.place_id) return null;
  const loc = c.geometry?.location;
  return {
    googlePlaceId: c.place_id,
    name: c.name ?? null,
    formattedAddress: c.formatted_address ?? null,
    lat: typeof loc?.lat === "number" ? loc.lat : null,
    lng: typeof loc?.lng === "number" ? loc.lng : null,
  };
}
