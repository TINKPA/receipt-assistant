/**
 * Linking a wish to a Google place: the one way a wish's `place_id` is
 * filled from a Google place id (a capture's match, a typed place wish's
 * match, a candidate the person picked from place search).
 *
 * A place the ledger already knows is linked as it is: `writePlace` would
 * count a visit (`hit_count`, `last_seen_at`), and wanting to go is not
 * having been. A new one is fetched and stored the way the server applier
 * stores a receipt's place (`prefetchPlace` + `writePlace`), which gives
 * it `hit_count` 1 from its insert.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { GooglePlacesApiKeyMissing, GooglePlacesError, fetchPlaceV1Dual } from "../google/places-fetch.js";
import { findPlaceByText } from "../google/find-place.js";
import { prefetchPlace, writePlace } from "../ingest/apply/places.js";

export interface PlaceLink {
  placeId: string | null;
  /** The place was already in `places`; nothing was fetched. */
  known: boolean;
  /** Why nothing was linked, or null. */
  error: string | null;
  /** `key_missing` | `not_found` (Google does not know the id) | `google`
   *  (any other failure fetching it) | `not_projectable`; null on success. */
  errorKind: "key_missing" | "not_found" | "google" | "not_projectable" | null;
}

export async function linkGooglePlace(googlePlaceId: string, nameLocal: string | null): Promise<PlaceLink> {
  const known = await db.execute(sql`SELECT id FROM places WHERE google_place_id = ${googlePlaceId}`);
  if (known.rows.length > 0) {
    return { placeId: (known.rows[0] as { id: string }).id, known: true, error: null, errorKind: null };
  }
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
  const written = await db.transaction((tx) => writePlace(tx, prefetch, nameLocal));
  if (!written.placeId) {
    return {
      placeId: null,
      known: false,
      error: written.warnings[0]?.message ?? "the place could not be stored",
      errorKind: "not_projectable",
    };
  }
  return { placeId: written.placeId, known: prefetch?.cached ?? false, error: null, errorKind: null };
}

/** What `capture.place_match` records: how a name became a place. */
export interface PlaceMatch {
  query: string;
  /** `address` | `locality` | `name_only` (a capture) | `title` (a typed wish). */
  basis: string;
  google_place_id: string | null;
  name: string | null;
  formatted_address: string | null;
  place_id: string | null;
  error: string | null;
}

/** Find Place for a query, then link what it found. Never throws. */
export async function matchPlaceByText(query: string, basis: string, nameLocal: string | null): Promise<PlaceMatch> {
  const match: PlaceMatch = { query, basis, google_place_id: null, name: null, formatted_address: null, place_id: null, error: null };
  try {
    const found = await findPlaceByText(query);
    if (!found) {
      match.error = "no place found";
      return match;
    }
    match.google_place_id = found.googlePlaceId;
    match.name = found.name;
    match.formatted_address = found.formattedAddress;
    const link = await linkGooglePlace(found.googlePlaceId, nameLocal);
    match.place_id = link.placeId;
    match.error = link.error;
  } catch (err) {
    match.error = (err as Error).message.slice(0, 200);
  }
  return match;
}
