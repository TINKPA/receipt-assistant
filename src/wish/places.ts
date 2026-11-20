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
import { searchPlacesByText } from "../google/text-search.js";
import { prefetchPlace, writePlace } from "../ingest/apply/places.js";
import { comparable, hasCjk, nameMatches, nameScore, nameTokens } from "./names.js";

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
   *  `name_unverified` (a typed name in another script than Google's),
   *  `address_mismatch` (the read address's house number is not in the
   *  found place's address), `street_mismatch` (the read street, given
   *  with no number, is not in it), `street_unverified` (Google's address
   *  names no street to compare), `outside_area` (a typed name found
   *  outside the workspace's usual area). */
  tentative_reason: string | null;
  /** Linked although Google's address names no street to check the read
   *  one against: the name agreed (score 0.9 or more), the read locality
   *  is in Google's address, and no other place of that name could be at
   *  the read address. Absent otherwise. */
  address_unverified?: true;
  /** How much of the asked-for name the found one carries (0..1); null
   *  when the two are in different scripts. */
  name_score: number | null;
  /** Google's answer when it shared no word with the asked-for name, or
   *  (a typed name) was outside the workspace's area with a name that does
   *  not agree and no branch of the brand was found inside it: not linked
   *  and not suggested (`error` says so). Absent otherwise. */
  rejected?: { google_place_id: string; name: string | null; formatted_address: string | null };
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
  /** The street address the query carried, if any: a found place whose
   *  address lacks its house number, or (with no number) its street, is
   *  another branch or another town. */
  address?: string | null;
  /** The city, district or neighbourhood the query carried, if any. */
  locality?: string | null;
  /** A bare name with nothing to say where (a typed wish): link only a
   *  place inside this area (the workspace's usual one); anything else,
   *  or anything at all when the workspace has no area yet (`null`), is a
   *  suggestion. Undefined: no such check. */
  requireInArea?: { lat: number; lng: number; radiusM: number } | null;
}

/** "7 Carmine St" → "7", "豫园路85号" → "85", "天平路123弄5号" → "123";
 *  null when the address carries none. */
export function houseNumber(address: string | null | undefined): string | null {
  const m = /^\s*(\d+[A-Za-z]?)\b/.exec(address ?? "");
  if (m?.[1]) return m[1];
  const han = /(?:大道|大街|路|街|道|巷|弄|胡同)\s*(\d+)(?:\s*[-－]\s*\d+)?\s*[号號弄]/u.exec(address ?? "");
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
/** What a Han street name ends with: 路, 街, 道, … ("天平路" → "天平"). */
const HAN_STREET_SUFFIX = /(大道|大街|路|街|道|巷|弄|里|胡同|通り|通|길|로)$/u;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

function fold(s: string): string {
  // Accents off; recomposed after, so a Hangul syllable stays one letter.
  return s.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase().replace(/['’`]/g, "");
}

/** The street of a read address, reduced to what names it: Latin words
 *  without the street type, side or number, and Han names without their
 *  路 / 街. Null when nothing is left (no street to check). */
export function streetCore(address: string | null | undefined): { latin: string[]; han: string[] } | null {
  if (!address) return null;
  const latin: string[] = [];
  const han: string[] = [];
  for (let word of fold(address).split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
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
    } else if (!/\d/.test(word) && !STREET_WORDS.has(word)) latin.push(word);
  }
  return latin.length + han.length > 0 ? { latin, han } : null;
}

/** Does Google's address carry the street? `unknown` when it is written in
 *  a script the street cannot be compared with (a Han street, an English
 *  address). */
function streetIn(core: { latin: string[]; han: string[] }, formatted: string | null): "yes" | "no" | "unknown" {
  if (!formatted) return "no";
  const f = fold(formatted);
  const words = new Set(f.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // A word, or (four letters or more) inside a run Google wrote as one
  // ("Tianping" in "Tianpinglu").
  const latinOk = core.latin.every((w) => words.has(w) || (w.length >= 4 && f.replace(/\s+/g, "").includes(w)));
  if (core.han.length > 0) {
    if (!HAN.test(formatted)) return core.latin.length > 0 && !latinOk ? "no" : "unknown";
    return core.han.every((h) => f.includes(h)) && latinOk ? "yes" : "no";
  }
  return latinOk ? "yes" : "no";
}

/** Google's address names a street at all (not just a district and a
 *  postcode): a house number before a name, or a Han street word. */
function hasStreetLevel(formatted: string | null): boolean {
  if (!formatted) return false;
  const first = formatted.split(",")[0] ?? "";
  return /\d+\s*[A-Za-z\u00c0-\u024f]/.test(first) || /[路街道巷弄号號]/u.test(formatted);
}

/** The language to ask Google in, from the script of a name. */
function languageFor(names: string[]): string | undefined {
  const all = names.join(" ");
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

interface Candidate {
  googlePlaceId: string;
  name: string | null;
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Does a found place's address agree with the read one? A read house
 * number must be in it. A read street with no number must be in it too:
 * Latin words compared without the street type ("Blvd") or side ("S"); a
 * Han street ("天平路") against Google's address in the street's own
 * script, asked for when the first answer is in English.
 */
async function addressAgreement(
  c: Candidate,
  address: string | null | undefined,
  query: string,
  locationBias: MatchOptions["locationBias"],
): Promise<null | "address_mismatch" | "street_mismatch" | "street_unverified"> {
  // A landmark ("near X", "X与Y交叉口") is not an address: the match rests
  // on the name and the locality, as with no address at all.
  if (isLandmarkAddress(address)) return null;
  const number = houseNumber(address);
  const numberIn = (f: string | null) => Boolean(number) && new RegExp(`(^|[^0-9A-Za-z])${number}([^0-9A-Za-z]|$)`, "i").test(f ?? "");
  if (number) {
    if (numberIn(c.formattedAddress)) return null;
    // Google's address has a street and not this number: another branch.
    // With no street in it at all, the number cannot be checked; the
    // street is compared below, in the street's own script if need be.
    if (hasStreetLevel(c.formattedAddress)) return "address_mismatch";
  }
  const core = streetCore(address);
  if (!core) return number ? "street_unverified" : null;
  let verdict = streetIn(core, c.formattedAddress);
  let local: string | null = null;
  if (verdict === "unknown" || (number && verdict === "no" && !hasStreetLevel(c.formattedAddress))) {
    const lang = languageFor([address ?? ""]);
    const again = lang ? await findPlaceByText(query, { locationBias: locationBias ?? null, language: lang }).catch(() => null) : null;
    if (again && again.googlePlaceId === c.googlePlaceId) {
      local = again.formattedAddress;
      if (number) {
        if (numberIn(local)) return null;
        if (hasStreetLevel(local)) return "address_mismatch";
      }
      verdict = streetIn(core, local);
    }
  }
  if (verdict === "yes") return null;
  return hasStreetLevel(c.formattedAddress) || hasStreetLevel(local) ? "street_mismatch" : "street_unverified";
}

/** The parts of a read locality ("豫园/城隍庙，上海" → 豫园, 城隍庙, 上海),
 *  without a trailing 市 / 区 / 县, folded. */
function localityParts(locality: string | null | undefined): string[] {
  return (locality ?? "")
    .split(/[\/,，、;；|·()（）]+|\s{2,}/u)
    .flatMap((p) => (HAN.test(p) ? [p.replace(/\s+/g, "")] : [p]))
    .map((p) => fold(p.trim()).replace(/(市|区|區|县|縣)$/u, ""))
    .filter((p) => p.length >= (HAN.test(p) ? 2 : 3));
}

/** One of the read locality's parts is in one of Google's addresses. */
function localityIn(locality: string | null | undefined, addresses: (string | null)[]): boolean {
  const parts = localityParts(locality);
  const hay = addresses.filter((a): a is string => Boolean(a)).map(fold);
  return parts.some((p) => hay.some((h) => h.includes(p)));
}

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
  const lang = languageFor(names);
  try {
    const first: FoundPlace | null = await findPlaceByText(q, { locationBias: opts.locationBias ?? null });
    if (!first) {
      match.error = "no place found";
      return match;
    }
    let found: Candidate = first;
    const best = (f: Candidate) => Math.max(0, ...names.map((n) => nameScore(n, f.name ?? "")));
    /** The names agree, asking again in the name's own script when Google
     *  answered a CJK name in English. */
    const nameAgreement = async (c: Candidate): Promise<{ agrees: boolean; score: number | null }> => {
      if (names.some((n) => nameMatches(n, c.name ?? ""))) return { agrees: true, score: best(c) };
      if (lang) {
        const again = await findPlaceByText(q, { locationBias: opts.locationBias ?? null, language: lang }).catch(() => null);
        if (again && again.googlePlaceId === c.googlePlaceId && names.some((n) => nameMatches(n, again.name ?? ""))) {
          return { agrees: true, score: best(again) };
        }
      }
      return { agrees: false, score: null };
    };
    let names1 = await nameAgreement(found);
    let addressIssue = await addressAgreement(found, opts.address, q, opts.locationBias);

    // Google's first answer is at another address, or is another place
    // altogether (a name it can compare that does not agree: "Kang Ho
    // Dong Baekjeong 6th St" answered with another restaurant on 6th St):
    // the place meant may be further down the list. Text Search, in the
    // name's script and in English, and take the first whose name and
    // address both agree.
    /** Google's addresses of the first answer, in every language seen. */
    const firstAddresses: (string | null)[] = [found.formattedAddress];
    /** Other places of the asked-for name whose address cannot rule them
     *  out either (Google gives no street for them). */
    let otherUnrefuted = 0;
    let searched = false;
    /** Every place Text Search answered, in its order. */
    const listed: Candidate[] = [];
    const otherName = !names1.agrees && names.some((n) => comparable(n, found.name ?? ""));
    if (addressIssue || otherName) {
      const seen = new Set([found.googlePlaceId]);
      const firstId = found.googlePlaceId;
      const langs = [...new Set([lang ?? languageFor([opts.address ?? ""]), undefined])];
      search: for (const languageCode of langs) {
        const list = await searchPlacesByText(q, { maxResults: 5, languageCode, locationBias: opts.locationBias ?? null }).catch(() => null);
        if (!list) continue;
        searched = true;
        for (const c of list) {
          if (c.google_place_id === firstId) firstAddresses.push(c.formatted_address);
          if (seen.has(c.google_place_id)) continue;
          seen.add(c.google_place_id);
          const cand: Candidate = { googlePlaceId: c.google_place_id, name: c.name, formattedAddress: c.formatted_address, lat: c.lat, lng: c.lng };
          listed.push(cand);
          if (!names.some((n) => nameMatches(n, cand.name ?? ""))) continue;
          const issue = await addressAgreement(cand, opts.address, q, opts.locationBias);
          if (issue === "street_unverified") otherUnrefuted++;
          if (issue !== null) continue;
          found = cand;
          names1 = { agrees: true, score: best(cand) };
          addressIssue = null;
          break search;
        }
      }
    }

    // Google's address names no street (common for mainland China: "四牌楼
    // Huangpu, China"), so the read one can be neither confirmed nor
    // refuted. Linked when the name agrees closely, the read locality is in
    // Google's address, and no other place of that name could be the one
    // at the read address (every other branch Text Search knows is on
    // another street or number).
    if (addressIssue === "street_unverified" && names1.agrees && (names1.score ?? 0) >= 0.9 && searched && otherUnrefuted === 0) {
      let inArea = localityIn(opts.locality, firstAddresses);
      if (!inArea && lang) {
        const again = await findPlaceByText(q, { locationBias: opts.locationBias ?? null, language: lang }).catch(() => null);
        if (again && again.googlePlaceId === found.googlePlaceId) inArea = localityIn(opts.locality, [again.formattedAddress]);
      }
      if (inArea) {
        addressIssue = null;
        match.address_unverified = true;
      }
    }

    // A typed name with words for where ("Sugarfish Little Tokyo"): no
    // branch carries the whole of it, and Find Place may answer with one in
    // another city. A branch in the workspace's area that carries the
    // name's first word (the brand) is the better suggestion; with none, a
    // place elsewhere whose name does not agree is not suggested at all.
    const area = opts.requireInArea;
    const inArea = (c: Candidate) =>
      Boolean(area) && c.lat !== null && c.lng !== null && distanceM(area!, { lat: c.lat, lng: c.lng }) <= area!.radiusM;
    let brandOnly = false;
    if (area && !inArea(found) && !names1.agrees) {
      if (!searched) {
        const list = await searchPlacesByText(q, { maxResults: 5, languageCode: lang, locationBias: area }).catch(() => null);
        for (const c of list ?? []) {
          if (c.google_place_id === found.googlePlaceId) continue;
          listed.push({ googlePlaceId: c.google_place_id, name: c.name, formattedAddress: c.formatted_address, lat: c.lat, lng: c.lng });
        }
      }
      const brands = names.map((n) => nameTokens(n)[0]).filter((t): t is string => Boolean(t) && (hasCjk(t!) || t!.length >= 3));
      const local = listed.find((c) => inArea(c) && brands.some((b) => nameTokens(c.name ?? "").includes(b)));
      if (local) {
        found = local;
        names1 = { agrees: false, score: best(local) };
        addressIssue = null;
        brandOnly = true;
      } else if (names.some((n) => comparable(n, found.name ?? ""))) {
        match.rejected = { google_place_id: found.googlePlaceId, name: found.name, formatted_address: found.formattedAddress };
        match.error = "no place of that name found in the usual area";
        return match;
      }
    }

    match.google_place_id = found.googlePlaceId;
    match.name = found.name;
    match.formatted_address = found.formattedAddress;
    match.name_score = Math.round((names1.score ?? best(found)) * 100) / 100;
    const agrees = names1.agrees;
    const uncomparable = !agrees && names.every((n) => !comparable(n, found.name ?? ""));
    if (uncomparable) match.name_score = null;
    const trusted = agrees || (uncomparable && opts.trustUncomparable === true);
    // A bare name: only a place in the workspace's own area is linked.
    let areaIssue: string | null = null;
    if (opts.requireInArea !== undefined) {
      const area = opts.requireInArea;
      if (!area) areaIssue = "name_only";
      else if (found.lat === null || found.lng === null || distanceM(area, { lat: found.lat, lng: found.lng }) > area.radiusM) {
        areaIssue = "outside_area";
      }
    }
    // Google's answer shares no word with the name asked for: it is
    // another place, and offering it would suggest the wrong one. Nothing
    // is suggested; what Google answered is kept for the record.
    if (!agrees && !uncomparable && match.name_score === 0 && !brandOnly) {
      match.google_place_id = null;
      match.name = null;
      match.formatted_address = null;
      match.rejected = { google_place_id: found.googlePlaceId, name: found.name, formatted_address: found.formattedAddress };
      match.error = "no place of that name found";
      return match;
    }
    if (!trusted || addressIssue || areaIssue || opts.guessReason) {
      match.tentative = true;
      match.tentative_reason =
        opts.guessReason ?? addressIssue ?? areaIssue ?? (uncomparable ? "name_unverified" : "name_mismatch");
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
