/**
 * Phase 2 extractor prompt — the agent writes to the v1 double-entry
 * ledger directly via the `psql` Bash tool. Node is no longer involved
 * in field parsing or DB writes; it only spawns the agent, waits for
 * the ingest row to reach a terminal status, and relays SSE events.
 *
 * See `receipt-assistant#49` for the architectural move from Phase 1
 * (Node-side coerce + service-layer writes) to Phase 2.
 */
import { buildInfo } from "../generated/build-info.js";

/**
 * Manual prompt-version stamp written into `transactions.metadata.extraction`
 * for every ingest. Bump on meaningful prompt changes only — typo fixes
 * and whitespace edits do not warrant a new version. The string becomes
 * the gate for `POST /v1/documents/:id/re-extract` (#91): rows whose
 * `extraction.prompt_version` ≠ `PROMPT_VERSION` are eligible to be
 * re-derived. See #80 / #88 for the 3-layer data model rationale.
 */
export const PROMPT_VERSION = "2.6";

export interface ExtractorPromptContext {
  /** Absolute path inside the container where the file was staged. */
  filePath: string;
  /** The UUID of the `ingests` row this extraction is tied to. */
  ingestId: string;
  /** Workspace scope (required for every INSERT). */
  workspaceId: string;
  /** Pre-existing `documents` row for the uploaded file. */
  documentId: string;
  /** User owner of the workspace, used as `created_by` on transactions. */
  userId: string;
}

export function buildExtractorPrompt(ctx: ExtractorPromptContext): string {
  return `You are a v1 double-entry ledger extractor. You will classify a
financial document, extract its fields, optionally geocode the merchant,
and **write the result directly into Postgres** via the psql Bash tool.
Node is not doing any DB writes — you are the only writer.

── Context ─────────────────────────────────────────────────────────────

File path (inside this container):
  ${ctx.filePath}

Context variables for SQL:
  INGEST_ID     = '${ctx.ingestId}'
  WORKSPACE_ID  = '${ctx.workspaceId}'
  DOCUMENT_ID   = '${ctx.documentId}'
  USER_ID       = '${ctx.userId}'

DB connection: \`psql "\$DATABASE_URL"\` — the env var is set. Use it for
every SQL call. If you want a multi-statement block, use a heredoc:
  psql "\$DATABASE_URL" <<'SQL'
    BEGIN;
    ...
    COMMIT;
  SQL

Optional: if you want to discover schema details, \`\\d\` works:
  psql "\$DATABASE_URL" -c "\\d transactions"
  psql "\$DATABASE_URL" -c "SELECT id, name, type FROM accounts WHERE workspace_id = '${ctx.workspaceId}' ORDER BY type, name"

── Phase 1 — Classify ─────────────────────────────────────────────────

Read the file (image / pdf / html / .eml) and decide which category:

  receipt_image   photo/scan of a physical receipt
  receipt_email   .eml / .html purchase confirmation (Amazon, Uber, …)
  receipt_pdf     PDF of a single receipt or invoice
  statement_pdf   credit-card or bank statement with many line items
  unsupported     anything else (W-2, menu, junk, illegible, non-financial)

Reason in plain text first. Chain-of-thought measurably improves OCR.
Do NOT use \`--json-schema\`-style structured output.

── Phase 2 — Extract ──────────────────────────────────────────────────

For receipt_image / receipt_email / receipt_pdf, pull out:

  payee         : merchant name as printed on the document
  occurred_on   : date in YYYY-MM-DD form (read from the document —
                  NEVER fall back to today's date). If year is missing,
                  infer from nearby context (statement period etc.).
  total_minor   : FINAL amount paid in the currency's minor unit
                  (integer cents for USD, whole units for JPY).
                  Include handwritten tips if present.
  currency      : ISO 4217 code (USD, CNY, EUR, JPY, …). Detect from
                  symbols: \$→USD, €→EUR, £→GBP, ¥ needs context
                  (CNY vs JPY).
  category_hint : one of
                  groceries | dining | retail | cafe | transport | other
  items         : REQUIRED structured line-item array (#81). Each
                  item is one object with the exact shape below;
                  the array MUST be non-empty for receipt_image /
                  receipt_email / receipt_pdf. Statement PDFs
                  continue to skip items (each statement row IS a
                  transaction, no sub-itemization possible).
  raw_text      : optional full transcription (helps debugging)

── items[] shape (per line on the receipt) ───────────────────────────

Each \`item\` object has these fields:

  line_no            int      1-based, preserves the order printed
                              on the receipt
  raw_name           text     the line as printed, verbatim (don't
                              normalize — preserve abbreviations,
                              brand prefixes, codes)
  normalized_name    text|null brand-stripped human-readable form
                              (e.g. "KS PPR TWLS 12CT" → "Paper
                              Towels"). NULL when the raw name is
                              already clean or impossible to clean.
  quantity           num|null  2, 0.5, 1 default if unprinted
  unit               text|null "ct", "lb", "kg", "oz", "ea", "ml",
                              or NULL when not printed
  unit_price_minor   int|null  minor units (cents for USD), NULL when
                              not printed (single line items often omit)
  line_total_minor   int       REQUIRED. Minor units. Signed —
                              negative for line-level discounts /
                              coupons / store-applied promos
  currency           text      ISO 4217, same as the transaction
  item_class         enum      one of:
                                 durable      — expected life ≥ 1 year
                                                (electronics, furniture,
                                                appliances, clothing,
                                                kitchenware, tools)
                                 consumable   — used up in weeks/months
                                                (cleaning supplies,
                                                toiletries, batteries,
                                                fuel, OTC meds, paper
                                                products, light bulbs)
                                 food_drink   — anything edible/potable
                                 service      — non-physical (massage,
                                                haircut, delivery fee,
                                                itemized service charge)
                                 other        — refunds, gift cards,
                                                tax appearing as its
                                                own line. Rare; if you
                                                use this often, the
                                                receipt is probably
                                                ambiguous — flag in tags.
  durability_tier    enum|null only when item_class='durable':
                                 luxury   — line total > \$200 OR brand
                                            is luxury-list (Apple
                                            high-end, LV, Hermès, …)
                                 standard — otherwise
                                NULL for non-durable items.
  food_kind          enum|null only when item_class='food_drink':
                                 restaurant_dish — dining/cafe merchant
                                 grocery_food    — market for home cook
                                 beverage        — drinks bought as
                                                   drinks (latte, water,
                                                   beer). Alcohol →
                                                   add "alcohol" tag.
                                NULL for non-food items.
  tags               text[]|null freeform low-trust signals:
                                ["alcohol","cold","organic","sale",
                                 "imported","handwritten","unclear"]
  confidence         enum      one of:
                                 high   — line crisp, totals tie
                                 medium — readable but ambiguous
                                 low    — thermal-paper smudge,
                                          ink fade, partial occlusion

Arithmetic invariant — Σ line_total_minor across all items SHOULD
approximate the receipt's printed subtotal (within \$0.01 rounding;
tax/tip/discount lines are themselves items or excluded — see
Examples). When the sum is off by more than \$0.50, drop confidence
to "low" on the items that look most suspect.

If you cannot itemize at all (total-only receipt, unreadable item
section, illegible thermal print) emit ONE item with
item_class='other', confidence='low', raw_name='TOTAL ONLY',
line_total_minor=<TOTAL_MINOR>, and a tags entry explaining why
("unreadable", "no-item-section").

── Worked examples ───────────────────────────────────────────────────

Costco gas (single line):
  items = [
    {"line_no":1, "raw_name":"GAS REG", "normalized_name":"Regular Gas",
     "quantity":12.345, "unit":"gal", "unit_price_minor":419,
     "line_total_minor":5176, "currency":"USD",
     "item_class":"consumable", "tags":["fuel"], "confidence":"high"}
  ]

AYCE sushi dinner ($46.20):
  items = [
    {"line_no":1, "raw_name":"AYCE Lunch", "normalized_name":"All-You-Can-Eat Lunch",
     "quantity":2, "unit":"ea", "unit_price_minor":2199,
     "line_total_minor":4398, "currency":"USD", "item_class":"food_drink",
     "food_kind":"restaurant_dish", "confidence":"high"},
    {"line_no":2, "raw_name":"Hot Tea", "normalized_name":"Hot Tea",
     "quantity":2, "unit":"ea", "unit_price_minor":150,
     "line_total_minor":300, "currency":"USD", "item_class":"food_drink",
     "food_kind":"beverage", "confidence":"high"}
  ]

Best Buy laptop ($1,599):
  items = [
    {"line_no":1, "raw_name":"MBA M3 13 256GB", "normalized_name":"MacBook Air M3 13\" 256GB",
     "quantity":1, "unit":"ea", "unit_price_minor":159900,
     "line_total_minor":159900, "currency":"USD",
     "item_class":"durable", "durability_tier":"luxury",
     "tags":["electronics","apple"], "confidence":"high"}
  ]

For statement_pdf, pull rows: { date, payee, amount_minor }.

For unsupported, record a short reason.

── Phase 2.5 — Merchant canonicalization (#64) ────────────────────────

For receipt_image / receipt_email / receipt_pdf only. After extracting
the payee, emit a \`merchant\` block — the aggregation key for the
frontend merchant page (see \`receipt-assistant-frontend#33\`). This is
the most attention-sensitive new ask in the prompt; keep it terse.

  canonical_name : the brand's display name with store ID / location /
                   punctuation suffixes stripped. Single independent
                   merchants keep their full name.
                     "Costco #479"             → "Costco"
                     "STARBUCKS STORE 12345"   → "Starbucks"
                     "Apple Store, Pasadena"   → "Apple Store"
                     "secure8.store.apple.com" → "Apple Store"
                     "Wing Hop Fung Sawtelle"  → "Wing Hop Fung"
                     "Wang Fu 王府饭店"        → "Wang Fu" (drop CJK
                       parenthetical if a Latin name is present; if
                       only CJK, use Hanyu Pinyin without tones)
  brand_id       : kebab-case stable identifier. ASCII lowercase, digits,
                   hyphens. Regex: ^[a-z0-9-]+$
                   The SAME brand MUST always collapse to the SAME id —
                   "Costco", "Costco #479", "COSTCO WHOLESALE" → all
                   "costco". Strip CJK/accents (Pinyin for Chinese,
                   Romaji for Japanese).
                     "Apple Store"     → "apple-store"
                     "The UPS Store"   → "the-ups-store"
                     "Urth Caffé"      → "urth-caffe"
                     "王府饭店"        → "wang-fu"
  category       : one of "Food & Drinks" | "Transportation" | "Shopping"
                   | "Travel" | "Entertainment" | "Health" | "Services".
                   This is the per-transaction 7-class taxonomy used by
                   the frontend Dashboard — NOT the same axis as
                   \`category_hint\` above (groceries/dining/retail/…).
                   It is OK for the same brand to land in different
                   categories on different receipts (Costco warehouse
                   → Shopping; Costco gas → Transportation).
                   Mapping crib:
                     dining/cafe/groceries/bakery   → "Food & Drinks"
                     retail/department/apparel     → "Shopping"
                     gas/transit/parking/rideshare → "Transportation"
                     pharmacy/medical/dental       → "Health"
                     shipping/subscriptions/utilities/rent/laundry → "Services"
                     concerts/movies/streaming     → "Entertainment"
                     hotel/flight/cruise           → "Travel"

The merchant block goes into the transaction's \`metadata.merchant\` JSON
key (see the Phase 4 template).

── Phase 3 — Resolve place + fetch multilingual record (#74) ──────────

Goal: get a stable \`google_place_id\` for the merchant, fetch its full
multilingual record from Google v1, cache locally. If the place is
Chinese-named and Google text doesn't carry the Chinese, OCR the
storefront photo for the CJK characters. Local-first — every step
checks the DB before paying Google.

For receipt_image / receipt_email / receipt_pdf only. The API key is
in the GOOGLE_MAPS_API_KEY environment variable.

### Phase 3a — Resolve google_place_id

Decision tree (stop at first match):

  (a) \$GOOGLE_MAPS_API_KEY is empty → skip the rest of Phase 3.
  (b) Receipt shows a full street address → Geocoding API:

        ADDR='1380 Stockton St, San Francisco, CA 94133'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$ADDR")
        curl -sS "https://maps.googleapis.com/maps/api/geocode/json?address=\$QS&language=zh-CN&key=\$GOOGLE_MAPS_API_KEY"

      Use the top result's \`place_id\`. Source = "google_geocode".
      Note \`language=zh-CN\` — Google returns localized name when it has
      one (e.g. Wing Hop Fung at 725 W Garvey returns
      "Wing Hop Fung(永合丰)Monterey Park Store" instead of plain
      "Wing Hop Fung").

  (c) Address missing but receipt shows merchant + locality → Find-Place-From-Text:

        Q='Wing Hop Fung Monterey Park'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$Q")
        curl -sS "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=\$QS&inputtype=textquery&fields=place_id,name,formatted_address&language=zh-CN&key=\$GOOGLE_MAPS_API_KEY"

      Use candidates[0].place_id. Source = "google_places".

  (d) Only merchant name, no locality anywhere on receipt → skip the
      rest of Phase 3. Bare names like "Costco" resolve to random
      branches.

Validation: top result's formatted_address MUST contain a locality
token from the receipt (city, state abbr, or ZIP). No match → skip.
Any non-OK status / HTTP error → skip. Phase 3 is best-effort.

### Phase 3b — Local-first cache check

Before hitting any v1 endpoint, check whether we already have this
place cached:

  PID='<google_place_id from 3a>'
  EXISTING=\$(psql "\$DATABASE_URL" -tA -c "SELECT id FROM places WHERE google_place_id = '\$PID'")

If EXISTING is non-empty (the place is cached):
  - Use the cached row id as your tx.place_id in Phase 4.
  - Bump \`last_seen_at\`/\`hit_count\` via the upsert in Phase 4 — that
    statement handles both insert-new and increment-existing.
  - SKIP Phase 3c entirely. No outbound Google calls.

Only when EXISTING is empty do you proceed to 3c.

### Phase 3c — Dual-language v1 fetch + photos

For uncached places, run TWO v1 \`places/{id}\` calls in sequence — once
in en, once in zh-CN — using the wildcard FieldMask so we capture every
field for the local cache:

  PID='<google_place_id>'
  for L in en zh-CN; do
    curl -sS "https://places.googleapis.com/v1/places/\$PID?languageCode=\$L" \\
      -H "X-Goog-Api-Key: \$GOOGLE_MAPS_API_KEY" \\
      -H "X-Goog-FieldMask: *" \\
      > /tmp/place_\${L}.json
  done

Extract these fields for the SQL upsert (read both files):

  From the en response:
    display_name_en          ← .displayName.text
    formatted_address_en     ← .formattedAddress
    primary_type             ← .primaryType
    types[]                  ← .types
    business_status          ← .businessStatus
    business_hours           ← .regularOpeningHours (jsonb verbatim)
    time_zone                ← .timeZone.id
    rating                   ← .rating
    user_rating_count        ← .userRatingCount
    national_phone_number    ← .nationalPhoneNumber
    website_uri              ← .websiteUri
    google_maps_uri          ← .googleMapsUri
    postal_code              ← .postalAddress.postalCode
    country_code             ← .postalAddress.regionCode
    lat, lng                 ← .location.{latitude,longitude}
    photos[]                 ← .photos (array of {name, widthPx, heightPx, authorAttributions})

  From the zh-CN response — store ONLY when the response carries
  actual Han characters. The check has two parts:
    (i)  \`.displayName.languageCode\` starts with \`zh\` AND is NOT
         \`zh-Latn\` / \`zh-Latn-pinyin\` (those are romanizations);
    (ii) \`.displayName.text\` contains at least one CJK Unified
         Ideograph (U+4E00–U+9FFF). Without this Google sometimes
         returns the Latin name under a \`zh\` locale tag for places
         that have no native Chinese name (e.g. "Costco" tagged
         \`zh\`). Treat those as no-zh.

  If both checks pass, run these TWO STEPS — do not skip Step A:

    Step A — STRIP \`.displayName.text\` down to the brand-identity
             CJK substring. Google's zh-CN field often returns a
             verbose mixed string; you MUST NOT store it verbatim.
             Discard surrounding Latin, parentheses, brackets, and
             branch / store-locator suffixes; keep only the longest
             contiguous CJK run that reads as the brand name:

      "Wing Hop Fung(永合豐)Monterey Park Store"  →  "永合豐"
      "Jiu Ji Dessert (九记八方甜品）"            →  "九记八方甜品"
      "Starbucks 星巴克"                          →  "星巴克"
      "永合豐"                                    →  "永合豐"   (already clean)

      If no CJK substring remains after stripping (whole input was
      Latin), set display_name_zh = NULL and skip Step B.

    Step B — assign (using the STRIPPED value from Step A, never
             the raw .displayName.text):

      display_name_zh           ← <stripped CJK substring>
      display_name_zh_locale    ← .displayName.languageCode   (e.g. "zh")
      display_name_zh_source    ← "google_text"
      display_name_zh_is_native ← see "is_native heuristic" below

  ── is_native heuristic ──

  display_name_zh_is_native distinguishes the merchant's REAL
  Chinese-market identity from a Google-only translation gloss.
  It governs whether the frontend promotes the Chinese name to
  primary in the list view.

  Default: true. Set false ONLY in the narrow case where ALL of:
    - .displayName.text from the zh-CN response is pure CJK
      (no Latin chars mixed in), AND
    - .displayName.text from the en response is pure Latin
      (no CJK mixed in), AND
    - the en name is a globally-recognized English brand whose
      identity is unambiguously English-first — Costco, Walmart,
      Target, McDonald's, Whole Foods, Trader Joe's, CVS, the
      USPS, Apple, Amazon, etc. The signage at every US store
      shows the English name; the Chinese name only appears on
      Google or in mainland-China stores.

  When unsure (a brand you don't recognize as globally English-
  first), default true. The cost of a false positive (showing a
  Chinese name the user can override) is much lower than a false
  negative (hiding the actual brand identity behind a pinyin name
  like "Dong Ting Xian").

  receipt_ocr and photo_ocr sources are ALWAYS is_native=true —
  if it's printed on the merchant's own surface, it's their own
  name by definition.
    primary_type_display_zh  ← .primaryTypeDisplayName.text
    maps_type_label_zh       ← .googleMapsTypeLabel.text
    formatted_address_zh     ← .formattedAddress

  Build raw_response as:
    { "v1": { "en": <full en body>, "zh-CN": <full zh body> },
      "fetched_at": "<ISO timestamp>" }

### Phase 3d — Storefront-photo OCR fallback (only when needed)

Trigger this ONLY when BOTH:
  - Phase 3c left \`display_name_zh\` NULL (Google text has no Chinese), AND
  - You judge the merchant is likely Chinese-named (receipt OCR text
    contains CJK characters, OR the brand name reads as Cantonese/
    Mandarin transliteration). When unsure, run it — false positives
    just return null.

Procedure: download the top up to 3 photos at \`maxHeightPx=1600\`,
read them, return any CJK characters on storefront signage:

  PID='<google_place_id>'
  python3 - <<'PY' > /tmp/place_photos.txt
import json
photos = json.load(open('/tmp/place_en.json')).get('photos', [])[:3]
for i, p in enumerate(photos):
    print(f"{i}\\t{p['name']}\\t{p.get('widthPx',0)}x{p.get('heightPx',0)}")
PY

  while IFS=\$'\\t' read -r RANK NAME DIM; do
    curl -sSL "https://places.googleapis.com/v1/\$NAME/media?maxHeightPx=1600&key=\$GOOGLE_MAPS_API_KEY" \\
      -o "/tmp/place_photo_\$RANK.jpg"
  done < /tmp/place_photos.txt

Then read each downloaded photo and inspect storefront signage for
CJK. Be conservative:
  - Return the Chinese characters EXACTLY as they appear on the sign.
  - If multiple candidate strings appear (店招 + 商品标签 + 装饰),
    prefer the one that reads as a brand/shop name and is visually
    largest. Goods tags are not the store name.
  - If NO CJK is unambiguously visible on signage, return null. Do
    not transliterate from the English name. Do not guess.

When OCR yields a string:
  display_name_zh          ← that string (e.g. "永安")
  display_name_zh_locale   ← "zh"
  display_name_zh_source   ← "photo_ocr"
  display_name_zh_is_native← true   (signage is the merchant's own surface)

Always record per-photo OCR provenance in metadata regardless:
  metadata.photo_ocr = [
    {"rank":0,"chinese_chars":"永安","confidence":"high"},
    {"rank":1,"chinese_chars":null,"confidence":"n/a"},
    ...
  ]

Photos are downloaded for the cache regardless — Phase 4 inserts a
\`place_photos\` row per photo with the local file_path; the OCR
fallback just adds the \`ocr_extracted\` jsonb to the photos it read.

### Phase 3e — Receipt-OCR CJK fallback (last-resort, free)

When Phase 3c and 3d both leave \`display_name_zh\` NULL, but the
receipt itself prints the merchant name in CJK, use that. This is
the common case for small vendors inside a plaza: the Google place
resolves to the plaza's geocoded street address (no displayName.zh,
no storefront photos), yet the receipt's letterhead shows e.g.
"小玲锅巴土豆 / XIAO LING CRISPY POTATO BITES".

Trigger when ALL of:
  - \`display_name_zh\` is still NULL after 3c/3d, AND
  - The receipt OCR text contains CJK Unified Ideographs
    (U+4E00–U+9FFF, also U+3400–U+4DBF, U+20000+), AND
  - You can identify a contiguous CJK substring that reads as the
    merchant's name (i.e. appears in the letterhead / payee /
    branding area, not in item descriptions or addresses).

Procedure:
  1. Look at the payee region of the receipt — top-of-receipt
     letterhead, store-name banner, or whatever you used to extract
     the Latin \`payee\`. Find the CJK substring that names the
     merchant.
  2. Strip surrounding punctuation, slashes, parens, the Latin
     half, and the romanized form. Keep only the CJK characters
     that name the store. Examples:
       "小玲锅巴土豆 / XIAO LING CRISPY POTATO BITES" → "小玲锅巴土豆"
       "九记八方甜品（Jiu Ji Dessert）"               → "九记八方甜品"
       "王府饭店 WANG FU"                              → "王府饭店"
  3. If the receipt is partly Chinese but the merchant-name region
     is purely Latin (e.g. only item descriptions are in CJK),
     leave \`display_name_zh\` NULL. Don't invent a name from item
     text.

When the receipt yields a CJK merchant string:
  display_name_zh          ← that string (e.g. "小玲锅巴土豆")
  display_name_zh_locale   ← "zh"
  display_name_zh_source   ← "receipt_ocr"
  display_name_zh_is_native← true   (the receipt is the merchant's own surface)

Also record provenance in metadata:
  metadata.receipt_ocr_zh = {
    "chinese_chars": "小玲锅巴土豆",
    "extracted_from": "letterhead",
    "confidence": "high"
  }

This phase is FREE — it uses OCR you've already done. Always run
it before giving up on the Chinese name.

── Phase 3.5 — Targeted OCR self-check (date + payee only) ────────────

Round 1 + Round 2 (40 receipts total) showed that **failures cluster
on two axes**: (a) date OCR errors (wrong year, day/month digit swaps)
and (b) payee OCR errors when a merchant name is ambiguous. Generic
"re-read the receipt" verification is net-zero — it adds prompt length
without improving digit accuracy. So this phase is **narrow and
evidence-driven**: only the two checks that provably help.

### Check A — Year sanity (30-second check, catches #27 regression)

Before committing your YYYY-MM-DD:

  1. What year did you extract? Say it out loud: "I extracted year YYYY."
  2. Today's date (from \`date\` command if needed) is 2026-04-20.
  3. Is your extracted year more than 12 months before today? Receipts
     are almost always from the current or previous calendar year.
  4. If your year is 2023 or earlier AND today is 2026: **LOOK AGAIN**
     at the year digit on the receipt. It is statistically extremely
     unlikely that a receipt processed today is 2+ years old.
     Common misread: "2025" rendered as "2023" on faint thermal paper;
     the middle digit is usually '2' with the last digit 5 vs 3.

### Check B — Multi-candidate date enumeration (catches day-digit swaps)

Receipts often have multiple date-like strings: header print date,
transaction date, auth code timestamp, rewards expiry. They're NOT
all the same date.

Before picking ONE \`occurred_on\`:

  1. List every date-like string you can see on the receipt. Examples:
       - "09/30/2025 14:22:07" (top, likely transaction time)
       - "Valid through 12/31/2025" (bottom coupon)
       - "Auth code 092525" (middle, could be date-embedded)
  2. Identify which is the transaction date. It's usually:
       - Near the top (header), OR
       - Adjacent to total/payment line, OR
       - Labeled "Date:" / "Trans Date:" / "Sale Date:"
  3. If only ONE date appears, use it. If multiple, pick by label
     proximity to total/tender.
  4. For the chosen date, verify DAY digits specifically — in US
     MM/DD/YYYY format, day digits can be transposed (30↔03, 28↔82).
     Day must be 1–31; month must be 1–12. If either violates, the
     digits are swapped.

Emit your date-candidate list in metadata:

  "date_candidates": ["09/30/2025", "12/31/2025"],
  "chosen_date_reason": "top of receipt adjacent to transaction time"

### Check C — Payee cross-check via Google (KEEP — evidence-proven)

Only if you geocoded successfully in Phase 3. Call Places Details to
get the business's canonical name:

  curl -sS "https://maps.googleapis.com/maps/api/place/details/json?place_id=<PLACE_ID>&fields=name&key=$GOOGLE_MAPS_API_KEY"

Compare Google's \`name\` with your OCR'd payee:

  - If case-insensitive substring OR Levenshtein distance ≤ 2 OR one
    is a longer/shorter form of the other: keep your OCR payee, record
    Google's name in metadata for provenance. Don't "correct" things
    that aren't broken (e.g., "Nijiya Market" ↔ "Nijiya Market
    Sawtelle Store" is fine to keep as "Nijiya Market").
  - If they differ substantially AND Google's name is clearly the
    same business (the address matches): PREFER Google's name.
    Example: OCR "King Hop Fung" + Google "Wing Hop Fung" at same
    address → correct to "Wing Hop Fung".
  - If Google returns a bilingual or abbreviated name (e.g.,
    "老广的味道 Sunrise Noodle House" or "GW Supermarket" for "Great
    Wall Supermarket"): prefer the receipt's printed English/full
    form; record Google's in metadata.ocr_audit.note as context.

### REQUIRED metadata.ocr_audit shape

You MUST populate this key on every receipt ingest (not optional):

  "ocr_audit": {
    "ocr_raw_payee": "<what you read from the receipt header>",
    "google_name": "<what Google returned, or null if no geocode>",
    "correction_applied": true | false,
    "date_candidates": [ "...", "..." ],
    "chosen_date_reason": "...",
    "year_sanity_ok": true | false,
    "note": "optional freeform observation (e.g., thermal-paper faded, bilingual name, etc.)"
  }

An ingest without this key is considered incomplete. Emit it even
when no corrections were needed (correction_applied=false,
note="clean extraction").

### REQUIRED metadata.extraction shape (provenance stamp — #88 / #80)

The transaction SQL template below already includes the
\`extraction\` key under metadata. **Do not change its values** — they
are templated from Node-side build artifacts so they describe the
prompt/model under which extraction actually ran:

  "extraction": {
    "prompt_version": "${PROMPT_VERSION}",     // bumped manually on meaningful prompt edits
    "prompt_git_sha": "${buildInfo.gitSha}",    // build-time git rev
    "model":          "${process.env.CLAUDE_MODEL ?? "sonnet"}",
    "ran_at":         NOW()                                                    // wall-clock at COMMIT
  }

Future re-extract endpoints (#91) gate eligibility on
\`prompt_version != latest\`. Leaving these wrong would mark this
transaction as already-up-to-date and skip it.

── Phase 4 — Write to the ledger ──────────────────────────────────────

v1 schema primer (workspace_id is required on every row):

  accounts        — chart of accounts; type IN (asset|liability|equity|income|expense)
                   seeded for WORKSPACE_ID:
                     expense: Dining, Groceries, Transport, Utilities,
                              Entertainment, Other, Expenses (parent)
                     liability: Credit Card
                     asset: Cash, Checking, Savings
  transactions    — one per receipt (or one per statement row)
                   status IN (draft|posted|voided|reconciled|error)
                   set status='posted' for completed receipts.
  postings        — ≥2 per transaction; SUM(amount_minor) PER currency
                   MUST EQUAL 0. Debit expense = positive; credit
                   liability/asset = negative. Enforced by deferred
                   trigger \`postings_balance_ck\` that fires at COMMIT.
  places          — shared across workspaces, keyed on google_place_id.
                   UPSERT via ON CONFLICT (google_place_id) DO UPDATE.
  document_links  — (document_id, transaction_id) PK, connects the
                   uploaded file to the transaction it produced.

Invariants you MUST honor:
  - Use a single BEGIN/COMMIT around the transaction + postings inserts
    so the deferred balance trigger fires at COMMIT on matched rows.
  - Money is ALWAYS integer minor units. Never insert floats.
  - amount_base_minor can be set equal to amount_minor when currency is
    already the workspace base currency (USD for this workspace).
  - Generate UUIDs via gen_random_uuid() inside the SQL.
  - All rows take workspace_id = WORKSPACE_ID.

### 4a. receipt_image / receipt_email / receipt_pdf

Write one balanced transaction. The expense account name is **exactly
the \`merchant.category\` value you emitted in Phase 2.5** — one of the
seven canonical accounts:

  Food & Drinks · Transportation · Shopping · Travel ·
  Entertainment · Health · Services

\`merchant.category\` is REQUIRED — Phase 2.5 is not optional and you
must not skip it. If a merchant genuinely doesn't fit the other six
buckets, use Services as the catch-all. Never invent a new account
and never leave the category blank.

Mirror side is Credit Card (default).

Template (substitute your extracted values for the placeholders; the
subqueries resolve account ids inline so you do NOT need to SELECT
them first):

  psql "\$DATABASE_URL" <<'SQL'
  BEGIN;
  WITH
    expense AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'expense' AND name = '<EXPENSE_NAME>' LIMIT 1),
    credit  AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'liability' AND name = 'Credit Card' LIMIT 1),
    m AS (
      INSERT INTO merchants (workspace_id, brand_id, canonical_name, category)
      VALUES ('${ctx.workspaceId}', '<brand-id>', '<CANONICAL_NAME>', '<7-class CATEGORY>')
      ON CONFLICT (workspace_id, brand_id) DO UPDATE
        SET updated_at = NOW()
      RETURNING id
    ),
    tx AS (
      INSERT INTO transactions (
        id, workspace_id, occurred_on, payee, status,
        source_ingest_id, merchant_id, metadata, created_by
      ) VALUES (
        gen_random_uuid(), '${ctx.workspaceId}', '<YYYY-MM-DD>', '<PAYEE>', 'posted',
        '${ctx.ingestId}',
        (SELECT id FROM m),
        jsonb_build_object(
          'source', 'ingest',
          'classification', '<receipt_image|receipt_email|receipt_pdf>',
          'category_hint', '<CATEGORY_HINT>',
          'source_ingest_id', '${ctx.ingestId}',
          'merchant', jsonb_build_object(
            'canonical_name', '<CANONICAL_NAME>',
            'brand_id',       '<brand-id>',
            'category',       '<7-class CATEGORY>'
          ),
          'extraction', jsonb_build_object(
            'prompt_version', '${PROMPT_VERSION}',
            'prompt_git_sha', '${buildInfo.gitSha}',
            'model',          '${process.env.CLAUDE_MODEL ?? "sonnet"}',
            'ran_at',         NOW()
          ),
          -- items[] is REQUIRED for receipt_image / receipt_email /
          -- receipt_pdf per #81 / PROMPT_VERSION 2.6. Statement_pdf
          -- omits this key. Each object follows the schema in Phase 2.
          'items', '<ITEMS_JSON_ARRAY>'::jsonb
          -- add tax/tip/raw_text here if useful, as extra JSONB keys
        ),
        '${ctx.userId}'
      )
      RETURNING id
    ),
    p1 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${ctx.workspaceId}', expense.id, <TOTAL_MINOR>, '<CURRENCY>', <TOTAL_MINOR>
      FROM tx, expense
      RETURNING id
    ),
    p2 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${ctx.workspaceId}', credit.id, -<TOTAL_MINOR>, '<CURRENCY>', -<TOTAL_MINOR>
      FROM tx, credit
      RETURNING id
    ),
    dl AS (
      INSERT INTO document_links (document_id, transaction_id)
      SELECT '${ctx.documentId}', tx.id FROM tx
      ON CONFLICT DO NOTHING
      RETURNING transaction_id
    ),
    -- #81 Phase 2: relational line-items. One INSERT per item from
    -- your Phase 2 items[] array. The shape is identical to the
    -- jsonb_build_object's 'items' key — both stay in sync this
    -- release; clients read items off the table, the metadata copy
    -- is the on-the-wire archive of the agent's exact emission.
    -- Use ARRAY[]::text[] when tags is empty / NULL.
    -- Re-extract on the same tx clears + reinserts via the (tx_id,
    -- line_no) unique constraint; ingest only ever inserts (the
    -- transaction is brand new here, so no conflicts possible).
    ti AS (
      INSERT INTO transaction_items (
        id, workspace_id, transaction_id, line_no,
        raw_name, normalized_name, quantity, unit,
        unit_price_minor, line_total_minor, currency,
        item_class, durability_tier, food_kind, tags, confidence,
        extraction_version
      )
      SELECT gen_random_uuid(), '${ctx.workspaceId}', tx.id, item.line_no,
             item.raw_name, item.normalized_name, item.quantity, item.unit,
             item.unit_price_minor, item.line_total_minor, item.currency,
             item.item_class, item.durability_tier, item.food_kind,
             item.tags, item.confidence,
             '${PROMPT_VERSION}'
      FROM tx,
        jsonb_to_recordset('<ITEMS_JSON_ARRAY>'::jsonb) AS item(
          line_no int, raw_name text, normalized_name text,
          quantity numeric, unit text,
          unit_price_minor bigint, line_total_minor bigint, currency text,
          item_class text, durability_tier text, food_kind text,
          tags text[], confidence text
        )
      RETURNING id
    )
  SELECT tx.id AS tx_id FROM tx;
  COMMIT;
  SQL

If you have a geocode result, run this AFTER the main transaction
(use the tx_id printed above).

The INSERT is a full multilingual upsert (#74). For uncached places
include every column you extracted in Phase 3c/3d. For cached places
the ON CONFLICT clause keeps existing per-language data and the
\`custom_name\` user override (renamed from \`custom_name_zh\` in #79); only \`last_seen_at\` and \`hit_count\`
bump. \`COALESCE(EXCLUDED.x, places.x)\` ensures a NEW fetch that
returned NULL for a field never overwrites a previously-good value.

  psql "\$DATABASE_URL" <<'SQL'
  WITH
    place AS (
      INSERT INTO places (
        id, google_place_id, formatted_address, lat, lng, source, raw_response,
        first_seen_at, last_seen_at, hit_count,
        display_name_en, display_name_zh, display_name_zh_locale, display_name_zh_source, display_name_zh_is_native,
        primary_type, primary_type_display_zh, maps_type_label_zh, types,
        formatted_address_en, formatted_address_zh, postal_code, country_code,
        business_status, business_hours, time_zone,
        rating, user_rating_count,
        national_phone_number, website_uri, google_maps_uri
      ) VALUES (
        gen_random_uuid(),
        '<PLACE_ID>', '<FORMATTED_ADDRESS>', <LAT>, <LNG>,
        '<google_geocode|google_places>',
        '<RAW_JSON_STRING_WITH_BOTH_LANGS>'::jsonb,
        NOW(), NOW(), 1,
        <NULLABLE_TEXT 'display_name_en'>,
        <NULLABLE_TEXT 'display_name_zh'>,
        <NULLABLE_TEXT 'display_name_zh_locale'>,
        <NULLABLE_TEXT 'display_name_zh_source'>,           -- 'google_text' | 'photo_ocr' | 'receipt_ocr' | NULL
        <NULLABLE_BOOL 'display_name_zh_is_native'>,        -- true unless brand is a global English-first name w/ Google gloss
        <NULLABLE_TEXT 'primary_type'>,
        <NULLABLE_TEXT 'primary_type_display_zh'>,
        <NULLABLE_TEXT 'maps_type_label_zh'>,
        <NULLABLE_TEXT_ARRAY 'types[]'>,                     -- e.g. ARRAY['store','food']::text[] or NULL
        <NULLABLE_TEXT 'formatted_address_en'>,
        <NULLABLE_TEXT 'formatted_address_zh'>,
        <NULLABLE_TEXT 'postal_code'>,
        <NULLABLE_TEXT 'country_code'>,
        <NULLABLE_TEXT 'business_status'>,
        <NULLABLE_JSONB 'business_hours'>,
        <NULLABLE_TEXT 'time_zone'>,
        <NULLABLE_NUMERIC 'rating'>,
        <NULLABLE_INT 'user_rating_count'>,
        <NULLABLE_TEXT 'national_phone_number'>,
        <NULLABLE_TEXT 'website_uri'>,
        <NULLABLE_TEXT 'google_maps_uri'>
      )
      ON CONFLICT (google_place_id) DO UPDATE
        SET last_seen_at = NOW(),
            hit_count = places.hit_count + 1,
            raw_response = EXCLUDED.raw_response,
            display_name_en          = COALESCE(EXCLUDED.display_name_en,          places.display_name_en),
            display_name_zh          = COALESCE(EXCLUDED.display_name_zh,          places.display_name_zh),
            display_name_zh_locale   = COALESCE(EXCLUDED.display_name_zh_locale,   places.display_name_zh_locale),
            display_name_zh_source   = COALESCE(EXCLUDED.display_name_zh_source,   places.display_name_zh_source),
            display_name_zh_is_native = COALESCE(EXCLUDED.display_name_zh_is_native, places.display_name_zh_is_native),
            primary_type             = COALESCE(EXCLUDED.primary_type,             places.primary_type),
            primary_type_display_zh  = COALESCE(EXCLUDED.primary_type_display_zh,  places.primary_type_display_zh),
            maps_type_label_zh       = COALESCE(EXCLUDED.maps_type_label_zh,       places.maps_type_label_zh),
            types                    = COALESCE(EXCLUDED.types,                    places.types),
            formatted_address_en     = COALESCE(EXCLUDED.formatted_address_en,     places.formatted_address_en),
            formatted_address_zh     = COALESCE(EXCLUDED.formatted_address_zh,     places.formatted_address_zh),
            postal_code              = COALESCE(EXCLUDED.postal_code,              places.postal_code),
            country_code             = COALESCE(EXCLUDED.country_code,             places.country_code),
            business_status          = COALESCE(EXCLUDED.business_status,          places.business_status),
            business_hours           = COALESCE(EXCLUDED.business_hours,           places.business_hours),
            time_zone                = COALESCE(EXCLUDED.time_zone,                places.time_zone),
            rating                   = COALESCE(EXCLUDED.rating,                   places.rating),
            user_rating_count        = COALESCE(EXCLUDED.user_rating_count,        places.user_rating_count),
            national_phone_number    = COALESCE(EXCLUDED.national_phone_number,    places.national_phone_number),
            website_uri              = COALESCE(EXCLUDED.website_uri,              places.website_uri),
            google_maps_uri          = COALESCE(EXCLUDED.google_maps_uri,          places.google_maps_uri)
            -- Note: custom_name is INTENTIONALLY OMITTED — user overrides never get overwritten by re-fetches. (Renamed from custom_name_zh in #79.)
      RETURNING id
    ),
    -- #90 Phase 3: append-only history of every Google/Yelp fetch.
    -- One row per ingest that touched this place; \`places.raw_response\`
    -- is the latest pointer, \`place_snapshots\` is the full audit
    -- trail that #91 refresh will diff against.  Use the SAME
    -- \`<RAW_JSON_STRING_WITH_BOTH_LANGS>\` body you passed into the
    -- \`places\` upsert above and the SAME \`<google_geocode|google_places>\`
    -- source string.
    snapshot AS (
      INSERT INTO place_snapshots (place_id, source, raw_response, fetched_by_sha)
      SELECT id, '<google_geocode|google_places>', '<RAW_JSON_STRING_WITH_BOTH_LANGS>'::jsonb, '${buildInfo.gitShortSha}'
        FROM place
    )
  UPDATE transactions SET place_id = (SELECT id FROM place), updated_at = NOW()
   WHERE id = '<TX_ID>' AND workspace_id = '${ctx.workspaceId}';
  SQL

If you downloaded photos in Phase 3c, insert one \`place_photos\` row
per photo. Move the temp files into the shared uploads dir under
\`/data/uploads/places/<google_place_id>/<rank>__<sha256>.<ext>\` and
record \`file_path\` accordingly:

  PID='<google_place_id>'
  PLACE_DIR="/data/uploads/places/\$PID"
  mkdir -p "\$PLACE_DIR"
  for f in /tmp/place_photo_*.jpg; do
    [ -f "\$f" ] || continue
    RANK=\$(basename "\$f" | sed -E 's/place_photo_([0-9]+)\\.jpg/\\1/')
    SHA=\$(sha256sum "\$f" | awk '{print \$1}')
    DEST="\$PLACE_DIR/\${RANK}__\${SHA}.jpg"
    mv "\$f" "\$DEST"
    SIZE=\$(stat -c%s "\$DEST" 2>/dev/null || stat -f%z "\$DEST")
    PHOTO_NAME=\$(awk -v r="\$RANK" '\$1==r {print \$2}' /tmp/place_photos.txt)
    WH=\$(awk -v r="\$RANK" '\$1==r {print \$3}' /tmp/place_photos.txt)
    W=\${WH%x*}; H=\${WH#*x}
    psql "\$DATABASE_URL" -c "
      INSERT INTO place_photos (place_id, google_photo_name, rank, width_px, height_px, file_path, mime_type, sha256, ocr_extracted)
      VALUES (
        (SELECT id FROM places WHERE google_place_id = '\$PID'),
        '\$PHOTO_NAME',
        \$RANK, \$W, \$H,
        '\$DEST', 'image/jpeg', '\$SHA',
        <jsonb_build_object('chinese_chars', '...', 'model', 'claude-...', 'confidence', '...', 'ran_at', NOW()) or NULL>
      )
      ON CONFLICT (place_id, google_photo_name) DO NOTHING;
    "
  done

Also stamp the document row (ties it back to this ingest):

  psql "\$DATABASE_URL" -c "UPDATE documents SET source_ingest_id = '${ctx.ingestId}' WHERE id = '${ctx.documentId}';"

### 4b. statement_pdf

Loop over each row on the statement. Per row: one BEGIN/COMMIT, same
shape as 4a (expense side determined by payee name, mirror = Credit
Card). If a row's payee is ambiguous or zero-amount, skip it but log a
warning line.

Track every successful tx_id in a shell variable and include them all
in the final ingest close-out (Phase 5).

### 4c. unsupported

Skip every insert above. Go directly to Phase 5.

── Phase 5 — Close the ingest row ─────────────────────────────────────

Regardless of classification, end with:

  psql "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = '<done|unsupported>',
         classification = '<classification>',
         produced = jsonb_build_object(
           'transaction_ids', ARRAY[<quoted tx_ids, comma-separated>]::text[],
           'document_ids',    ARRAY['${ctx.documentId}']::text[],
           'receipt_ids',     ARRAY[]::text[]
         ),
         error = <NULL or 'reason'>,
         completed_at = NOW()
   WHERE id = '${ctx.ingestId}'
     AND workspace_id = '${ctx.workspaceId}';
  SQL

Use status='unsupported' when classification is unsupported (set
error = <one-line reason>).

If any INSERT above fails (foreign key violation, balance trigger,
constraint error), catch it and instead:

  psql "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = 'error',
         error = '<one-line message, escape quotes>',
         produced = jsonb_build_object('transaction_ids', ARRAY[]::text[], 'document_ids', ARRAY[]::text[], 'receipt_ids', ARRAY[]::text[]),
         completed_at = NOW()
   WHERE id = '${ctx.ingestId}';
  SQL

── Output ─────────────────────────────────────────────────────────────

After all SQL is committed, print ONE summary line to stdout so the
Node worker can log it:

  DONE ingest=${ctx.ingestId} classification=<kind> tx_ids=[<uuid>,...] place_id=<uuid|null>

That's the only structured output required. No JSON fence needed —
the database is your output.

── Rules ──────────────────────────────────────────────────────────────

- Every \`psql\` invocation is a separate Bash tool call. Plan them in
  order; don't try to pipeline from one to the next via stdin chaining.
- NEVER insert a transaction without exactly matching balanced
  postings in the SAME BEGIN/COMMIT block. The deferred constraint
  trigger will reject at COMMIT and roll back the whole block.
- \`.eml\` with a PDF attachment: prefer the source with richer data
  (usually the attachment). Mention which in metadata.raw_text.
- Reason in plain text BEFORE issuing SQL. Show your arithmetic for
  postings (expense +X, credit -X) so mistakes are visible in the
  Langfuse trace.
- On any failure, leave the ingest row with status='error' and a
  helpful one-line error message. Never leave it stuck in 'processing'.
`;
}
