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
 * A match found from text (`matchPlaceByText`) is linked only when its name
 * agrees and the read location is confirmed by Google's address
 * (`decidePlaceMatch` has the rule). Anything weaker is kept as a
 * suggestion with `tentative: true`, a reason and no `place_id`. The wish then exposes it as
 * `place_suggestion` for the person to confirm (PATCH `google_place_id`)
 * or reject (PATCH `place_id: null`); a suggestion never converts a wish.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import { GooglePlacesApiKeyMissing, GooglePlacesError, fetchAddressComponents, fetchPlaceV1Dual } from "../google/places-fetch.js";
import { findPlaceByText } from "../google/find-place.js";
import { searchPlacesByText } from "../google/text-search.js";
import { prefetchPlace, writePlace } from "../ingest/apply/places.js";
import { BOROUGH_TOWNS, CITY_ALIASES, CITY_REGIONS, NEW_YORK_BOROUGHS, NEW_YORK_SPELLINGS, hanCitiesIn, isKnownCity } from "./cities.js";
import { toAddressComponents, type GoogleAddressComponent } from "../google/text-search.js";
import { comparable, hasCjk, looseTokens, nameMatches, nameScore, nameTokens } from "./names.js";

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
  /** Why it is a guess (see `MatchReason`). */
  tentative_reason: MatchReason | null;
  /** Linked although Google's address names no street to check the read
   *  one against: the name agreed (score 0.9 or more), the read locality
   *  is in Google's address, and no other place of that name could be at
   *  the read address. Absent otherwise. */
  address_unverified?: true;
  /** How much of the asked-for name the found one carries (0..1); null
   *  when the two are in different scripts. */
  name_score: number | null;
  /** Google's answer when it was not offered at all: its name shares no
   *  word with the asked-for one, or (a typed name) it is outside the
   *  workspace's area and named for somewhere its address is not.
   *  `error` says so. Absent otherwise. */
  rejected?: { google_place_id: string; name: string | null; formatted_address: string | null };
  /** True when the query was biased to the workspace's usual area. */
  location_biased: boolean;
  error: string | null;
}

/**
 * Why a found place is only a suggestion:
 * - `name_only`: a capture with no city or address, or a typed name in a
 *   workspace with no usual area yet;
 * - `low_confidence`: the reading itself was a guess;
 * - `name_mismatch`: Google's name does not carry the asked-for one (for a
 *   typed name, also a branch of the brand inside the area);
 * - `name_unverified`: a name in another script than Google's (a Han name,
 *   and Google has no Chinese name for the place) without a house number
 *   Google's address confirms;
 * - `address_mismatch`: the read house number is not the house number of
 *   Google's address on the read street;
 * - `street_mismatch`: the read street is not in it;
 * - `street_unverified`: Google's address names no street to compare;
 * - `locality_mismatch`: no part of the read city or neighbourhood is a
 *   whole city-level part of Google's structured address in any language
 *   asked (`localityConfirmed`; a state or a country alone confirms
 *   nothing), or a read city is not, whatever street agrees (a namesake in
 *   another town, "South San Francisco" for San Francisco, or a
 *   neighbourhood Google does not name);
 * - `outside_area`: a typed name found outside the workspace's area.
 */
export type MatchReason =
  | "name_only"
  | "low_confidence"
  | "name_mismatch"
  | "name_unverified"
  | "address_mismatch"
  | "street_mismatch"
  | "street_unverified"
  | "locality_mismatch"
  | "outside_area";

export interface MatchOptions {
  /** The names the query is about (a title, its original-script form). */
  names: string[];
  /** The query itself is a guess (`name_only`, `low_confidence`): a match
   *  is only a suggestion, whatever its name. */
  guessReason?: "name_only" | "low_confidence" | null;
  /** Bias the lookups to this area (the workspace's usual one). */
  locationBias?: { lat: number; lng: number; radiusM: number } | null;
  /** Link a match whose name cannot be compared with the asked-for one
   *  (a Han name, an English answer) once its location is confirmed. True
   *  for a capture whose query had an address or a city; false for a bare
   *  typed name. */
  trustUncomparable?: boolean;
  /** The street address the query carried, if any. */
  address?: string | null;
  /** The city, district or neighbourhood the query carried, if any. */
  locality?: string | null;
  /** A bare name with nothing to say where (a typed wish): the location to
   *  confirm is this area (the workspace's usual one); with no area yet
   *  (`null`) nothing can be confirmed. Undefined for a capture. */
  requireInArea?: { lat: number; lng: number; radiusM: number } | null;
}

/** "7 Carmine St" → "7", "豫园路85号" → "85", "天平路123弄5号" → "123";
 *  null when the address carries none. */
export function houseNumber(address: string | null | undefined): string | null {
  const a = address ?? "";
  // "6th Ave" is a street, not number 6.
  const m = /^\s*(\d+[A-Za-z]?)(?![A-Za-z])\b/.exec(a);
  if (m?.[1] && !/^\s*\d+(st|nd|rd|th)\b/i.test(a)) return m[1];
  const han = /(?:大道|大街|路|街|道|巷|弄|胡同)\s*(\d+)(?:\s*[-－]\s*\d+)?\s*[号號弄]/u.exec(a);
  return han?.[1] ?? null;
}

/**
 * A street given only as a landmark ("近 Commercial St", "near Main St",
 * "Between Washington St & Jackson St", "corner of X and Y", "南京路与
 * 西藏路交叉口", "天平路附近"): it says where to look, not the address, so
 * it neither confirms nor refutes a found place.
 */
export function isLandmarkAddress(address: string | null | undefined): boolean {
  const a = (address ?? "").trim();
  if (!a) return false;
  if (/^(近(?![江畿鉄铁])|靠近|临近|鄰近|邻近|挨着|离|在)/u.test(a)) return true;
  if (/^(near|nr\.?|off|between|btwn\.?|at|on the corner|corner of|at the corner|across from|opposite|next to|behind)\b/i.test(a)) return true;
  if (/(附近|旁边|旁邊|对面|對面|一带|一帶|路口|交叉口|交汇处|交匯處)$/u.test(a)) return true;
  // Two streets named together: "南京路与西藏路", "X St & Y St", "X / Y".
  if (/(路|街|道|巷).*?(与|與|和|跟|及).*?(路|街|道|巷)/u.test(a)) return true;
  if (/\s(&|and|\/|@)\s/i.test(a) && !/^\s*\d/.test(a)) return true;
  return false;
}

/** A landmark phrase as query words: the "near" / "近" / "附近" taken
 *  off, which Google reads as part of the name ("R&G Lounge near
 *  Commercial St" finds nothing; "R&G Lounge Commercial St" finds it). */
export function landmarkQueryText(address: string): string {
  return address
    .trim()
    .replace(/^(near|nr\.?|off|between|btwn\.?|at the corner of|on the corner of|corner of|at|across from|opposite|next to|behind)\s+/i, "")
    .replace(/^(近|靠近|临近|鄰近|邻近|挨着|离|在)\s*/u, "")
    .replace(/\s*(附近|旁边|旁邊|对面|對面|一带|一帶)$/u, "")
    .trim();
}

/** Words that say what kind of street it is, or which side: dropped before
 *  two spellings of one street are compared ("Valley Blvd", "Valley
 *  Boulevard"; "S Grand Ave", "South Grand Avenue"). */
const STREET_WORDS = new Set([
  "st", "street", "ave", "av", "avenue", "blvd", "boulevard", "bl", "rd", "road", "dr", "drive", "ln", "lane", "way",
  "pl", "place", "ct", "court", "ter", "terrace", "pkwy", "parkway", "hwy", "highway", "cir", "circle", "sq", "square",
  "plz", "plaza", "aly", "alley", "row", "walk", "mall",
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
  "lu", "jie", "dao", "nan", "bei", "dong", "xi", "zhong",
]);
/** "Sixth" and "6th" are one street. */
const ORDINAL_WORDS: Record<string, string> = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th", eighth: "8th",
  ninth: "9th", tenth: "10th", eleventh: "11th", twelfth: "12th",
};
const ORDINAL = /^\d+(st|nd|rd|th)$/;
/** What a Han street name ends with: 路, 街, 道, … ("天平路" → "天平"). */
const HAN_STREET_SUFFIX = /(大道|大街|路|街|道|巷|弄|里|胡同|通り|通|길|로)$/u;
const HAN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/u;

function fold(s: string): string {
  // Accents off; recomposed after, so a Hangul syllable stays one letter.
  return s.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase().replace(/['’`]/g, "");
}

/** The words of an address, folded, an ordinal word written as a number. */
function addressWords(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => ORDINAL_WORDS[w] ?? w);
}

/** The street of a read address, reduced to what names it: Latin words
 *  without the street type or side ("6th" and "3rd" kept: a numbered
 *  street is named by its number), and Han names without their 路 / 街.
 *  Null when nothing is left (no street to check). */
export function streetCore(address: string | null | undefined): { latin: string[]; han: string[] } | null {
  if (!address) return null;
  const latin: string[] = [];
  const han: string[] = [];
  for (let word of addressWords(address.replace(/[(（][^()（）]*[)）]/gu, " "))) {
    if (HAN.test(word)) {
      word = word.replace(/\d+/g, " ");
      // A run up to its street suffix is the street ("天平路" → "天平").
      for (const run of word.match(new RegExp(`${HAN.source}+`, "gu")) ?? []) {
        const m = /^(.*?(?:大道|大街|路|街|道|巷|弄|胡同|通り|通|길|로))/u.exec(run);
        if (m?.[1]) {
          const street = m[1].replace(HAN_STREET_SUFFIX, "");
          if (street.length >= 1) han.push(street);
        } else if (run.length >= 2 && !/[号號楼樓层層室座]$/u.test(run)) han.push(run);
      }
      const rest = word.replace(new RegExp(`${HAN.source}+`, "gu"), " ").trim();
      for (const w of rest.split(/\s+/)) if (w && !STREET_WORDS.has(w)) latin.push(w);
    } else if ((ORDINAL.test(word) || !/\d/.test(word)) && !STREET_WORDS.has(word)) latin.push(word);
  }
  return latin.length + han.length > 0 ? { latin, han } : null;
}

/** Is the read street the route Google names (`formatted`: the route's
 *  spellings, `routeText`)? `unknown` when it is written in a script the
 *  street cannot be compared with (a Han street, an English route). */
function streetIn(core: { latin: string[]; han: string[] }, formatted: string | null): "yes" | "no" | "unknown" {
  if (!formatted) return "no";
  const f = fold(formatted);
  const words = new Set(addressWords(formatted));
  // A word, or (four letters or more) inside a run Google wrote as one
  // ("Tianping" in "Tianpinglu").
  const latinOk = core.latin.every((w) => words.has(w) || (w.length >= 4 && !ORDINAL.test(w) && f.replace(/\s+/g, "").includes(w)));
  if (core.han.length > 0) {
    if (!HAN.test(formatted)) return core.latin.length > 0 && !latinOk ? "no" : "unknown";
    return core.han.every((h) => f.includes(h)) && latinOk ? "yes" : "no";
  }
  return latinOk ? "yes" : "no";
}

/** The language to ask Google in, from the script of a name. */
function languageFor(names: (string | null | undefined)[]): string | undefined {
  const all = names.filter(Boolean).join(" ");
  if (/[぀-ヿ]/u.test(all)) return "ja";
  if (/[가-힯]/u.test(all)) return "ko";
  if (hasCjk(all)) return "zh-CN";
  return undefined;
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const MAX_QUERY = 300;

/** Everything Google said about one place, in every language asked. The
 *  first name and address are the ones in Google's default language. */
interface Seen {
  googlePlaceId: string;
  names: string[];
  addresses: string[];
  lat: number | null;
  lng: number | null;
  /** Google's structured address by language ("en", "zh-CN", …). What
   *  confirms a locality, a street or a house number. */
  components: Map<string, GoogleAddressComponent[]>;
}

const componentSets = (c: Seen) => [...c.components.values()].filter((set) => set.length > 0);

/** Structured addresses already fetched, per Google id and language. */
const componentCache = new Map<string, GoogleAddressComponent[]>();
const COMPONENT_CACHE_MAX = 2000;

/** Google's structured address of a place in one language: from the
 *  `places` row when the ledger has the place (its `raw_response` holds
 *  the full Place Details in en and zh-CN), else Place Details. Empty when
 *  neither answers (the match is then not confirmed). */
async function addressComponentsOf(googlePlaceId: string, language: string): Promise<GoogleAddressComponent[]> {
  const key = `${googlePlaceId}|${language}`;
  const hit = componentCache.get(key);
  if (hit) return hit;
  let found: GoogleAddressComponent[] = [];
  if (language === "en" || language === "zh-CN") {
    try {
      const res = await db.execute(
        sql`SELECT raw_response->'v1'->${language}->'addressComponents' AS c FROM places WHERE google_place_id = ${googlePlaceId}`,
      );
      found = toAddressComponents((res.rows[0] as { c: unknown } | undefined)?.c);
    } catch {
      /* fall through to Google */
    }
  }
  if (found.length === 0) {
    try {
      found = await fetchAddressComponents(googlePlaceId, language);
    } catch (err) {
      console.warn(`[wish] address of ${googlePlaceId} (${language}) not fetched: ${(err as Error).message.slice(0, 200)}`);
      return [];
    }
  }
  if (componentCache.size >= COMPONENT_CACHE_MAX) componentCache.delete(componentCache.keys().next().value!);
  componentCache.set(key, found);
  return found;
}

// ── Locality: Google's structured address ──────────────────────────────

/** Component types that name a city or a part of one: what confirms a read
 *  locality. Never a street (`route`, `street_number`, `subpremise`), and
 *  never a state or a country alone (`administrative_area_level_1`,
 *  `country`) except for the cities Google files that way (`CITY_REGIONS`). */
const CITY_LEVEL_TYPES = new Set([
  "locality", "postal_town", "neighborhood", "administrative_area_level_2", "administrative_area_level_3",
]);
function isCityLevel(c: GoogleAddressComponent): boolean {
  return c.types.some((t) => CITY_LEVEL_TYPES.has(t) || t.startsWith("sublocality"));
}
function isRegionLevel(c: GoogleAddressComponent): boolean {
  return c.types.includes("administrative_area_level_1") || c.types.includes("country");
}
/** A component with no type is a street line Google did not split
 *  ("解放街129号", "南京东路720号第一食品3楼"): it is read as the route, and
 *  its house number as the street number. */
const isUnsplitLine = (c: GoogleAddressComponent) => c.types.length === 0;
const isRoute = (c: GoogleAddressComponent) => c.types.includes("route") || isUnsplitLine(c);

/** One way to write a place name, for comparing whole names: folded,
 *  spaces and punctuation out ("Shang Hai" = "Shanghai"), a trailing
 *  "City", "Shi", "Qu" or "District" word cut ("Taipei City", "Shang Hai
 *  Shi", "Jing An Qu"), and a Han name's trailing 市 / 区 / 县 cut (上海市 =
 *  上海). Never a part of a name: "South San Francisco" stays itself. */
export function placeKey(name: string): string {
  const f = fold(name).trim();
  if (HAN.test(f)) {
    const h = f.replace(/\s+/g, "");
    const cut = h.replace(/(市|区|區|县|縣)$/u, "");
    return cut.length >= 2 ? cut : h;
  }
  const words = f.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length > 1 && ["city", "shi", "qu", "district"].includes(words[words.length - 1]!)) words.pop();
  return words.join("");
}

const REGION_KEYS = new Set([...CITY_REGIONS].map(placeKey));
/** "Downtown Los Angeles" is in Los Angeles; "South San Francisco" is not
 *  in San Francisco, so only these words come off. */
const QUALIFIER = /^(downtown|uptown|midtown|central|greater|old town|historic)\s+/;

/** The names a read locality may be filed under, as `placeKey`s, each
 *  marked when it is a city Google files as a region ("豫园/城隍庙，上海" →
 *  豫园, 城隍庙, 上海 and shanghai, both regions; "NYC" → new york and the
 *  five boroughs; "Downtown Los Angeles" → itself and los angeles). */
export function localityKeys(locality: string | null | undefined): { key: string; region: boolean }[] {
  const out = new Map<string, boolean>();
  const add = (name: string, region = false) => {
    const k = placeKey(name);
    if (k.length < 2) return;
    out.set(k, Boolean(out.get(k)) || region || REGION_KEYS.has(k));
  };
  // `read` is what the post wrote: only New York's own spellings bring in
  // the five boroughs ("Manhattan" is an alias of New York, and brings in
  // none of them).
  const withCity = (name: string, read: string, region = false) => {
    add(name, region);
    if (NEW_YORK_SPELLINGS.has(read)) for (const b of NEW_YORK_BOROUGHS) add(b);
    for (const t of BOROUGH_TOWNS[name] ?? []) add(t);
  };
  const parts = (locality ?? "")
    .split(/[\/,，、;；|·()（）]+|\s{2,}/u)
    .flatMap((p) => (HAN.test(p) ? [p.replace(/\s+/g, "")] : [p]))
    .map((p) => fold(p.trim()).replace(/\s+/g, " "))
    .filter(Boolean);
  for (const p of parts) {
    if (HAN.test(p)) {
      add(p);
      // A branch area read with its 店 ("外滩店"); a place whose name ends
      // in 店 (驻马店) is kept whole too.
      const bare = p.replace(/分?店$/u, "");
      if (bare !== p) add(bare);
      for (const [han, city] of Object.entries(CITY_ALIASES)) {
        if (!HAN.test(han) || !p.includes(han)) continue;
        const region = REGION_KEYS.has(placeKey(city));
        add(han, region);
        withCity(city, han, region);
      }
      continue;
    }
    const names = [p];
    const unqualified = p.replace(QUALIFIER, "");
    if (unqualified !== p && unqualified) names.push(unqualified);
    for (const n of names) {
      withCity(n, n);
      const alias = CITY_ALIASES[n];
      if (alias) withCity(alias, n);
    }
  }
  return [...out].map(([key, region]) => ({ key, region }));
}

/** The read locality is a whole city-level part of Google's structured
 *  address in some language asked: a locality, sublocality, neighbourhood,
 *  postal town or county-level area, never a street; a state or a country
 *  only for the cities Google files that way (`CITY_REGIONS`). */
export function localityConfirmed(locality: string | null | undefined, sets: GoogleAddressComponent[][]): boolean {
  const keys = localityKeys(locality);
  if (keys.length === 0) return false;
  return sets.some((set) =>
    set.some((c) => {
      const names = [placeKey(c.long), placeKey(c.short)];
      if (isCityLevel(c)) return keys.some((k) => names.includes(k.key));
      if (isRegionLevel(c)) return keys.some((k) => k.region && names.includes(k.key));
      return false;
    }),
  );
}

/** The parts of a read locality that are a city this app knows ("Nolita,
 *  NYC" → NYC; "旧金山唐人街" → 旧金山; "Koreatown" → none). */
export function readCities(locality: string | null | undefined): string[] {
  const out: string[] = [];
  for (const p of (locality ?? "").split(/[\/,，、;；|·()（）]+/u).map((x) => x.trim()).filter(Boolean)) {
    if (isKnownCity(p)) out.push(p);
    else if (HAN.test(p)) out.push(...hanCitiesIn(p));
  }
  return out;
}

/** The read locality names a known city and Google files the place under
 *  none of the cities it names: a namesake elsewhere, whatever street
 *  agrees. Unknown (false) when Google gave no structured address. */
export function cityContradicted(locality: string | null | undefined, sets: GoogleAddressComponent[][]): boolean {
  const cities = readCities(locality);
  if (cities.length === 0 || !sets.some((s) => s.length > 0)) return false;
  return !cities.some((c) => localityConfirmed(c, [...sets]));
}

/** Is `number` (as `houseNumber` reads it) the `street_number` of a
 *  structured address: the number itself ("1435"), an end of a range
 *  ("1001-1003", "9-11"), a Han one with its 号 ("269号", "45號")? Never a
 *  suite (`subpremise`) or a postcode, which are other components. */
export function streetNumberIs(number: string, set: GoogleAddressComponent[]): boolean {
  const want = number.toLowerCase();
  if (set.some((c) => isUnsplitLine(c) && houseNumber(c.long)?.toLowerCase() === want)) return true;
  return set.some(
    (c) =>
      c.types.includes("street_number") &&
      [c.long, c.short].some((v) =>
        fold(v)
          .replace(/[号號番地]/gu, "")
          .replace(/\s+/g, "")
          .split(/[-–]/)
          .some((n) => n === want),
      ),
  );
}

/** The route names of a structured address, every spelling Google gave. */
function routeText(set: GoogleAddressComponent[]): string {
  return set.filter(isRoute).flatMap((c) => [c.long, c.short]).join(" , ");
}

// ── The decision ────────────────────────────────────────────────────────

interface Judged {
  /** `agrees`: one name carries the other; `uncomparable`: different
   *  scripts; `partial`: they share a word; `none`: they share nothing. */
  name: "agrees" | "uncomparable" | "partial" | "none";
  score: number | null;
  /** Null when the location is confirmed. */
  where: MatchReason | null;
  /** What confirmed it: a house number, a street, the locality, the area. */
  by: "number" | "street" | "locality" | "area" | null;
}

function judgeName(names: string[], c: Seen): Pick<Judged, "name" | "score"> {
  const pairs = names.flatMap((n) => c.names.map((f) => [n, f] as const));
  const comparablePairs = pairs.filter(([n, f]) => comparable(n, f));
  if (comparablePairs.length === 0) return { name: "uncomparable", score: null };
  const score = Math.max(0, ...comparablePairs.map(([n, f]) => nameScore(n, f)));
  if (comparablePairs.some(([n, f]) => nameMatches(n, f))) return { name: "agrees", score };
  const shares = comparablePairs.some(([n, f]) => {
    const fs = new Set(looseTokens(f));
    return looseTokens(n).some((t) => fs.has(t));
  });
  return { name: shares || score > 0 ? "partial" : "none", score };
}

/** The read address against Google's structured address of the place:
 *  `number` or `street` when it is confirmed (Google's `street_number`
 *  together with a `route` that is the read street, or the read street is
 *  the route), `no_address` when it says nothing checkable (a landmark) and
 *  the locality decides, else why not. A suite (`subpremise`), a postcode
 *  or a city named like a street are other components and confirm
 *  nothing. */
function judgeAddress(address: string | null | undefined, c: Seen): MatchReason | "no_address" | "number" | "street" {
  if (!address || isLandmarkAddress(address)) return "no_address";
  const a = address.replace(/[(（][^()（）]*[)）]/gu, " ").trim();
  const number = houseNumber(a);
  const core = streetCore(a);
  if (!number && !core) return "no_address";
  const withRoute = componentSets(c).filter((set) => set.some(isRoute));
  const streetLevel = withRoute.length > 0;
  const verdicts = core ? withRoute.map((set) => streetIn(core, routeText(set))) : [];
  // The number confirms only on the read street, unless Google wrote the
  // street in a script it cannot be compared with in every language asked.
  const streetOk = !core || verdicts.includes("yes") || (verdicts.length > 0 && verdicts.every((v) => v === "unknown"));
  if (number) {
    if (streetOk && withRoute.some((set) => streetNumberIs(number, set))) return "number";
    if (streetLevel) return "address_mismatch";
  }
  if (!core) return "street_unverified";
  if (verdicts.includes("yes")) return "street";
  return streetLevel ? "street_mismatch" : "street_unverified";
}

/**
 * Find a place for a query and decide what it is to the wish: a place to
 * link (`linkGoogleId`), a suggestion, or nothing. Calls Google, writes
 * nothing; `matchPlaceByText` links. `scripts/check-wish-match.ts` runs
 * every case this rule has been tested on through it.
 *
 * The rule. A place is linked only when its name agrees with the asked-for
 * one (`nameMatches`, in any language Google gave it in) and the read
 * location is confirmed by Google's address in any language asked. A name
 * in another script than every name Google gave (a Han name, an English
 * answer) counts as agreeing only for a capture whose house number
 * Google's address confirms: a city or a street alone does not do, because
 * any Han name, real or misread, finds some place in a city. The location:
 * Every location check reads Google's structured address
 * (`addressComponents`, in English and in the name's script), never the
 * words of its formatted address:
 * - a capture with a street address: its house number is the
 *   `street_number` of a structured address whose `route` is the read
 *   street (never a suite, which is a `subpremise`, or a postcode), else
 *   its street ("6th St", "天平路") is the `route`. Where Google gives no
 *   route at all, the read locality must be confirmed instead, the name
 *   must agree at 0.9 or more, and no other place of that name in Text
 *   Search's answer may be one the address cannot rule out
 *   (`address_unverified`);
 * - a capture with a city or neighbourhood and no address: one of its
 *   parts is a whole city-level component (`localityConfirmed`: locality,
 *   sublocality, neighbourhood, postal town, county level), never a route
 *   ("Washington" is not "Washington St"), never a part of a longer name
 *   ("San Francisco" is not "South San Francisco"), never a state or a
 *   country ("USA", "Taiwan", "California"), except for a city Google
 *   files as one (`CITY_REGIONS`: 上海, Taipei, Tokyo, Singapore); "New
 *   York", "NYC" and 纽约 are confirmed by the five boroughs;
 * - either way, a read city this app knows (`src/wish/cities.ts`) must be
 *   confirmed too (`cityContradicted`): Katz's on E Houston St read as
 *   "Chicago" is a suggestion;
 * - a typed name: the place is inside the workspace's usual area.
 * A reading that is itself a guess (`name_only`, `low_confidence`) is never
 * linked. When Find Place's first answer does not qualify, Text Search (in
 * the name's script and in English) is tried for one that does.
 *
 * Anything weaker is a suggestion with the reason; a found place whose
 * name shares no word with the asked-for one is dropped (`rejected`). A
 * typed name found outside the area whose name does not agree is offered
 * only when Google's name shares the title's words and the rest of the
 * title is in its address ("El Farolito Mission District" → Taquería El
 * Farolito, Mission St); an in-area branch carrying the brand word comes
 * first ("Sugarfish Little Tokyo" → a Los Angeles SUGARFISH), and a branch
 * named for somewhere else with no in-area one is dropped.
 */
export async function decidePlaceMatch(
  query: string,
  basis: string,
  opts: MatchOptions,
): Promise<{ match: PlaceMatch; linkGoogleId: string | null }> {
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
  const typed = opts.requireInArea !== undefined;
  const area = opts.requireInArea ?? null;
  const bias = typed ? area : opts.locationBias ?? null;
  // The script to ask in besides English: the name's, else the address's.
  const lang = languageFor(names) ?? languageFor([opts.address, opts.locality]);

  const seen = new Map<string, Seen>();
  const order: string[] = [];
  const note = (
    id: string,
    name: string | null,
    address: string | null,
    lat: number | null,
    lng: number | null,
    components?: { language: string; list: GoogleAddressComponent[] },
  ) => {
    let s = seen.get(id);
    if (!s) {
      s = { googlePlaceId: id, names: [], addresses: [], lat, lng, components: new Map() };
      seen.set(id, s);
      order.push(id);
    }
    if (name && !s.names.includes(name)) s.names.push(name);
    if (address && !s.addresses.includes(address)) s.addresses.push(address);
    if (s.lat === null && lat !== null) s.lat = lat;
    if (s.lng === null && lng !== null) s.lng = lng;
    if (components && components.list.length > 0 && !s.components.has(components.language)) {
      s.components.set(components.language, components.list);
    }
  };
  // The languages a place's structured address is read in: English, and
  // the name's (or address's) script.
  const languages = [...new Set(["en", ...(lang ? [lang] : [])])];
  const fetchComponents = async (c: Seen) => {
    for (const language of languages) {
      if (!c.components.has(language)) c.components.set(language, await addressComponentsOf(c.googlePlaceId, language));
    }
  };

  const inArea = (c: Seen) => Boolean(area) && c.lat !== null && c.lng !== null && distanceM(area!, { lat: c.lat, lng: c.lng }) <= area!.radiusM;
  const judge = async (c: Seen): Promise<Judged> => {
    const n = judgeName(names, c);
    // A place whose name shares nothing is never linked nor offered: its
    // address is not worth a request.
    if (!typed && n.name !== "none") await fetchComponents(c);
    const sets = componentSets(c);
    let where: MatchReason | null = null;
    let by: Judged["by"] = null;
    if (typed) {
      if (!area) where = "name_only";
      else if (inArea(c)) by = "area";
      else where = "outside_area";
    } else {
      const a = judgeAddress(opts.address, c);
      if (a === "number" || a === "street") by = a;
      else if (a !== "no_address") where = a;
      else if (opts.locality) {
        if (localityConfirmed(opts.locality, sets)) by = "locality";
        else where = "locality_mismatch";
      } else where = "name_only";
      // A street that agrees does not outweigh a read city the address is
      // not in (Katz's on E Houston St, "Chicago").
      if (by && cityContradicted(opts.locality, sets)) {
        by = null;
        where = "locality_mismatch";
      }
    }
    return { ...n, where, by };
  };
  // A name in another script than Google's (a Han name, and Google has no
  // Chinese name for the place) is linked only on a confirmed house number:
  // any name, real or misread, finds some place in a city, and Find Place's
  // guess for a name it does not know is on some street of it.
  const linkable = (j: Judged) =>
    !opts.guessReason &&
    j.where === null &&
    (j.name === "agrees" || (j.name === "uncomparable" && opts.trustUncomparable === true && j.by === "number"));
  const finish = (c: Seen, j: Judged, reason: MatchReason | null): { match: PlaceMatch; linkGoogleId: string | null } => {
    match.google_place_id = c.googlePlaceId;
    match.name = c.names[0] ?? null;
    match.formatted_address = c.addresses[0] ?? null;
    match.name_score = j.score === null ? null : Math.round(j.score * 100) / 100;
    if (reason) {
      match.tentative = true;
      match.tentative_reason = reason;
      return { match, linkGoogleId: null };
    }
    return { match, linkGoogleId: c.googlePlaceId };
  };
  const reject = (c: Seen, error: string) => {
    match.rejected = { google_place_id: c.googlePlaceId, name: c.names[0] ?? null, formatted_address: c.addresses[0] ?? null };
    match.error = error;
    return { match, linkGoogleId: null };
  };

  try {
    // Find Place answers nothing for some phrasings Text Search reads
    // ("R&G Lounge near Commercial St"): its first answer stands in.
    const first =
      (await findPlaceByText(q, { locationBias: bias })) ??
      (await searchPlacesByText(q, { maxResults: 1, locationBias: bias }).then(
        ([c]) => (c ? { googlePlaceId: c.google_place_id, name: c.name, formattedAddress: c.formatted_address, lat: c.lat, lng: c.lng } : null),
        () => null,
      ));
    if (!first) {
      match.error = "no place found";
      return { match, linkGoogleId: null };
    }
    note(first.googlePlaceId, first.name, first.formattedAddress, first.lat, first.lng);
    if (lang) {
      const local = await findPlaceByText(q, { locationBias: bias, language: lang }).catch(() => null);
      if (local?.googlePlaceId === first.googlePlaceId) note(local.googlePlaceId, local.name, local.formattedAddress, local.lat, local.lng);
    }
    const firstSeen = seen.get(first.googlePlaceId)!;
    const firstJudged = await judge(firstSeen);
    if (linkable(firstJudged)) return finish(firstSeen, firstJudged, null);

    // Text Search, in the name's script and in English, for a place that
    // qualifies further down Google's list. Not for a bare name with
    // nothing to check it against.
    let searched = false;
    if (opts.guessReason !== "name_only") {
      for (const languageCode of [...new Set([lang, undefined])]) {
        const list = await searchPlacesByText(q, { maxResults: 5, languageCode, locationBias: bias, withAddressComponents: !typed }).catch(
          () => null,
        );
        if (!list) continue;
        searched = true;
        for (const c of list) {
          const components = c.address_components ? { language: languageCode ?? "en", list: c.address_components } : undefined;
          note(c.google_place_id, c.name, c.formatted_address, c.lat, c.lng, components);
        }
      }
    }
    const judged: { c: Seen; j: Judged }[] = [];
    for (const id of order) {
      const c = seen.get(id)!;
      judged.push({ c, j: await judge(c) });
    }
    const ok = judged.find(({ j }) => linkable(j));
    if (ok) return finish(ok.c, ok.j, null);

    // Google's address names no street to check the read one against
    // (mainland China: "四牌楼 Huangpu, China"): linked on the name and the
    // locality when no other place of that name could be at the address.
    if (!opts.guessReason && searched && opts.locality) {
      const sameName = judged.filter(({ j }) => j.name === "agrees");
      const unrefuted = sameName.filter(({ j }) => j.where === "street_unverified");
      const only = unrefuted.length === 1 ? unrefuted[0]! : null;
      if (
        only &&
        (only.j.score ?? 0) >= 0.9 &&
        localityConfirmed(opts.locality, componentSets(only.c)) &&
        !cityContradicted(opts.locality, componentSets(only.c))
      ) {
        match.address_unverified = true;
        return finish(only.c, only.j, null);
      }
    }

    const reasonFor = (j: Judged): MatchReason =>
      opts.guessReason ?? j.where ?? (j.name === "uncomparable" ? "name_unverified" : "name_mismatch");

    // A typed name found outside the area with a name that does not agree.
    if (typed && area && firstJudged.where === "outside_area" && firstJudged.name !== "agrees") {
      const brands = names.map((n) => nameTokens(n)[0]).filter((t): t is string => Boolean(t) && (hasCjk(t!) || t!.length >= 3));
      const local = judged.find(({ c }) => inArea(c) && brands.some((b) => c.names.some((n) => nameTokens(n).includes(b))));
      if (local) return finish(local.c, local.j, local.j.name === "agrees" ? "outside_area" : "name_mismatch");
      if (firstJudged.name === "partial" && namedForItsAddress(names, firstSeen)) return finish(firstSeen, firstJudged, "outside_area");
      return reject(firstSeen, "no place of that name found in the usual area");
    }

    // The best guess: the first place whose name agrees (or cannot be
    // compared), else the first answer if its name shares a word.
    const pick =
      judged.find(({ j }) => j.name === "agrees") ??
      judged.find(({ j }) => j.name === "uncomparable") ??
      (firstJudged.name === "partial" ? { c: firstSeen, j: firstJudged } : null);
    if (!pick) return reject(firstSeen, "no place of that name found");
    return finish(pick.c, pick.j, reasonFor(pick.j));
  } catch (err) {
    match.error = (err as Error).message.slice(0, 200);
    return { match, linkGoogleId: null };
  }
}

/** A typed "<name> <where>" whose found place carries the name and sits
 *  at the where: every word of the title Google's name lacks is either in
 *  Google's address or there are none ("El Farolito Mission District" →
 *  Taquería El Farolito, 2779 Mission St: "mission" is in the address).
 *  "Sugarfish Little Tokyo" → SUGARFISH Little Italy, San Diego is not:
 *  "tokyo" is nowhere in it. */
function namedForItsAddress(names: string[], c: Seen): boolean {
  const found = new Set(c.names.flatMap((n) => looseTokens(n)));
  const addr = new Set(c.addresses.flatMap((a) => addressWords(a)));
  return names.some((n) => {
    const words = looseTokens(n);
    if (!words.some((w) => found.has(w))) return false;
    const extra = words.filter((w) => !found.has(w));
    return extra.length === 0 || extra.some((w) => addr.has(w));
  });
}

/** Find Place for a query, then link what it found, or keep it as a
 *  suggestion when it is a guess (`decidePlaceMatch`). Never throws. */
export async function matchPlaceByText(query: string, basis: string, nameLocal: string | null, opts: MatchOptions): Promise<PlaceMatch> {
  const { match, linkGoogleId } = await decidePlaceMatch(query, basis, opts);
  if (!linkGoogleId) return match;
  try {
    const link = await linkGooglePlace(linkGoogleId, nameLocal);
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
