/**
 * Linking a wish to a Google place: the one way a wish's `place_id` is
 * filled from a Google place id (a capture's match, a typed place wish's
 * match, a candidate the person picked from place search).
 *
 * A place the ledger already knows is linked as it is: `writePlace` would
 * count a visit (`hit_count`, `last_seen_at`), and wanting to go is not
 * having been. A new one is fetched and stored the way the server applier
 * stores a receipt's place (`prefetchPlace` + `writePlace`), which gives
 * it `hit_count` 1 from its insert. The "known?" check and the write run
 * under one advisory lock per Google id, so links of one new place that
 * arrive together store it once and count it once.
 *
 * A match found from text (`matchPlaceByText`) is linked only when it is
 * likely the place meant. It is a guess, kept as a suggestion with
 * `tentative: true` and no `place_id`, when the name Google found shares
 * too little with the name asked for (src/wish/names.ts), or when the
 * caller says the query itself is a guess (a capture with a name and no
 * city, a reading the model was not sure of). The wish then exposes it as
 * `place_suggestion` for the person to confirm (PATCH `google_place_id`)
 * or reject (PATCH `place_id: null`); a suggestion never converts a wish.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import { GooglePlacesApiKeyMissing, GooglePlacesError, fetchPlaceV1Dual } from "../google/places-fetch.js";
import { findPlaceByText, type FoundPlace } from "../google/find-place.js";
import { prefetchPlace, writePlace } from "../ingest/apply/places.js";
import { comparable, hasCjk, nameMatches, nameScore } from "./names.js";

export interface PlaceLink {
  placeId: string | null;
  /** The place was already in `places`; nothing was written. */
  known: boolean;
  /** Why nothing was linked, or null. */
  error: string | null;
  /** `key_missing` | `not_found` (Google does not know the id) | `google`
   *  (any other failure fetching it) | `not_projectable`; null on success. */
  errorKind: "key_missing" | "not_found" | "google" | "not_projectable" | null;
}

async function knownPlace(executor: Pick<typeof db, "execute">, googlePlaceId: string): Promise<string | null> {
  const res = await executor.execute(sql`SELECT id FROM places WHERE google_place_id = ${googlePlaceId}`);
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
}

export async function linkGooglePlace(googlePlaceId: string, nameLocal: string | null): Promise<PlaceLink> {
  const known = await knownPlace(db, googlePlaceId);
  if (known) return { placeId: known, known: true, error: null, errorKind: null };
  let fetchErr: unknown = null;
  const prefetch = await prefetchPlace(db, googlePlaceId, async (id) => {
    try {
      return await fetchPlaceV1Dual(id);
    } catch (err) {
      fetchErr = err;
      throw err;
    }
  });
  if (prefetch && !prefetch.cached && !prefetch.envelope) {
    if (fetchErr instanceof GooglePlacesApiKeyMissing) {
      return { placeId: null, known: false, error: "GOOGLE_MAPS_API_KEY is not set", errorKind: "key_missing" };
    }
    // 404, or a 400 about the id rather than the key: Google has no such place.
    if (
      fetchErr instanceof GooglePlacesError &&
      (fetchErr.status === 404 || (fetchErr.status === 400 && !/api[ _]?key/i.test(fetchErr.body)))
    ) {
      return { placeId: null, known: false, error: `Google has no place ${googlePlaceId}`, errorKind: "not_found" };
    }
    return { placeId: null, known: false, error: prefetch.warning?.message ?? "the place could not be fetched", errorKind: "google" };
  }
  const written = await db.transaction(async (tx) => {
    // One linker at a time per Google id; whoever comes second finds the
    // row the first stored and links it without counting a visit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wish-place:${googlePlaceId}`}, 0))`);
    const stored = await knownPlace(tx, googlePlaceId);
    if (stored) return { known: stored, write: null };
    return { known: null, write: await writePlace(tx, prefetch, nameLocal) };
  });
  if (written.known) return { placeId: written.known, known: true, error: null, errorKind: null };
  if (!written.write?.placeId) {
    return {
      placeId: null,
      known: false,
      error: written.write?.warnings[0]?.message ?? "the place could not be stored",
      errorKind: "not_projectable",
    };
  }
  return { placeId: written.write.placeId, known: false, error: null, errorKind: null };
}

/** What `capture.place_match` records: how a name became a place. */
export interface PlaceMatch {
  query: string;
  /** `address` | `locality` | `name_only` (a capture) | `title` (a typed wish). */
  basis: string;
  google_place_id: string | null;
  name: string | null;
  formatted_address: string | null;
  /** Set only when the match was linked. */
  place_id: string | null;
  /** True when the match is a guess: not linked, offered as
   *  `place_suggestion` until the person confirms or rejects it. */
  tentative: boolean;
  /** Why it is a guess: `name_only`, `low_confidence`, `name_mismatch`,
   *  `name_unverified` (a typed name in another script than Google's). */
  tentative_reason: string | null;
  /** How much of the asked-for name the found one carries (0..1); null
   *  when the two are in different scripts. */
  name_score: number | null;
  /** True when the query was biased to the workspace's usual area. */
  location_biased: boolean;
  error: string | null;
}

export interface MatchOptions {
  /** The names the query is about (a title, its original-script form). */
  names: string[];
  /** The query itself is a guess (`name_only`, `low_confidence`): a match
   *  is only a suggestion, whatever its name. */
  guessReason?: string | null;
  /** Bias Find Place to this area (the workspace's usual one). */
  locationBias?: { lat: number; lng: number; radiusM: number } | null;
  /** Link a match whose name cannot be compared with the asked-for one
   *  (a Han name, an English answer). True for a capture whose query had
   *  an address or a city, which is what the match rests on; false for a
   *  bare typed name. */
  trustUncomparable?: boolean;
}

/** The language to ask Google in, from the script of a name. */
function languageFor(names: string[]): string | undefined {
  const all = names.join(" ");
  if (/[぀-ヿ]/u.test(all)) return "ja";
  if (/[가-힯]/u.test(all)) return "ko";
  if (hasCjk(all)) return "zh-CN";
  return undefined;
}

const MAX_QUERY = 300;

/** Find Place for a query, then link what it found, or keep it as a
 *  suggestion when it is a guess. Never throws. */
export async function matchPlaceByText(query: string, basis: string, nameLocal: string | null, opts: MatchOptions): Promise<PlaceMatch> {
  const q = query.trim().slice(0, MAX_QUERY);
  const match: PlaceMatch = {
    query: q,
    basis,
    google_place_id: null,
    name: null,
    formatted_address: null,
    place_id: null,
    tentative: false,
    tentative_reason: null,
    name_score: null,
    location_biased: Boolean(opts.locationBias),
    error: null,
  };
  const names = opts.names.map((n) => n.trim()).filter(Boolean);
  try {
    const found: FoundPlace | null = await findPlaceByText(q, { locationBias: opts.locationBias ?? null });
    if (!found) {
      match.error = "no place found";
      return match;
    }
    const best = (f: FoundPlace) => Math.max(0, ...names.map((n) => nameScore(n, f.name ?? "")));
    let agrees = names.some((n) => nameMatches(n, found.name ?? ""));
    // A CJK name and a Latin answer cannot be compared: ask again in the
    // name's language, which names the same place in its own script.
    const lang = languageFor(names);
    if (!agrees && lang) {
      const again = await findPlaceByText(q, { locationBias: opts.locationBias ?? null, language: lang }).catch(() => null);
      if (again && again.googlePlaceId === found.googlePlaceId && names.some((n) => nameMatches(n, again.name ?? ""))) {
        agrees = true;
        match.name_score = best(again);
      }
    }
    match.google_place_id = found.googlePlaceId;
    match.name = found.name;
    match.formatted_address = found.formattedAddress;
    if (match.name_score === null) match.name_score = Math.round(best(found) * 100) / 100;
    else match.name_score = Math.round(match.name_score * 100) / 100;
    const uncomparable = !agrees && names.every((n) => !comparable(n, found.name ?? ""));
    if (uncomparable) match.name_score = null;
    const trusted = agrees || (uncomparable && opts.trustUncomparable === true);
    if (!trusted || opts.guessReason) {
      match.tentative = true;
      match.tentative_reason = opts.guessReason ?? (uncomparable ? "name_unverified" : "name_mismatch");
      return match;
    }
    const link = await linkGooglePlace(found.googlePlaceId, nameLocal);
    match.place_id = link.placeId;
    match.error = link.error;
  } catch (err) {
    match.error = (err as Error).message.slice(0, 200);
  }
  return match;
}

// ── The workspace's usual area ─────────────────────────────────────────

const centerCache = new Map<string, { at: number; center: { lat: number; lng: number } | null }>();
const CENTER_TTL_MS = 60 * 60 * 1000;
/** Find Place and Text Search take a bias circle of at most 50 km. */
export const AREA_RADIUS_M = 50_000;

/**
 * Where the workspace's purchases happen: the median latitude and
 * longitude of the places of its live transactions in the last year (all
 * time when the year has fewer than three). Null with fewer than three
 * places. Cached for an hour per workspace.
 */
export async function workspaceArea(workspaceId: string): Promise<{ lat: number; lng: number; radiusM: number } | null> {
  const hit = centerCache.get(workspaceId);
  let center: { lat: number; lng: number } | null;
  if (hit && Date.now() - hit.at < CENTER_TTL_MS) center = hit.center;
  else {
    const median = async (recent: boolean) => {
      const res = await db.execute(sql`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lat) AS lat,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY p.lng) AS lng,
               count(*)::int AS n
          FROM ${liveTransactions} t JOIN places p ON p.id = t.place_id
         WHERE t.workspace_id = ${workspaceId}::uuid AND p.lat IS NOT NULL AND p.lng IS NOT NULL
           ${recent ? sql`AND t.occurred_on >= current_date - 365` : sql``}`);
      const r = res.rows[0] as { lat: number | null; lng: number | null; n: number } | undefined;
      return r && r.n >= 3 && r.lat !== null && r.lng !== null ? { lat: Number(r.lat), lng: Number(r.lng) } : null;
    };
    center = (await median(true)) ?? (await median(false));
    centerCache.set(workspaceId, { at: Date.now(), center });
  }
  return center ? { ...center, radiusM: AREA_RADIUS_M } : null;
}
