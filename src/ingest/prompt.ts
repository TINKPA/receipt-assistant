/**
 * Phase 2 extractor prompt — the agent writes to the v1 double-entry
 * ledger directly via the `psql` Bash tool. Node is no longer involved
 * in field parsing or DB writes; it only spawns the agent, waits for
 * the ingest row to reach a terminal status, and relays SSE events.
 *
 * See `receipt-assistant#49` for the architectural move from Phase 1
 * (Node-side coerce + service-layer writes) to Phase 2.
 */

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
  items         : optional list of line items (for later inventory use)
  raw_text      : optional full transcription (helps debugging)

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

── Phase 3 — Geocode (receipt_image / receipt_email / receipt_pdf only) ──

Resolve the merchant location to a Google Places entry IF you can do
so with high confidence. Call Google Maps APIs via the Bash tool; the
API key is in the GOOGLE_MAPS_API_KEY environment variable.

Decision tree (in order — stop at first match):

  (a) \$GOOGLE_MAPS_API_KEY is empty → skip geocoding.
  (b) Receipt shows a full street address → call Geocoding API:

        ADDR='1380 Stockton St, San Francisco, CA 94133'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$ADDR")
        curl -sS "https://maps.googleapis.com/maps/api/geocode/json?address=\$QS&key=\$GOOGLE_MAPS_API_KEY"

      If status=="OK" and results is non-empty, use results[0].
      Record source="google_geocode".

  (c) No address, but receipt shows merchant + a locality hint (city
      name on the header, state abbreviation, or ZIP code) → call
      Places Find-Place-From-Text with the locality in the query:

        Q='Wing On Market San Francisco'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$Q")
        curl -sS "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=\$QS&inputtype=textquery&fields=place_id,name,formatted_address,geometry&key=\$GOOGLE_MAPS_API_KEY"

      If status=="OK" and candidates is non-empty, use candidates[0].
      Record source="google_places".

  (d) Only merchant name, no locality anywhere on receipt → skip.
      Bare names like "Costco" resolve to random branches.

Validation (MUST do before using a geocode result):
  - The top result's formatted_address MUST contain one of the
    locality tokens visible on the receipt (city name, two-letter
    state abbreviation, or ZIP code). If none match, skip — you got a
    wrong-city match.
  - Any non-OK API status, HTTP error, timeout, or parse failure →
    skip. Geocoding is best-effort and never blocks extraction.

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

Write one balanced transaction. Expense account is picked by
category_hint: groceries→Groceries, dining→Dining, cafe→Dining,
transport→Transport, retail→Other, other→Other. Fall back to Other if
unsure. Mirror side is Credit Card (default).

Template (substitute your extracted values for the placeholders; the
subqueries resolve account ids inline so you do NOT need to SELECT
them first):

  psql "\$DATABASE_URL" <<'SQL'
  BEGIN;
  WITH
    expense AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'expense' AND name = '<EXPENSE_NAME>' LIMIT 1),
    credit  AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'liability' AND name = 'Credit Card' LIMIT 1),
    tx AS (
      INSERT INTO transactions (
        id, workspace_id, occurred_on, payee, status,
        source_ingest_id, metadata, created_by
      ) VALUES (
        gen_random_uuid(), '${ctx.workspaceId}', '<YYYY-MM-DD>', '<PAYEE>', 'posted',
        '${ctx.ingestId}',
        jsonb_build_object(
          'source', 'ingest',
          'classification', '<receipt_image|receipt_email|receipt_pdf>',
          'category_hint', '<CATEGORY_HINT>',
          'source_ingest_id', '${ctx.ingestId}',
          'merchant', jsonb_build_object(
            'canonical_name', '<CANONICAL_NAME>',
            'brand_id',       '<brand-id>',
            'category',       '<7-class CATEGORY>'
          )
          -- add tax/tip/items/raw_text here if useful, as extra JSONB keys
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
    )
  SELECT tx.id AS tx_id FROM tx;
  COMMIT;
  SQL

If you have a geocode result, run this AFTER the main transaction
(use the tx_id printed above):

  psql "\$DATABASE_URL" <<'SQL'
  WITH
    place AS (
      INSERT INTO places (
        id, google_place_id, formatted_address, lat, lng, source, raw_response,
        first_seen_at, last_seen_at, hit_count
      ) VALUES (
        gen_random_uuid(), '<PLACE_ID>', '<FORMATTED_ADDRESS>', <LAT>, <LNG>,
        '<google_geocode|google_places>', '<RAW_JSON_STRING>'::jsonb,
        NOW(), NOW(), 1
      )
      ON CONFLICT (google_place_id) DO UPDATE
        SET last_seen_at = NOW(), hit_count = places.hit_count + 1
      RETURNING id
    )
  UPDATE transactions SET place_id = (SELECT id FROM place), updated_at = NOW()
   WHERE id = '<TX_ID>' AND workspace_id = '${ctx.workspaceId}';
  SQL

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
