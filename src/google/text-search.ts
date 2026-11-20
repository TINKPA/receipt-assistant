/**
 * Google Places API (New) Text Search: a free-text query to a short list
 * of places, for a person to pick from (`GET /v1/wish-items/place-search`).
 * The server calls it with its own key; no agent does.
 *
 * `find-place.ts` answers "the one place this text most likely names" and
 * is used where nobody is there to choose; this one returns candidates.
 * The key travels in a header, never in a URL, and no error message here
 * carries either.
 */
const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.primaryType",
  "places.location",
].join(",");

export interface TextSearchCandidate {
  google_place_id: string;
  name: string | null;
  formatted_address: string | null;
  rating: number | null;
  user_rating_count: number | null;
  primary_type: string | null;
  /** Where it is; used to rank, not part of the API answer. */
  lat: number | null;
  lng: number | null;
  /** Google's structured address, only when `withAddressComponents` asked
   *  for it; not part of the API answer. */
  address_components?: GoogleAddressComponent[];
}

/** One part of Google's structured address: "Brooklyn", with its types
 *  (`sublocality_level_1`, `sublocality`, `political`). */
export interface GoogleAddressComponent {
  long: string;
  short: string;
  types: string[];
}

/** Places API (New) `addressComponents` to `GoogleAddressComponent`s. */
export function toAddressComponents(raw: unknown): GoogleAddressComponent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: { longText?: unknown; shortText?: unknown; types?: unknown }) => ({
      long: typeof c?.longText === "string" ? c.longText : "",
      short: typeof c?.shortText === "string" ? c.shortText : "",
      types: Array.isArray(c?.types) ? c.types.filter((t): t is string => typeof t === "string") : [],
    }))
    .filter((c) => c.long || c.short);
}

export class TextSearchKeyMissing extends Error {
  constructor() {
    super("GOOGLE_MAPS_API_KEY is not set");
    this.name = "TextSearchKeyMissing";
  }
}

export class TextSearchError extends Error {
  /** `status` is Google's HTTP status, or 0 for a network error or timeout. */
  constructor(public readonly status: number, public readonly reason: string) {
    super(`Google Text Search failed: ${reason}`);
    this.name = "TextSearchError";
  }
}

export async function searchPlacesByText(
  textQuery: string,
  opts: {
    apiKey?: string;
    maxResults?: number;
    timeoutMs?: number;
    languageCode?: string;
    /** Prefer places within `radiusM` (at most 50 km) of this point. */
    locationBias?: { lat: number; lng: number; radiusM: number } | null;
    /** Also return each place's structured address (`address_components`). */
    withAddressComponents?: boolean;
  } = {},
): Promise<TextSearchCandidate[]> {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new TextSearchKeyMissing();
  const body: Record<string, unknown> = { textQuery, pageSize: opts.maxResults ?? 5 };
  if (opts.languageCode) body.languageCode = opts.languageCode;
  if (opts.locationBias) {
    const b = opts.locationBias;
    body.locationBias = {
      circle: { center: { latitude: b.lat, longitude: b.lng }, radius: Math.min(50_000, Math.max(1, b.radiusM)) },
    };
  }
  let resp: globalThis.Response;
  try {
    resp = await fetch(TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": opts.withAddressComponents ? `${FIELD_MASK},places.addressComponents` : FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (err) {
    throw new TextSearchError(0, err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`) ? "timed out" : "network error");
  }
  if (!resp.ok) {
    // Google's error body names the problem (`API_KEY_INVALID`, quota);
    // its `status` word is safe to pass on, the rest stays in the log.
    const text = await resp.text().catch(() => "");
    let word: string | null = null;
    try {
      word = (JSON.parse(text) as { error?: { status?: string } }).error?.status ?? null;
    } catch {
      /* not JSON */
    }
    console.warn(`[google] text search HTTP ${resp.status}: ${text.slice(0, 300).replace(/AIza[0-9A-Za-z_-]{20,}/g, "<key>")}`);
    throw new TextSearchError(resp.status, `HTTP ${resp.status}${word ? ` ${word}` : ""}`);
  }
  const json = (await resp.json()) as {
    places?: {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      rating?: number;
      userRatingCount?: number;
      primaryType?: string;
      location?: { latitude?: number; longitude?: number };
      addressComponents?: unknown;
    }[];
  };
  return (json.places ?? [])
    .filter((p) => typeof p.id === "string" && p.id !== "")
    .slice(0, opts.maxResults ?? 5)
    .map((p) => ({
      google_place_id: p.id!,
      name: p.displayName?.text ?? null,
      formatted_address: p.formattedAddress ?? null,
      rating: typeof p.rating === "number" ? p.rating : null,
      user_rating_count: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      primary_type: p.primaryType ?? null,
      lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
      lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
      ...(opts.withAddressComponents ? { address_components: toAddressComponents(p.addressComponents) } : {}),
    }));
}
