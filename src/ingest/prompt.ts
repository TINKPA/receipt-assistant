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
import {
  PHASE_2_6_BRAND_DISCOVERY,
  PHASE_4B_4C_ICON_PIPELINE,
} from "./brand-icon-prompt.js";
import {
  PROMPT_VERSION,
  EXTRACTION_MODEL,
  NO_JSON_SCHEMA_RULE,
  PSQL_DISCIPLINE,
  dateSelfCheck,
  OCR_AUDIT_REQUIREMENT,
  agentHygiene,
  renderActiveLessons,
} from "./prompt-contract.js";
import { phase0DocumentRead } from "./document-read-prompt.js";
import {
  ITEM_SCHEMA,
  LINE_TYPE_VOCAB_AND_NAMES,
  LINE_ITEM_TWO_LEVEL_RULE,
  LINE_ITEM_COVERAGE_AND_BRIDGE,
  ALLOCATION_LOGIC,
  LINE_ITEM_WORKED_EXAMPLES,
} from "./line-item-prompt.js";
import {
  itemsCte,
  brandFkGuard,
  productsUpsert,
  transactionItemsInsert,
  productAggregateRecompute,
} from "./items-sql.js";

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
  /** Perceptually-near existing documents (#134), pHash d ≤ 2, each
   *  linked to a live transaction. Injected by the worker; candidate-
   *  surfacing evidence for the near-dup decision in Phase 4a.0. */
  phashNeighbors?: {
    documentId: string;
    transactionId: string;
    distance: number;
  }[];
}

/** Render the pHash-neighbor context block for Phase 4a.0. */
function renderPhashNeighbors(
  neighbors: ExtractorPromptContext["phashNeighbors"],
): string {
  if (!neighbors || neighbors.length === 0) {
    return `(none — no perceptually-similar existing image was found for this
upload. The SQL candidate check below still applies.)`;
  }
  return neighbors
    .map(
      (n) =>
        `  - document ${n.documentId} (pHash distance ${n.distance}) → transaction ${n.transactionId}`,
    )
    .join("\n");
}

/**
 * Append-only proposal file the agent writes (Phase 6); never read back.
 * Runtime-only bind-mount on the mini (`/data/prompt-lessons/`):
 * ephemeral, unvetted agent output, appended to and never read back.
 *
 * Its counterpart — the curated, human-reviewed `lessons.md` that gets
 * injected INTO the prompt — lives with `renderActiveLessons()` in
 * `prompt-contract.ts`, because both prompts inject it. Only the ingest
 * prompt runs Phase 6, so the proposal path stays here.
 */
const PROPOSED_LESSONS_PATH =
  process.env.PROMPT_LESSONS_PROPOSED ??
  "/data/prompt-lessons/lessons.proposed.md";

export function buildExtractorPrompt(ctx: ExtractorPromptContext): string {
  const scratchDir = `/tmp/${ctx.ingestId}`;
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

${PSQL_DISCIPLINE}

Optional: if you want to discover schema details, \`\\d\` works:
  psql "\$DATABASE_URL" -c "\\d transactions"
  psql "\$DATABASE_URL" -c "SELECT id, name, type FROM accounts WHERE workspace_id = '${ctx.workspaceId}' ORDER BY type, name"

${agentHygiene({ scratchDir, filePath: ctx.filePath, path: "ingest" })}
${renderActiveLessons()}
${phase0DocumentRead({ filePath: ctx.filePath, scratchDir })}

── Phase 1 — Classify ─────────────────────────────────────────────────

Follow the document-reading rules above FIRST — for a PDF that means
the text file, never the PDF itself (the Read tool rasterizes PDFs into
images). Then decide which category:

  receipt_image   photo/scan of a physical receipt
  receipt_email   .eml / .html purchase confirmation (Amazon, Uber, …)
  receipt_pdf     PDF of a single receipt or invoice
  statement_pdf   credit-card or bank statement with many line items
  unsupported     anything else (W-2, menu, junk, illegible, non-financial)

${NO_JSON_SCHEMA_RULE}

── Phase 2 — Extract ──────────────────────────────────────────────────

For receipt_image / receipt_email / receipt_pdf, pull out:

  payee         : merchant name as printed on the document
  occurred_on   : date in YYYY-MM-DD form (read from the document —
                  NEVER fall back to today's date). If year is missing,
                  infer from nearby context (statement period etc.).
  occurred_at   : timestamp YYYY-MM-DD HH:MM:SS+TZ if a time is
                  printed; NULL otherwise
  total_minor   : the receipt's FINAL "Grand Total" — the amount actually
                  charged — in the currency's minor unit (integer cents for
                  USD, whole units for JPY). Include handwritten tips.
                  ⚠ Read the GRAND TOTAL line, never the item subtotal. When
                  Gift Card / Rewards Points / store credit bring the order to
                  \$0.00, total_minor = 0 — that IS the out-of-pocket amount
                  charged (the goods still get itemized in items[]; the money
                  was counted when the card/points were loaded). For a PARTIAL
                  gift-card order, use the printed residual Grand Total, not
                  the pre-credit subtotal.
  currency      : ISO 4217 code (USD, CNY, EUR, JPY, …). Detect from
                  symbols: \$→USD, €→EUR, £→GBP, ¥ needs context
                  (CNY vs JPY).
  category_hint : one of
                  groceries | dining | retail | cafe | transport | other
                  (vehicle repair / maintenance / parts / fuel / parking →
                  transport — the same "car spending" axis as the
                  "Transportation" merchant category; never "other" for a
                  vehicle expense.)
  items         : REQUIRED structured line-item array (#81). Each
                  item is one object with the exact shape below;
                  the array MUST be non-empty for receipt_image /
                  receipt_email / receipt_pdf. Statement PDFs
                  continue to skip items (each statement row IS a
                  transaction, no sub-itemization possible).
  raw_text      : full transcription (written to \`documents.ocr_text\`)

${ITEM_SCHEMA}

${LINE_TYPE_VOCAB_AND_NAMES}

${LINE_ITEM_COVERAGE_AND_BRIDGE}

${LINE_ITEM_TWO_LEVEL_RULE}

${LINE_ITEM_WORKED_EXAMPLES}

For statement_pdf, pull rows: { date, payee, amount_minor }.

For unsupported, record a short reason.

${ALLOCATION_LOGIC}

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
                   For a genuinely multi-purpose merchant it is OK to
                   land in different categories on different receipts
                   (Costco warehouse → Shopping; Costco gas →
                   Transportation). But a SINGLE-purpose merchant (an auto
                   shop, a pharmacy) must stay in its ONE category on every
                   receipt. If you have resolved this merchant before, keep
                   the category you gave it last time unless the receipt
                   clearly shows a different KIND of spend.
                   Mapping crib:
                     dining/cafe/groceries/bakery   → "Food & Drinks"
                     retail/department/apparel     → "Shopping"
                     gas/transit/parking/rideshare → "Transportation"
                     auto repair/service/parts/tires/smog/oil/towing → "Transportation"
                     pharmacy/medical/dental       → "Health"
                     shipping/subscriptions/utilities/rent/laundry → "Services"
                     concerts/movies/streaming     → "Entertainment"
                     hotel/flight/cruise           → "Travel"

                   ── category is the KIND of spend, NOT the item_class ──
                   This category (= the expense account = the Dashboard
                   icon) answers "what kind of purchase is this whole
                   payment?" It is chosen from the MERCHANT / what was
                   bought, and is INDEPENDENT of the per-line item_class.
                   An auto shop is "Transportation" (money spent on your
                   car) EVEN THOUGH every labor line inside is
                   item_class='service' and the parts are
                   'consumable'/'durable'. Do NOT let "the lines are
                   services" pull the whole transaction into "Services" —
                   that is the #1 mistake on auto-repair receipts.

The merchant block goes into the transaction's \`metadata.merchant\` JSON
key (see the Phase 4 template).

${PHASE_2_6_BRAND_DISCOVERY}

For receipt_image / receipt_email / receipt_pdf only. Skip for
\`statement_pdf\` (handled per-row in Phase 4b) and \`unsupported\`.

── Phase 3 — Resolve place + fetch multilingual record (#74) ──────────

BUDGET GATE (see the Priority & effort-budget preamble): this ENTIRE
phase is best-effort enrichment. Skip it whenever the core is what
matters — a cached place, an obvious non-CJK global brand, or when you
are already many turns deep. Everything below is "do it if it is cheap
and adds value", never "do it no matter what".

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
place cached. Do NOT spend a psql call of your own here: this lookup
is result set ② of the ONE consolidated read (**Turn A**, Phase 4.0
below). Run Turn A now — you have the \`<PLACE_ID>\` from 3a, which is
all it was waiting for — and read its answer.

If Turn A's ② returned a row (the place is cached):
  - SKIP Phase 3c entirely. No outbound Google calls.
  - You do NOT need the returned id in hand: the \`place\` CTE inside
    Turn B upserts on \`google_place_id\` and feeds \`tx.place_id\`
    inline, so it handles insert-new and increment-existing alike.

Only when Turn A's ② returned no row do you proceed to 3c.

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

For every photo you DID read, record per-photo OCR provenance in metadata
(even a null result):
  metadata.photo_ocr = [
    {"rank":0,"chinese_chars":"永安","confidence":"high"},
    {"rank":1,"chinese_chars":null,"confidence":"n/a"},
    ...
  ]

Photos are a best-effort cache, NOT part of a complete extraction. Only
download them when Phase 3d actually needs them for CJK OCR (per the
budget preamble) — if there is no Chinese name to hunt for, skip the
download entirely. When you DID download for OCR, Phase 4 inserts a
\`place_photos\` row per photo with the local file_path and the OCR
fallback adds the \`ocr_extracted\` jsonb to the photos it read; if you
skipped the download, skip the \`place_photos\` insert too.

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

${dateSelfCheck()}

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

${OCR_AUDIT_REQUIREMENT}

### REQUIRED metadata.extraction shape (provenance stamp — #88 / #80)

The transaction SQL template below already includes the
\`extraction\` key under metadata. **Do not change its values** — they
are templated from Node-side build artifacts so they describe the
prompt/model under which extraction actually ran:

  "extraction": {
    "prompt_version": "${PROMPT_VERSION}",     // bumped manually on meaningful prompt edits
    "prompt_git_sha": "${buildInfo.gitSha}",    // build-time git rev
    "model":          "${EXTRACTION_MODEL}",
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
                   status IN (draft|posted|reconciled|error)
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
  - amount_base_minor: always write it equal to amount_minor, and NEVER
    write fx_rate at all — leave that column out of your INSERT so it
    stays NULL. When the receipt is already in the workspace base
    currency (USD here) that is the final, correct answer. When it is
    NOT (a CNY / JPY / EUR receipt), your value is a placeholder that
    only exists to satisfy the deferred balance trigger: the worker
    re-derives both columns straight after your run using the published
    FX rate for the receipt's own date (#184, src/fx/normalize.ts).
    \`fx_rate IS NULL\` is precisely the marker it looks for, so a
    guessed rate from you would suppress the real conversion and leave
    1 CNY counted as 1 USD in every report. Do not guess a rate, do not
    convert the total yourself, and do not "helpfully" write USD into
    the currency column — record the currency actually printed on the
    receipt.
  - Generate UUIDs via gen_random_uuid() inside the SQL.
  - All rows take workspace_id = WORKSPACE_ID.
  - The items[] JSON is embedded via PostgreSQL dollar-quoting
    (\`$items$<ITEMS_JSON_ARRAY>$items$::jsonb\`): drop your JSON array
    directly between the \`$items$\` markers with NO surrounding single
    quotes and NO escaping — this is what keeps apostrophes in product
    titles ("World's", 12" pan) from breaking the write. Never revert it
    to a single-quoted \`'...'::jsonb\` literal.

### 4.0 The write-phase turn plan — READ THIS BEFORE ANY WRITE

The entire ledger write is **THREE psql invocations**, not eight and
not twenty:

  Turn A — ONE read invocation, four result sets. Everything the write
           branches on.
  Turn B — ONE write invocation. The whole ledger write.
  Turn C — Phase 5, close the ingest row.

Batch statements inside each invocation with a heredoc (see the psql
discipline near the top). Every extra invocation re-sends this whole
conversation, and that round-trip cost — not the extraction itself —
is what makes a run expensive.

**Turn A.** Run it ONCE, after you have (a) your extracted fields,
(b) the Phase 2.5 merchant block, and (c) the Phase 3a geocode result
if you are doing Phase 3 at all. Phase 3a is a \`curl\`, not a psql
call, so doing it before Turn A costs you nothing and lets the place
lookup ride along. Include only the result sets that apply; keep them
in this order so you can read the output positionally:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
  -- (1) brand registry: Phase 2.6 cache check AND the Phase 4b icon
  --     pre-check, in one row per brand.
  SELECT b.brand_id, b.name, b.domain, b.user_chose_at,
         b.preferred_asset_id,
         b.metadata->>'icon_resolution' AS icon_resolution,
         (SELECT count(*) FROM brand_assets a
           WHERE a.brand_id = b.brand_id AND a.retired_at IS NULL) AS live_count
    FROM brands b
   WHERE b.brand_id IN ('<merchant brand-id>' /* , '<product brand-ids>' */);

  -- (2) place cache: Phase 3b. OMIT this query when Phase 3a produced
  --     no place id (or you skipped Phase 3).
  SELECT id FROM places WHERE google_place_id = '<PLACE_ID>';

  -- (3) Message-ID dedup: receipt_email ONLY. OMIT otherwise.
  SELECT id FROM documents
   WHERE workspace_id = '${ctx.workspaceId}'
     AND message_id = '<MESSAGE_ID>'
     AND id <> '${ctx.documentId}'
   LIMIT 1;

  -- (4) near-duplicate candidates: Phase 4a.0. Use YOUR extracted
  --     values; the ±3-day window covers settlement-date drift.
  SELECT t.id, t.payee, t.occurred_on,
         t.metadata->>'order_number'  AS order_number,
         t.metadata->>'payment_id'    AS payment_id,
         t.metadata->>'approval_code' AS approval_code,
         t.metadata->>'payment'       AS payment
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id AND p.amount_minor > 0
   WHERE t.workspace_id = '${ctx.workspaceId}'
     AND t.status IN ('posted','reconciled')
     AND t.occurred_on BETWEEN DATE '<YYYY-MM-DD>' - 3 AND DATE '<YYYY-MM-DD>' + 3
   GROUP BY t.id
  HAVING SUM(p.amount_minor) = <TOTAL_MINOR>
   LIMIT 5;
  SQL

psql prints the result sets in order. Read them once, then branch:
  (3) non-empty → duplicate email; skip the write entirely and go to
      Turn C with status='done' (see 4a step 1).
  (4) → walk the near-dup decision tree in 4a.0.
  (2) → Phase 3b/3c.
  (1) → Phase 2.6 discovery and the Phase 4b/4c icon cases.

Do NOT re-run any of these queries later in the run. If a result
surprises you, re-read the output you already have.

### 4a. receipt_image / receipt_email / receipt_pdf

**Email-only pre/post steps (receipt_email). #122.**
For \`receipt_email\`, first parse the \`.eml\` headers: From, Subject,
Date, Message-ID.

**Canonical Message-ID — read this.** The header is \`Message-ID: <id@host>\`.
Everywhere \`<MESSAGE_ID>\` appears below it means the id **with the
surrounding angle brackets stripped** (\`id@host\`, NOT \`<id@host>\`). Use this
exact bracket-free form in BOTH the dedup pre-check query AND when you store
\`documents.message_id\` / \`source_meta.message_id\`. Storing one form and
querying the other silently breaks dedup → duplicate transactions. One form,
everywhere.

(Decode the body with the tested MIME one-liner from the "Reading the
document" phase above before reading it.)

1. **Dedup pre-check — skip the WHOLE ingest if this email was already
   ingested.** A re-forwarded copy has different bytes (so the sha256
   dedup misses it) but the same Message-ID. This is result set (3) of
   **Turn A** — do not issue a separate psql call for it.

   If Turn A's (3) returned a row, do **NOT** write a transaction — go
   straight to Phase 5 (Turn C) and close the ingest as \`done\` with
   \`produced.transaction_ids = []\` and \`error = 'duplicate Message-ID'\`.
   (The \`(workspace_id, message_id)\` unique index is the hard backstop;
   this pre-check is the graceful path.)

2. **Stamping the document** with \`message_id\` / \`source_meta\` is NOT
   a separate call either — it is folded into Turn B's
   \`UPDATE documents\` statement, which runs after the transaction
   INSERT inside the same transaction. The values to put there:

       message_id  = '<MESSAGE_ID>',
       source_meta = jsonb_build_object(
         'channel', 'eml',
         'sender', '<FROM>',
         'subject', '<SUBJECT>',
         'received_at', '<RFC822 Date as ISO-8601>',
         'message_id', '<MESSAGE_ID>')

**Brand rows are FK parents — they are the first statements of Turn
B.** \`merchants.brand_id\` and \`products.brand_id\` are both FK into
\`brands\`, so both must exist before the \`m\` and \`p_upsert\` CTEs
run. Items may carry a \`product_brand_id\` distinct from the merchant's
(e.g. Apple-branded products at Best Buy → product brand = "apple",
merchant brand = "best-buy").

Each is its OWN statement inside Turn B's heredoc, never a sibling
CTE: \`WITH\` sub-statements cannot see each other's effects on target
tables, and RI checks are AFTER-ROW, so a brands row created in a
sibling CTE is not reliably visible to the FK check.

The product-brand rows are stubs (domain NULL); we don't run Phase 2.6
discovery for product brand_ids in v1. Phase 4b will skip them at the
discovery_failed check, so they cost nothing extra at ingest. They
become eligible for discovery + icon acquisition if a future ingest
sees the same brand as a merchant.

**Phase 4a.0 — Near-duplicate pre-INSERT check (#134). MANDATORY for
receipt_image / receipt_email / receipt_pdf, AFTER extraction and
BEFORE any transaction INSERT.**

The same purchase may already be in the ledger via another copy
(re-shot photo, re-scanned PDF) or another evidence channel (the email
for a PDF you're holding, the invoice for a receipt). Inserting again
double-counts the money. Decide attach-vs-insert as follows.

Perceptually-similar existing documents (pHash, candidate-surfacing
ONLY — same-app screenshots of DIFFERENT purchases can land here, so
the extracted fields below always decide, never this list by itself):

${renderPhashNeighbors(ctx.phashNeighbors)}

Candidate list — this is result set (4) of **Turn A**, already run with
YOUR extracted values. Do not re-query it here.

Union that result with any pHash-neighbor transactions above, then walk
this tree (tiebreaker strength: order/receipt number > payment auth
code / card last-4 > time-of-day > items list):

1. **No candidate** → proceed to the normal INSERT below.
2. **A candidate matches on a STRONG tiebreaker** (same order/receipt
   number, or same auth code, or same card last-4 + same time-of-day +
   same items) AND same merchant → this purchase is already in the
   ledger. Do NOT insert a transaction. Instead ATTACH:

     psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
     BEGIN;
     INSERT INTO document_links (document_id, transaction_id)
     VALUES ('${ctx.documentId}', '<EXISTING_TX_ID>')
     ON CONFLICT DO NOTHING;
     UPDATE transactions
        SET metadata = metadata || jsonb_build_object(
              'merge_audit',
              COALESCE(metadata->'merge_audit', '[]'::jsonb) || jsonb_build_object(
                'attached_document_id', '${ctx.documentId}',
                'source_ingest_id', '${ctx.ingestId}',
                'reason', '<one line: which tiebreakers matched>',
                'at', NOW()::text
              )
            )
      WHERE id = '<EXISTING_TX_ID>';
     -- receipt_email only: Turn B never runs on this branch, so stamp
     -- the document here or dedup breaks for the next forwarded copy.
     UPDATE documents
        SET message_id  = '<MESSAGE_ID>',
            source_meta = jsonb_build_object(
              'channel', 'eml',
              'sender', '<FROM>',
              'subject', '<SUBJECT>',
              'received_at', '<RFC822 Date as ISO-8601>',
              'message_id', '<MESSAGE_ID>'),
            updated_at  = NOW()
      WHERE id = '${ctx.documentId}';
     COMMIT;
     SQL

   That heredoc is the whole write for this branch — one invocation.
   Then close the ingest in Phase 5 (Turn C)
   with **status='near_dup'** and
   \`produced.transaction_ids = ['<EXISTING_TX_ID>']\`. Skip Phases
   2.6/3/4b/4c entirely — the existing transaction already carries
   merchant/place/brand data.
3. **Candidates exist but a strong tiebreaker DISAGREES** (different
   order numbers, different auth codes, or clearly different items /
   time-of-day) → genuinely distinct purchases that coincide on
   amount+date. Proceed to INSERT, and add
   \`'near_dup_check', jsonb_build_object('candidate_transaction_id','<ID>','verdict','distinct','reason','<why>')\`
   to the metadata object in the template.
4. **Candidates exist but NEITHER side has a strong tiebreaker**
   (no order number, no auth code on one or both) → NEVER attach on a
   weak match. Proceed to INSERT, and add
   \`'near_dup_check', jsonb_build_object('candidate_transaction_id','<ID>','verdict','uncertain','flagged_for_review',true,'reason','<why>')\`
   to the metadata object. A flagged duplicate is recoverable; a wrong
   merge silently loses a real purchase (#125's failure class).

Write one balanced transaction. The expense account name is **exactly
the \`merchant.category\` value you emitted in Phase 2.5** — one of the
seven canonical accounts:

  Food & Drinks · Transportation · Shopping · Travel ·
  Entertainment · Health · Services

This is the KIND of spend (an auto shop → "Transportation"), NOT the
item_class of the lines (which stay 'service'/'consumable'/'durable').
Never let the lines being services push the whole transaction to
"Services".

\`merchant.category\` is REQUIRED — Phase 2.5 is not optional and you
must not skip it. If a merchant genuinely doesn't fit the other six
buckets, use Services as the catch-all. Never invent a new account
and never leave the category blank.

Mirror side is Credit Card (default).

Template — **this whole heredoc is Turn B: ONE Bash tool call.**
Substitute your extracted values for the placeholders; the subqueries
resolve account ids inline so you do NOT need to SELECT them first.
Statements marked OPTIONAL get deleted when they don't apply to this
receipt. Everything that stays goes in this single invocation — do not
split it back into one psql call per statement.

\`<TX>\` below means the expression

  (SELECT id FROM transactions WHERE source_ingest_id = '${ctx.ingestId}' AND workspace_id = '${ctx.workspaceId}')

— the row the \`tx\` CTE inserts in step (3). Later statements resolve
the new transaction that way, so nothing here needs its uuid echoed
back to you in a separate turn.

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
  BEGIN;

  -- (1) FK parent — the merchant's brand. Its OWN statement: a sibling
  --     CTE cannot reliably satisfy merchants.brand_id's AFTER-ROW RI
  --     check. Use the canonical_name + domain you settled in Phase 2.6
  --     (domain NULL is fine). When Phase 2.6 found no usable domain,
  --     add  metadata = jsonb_build_object('icon_resolution','discovery_failed')
  --     to the DO UPDATE list so Phase 4b skips the brand cheaply.
  INSERT INTO brands (brand_id, name, domain)
  VALUES ('<brand-id>', '<CANONICAL_NAME>', <'<domain>' | NULL>)
  ON CONFLICT (brand_id) DO UPDATE
    SET name       = EXCLUDED.name,
        domain     = COALESCE(brands.domain, EXCLUDED.domain),
        updated_at = NOW();

  -- (2) OPTIONAL FK parents — every distinct product_brand_id in
  --     items[]. Stub rows (domain NULL). Delete when no item carries
  --     a product_brand_id.
${brandFkGuard()}

  -- (3) The ledger write itself: merchant, transaction, both postings,
  --     the document link, the product catalog and the line items —
  --     ONE statement, so the deferred balance trigger sees a matched
  --     set of postings.
  WITH
${itemsCte()},
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
        id, workspace_id, occurred_on, occurred_at, payee, status,
        source_ingest_id, merchant_id, metadata, created_by
      ) VALUES (
        gen_random_uuid(), '${ctx.workspaceId}', '<YYYY-MM-DD>',
        <'<YYYY-MM-DD HH:MM:SS+TZ>'::timestamptz | NULL>,
        '<PAYEE>', 'posted',
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
            'model',          '${EXTRACTION_MODEL}',
            'ran_at',         NOW(),
            'source',         'ingest'
          ),
          -- items[] is REQUIRED for receipt_image / receipt_email /
          -- receipt_pdf per #81. Statement_pdf omits this key. Each
          -- object follows the schema in Phase 2. This reads the SAME
          -- array you already pasted into the \`raw\` CTE above — copy
          -- it from there, do not retype it differently.
          'items', (SELECT j FROM raw)
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
${productsUpsert({ workspaceId: ctx.workspaceId, merchantIdExpr: "(SELECT id FROM m)" })},
    -- #81 Phase 2 + #84: relational line-items with product_id link
    -- and per-line allocation columns. Re-extract on the same tx
    -- bumps extraction_run and soft-deletes the prior run; this
    -- ingest path always writes the first run (run=1, retired_at=NULL).
    ti AS (
${transactionItemsInsert({
  workspaceId: ctx.workspaceId,
  txIdExpr: "tx.id",
  runExpr: "1",
  merchantIdExpr: "(SELECT id FROM m)",
  fromPrefix: "tx,",
  returning: "id, product_id",
})}
    )
  SELECT tx.id AS tx_id FROM tx;

  -- (4) Force the DEFERRABLE balance triggers to fire HERE, where psql
  --     can point at a line number, instead of at COMMIT where it
  --     cannot. If postings don't sum to zero you find out now.
  SET CONSTRAINTS ALL IMMEDIATE;

  -- (5) OPTIONAL — owned_items for the durable lines you judged worth
  --     tracking (see 4a-bis for the judgment). ONE set-based
  --     statement: list those line_no values in the ARRAY. Delete this
  --     statement entirely when no line qualifies.
  INSERT INTO owned_items (workspace_id, product_id, transaction_item_id, instance_index, acquired_on)
  SELECT '${ctx.workspaceId}', ti.product_id, ti.id, gs.idx, '<YYYY-MM-DD>'::date
  FROM transaction_items ti
  CROSS JOIN LATERAL generate_series(1, COALESCE(ti.quantity, 1)::int) gs(idx)
  WHERE ti.transaction_id = <TX>
    AND ti.retired_at IS NULL
    AND ti.line_no = ANY(ARRAY[<durable line_nos, comma-separated>]::int[])
    AND ti.item_class = 'durable'
    AND ti.product_id IS NOT NULL
  ON CONFLICT (transaction_item_id, instance_index) DO NOTHING;

  -- (6) Stamp the document: ties the file back to this ingest AND
  --     stores the OCR text, so \`documents.ocr_text\` is populated by
  --     BOTH the ingest and the re-extract path (it used to be
  --     re-extract only, which made every "what did the agent actually
  --     read?" question unanswerable for ingest-only documents).
  --     message_id / source_meta are the receipt_email post-step from
  --     4a step 2 — drop those two assignments for non-email uploads.
  UPDATE documents
     SET source_ingest_id  = '${ctx.ingestId}',
         ocr_text          = '<RAW_TEXT, single-quote-escaped>',
         ocr_model_version = '${EXTRACTION_MODEL}',
         message_id        = '<MESSAGE_ID>',
         source_meta       = jsonb_build_object(
                               'channel', 'eml',
                               'sender', '<FROM>',
                               'subject', '<SUBJECT>',
                               'received_at', '<RFC822 Date as ISO-8601>',
                               'message_id', '<MESSAGE_ID>'),
         updated_at        = NOW()
   WHERE id = '${ctx.documentId}';

  -- (7) products aggregate recomputation, for every product this
  --     ingest touched. Recompute, never increment (#84) — the stats
  --     then reflect the LIVE set of transaction_items immediately.
  --     total_spent_minor uses the workspace base-currency snapshot
  --     already on postings.amount_base_minor.
${productAggregateRecompute({ workspaceId: ctx.workspaceId, touchedPredicate: `t.source_ingest_id = '${ctx.ingestId}'` })}

  COMMIT;

  -- (8) AFTER COMMIT, still inside this one invocation: the party
  --     graph (see 4a-ter for which parties to record). Additive —
  --     it must never be able to roll back the transaction itself,
  --     which is why it sits after COMMIT rather than inside it.
  INSERT INTO transaction_parties
    (workspace_id, transaction_id, transaction_item_id, role, display_name, brand_id)
  VALUES
    ('${ctx.workspaceId}', <TX>, NULL, 'channel', '<as printed>', '<brand_id-or-NULL>')
    -- , line-level example:
    -- ('${ctx.workspaceId}', <TX>,
    --   (SELECT id FROM transaction_items WHERE transaction_id=<TX> AND line_no=<N> AND retired_at IS NULL),
    --   'maker', 'Anker', 'anker')
  ON CONFLICT ON CONSTRAINT transaction_parties_identity_uq DO NOTHING;

  -- (9) OPTIONAL, Phase 3 only — the place cache. Also after COMMIT,
  --     and for the same reason: Phase 3 is best-effort enrichment and
  --     a malformed Google blob must never take the ledger write down
  --     with it. Full multilingual upsert (#74): for uncached places
  --     include every column you extracted in Phase 3c/3d; for cached
  --     places the ON CONFLICT clause keeps existing per-language data
  --     and the \`custom_name\` user override (renamed from
  --     \`custom_name_zh\` in #79) and only bumps \`last_seen_at\` /
  --     \`hit_count\`. COALESCE(EXCLUDED.x, places.x) ensures a NEW
  --     fetch that returned NULL for a field never overwrites a
  --     previously-good value. Delete (9)-(11) when you have no
  --     geocode result.
  INSERT INTO places (
    id, google_place_id, formatted_address, lat, lng, source, raw_response,
    last_seen_at, hit_count,
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
    NOW(), 1,
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
        google_maps_uri          = COALESCE(EXCLUDED.google_maps_uri,          places.google_maps_uri);
        -- Note: custom_name is INTENTIONALLY OMITTED — user overrides never get overwritten by re-fetches. (Renamed from custom_name_zh in #79.)

  -- (10) OPTIONAL, Phase 3 only — #90 Phase 3: append-only history of
  --      every Google/Yelp fetch. One row per ingest that touched this
  --      place; \`places.raw_response\` is the latest pointer,
  --      \`place_snapshots\` is the full audit trail that #91 refresh
  --      will diff against. Use the SAME
  --      \`<RAW_JSON_STRING_WITH_BOTH_LANGS>\` body you passed into the
  --      \`places\` upsert above and the SAME
  --      \`<google_geocode|google_places>\` source string.
  INSERT INTO place_snapshots (place_id, source, raw_response, fetched_by_sha)
  SELECT id, '<google_geocode|google_places>', '<RAW_JSON_STRING_WITH_BOTH_LANGS>'::jsonb, '${buildInfo.gitShortSha}'
    FROM places WHERE google_place_id = '<PLACE_ID>';

  -- (11) OPTIONAL, Phase 3 only — attach the place to the transaction.
  UPDATE transactions
     SET place_id = (SELECT id FROM places WHERE google_place_id = '<PLACE_ID>'),
         updated_at = NOW()
   WHERE id = <TX> AND workspace_id = '${ctx.workspaceId}';
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

### 4a-bis. owned_items judgment (#84 Phase 2)

For each line where you set \`item_class='durable'\` AND assigned a
\`product_id\` AND judge the item **worth tracking as a real-world
thing**, insert N owned_items rows (instance_index 1..quantity).
Pure judgment, no threshold:

  - Limited-edition / luxury / high-value goods                  → YES
  - Anything with a serial number printed on the receipt          → YES
  - Items the user plausibly tracks warranty / location for       → YES
  - Cheap commodity durables ($5 hammer, basic kitchenware)       → NO
  - One-time-use durables (party plates that *technically* last)  → NO

Leave \`serial_number\`, \`location\`, \`warranty_until\`, \`condition\`,
\`notes\` blank — the user fills those in. \`acquired_on\` defaults to
the transaction's \`occurred_on\`.

The INSERT is statement (5) of Turn B — you do NOT run it here and you
do NOT need to query the transaction_items ids back first. Decide which
durable lines qualify, then put THOSE line_no values into the
\`ARRAY[...]\` in Turn B (5). It is ONE set-based statement for the
whole receipt, not one per line. The ON CONFLICT clause makes it safe
to re-run. Delete Turn B (5) entirely when nothing qualifies — which
is the common case: non-durable items, durables you judge not worth
tracking, and product-less lines all fall out.

### 4a-ter. transaction_parties — the party graph (#149 P4)

The card statement sees one merchant; the receipt sees more. Record
every party the receipt TEXT states, one row per (role, party):

  - **channel** (tx-level, transaction_item_id NULL): the platform /
    statement entity that took the order — what shows up as the line on
    a card statement. ALWAYS write exactly one channel row.
    · DEFAULT (a normal in-store / single-merchant receipt): the
      channel IS the merchant you resolved in Phase 2.5 — duplicate it
      with its brand_id.
    · DELIVERY / MARKETPLACE PLATFORM ORDERS (DoorDash, Uber Eats,
      Grubhub, Postmates, Caviar; Amazon when a third-party "Sold by"
      seller is named): the **platform is the channel**, even when
      Phase 2.5 resolved the merchant to the restaurant/seller behind
      it. Detect the platform from the receipt header / email sender
      ("Your order from <restaurant>" emails are DoorDash-style). The
      restaurant/seller then becomes the **seller** row below — NOT the
      channel, and the platform is NEVER an acquirer.
  - **seller** (tx- or line-level): the party that actually sold the
    goods when it differs from the channel.
    · Platform orders: the restaurant / store behind the platform —
      i.e. the merchant Phase 2.5 resolved (tx-level seller row). On a
      bb.q Chicken order via DoorDash: channel=DoorDash,
      seller=bb.q Chicken.
    · Marketplace lines: "Sold by: AnkerDirect" (line-level).
    Same party as the channel → NO seller row.
  - **maker** (line-level): the product's brand, only when the line
    text itself states it ("Anker MagGo 610" → Anker; "KS WATER 40PK"
    → Kirkland Signature). Don't infer makers from world knowledge
    when the text doesn't name them.
  - **acquirer** (tx-level): payment PROCESSOR only — Stripe, Square,
    Adyen, Toast, Block ("Powered by Stripe"). A delivery platform
    (DoorDash etc.) is a channel, NEVER an acquirer. Rare; skip when
    absent.

\`display_name\` = the string as printed. \`brand_id\`: reuse the
channel's resolved brand for the channel row; for sellers/makers, set
it ONLY when a brands row already exists (check with a SELECT) or the
party is unambiguously a known brand — then upsert a brands row first
(brand_id = lowercase-hyphenated name; for a marketplace seller whose
parent brand is obvious, e.g. AnkerDirect → anker, set parent_id).
Otherwise leave brand_id NULL — a text-only row is still useful.

The INSERT is statement (8) of Turn B — you do NOT run it here. Fill in
one VALUES row per (role, party) you decided on above; line-level rows
resolve their \`transaction_item_id\` by line_no from the items Turn B
just wrote, in the same invocation.

Don't fabricate parties; a plain single-merchant receipt legitimately
produces just the one channel row. This step is additive — never let a
parties failure roll back the transaction itself, which is exactly why
Turn B places it after COMMIT rather than inside the block.

### 4b. statement_pdf

Loop over each row on the statement. Per row: one BEGIN/COMMIT, same
shape as 4a (expense side determined by payee name, mirror = Credit
Card). If a row's payee is ambiguous or zero-amount, skip it but log a
warning line.

Track every successful tx_id in a shell variable and include them all
in the final ingest close-out (Phase 5).

### 4c. unsupported

Skip every insert above. Go directly to Phase 5.

BUDGET GATE (see the Priority & effort-budget preamble): the brand-icon
resolution below is optional visual polish. Do it when it is quick and
the asset is readily found; skip it when the core is already committed
and an icon is not close at hand. Never chase an icon across many
fallback providers — one or two cheap tries, then move on and close.

${PHASE_4B_4C_ICON_PIPELINE}


── Phase 5 — Close the ingest row (Turn C) ────────────────────────────

Regardless of classification, end with ONE invocation:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = '<done|unsupported|near_dup>',
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

Use status='near_dup' ONLY for the Phase 4a.0 attach outcome (branch 2):
\`transaction_ids\` must contain exactly the existing transaction you
attached '${ctx.documentId}' to, and the \`document_links\` row must
already be committed — the worker verifies the link exists and forces
'error' if it doesn't. error = NULL.

If any INSERT above fails (foreign key violation, balance trigger,
constraint error), catch it and instead:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = 'error',
         error = '<one-line message, escape quotes>',
         produced = jsonb_build_object('transaction_ids', ARRAY[]::text[], 'document_ids', ARRAY[]::text[], 'receipt_ids', ARRAY[]::text[]),
         completed_at = NOW()
   WHERE id = '${ctx.ingestId}';
  SQL

── Phase 6 — Propose a lesson (optional, best-effort, human-reviewed) ──

After the ingest is closed, if THIS run hit something genuinely worth
remembering — a slowdown you could have avoided, an error you had to
self-correct, a schema surprise, or a skip heuristic that clearly paid
off or misfired — append ONE concise line to the PROPOSAL file:

  echo '- [<classification>] <one specific, evidence-based lesson>' \\
    >> ${PROPOSED_LESSONS_PATH} 2>/dev/null || true

This is how the extractor improves itself over time WITHOUT self-poisoning:
  • Proposals are for a HUMAN to review and promote into the curated
    lesson set that gets fed back to future runs. They are NOT active
    rules; never read this file back, never treat your own proposals as
    instructions.
  • One line, max. Be specific and evidence-based ("Costco gas prints the
    date as MM/DD in tiny type at the top-right — check there first"), not
    generic ("be careful with dates").
  • Skip this entirely on an unremarkable run. No lesson beats a noise
    lesson — the reviewer's attention is the bottleneck.
  • Never let this step fail or delay the run. The \`2>/dev/null || true\`
    drops it silently if the file is not writable. Do not retry.

── Output ─────────────────────────────────────────────────────────────

After all SQL is committed, print ONE summary line to stdout so the
Node worker can log it:

  DONE ingest=${ctx.ingestId} classification=<kind> tx_ids=[<uuid>,...] place_id=<uuid|null>

That's the only structured output required. No JSON fence needed —
the database is your output.

── Rules ──────────────────────────────────────────────────────────────

- Every \`psql\` INVOCATION is a separate Bash tool call, so BATCH your
  statements into as few invocations as possible — the write phase is
  Turn A / Turn B / Turn C and nothing else (Phase 4.0). Don't try to
  pipeline from one invocation to the next via stdin chaining.
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
