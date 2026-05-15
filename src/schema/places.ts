import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt } from "./common.js";

/**
 * Normalized Google Places entries, keyed by Google's stable
 * `google_place_id`. Shared across workspaces: the data is public
 * (street address + lat/lng), and de-duplication across tenants is a
 * feature — the same merchant visited by two users is one row.
 *
 * Populated by the ingest worker when the extraction agent returns a
 * `geo` block (see `src/ingest/prompt.ts` Phase 3). Transactions point
 * here via `transactions.place_id`; the response shape for
 * `GET /v1/transactions/:id` joins this table and returns a nested
 * `place` subobject.
 *
 * Multilingual columns (#74): every receipt-relevant Google v1 field is
 * stored at first fetch in both `en` and `zh-CN`. `raw_response` keeps
 * the full v1 response in both languages so anything not column-promoted
 * is still queryable. `custom_name_zh` is the user override that wins
 * over `display_name_zh` in the UI fallback chain.
 */
export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Google's stable place_id. Unique across the table. */
    googlePlaceId: text("google_place_id").notNull().unique(),
    /** Legacy primary address column — kept for the existing Place
     *  response shape. `formatted_address_en` / `_zh` are the new
     *  per-language columns; this one mirrors `_en` for new rows. */
    formattedAddress: text("formatted_address").notNull(),
    /** Decimal degrees, ±90.000000. */
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    /** Decimal degrees, ±180.000000. */
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    /** Which Google endpoint produced this entry. */
    source: text("source").notNull(),
    /** Full Google response body. Post-#74 this is a multi-language
     *  envelope: `{v1: {en: <full>, "zh-CN": <full>}, fetched_at}`.
     *  Pre-#74 rows have whatever the old extractor saved here. */
    rawResponse: jsonb("raw_response"),
    firstSeenAt: createdAt,
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    hitCount: integer("hit_count").notNull().default(1),

    // ── #74 multilingual identity ──────────────────────────────────
    displayNameEn: text("display_name_en"),
    displayNameZh: text("display_name_zh"),
    /** Locale Google actually returned (`zh` | `zh-CN` | `zh-TW`).
     *  When Google falls back to en for a zh-CN request, this is `en`
     *  and `display_name_zh` should be NULL — caller MUST NOT store
     *  the English fallback in the zh column. */
    displayNameZhLocale: text("display_name_zh_locale"),
    /** Provenance of `display_name_zh`:
     *    `google_text`   — direct from Google v1 zh-CN call
     *    `photo_ocr`     — extracted from storefront photo signage
     *    `receipt_ocr`   — extracted from CJK on the receipt itself
     *                       (used when Google has no Chinese for the
     *                       place — typical for small vendors inside a
     *                       plaza that only geocode to the plaza address)
     *    `user_override` — should never be — that's `custom_name_zh`
     *  NULL when no zh name is known. */
    displayNameZhSource: text("display_name_zh_source"),
    /** Whether `display_name_zh` is the merchant's NATIVE-script name
     *  (true) vs a translation/gloss Google added (false).
     *
     *  Examples:
     *    永合豐 for Wing Hop Fung           → true  (on signage + receipts)
     *    九记八方甜品 for Jiu Ji Dessert    → true  (Chinese-owned brand)
     *    小玲锅巴土豆 (receipt_ocr)         → true  (printed on receipt)
     *    好市多 for Costco                  → false (Google translation;
     *                                                Costco's signage is
     *                                                always English)
     *    星巴克 for Starbucks               → false (gloss; brand identity
     *                                                is global English)
     *
     *  Used by the display-name selector to decide whether to promote
     *  the Chinese name to primary. Glosses (false) stay as alternates
     *  only — never replace the merchant's actual brand name.
     *
     *  Source-derived defaults at ingest time:
     *    receipt_ocr / photo_ocr → true (it's on the merchant's own surface)
     *    google_text             → derived from heuristic (mixed Latin+CJK
     *                              in the response → true; pure CJK while
     *                              en is pure Latin → false)
     *    user_override           → N/A (custom_name_zh has its own column)
     *  NULL means unknown — selector treats as false (conservative). */
    displayNameZhIsNative: boolean("display_name_zh_is_native"),
    /** User-supplied Chinese name. Wins over `display_name_zh` in the
     *  UI fallback chain. The user can correct OCR errors or supply a
     *  name Google never had. */
    customNameZh: text("custom_name_zh"),

    // ── typing ────────────────────────────────────────────────────
    primaryType: text("primary_type"),
    primaryTypeDisplayZh: text("primary_type_display_zh"),
    mapsTypeLabelZh: text("maps_type_label_zh"),
    types: text("types").array(),

    // ── address ───────────────────────────────────────────────────
    formattedAddressEn: text("formatted_address_en"),
    formattedAddressZh: text("formatted_address_zh"),
    postalCode: text("postal_code"),
    countryCode: text("country_code"),

    // ── operational ───────────────────────────────────────────────
    businessStatus: text("business_status"),
    businessHours: jsonb("business_hours"),
    timeZone: text("time_zone"),

    // ── ratings (snapshot; refreshed on re-fetch) ─────────────────
    rating: numeric("rating", { precision: 2, scale: 1 }),
    userRatingCount: integer("user_rating_count"),

    // ── contact ───────────────────────────────────────────────────
    nationalPhoneNumber: text("national_phone_number"),
    websiteUri: text("website_uri"),
    googleMapsUri: text("google_maps_uri"),

    // ── Yelp augmentation (nullable placeholders; no client yet) ──
    yelpBusinessId: text("yelp_business_id"),
    yelpAlias: text("yelp_alias"),
    yelpPriceLevel: text("yelp_price_level"),
    yelpCategories: jsonb("yelp_categories"),
    yelpRawResponse: jsonb("yelp_raw_response"),
  },
  (t) => [
    // Geo-bbox filtering for future trip clustering. Btree on (lat, lng)
    // isn't ideal for range queries (a GiST + PostGIS index would be
    // better), but it's cheap, indexed, and sufficient for the small
    // data volumes we expect pre-PostGIS.
    index("places_lat_lng_idx").on(t.lat, t.lng),
  ],
);

/**
 * One row per Google Places photo. Bytes copy locally on first fetch
 * (sha256-named, same uploads bind mount). `ocr_extracted` carries the
 * Vision-LLM output for the storefront-Chinese fallback (#74).
 */
export const placePhotos = pgTable(
  "place_photos",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    placeId: uuid("place_id").notNull(),
    /** `places/<google_place_id>/photos/<photo_resource_id>` */
    googlePhotoName: text("google_photo_name").notNull(),
    /** 0-based rank in Google's returned order. */
    rank: integer("rank").notNull(),
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    authorAttributions: jsonb("author_attributions").notNull().default(sql`'[]'::jsonb`),
    /** Local path. NULL when bytes haven't been downloaded yet. */
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    sha256: text("sha256"),
    /** Vision-LLM extraction output:
     *  { chinese_chars: "永安", model: "claude-...", confidence: "high"|"low",
     *    raw_text: "...full transcription...", ran_at: ISO }.
     *  NULL when OCR hasn't been attempted on this photo. */
    ocrExtracted: jsonb("ocr_extracted"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
);

/**
 * Snapshot history of Google reviews. A re-fetch inserts NEW rows; we
 * never UPDATE-in-place. Lets us trend ratings/text over time. Cheap
 * latest-N query is `ORDER BY snapshot_taken_at DESC LIMIT N`.
 */
export const placeReviews = pgTable(
  "place_reviews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    placeId: uuid("place_id").notNull(),
    googleReviewName: text("google_review_name").notNull(),
    rating: integer("rating").notNull(),
    textText: text("text_text"),
    textLanguage: text("text_language"),
    originalTextText: text("original_text_text"),
    originalTextLanguage: text("original_text_language"),
    relativePublishTime: text("relative_publish_time"),
    publishTime: timestamp("publish_time", { withTimezone: true }),
    authorDisplayName: text("author_display_name"),
    authorUri: text("author_uri"),
    authorPhotoUri: text("author_photo_uri"),
    snapshotTakenAt: timestamp("snapshot_taken_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    raw: jsonb("raw").notNull(),
  },
);
