/**
 * Deterministic Layer 2 projection from a cached Google Places v1
 * raw response (`places.raw_response`) — the read side of the
 * 3-layer data model rollout in #80, used by `POST
 * /v1/places/:id/re-derive` (#89).
 *
 * Why TS-deterministic and not an LLM call:
 *   - 95 % of the projection is rote field mapping. The remaining
 *     5 % (CJK stripping + `is_native` heuristic) is rule-encodable
 *     faithfully from `src/ingest/prompt.ts` Phase 3c. An LLM call
 *     per place would add 5–15 s of latency × N for the batch path
 *     with no judgment-call payoff the rules can't deliver.
 *   - The pre-existing `scripts/backfill-multilingual-places.ts`
 *     `derive(en, zh)` (now superseded by this module) has been
 *     running this exact projection over the production corpus
 *     since #74 shipped. This module is a hardened extraction +
 *     extension of that proven code, NOT a from-scratch port of
 *     the prompt.
 *
 * AI-native principle: LLM still owns initial extraction (the
 * agent that wrote `raw_response` in the first place), photo OCR,
 * receipt OCR, and merchant aggregation at ingest time. Re-derive
 * deliberately stays cheap so it can run frequently without
 * burning Anthropic credits — the prompt's Phase 3c heuristics are
 * stable enough to encode once and reuse across re-derive runs.
 *
 * Domain boundary: this module only projects from Google data. It
 * NEVER touches:
 *   - `places.custom_name`        (Layer 3 user-truth — renamed
 *                                  from `custom_name_zh` in #79)
 *   - `places.display_name_zh_*`  when the current source is
 *                                  `photo_ocr` / `receipt_ocr`
 *                                  (different input domain — the
 *                                  service layer enforces this)
 *   - `places.lat / .lng`         (physical facts, set at fetch)
 *   - `places.formatted_address`  (legacy primary, never rewritten)
 */

/** Google Places v1 dual-language envelope, as stored on
 *  `places.raw_response`. Pre-#74 rows may have a different shape;
 *  the caller is responsible for type-narrowing before passing in. */
export interface RawResponseV1 {
  v1: {
    en?: Record<string, unknown> | null;
    "zh-CN"?: Record<string, unknown> | null;
  };
  fetched_at?: string;
}

/** Layer 2 fields produced by a projection run. Every key here
 *  is something `reDerivePlace` will write to `places`. Keys not
 *  in this shape are NOT touched by re-derive. */
export interface ProjectedPlaceFields {
  display_name_en: string | null;
  display_name_zh: string | null;
  display_name_zh_locale: string | null;
  /** Source attribution for `display_name_zh`. This module only
   *  ever emits `"google_text"` or `null`; OCR-based sources are
   *  preserved by the service layer if the current row carries
   *  them (re-derive never reclassifies a photo/receipt-OCR name
   *  as Google-sourced). */
  display_name_zh_source: "google_text" | null;
  /** Native-script flag per prompt.ts:277-304 heuristic. */
  display_name_zh_is_native: boolean | null;

  primary_type: string | null;
  primary_type_display_zh: string | null;
  maps_type_label_zh: string | null;
  types: string[] | null;

  formatted_address_en: string | null;
  formatted_address_zh: string | null;
  postal_code: string | null;
  country_code: string | null;

  business_status: string | null;
  business_hours: unknown | null;
  time_zone: string | null;

  rating: string | null;
  user_rating_count: number | null;

  national_phone_number: string | null;
  website_uri: string | null;
  google_maps_uri: string | null;
}

/** Constant identifying this projection's "model" in audit logs.
 *  Bumped only when the projection logic in this file changes in a
 *  way that should mark rows as re-derive-eligible (i.e. the
 *  equivalent of `PROMPT_VERSION` for the deterministic side). */
export const PROJECTION_VERSION = "1.0";

/** `derivation_events.model` value for runs of this module.
 *  LLM-backed re-derive paths (e.g. future merchant cascade in
 *  #91) stamp the actual model name instead. */
export const PROJECTION_MODEL = "ts-deterministic";

// ── Helpers ─────────────────────────────────────────────────────

/** Read a string at `obj.path[0].path[1]…`, return `null` for any
 *  missing / non-string node. Doubles as a runtime type guard. */
function s(
  obj: Record<string, unknown> | null | undefined,
  ...path: string[]
): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : null;
}

/** Same as `s` but for numeric leaves. */
function n(
  obj: Record<string, unknown> | null | undefined,
  ...path: string[]
): number | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : null;
}

/** CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A
 *  (U+3400–U+4DBF). Extension B+ (surrogate pairs) is rare in
 *  Google Places responses and adds complexity for marginal
 *  recall — defer until we see an actual case. */
const CJK_RE = /[一-鿿㐀-䶿]/;
const CJK_RUN_RE = /[一-鿿㐀-䶿]+/g;
const LATIN_RE = /[A-Za-z]/;

function hasCJK(str: string): boolean {
  return CJK_RE.test(str);
}
function hasLatin(str: string): boolean {
  return LATIN_RE.test(str);
}

/** Step A from prompt.ts:254-267 — keep only the longest
 *  contiguous CJK run, the rest (Latin / parens / branch
 *  suffixes) gets discarded. Examples:
 *
 *    "Wing Hop Fung(永合豐)Monterey Park Store" → "永合豐"
 *    "Jiu Ji Dessert (九记八方甜品）"           → "九记八方甜品"
 *    "Starbucks 星巴克"                         → "星巴克"
 *    "永合豐"                                   → "永合豐"
 *    "Costco"                                   → null
 */
export function stripToLongestCjkRun(input: string): string | null {
  const runs = input.match(CJK_RUN_RE);
  if (!runs || runs.length === 0) return null;
  // ties → first occurrence wins, which matches the prompt's
  // "leftmost is usually the brand" intuition for inputs like
  // "永合豐 Monterey Park 永和" (rare).
  let best = runs[0]!;
  for (const r of runs) if (r.length > best.length) best = r;
  return best;
}

/** Brands the prompt calls out as "globally-recognized English
 *  brand whose identity is unambiguously English-first".
 *  Lowercased; matched against `en_name` after locator-suffix
 *  stripping. Expand when you find a Chinese gloss masquerading
 *  as the brand identity, then re-run `re-derive` to fix the
 *  corpus. The list is INTENTIONALLY conservative — the prompt
 *  says "when unsure, default true" because false negatives
 *  (hiding the real brand identity behind a pinyin name) hurt
 *  more than false positives. */
const GLOBAL_ENGLISH_BRANDS: ReadonlyArray<string> = [
  "costco",
  "walmart",
  "target",
  "mcdonald's",
  "mcdonalds",
  "whole foods",
  "trader joe's",
  "trader joes",
  "cvs",
  "usps",
  "apple",
  "amazon",
  "starbucks",
  "7-eleven",
  "7 eleven",
  "seven eleven",
  "best buy",
  "home depot",
  "lowe's",
  "lowes",
  "kroger",
  "ralphs",
  "albertsons",
  "safeway",
];

/** True when the leading brand token of `enName` matches a known
 *  English-first global brand. Accepts trailing locator junk —
 *  "Costco #479" / "COSTCO WHOLESALE Monterey Park" both match. */
function isGlobalEnglishBrand(enName: string): boolean {
  const cleaned = enName
    .toLowerCase()
    // Strip everything from the first store-locator marker on.
    .replace(/\s*[#(\[].*$/, "")
    .trim();
  for (const brand of GLOBAL_ENGLISH_BRANDS) {
    if (cleaned === brand) return true;
    if (cleaned.startsWith(brand + " ")) return true;
  }
  return false;
}

/** is_native heuristic from prompt.ts:277-304.
 *
 * Default: true. Set false ONLY in the narrow Costco/星巴克 case
 * where all three conditions hold:
 *   (a) the zh response's raw displayName is pure CJK (no Latin),
 *   (b) the en response's displayName is pure Latin (no CJK), AND
 *   (c) en is one of the globally-English brands we know about.
 *
 * Note we test against the **raw** zh displayName (pre-strip), not
 * the stripped one — the gloss detection cares about whether
 * Google's response is monolingual CJK, not whether we extracted a
 * CJK substring after the fact.
 */
export function computeIsNative(args: {
  enName: string | null;
  zhDisplayNameRaw: string | null;
}): boolean | null {
  const { enName, zhDisplayNameRaw } = args;
  if (zhDisplayNameRaw == null) return null;     // no zh → no flag
  if (enName == null) return true;                // can't disprove
  if (hasLatin(zhDisplayNameRaw)) return true;    // mixed zh → native
  if (hasCJK(enName)) return true;                // en has CJK → native
  if (!isGlobalEnglishBrand(enName)) return true; // not a known gloss
  return false;
}

// ── Main entry point ────────────────────────────────────────────

/** Project the cached Google response into Layer 2 fields.
 *
 * Pure function: no DB, no network, no clock side effects. Re-runs
 * are bit-identical given the same input. */
export function projectPlace(raw: RawResponseV1 | null): ProjectedPlaceFields {
  const en = raw?.v1?.en ?? null;
  const zh = raw?.v1?.["zh-CN"] ?? null;

  const enName = s(en, "displayName", "text");
  const zhRawName = s(zh, "displayName", "text");
  const zhLocale = s(zh, "displayName", "languageCode");

  // Phase 3c gate: only honor a zh response when (i) Google
  // tagged the response with a real CJK locale (not zh-Latn),
  // and (ii) the displayName actually contains CJK. Without (ii)
  // Google sometimes returns the Latin name under a `zh` tag for
  // places that have no native Chinese name.
  const zhIsChinese =
    zhLocale != null &&
    zhLocale.startsWith("zh") &&
    !zhLocale.startsWith("zh-Latn") &&
    zhRawName != null &&
    hasCJK(zhRawName);

  // Step A — strip Latin / branch suffixes; keep the longest CJK
  // run. If the response was tagged `zh` but the displayName is
  // entirely Latin (rare; treated above), `zhRawName` would have
  // failed the `hasCJK` gate already.
  const zhStripped = zhIsChinese && zhRawName ? stripToLongestCjkRun(zhRawName) : null;

  const isNative = zhStripped
    ? computeIsNative({ enName, zhDisplayNameRaw: zhRawName })
    : null;

  const typesRaw = en != null ? (en as Record<string, unknown>).types : null;
  const ratingNum = n(en, "rating");

  return {
    display_name_en: enName,
    display_name_zh: zhStripped,
    display_name_zh_locale: zhStripped ? zhLocale : null,
    display_name_zh_source: zhStripped ? "google_text" : null,
    display_name_zh_is_native: isNative,

    primary_type: s(en, "primaryType"),
    primary_type_display_zh: s(zh, "primaryTypeDisplayName", "text"),
    maps_type_label_zh: s(zh, "googleMapsTypeLabel", "text"),
    types: Array.isArray(typesRaw) ? (typesRaw as string[]) : null,

    formatted_address_en: s(en, "formattedAddress"),
    formatted_address_zh: s(zh, "formattedAddress"),
    postal_code: s(en, "postalAddress", "postalCode"),
    country_code: s(en, "postalAddress", "regionCode"),

    business_status: s(en, "businessStatus"),
    business_hours:
      (en as Record<string, unknown> | null)?.regularOpeningHours ?? null,
    time_zone: s(en, "timeZone", "id"),

    rating: ratingNum != null ? String(ratingNum) : null,
    user_rating_count: n(en, "userRatingCount"),

    national_phone_number: s(en, "nationalPhoneNumber"),
    website_uri: s(en, "websiteUri"),
    google_maps_uri: s(en, "googleMapsUri"),
  };
}
