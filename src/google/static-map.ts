/**
 * Google Static Maps proxy + filesystem cache (#96).
 *
 * Why proxy instead of redirect: the API key stays server-side, and
 * we get a free CDN-style cache on first hit. Filesystem cache
 * (matching the existing `place_photos` pattern in
 * `src/enrichment/places.ts` and `documents.ts`) is sufficient at
 * current scale; MinIO blob store was specced in #96 but deferred
 * — same value at higher complexity.
 *
 * Key shape: `(google_place_id, lat, lng, size, zoom, marker)` →
 * one PNG. Lat/lng are part of the key because they're the actual
 * Google input; if a place's lat/lng ever changes (re-fetch, manual
 * fix) the cache key naturally rotates.
 */
import { createHash } from "crypto";
import { mkdir, stat, writeFile } from "fs/promises";
import path from "path";

const STATIC_MAP_BASE = "https://maps.googleapis.com/maps/api/staticmap";

export interface StaticMapOpts {
  /** "WIDTHxHEIGHT" pre-scale. Final image is 2× this. Default 128x128. */
  size?: string;
  zoom?: number;
  marker?: boolean;
}

const DEFAULTS = {
  size: "128x128",
  zoom: 15,
  marker: true,
} as const;

/** Recognized output-size cap (post-Google's own 640px limit on
 *  scale=2 is 1280). We accept up to 512x512 pre-scale; bigger is
 *  rejected to keep quota bounded. */
const MAX_DIM = 512;

export class StaticMapOptsInvalid extends Error {
  constructor(reason: string) {
    super(`Invalid static-map options: ${reason}`);
    this.name = "StaticMapOptsInvalid";
  }
}

export class GoogleStaticMapsApiKeyMissing extends Error {
  constructor() {
    super(
      "GOOGLE_MAPS_API_KEY is not set — static-map endpoint cannot fetch from Google",
    );
    this.name = "GoogleStaticMapsApiKeyMissing";
  }
}

export class GoogleStaticMapsError extends Error {
  constructor(
    public readonly status: number,
    public readonly googlePlaceId: string,
    public readonly body: string,
  ) {
    super(
      `Google Static Maps returned ${status} for ${googlePlaceId}: ${body.slice(0, 200)}`,
    );
    this.name = "GoogleStaticMapsError";
  }
}

interface ResolvedOpts {
  size: string;
  zoom: number;
  marker: boolean;
}

function resolveOpts(opts: StaticMapOpts): ResolvedOpts {
  const size = opts.size ?? DEFAULTS.size;
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!m) throw new StaticMapOptsInvalid(`size must be "WxH"`);
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w > MAX_DIM || h > MAX_DIM) {
    throw new StaticMapOptsInvalid(`size capped at ${MAX_DIM}x${MAX_DIM}`);
  }

  const zoom = opts.zoom ?? DEFAULTS.zoom;
  if (!Number.isInteger(zoom) || zoom < 10 || zoom > 19) {
    throw new StaticMapOptsInvalid(`zoom must be integer in [10,19]`);
  }

  const marker = opts.marker ?? DEFAULTS.marker;
  return { size, zoom, marker };
}

function buildUrl(
  lat: number,
  lng: number,
  opts: ResolvedOpts,
  apiKey: string,
): string {
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: String(opts.zoom),
    size: opts.size,
    scale: "2",
    maptype: "roadmap",
    style: "feature:poi|visibility:off",
    key: apiKey,
  });
  if (opts.marker) {
    // `markers=` value with explicit color (orange, matches design
    // soft-organic accent). Appended raw because URLSearchParams
    // would re-encode `|` and `,` differently from Google's expected
    // shape; we use `params.set` then patch.
    params.set(
      "markers",
      `color:0xe9b54a|${lat},${lng}`,
    );
  }
  return `${STATIC_MAP_BASE}?${params.toString()}`;
}

/**
 * SHA-256 of the cache key. `place_id` is included so two places
 * at the same lat/lng (rare but possible) still cache separately.
 */
export function cacheKey(
  googlePlaceId: string,
  lat: number,
  lng: number,
  opts: ResolvedOpts,
): string {
  return createHash("sha256")
    .update(
      `${googlePlaceId}|${lat.toFixed(6)},${lng.toFixed(6)}|${opts.size}|${opts.zoom}|${opts.marker ? "1" : "0"}`,
    )
    .digest("hex");
}

/**
 * Resolve a cached PNG path + ensure parent exists.
 * Layout: <UPLOAD_DIR>/places/<google_place_id>/map-<sha>.png
 */
export function cachePath(
  uploadDir: string,
  googlePlaceId: string,
  sha: string,
): string {
  return path.join(uploadDir, "places", googlePlaceId, `map-${sha}.png`);
}

/**
 * Fetch from Google + write to filesystem cache. Returns the resolved
 * cache file path. Idempotent — repeated calls with the same opts
 * return the cached file without a Google round-trip.
 *
 * Throws `GoogleStaticMapsApiKeyMissing` (→ 503) or
 * `GoogleStaticMapsError` (→ 502 with upstream status carried).
 */
export async function ensureStaticMapCached(args: {
  uploadDir: string;
  googlePlaceId: string;
  lat: number;
  lng: number;
  opts: StaticMapOpts;
}): Promise<{ filePath: string; etag: string; cacheHit: boolean }> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new GoogleStaticMapsApiKeyMissing();

  const resolved = resolveOpts(args.opts);
  const sha = cacheKey(args.googlePlaceId, args.lat, args.lng, resolved);
  const filePath = cachePath(args.uploadDir, args.googlePlaceId, sha);

  // Cache check.
  try {
    const st = await stat(filePath);
    if (st.isFile() && st.size > 0) {
      return { filePath, etag: `"${sha}"`, cacheHit: true };
    }
  } catch {
    /* miss — fall through */
  }

  const url = buildUrl(args.lat, args.lng, resolved, apiKey);
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new GoogleStaticMapsError(resp.status, args.googlePlaceId, body);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buf);

  return { filePath, etag: `"${sha}"`, cacheHit: false };
}
