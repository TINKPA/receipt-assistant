/**
 * Re-extract prompt — the agent re-reads an already-ingested receipt
 * and UPDATEs the existing transaction in place.
 *
 * Scope decision (Phase 4c of #80 / #91 MVP):
 *   - Re-extract = re-OCR the receipt against the **current** prompt
 *     and model. Refines payee, occurred_on, occurred_at, currency,
 *     total_minor on the existing transaction; refreshes `documents.ocr_text`.
 *   - It does NOT touch postings — re-running extraction could change
 *     category/amount and risk the double-entry sum-to-zero invariant.
 *     If category drift matters, edit postings explicitly via the
 *     postings endpoints. A later 91d-style scope can extend re-extract
 *     to safely rewrite postings (DELETE + INSERT in one tx with
 *     balance re-check).
 *   - It does NOT touch `place_id` / `merchant_id`. Place refresh is
 *     `POST /v1/places/:id/refresh` (91a). Merchant aggregation is its
 *     own enrichment loop.
 *
 * Layer-3 shielding (matches `src/projection/layer3.ts`):
 *   - HARD fields (status, voided_by_id, trip_id, narration, identity,
 *     version) are NEVER in the UPDATE column list — extraction can't
 *     even mention them.
 *   - SOFT fields (occurred_on, occurred_at, payee) use a CASE WHEN
 *     reading `metadata.user_edited.<field>` so a user override survives
 *     re-extract verbatim.
 *
 * The prompt itself stays short because the heavy lifting (classify,
 * postings, place resolution) is gone. ~70 lines of prose vs.
 * `src/ingest/prompt.ts`'s ~800.
 */
import { buildInfo } from "../generated/build-info.js";

/**
 * Bumped on meaningful re-extract prompt edits. Separate from
 * `PROMPT_VERSION` in `src/ingest/prompt.ts` because the two prompts
 * can drift independently — re-extract has a narrower job. Stamped
 * into `transactions.metadata.extraction.prompt_version` on every run
 * (overwriting the prior value), and into `derivation_events.prompt_version`.
 */
export const REEXTRACT_PROMPT_VERSION = "1.3";

/**
 * The model identifier we stamp into `documents.ocr_model_version`.
 * Matches the `--model` flag we pass to `claude -p`; kept in sync
 * with the env var fallback in `extractor.ts`.
 */
export const REEXTRACT_MODEL = process.env.CLAUDE_MODEL || "sonnet";

export interface ReExtractPromptContext {
  /** Absolute path inside the container where the original upload lives. */
  filePath: string;
  /** Workspace scope (UPDATE WHERE clause). */
  workspaceId: string;
  /** Document row that holds `ocr_text` + `ocr_model_version` to refresh. */
  documentId: string;
  /** Existing transaction row to UPDATE. Looked up by the service via
   *  `document_links`; the prompt does not search for it. */
  transactionId: string;
  /** Owner user id, recorded in the `transaction_events` row. */
  userId: string;
}

export function buildReExtractPrompt(ctx: ReExtractPromptContext): string {
  return `You are re-running extraction on a previously-ingested receipt.
The transaction row already exists; your job is to refresh the
receipt-readable fields against the current prompt/model. You will
write directly to Postgres via the \`psql\` Bash tool.

── Context ─────────────────────────────────────────────────────────────

File path (inside this container):
  ${ctx.filePath}

Context variables for SQL (use as-is):
  TX_ID         = '${ctx.transactionId}'
  WORKSPACE_ID  = '${ctx.workspaceId}'
  DOCUMENT_ID   = '${ctx.documentId}'
  USER_ID       = '${ctx.userId}'
  PROMPT_VERSION   = '${REEXTRACT_PROMPT_VERSION}'
  PROMPT_GIT_SHA   = '${buildInfo.gitSha}'
  MODEL            = '${REEXTRACT_MODEL}'

DB connection: \`psql "\$DATABASE_URL"\` — the env var is set.

── Phase 1 — Extract ──────────────────────────────────────────────────

Read the file at the path above (same image / pdf / .eml the original
ingest read). Reason in plain text first — chain-of-thought measurably
improves OCR. Do NOT use \`--json-schema\`-style structured output.

Pull these fields. Use NULL when the field is not visible — never
guess, never fall back to today's date.

  payee         : merchant name as printed on the document
  occurred_on   : date in YYYY-MM-DD form (read from the document)
  occurred_at   : timestamp YYYY-MM-DD HH:MM:SS+TZ if a time is
                  printed; NULL otherwise
  total_minor   : FINAL amount in the currency's minor unit (integer
                  cents for USD, whole units for JPY). Include
                  handwritten tips if visible.
  currency      : ISO 4217 (USD, CNY, EUR, JPY, …)
  raw_text      : full transcription (for \`documents.ocr_text\`)
  items         : REQUIRED structured line-item array per #81 / REEXTRACT_PROMPT_VERSION 1.1.
                  Each item is one object with these fields:
                    line_no            int (1-based, preserves order)
                    raw_name           text (verbatim line)
                    normalized_name    text|null (brand-stripped)
                    quantity           num|null
                    unit               text|null ("ct","lb","ea",…)
                    unit_price_minor   int|null (minor units)
                    line_total_minor   int REQUIRED (signed; negative for discounts)
                    currency           ISO 4217 (same as transaction)
                    item_class         enum:
                                         durable    — life ≥ 1 year
                                         consumable — used in weeks/months (fuel, paper, batteries)
                                         food_drink — edible/potable
                                         service    — non-physical (massage, delivery fee)
                                         other      — refunds, gift cards, rare
                    durability_tier    enum|null (only if durable): luxury|standard
                                       (luxury when single-line total > \$200 OR known
                                        luxury brand: Apple high-end, LV, Hermès, …)
                    food_kind          enum|null (only if food_drink):
                                         restaurant_dish|grocery_food|beverage
                    tags               text[]|null (freeform: alcohol, cold, organic,
                                                   sale, imported, handwritten, unclear)
                    confidence         enum: high|medium|low

                  Σ line_total_minor across items SHOULD approximate the
                  receipt's subtotal (within \$0.01). If sum is off by >\$0.50,
                  drop confidence='low' on items that look suspect.

                  If you cannot itemize at all (total-only receipt, illegible
                  thermal print), emit ONE item with item_class='other',
                  confidence='low', raw_name='TOTAL ONLY',
                  line_total_minor=<TOTAL_MINOR>, tags=['no-item-section'].

Place resolution and merchant canonicalization are OUT OF SCOPE for
re-extract — those have their own endpoints (\`POST /v1/places/:id/refresh\`
and the merchant enrichment loop). Do NOT touch \`place_id\`,
\`merchant_id\`, \`merchants\`, or \`places\`.

Postings (the double-entry debit/credit rows under the transaction) are
also OUT OF SCOPE — re-extract does not rewrite them. Do NOT touch
\`postings\` or \`document_links\`.

── Phase 2 — Write ────────────────────────────────────────────────────

Run exactly ONE psql block. Substitute your extracted values for the
placeholders; the CASE statements consult \`metadata.user_edited\` so a
user override survives this re-extract.

  psql "\$DATABASE_URL" <<'SQL'
  BEGIN;

  UPDATE transactions SET
    occurred_on = CASE
      WHEN (metadata->'user_edited'->>'occurred_on')::boolean IS TRUE THEN occurred_on
      ELSE '<YYYY-MM-DD>'
    END,
    occurred_at = CASE
      WHEN (metadata->'user_edited'->>'occurred_at')::boolean IS TRUE THEN occurred_at
      ELSE <'<YYYY-MM-DD HH:MM:SS+TZ>'::timestamptz | NULL>
    END,
    payee = CASE
      WHEN (metadata->'user_edited'->>'payee')::boolean IS TRUE THEN payee
      ELSE '<PAYEE>'
    END,
    metadata = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{extraction}',
          jsonb_build_object(
            'prompt_version', '${REEXTRACT_PROMPT_VERSION}',
            'prompt_git_sha', '${buildInfo.gitSha}',
            'model',          '${REEXTRACT_MODEL}',
            'ran_at',         NOW()::text,
            'source',         're-extract'
          )
        ),
        '{items}',
        '<ITEMS_JSON_ARRAY>'::jsonb
      ),
      '{re_extracted_at}',
      to_jsonb(NOW()::text)
    ),
    version = version + 1
  WHERE id = '${ctx.transactionId}' AND workspace_id = '${ctx.workspaceId}';

  UPDATE documents SET
    ocr_text          = '<RAW_TEXT, single-quote-escaped>',
    ocr_model_version = '${REEXTRACT_MODEL}',
    updated_at        = NOW()
  WHERE id = '${ctx.documentId}' AND workspace_id = '${ctx.workspaceId}';

  -- #84 Phase 1: re-extract is now versioned (extraction_run counter
  -- bumps; old run rows soft-deleted via retired_at). Live aggregates
  -- read WHERE retired_at IS NULL, so old purchases drop out and new
  -- ones count immediately — purchase_count stays correct, no drift.
  -- Soft-delete every live item belonging to this tx.
  UPDATE transaction_items
  SET retired_at = NOW()
  WHERE transaction_id = '${ctx.transactionId}'
    AND retired_at IS NULL;

  -- Insert the freshly extracted rows under run = MAX(prev)+1.
  -- Capture the run number in a temp var via WITH ... SELECT, then
  -- INSERT. The agent computes this run number inline below.
  WITH next_run AS (
    SELECT COALESCE(MAX(extraction_run), 0) + 1 AS run
    FROM transaction_items
    WHERE transaction_id = '${ctx.transactionId}'
  ),
  p_upsert AS (
    INSERT INTO products (
      workspace_id, merchant_id, product_key, canonical_name,
      item_class, brand_id, model, color, size, variant, sku,
      manufacturer
    )
    SELECT '${ctx.workspaceId}',
           CASE WHEN item.product_merchant_exclusive THEN
             (SELECT merchant_id FROM transactions WHERE id = '${ctx.transactionId}')
           ELSE NULL END,
           item.product_key,
           COALESCE(item.normalized_name, item.raw_name),
           item.item_class, item.product_brand_id,
           item.product_model, item.product_color, item.product_size,
           item.product_variant, item.product_sku, item.product_manufacturer
    FROM jsonb_to_recordset('<ITEMS_JSON_ARRAY>'::jsonb) AS item(
      line_no int, raw_name text, normalized_name text,
      quantity numeric, unit text,
      unit_price_minor bigint, line_total_minor bigint, currency text,
      item_class text, durability_tier text, food_kind text,
      tags text[], confidence text,
      line_type text, product_key text, product_brand_id text,
      product_merchant_exclusive boolean, product_model text,
      product_color text, product_size text, product_variant text,
      product_sku text, product_manufacturer text,
      tax_minor bigint, tip_share_minor bigint, discount_share_minor bigint
    )
    WHERE COALESCE(item.line_type, 'product') = 'product' AND item.product_key IS NOT NULL
    ON CONFLICT (workspace_id, merchant_id, product_key) DO UPDATE
      SET updated_at = NOW(),
          canonical_name = COALESCE(EXCLUDED.canonical_name, products.canonical_name),
          brand_id       = COALESCE(EXCLUDED.brand_id,       products.brand_id),
          item_class     = COALESCE(EXCLUDED.item_class,     products.item_class)
    RETURNING id, product_key, merchant_id
  )
  INSERT INTO transaction_items (
    id, workspace_id, transaction_id, line_no,
    raw_name, normalized_name, quantity, unit,
    unit_price_minor, line_total_minor, currency,
    item_class, durability_tier, food_kind, tags, confidence,
    line_type, product_id, tax_minor, tip_share_minor,
    discount_share_minor, extraction_run, extraction_version
  )
  SELECT gen_random_uuid(), '${ctx.workspaceId}', '${ctx.transactionId}', item.line_no,
         item.raw_name, item.normalized_name, item.quantity, item.unit,
         item.unit_price_minor, item.line_total_minor, item.currency,
         item.item_class, item.durability_tier, item.food_kind,
         item.tags, item.confidence,
         COALESCE(item.line_type, 'product'),
         (SELECT pu.id FROM p_upsert pu
            WHERE pu.product_key = item.product_key
              AND pu.merchant_id IS NOT DISTINCT FROM
                  (CASE WHEN item.product_merchant_exclusive THEN
                     (SELECT merchant_id FROM transactions WHERE id = '${ctx.transactionId}')
                   ELSE NULL END)
            LIMIT 1),
         item.tax_minor, item.tip_share_minor, item.discount_share_minor,
         (SELECT run FROM next_run),
         '${REEXTRACT_PROMPT_VERSION}'
  FROM jsonb_to_recordset('<ITEMS_JSON_ARRAY>'::jsonb) AS item(
    line_no int, raw_name text, normalized_name text,
    quantity numeric, unit text,
    unit_price_minor bigint, line_total_minor bigint, currency text,
    item_class text, durability_tier text, food_kind text,
    tags text[], confidence text,
    line_type text, product_key text, product_brand_id text,
    product_merchant_exclusive boolean, product_model text,
    product_color text, product_size text, product_variant text,
    product_sku text, product_manufacturer text,
    tax_minor bigint, tip_share_minor bigint, discount_share_minor bigint
  );

  -- #84: recompute aggregate stats for every product whose live
  -- transaction_items set just changed. The WHERE clause unions
  -- old-touched + new-touched products by reading the live set,
  -- which now reflects the post-soft-delete state.
  WITH stats AS (
    SELECT ti.product_id,
           MIN(t.occurred_on) AS first_on,
           MAX(t.occurred_on) AS last_on,
           COUNT(DISTINCT ti.transaction_id) AS purchases,
           SUM(ti.effective_total_minor) AS total_minor
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE ti.workspace_id = '${ctx.workspaceId}'
      AND ti.product_id IS NOT NULL
      AND ti.retired_at IS NULL
      AND ti.line_type = 'product'
    GROUP BY ti.product_id
  )
  UPDATE products p SET
    first_purchased_on = stats.first_on,
    last_purchased_on  = stats.last_on,
    purchase_count     = stats.purchases,
    total_spent_minor  = stats.total_minor,
    updated_at         = NOW()
  FROM stats
  WHERE p.id = stats.product_id
    AND p.workspace_id = '${ctx.workspaceId}';

  INSERT INTO transaction_events (
    id, workspace_id, transaction_id, event_type, actor_id, payload
  ) VALUES (
    gen_random_uuid(), '${ctx.workspaceId}', '${ctx.transactionId}',
    're_extracted', '${ctx.userId}',
    jsonb_build_object(
      'prompt_version', '${REEXTRACT_PROMPT_VERSION}',
      'model',          '${REEXTRACT_MODEL}'
    )
  );

  COMMIT;
  SQL

IMPORTANT escaping rule: SQL single quotes inside values must be
doubled (\`O''Brien\`). Newlines inside \`raw_text\` are fine inside a
single-quoted SQL literal as long as no single quote is unescaped.

── Done ────────────────────────────────────────────────────────────────

After the psql block exits 0, print ONE line:

  DONE re_extracted tx=${ctx.transactionId} prompt_version=${REEXTRACT_PROMPT_VERSION}

If you cannot read the receipt at all (unsupported / illegible /
corrupted), do NOT write anything to the database. Print:

  ERROR <one-line reason>

and exit. The service will mark the document accordingly.
`;
}
