/**
 * Re-extract prompt — the agent re-reads an already-ingested receipt
 * and UPDATEs the existing transaction in place.
 *
 * Scope decision (Phase 4c of #80 / #91 MVP):
 *   - Re-extract = re-OCR the receipt against the **current** prompt
 *     and model. Refines payee, occurred_on, occurred_at and the
 *     `items[]` line-item set on the existing transaction; refreshes
 *     `documents.ocr_text`. It deliberately does NOT extract a
 *     transaction total or currency — `transactions` has no such
 *     columns (they live on `postings`, which are out of scope), so
 *     asking for them was pure dead work.
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
 *   - HARD fields (status, deleted_at, trip_id, narration, identity,
 *     version) are NEVER in the UPDATE column list — extraction can't
 *     even mention them.
 *   - SOFT fields (occurred_on, occurred_at, payee) use a CASE WHEN
 *     reading `metadata.user_edited.<field>` so a user override survives
 *     re-extract verbatim.
 *
 * The extraction CONTRACT — item schema, line_type vocabulary,
 * two-level modifier rule, coverage invariant, allocation logic,
 * worked examples, date self-check, psql/agent hygiene, and every
 * items-related SQL fragment — is NOT restated here. It is imported
 * from the shared modules (#164) that `prompt.ts` interpolates too,
 * because the two hand-maintained copies had already drifted apart in
 * ways that measurably degraded re-extract output.
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
  DATE_SELF_CHECK,
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
  ITEMS_JSON_EXPR,
  brandFkGuard,
  productsUpsert,
  transactionItemsInsert,
  productAggregateRecompute,
} from "./items-sql.js";

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
  const scratchDir = `/tmp/reextract-${ctx.transactionId}`;
  const merchantIdExpr = `(SELECT merchant_id FROM transactions WHERE id = '${ctx.transactionId}')`;
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
  PROMPT_VERSION   = '${PROMPT_VERSION}'
  PROMPT_GIT_SHA   = '${buildInfo.gitSha}'
  MODEL            = '${EXTRACTION_MODEL}'

${PSQL_DISCIPLINE}

${agentHygiene({ scratchDir, filePath: ctx.filePath })}
${renderActiveLessons()}
${phase0DocumentRead({ filePath: ctx.filePath, scratchDir })}

── Phase 1 — Extract ──────────────────────────────────────────────────

Read the file at the path above (same image / pdf / .eml the original
ingest read). ${NO_JSON_SCHEMA_RULE}

Pull these fields. Use NULL when the field is not visible — never
guess, never fall back to today's date.

  payee         : merchant name as printed on the document
  occurred_on   : date in YYYY-MM-DD form (read from the document)
  occurred_at   : timestamp YYYY-MM-DD HH:MM:SS+TZ if a time is
                  printed; NULL otherwise
  raw_text      : full transcription (for \`documents.ocr_text\`)
  items         : REQUIRED structured line-item array (#81). Each item
                  is one object with the exact shape below.

${ITEM_SCHEMA}

${LINE_TYPE_VOCAB_AND_NAMES}

${LINE_ITEM_COVERAGE_AND_BRIDGE}

${LINE_ITEM_TWO_LEVEL_RULE}

${LINE_ITEM_WORKED_EXAMPLES}

${ALLOCATION_LOGIC}

${DATE_SELF_CHECK}

${OCR_AUDIT_REQUIREMENT}

Place resolution and merchant canonicalization are OUT OF SCOPE for
re-extract — those have their own endpoints (\`POST /v1/places/:id/refresh\`
and the merchant enrichment loop). Do NOT touch \`place_id\`,
\`merchant_id\`, \`merchants\`, or \`places\`.

Postings (the double-entry debit/credit rows under the transaction) are
also OUT OF SCOPE — re-extract does not rewrite them. Do NOT touch
\`postings\` or \`document_links\`. The transaction's total and currency
live there, so you do not extract them at all.

── Phase 2 — Write ────────────────────────────────────────────────────

**Brand FK guard (#101).** Items may carry product_brand_id, which is
FK into \`brands\`. The products UPSERT below would fail if the brand
row doesn't exist. Run this defensively BEFORE the main block:

${brandFkGuard()}

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
    -- Top-level jsonb merge. The extraction_history term MUST be
    -- evaluated from the OLD metadata (it is, inside UPDATE ... SET),
    -- so it captures the stamp this run is about to overwrite.
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      -- Never destroy the previous provenance stamp: push the CURRENT
      -- extraction object onto extraction_history, keeping the newest 5.
      'extraction_history', (
        SELECT COALESCE(jsonb_agg(h.elem ORDER BY h.ord), '[]'::jsonb)
          FROM (
            SELECT elem, ord
              FROM jsonb_array_elements(
                     COALESCE(metadata->'extraction_history', '[]'::jsonb)
                     || CASE WHEN metadata->'extraction' IS NOT NULL
                             THEN jsonb_build_array(metadata->'extraction')
                             ELSE '[]'::jsonb END
                   ) WITH ORDINALITY AS t(elem, ord)
             ORDER BY ord DESC
             LIMIT 5
          ) h
      ),
      'extraction', jsonb_build_object(
        'prompt_version', '${PROMPT_VERSION}',
        'prompt_git_sha', '${buildInfo.gitSha}',
        'model',          '${EXTRACTION_MODEL}',
        'ran_at',         NOW()::text,
        'source',         're-extract'
      ),
      'items', ${ITEMS_JSON_EXPR},
      'ocr_audit', $audit$<OCR_AUDIT_JSON>$audit$::jsonb,
      're_extracted_at', to_jsonb(NOW()::text)
    ),
    version = version + 1
  WHERE id = '${ctx.transactionId}'
    AND workspace_id = '${ctx.workspaceId}'
    AND deleted_at IS NULL;

  UPDATE documents SET
    ocr_text          = '<RAW_TEXT, single-quote-escaped>',
    ocr_model_version = '${EXTRACTION_MODEL}',
    updated_at        = NOW()
  WHERE id = '${ctx.documentId}' AND workspace_id = '${ctx.workspaceId}';

  -- #84 Phase 1: re-extract is versioned (extraction_run counter
  -- bumps; old run rows soft-deleted via retired_at). Live aggregates
  -- read WHERE retired_at IS NULL, so old purchases drop out and new
  -- ones count immediately — purchase_count stays correct, no drift.
  -- Soft-delete every live item belonging to this tx.
  UPDATE transaction_items
  SET retired_at = NOW()
  WHERE transaction_id = '${ctx.transactionId}'
    AND retired_at IS NULL;

  -- Insert the freshly extracted rows under run = MAX(prev)+1.
  WITH next_run AS (
    SELECT COALESCE(MAX(extraction_run), 0) + 1 AS run
    FROM transaction_items
    WHERE transaction_id = '${ctx.transactionId}'
  ),
${productsUpsert({ workspaceId: ctx.workspaceId, merchantIdExpr })}
${transactionItemsInsert({
  workspaceId: ctx.workspaceId,
  txIdExpr: `'${ctx.transactionId}'`,
  runExpr: "(SELECT run FROM next_run)",
  merchantIdExpr,
})};

  -- #84: recompute aggregate stats for every product this run touched.
  -- Scoped by transaction, and deliberately NOT filtered on retired_at,
  -- so a product that dropped OUT of the new run still gets recomputed.
${productAggregateRecompute({
  workspaceId: ctx.workspaceId,
  touchedPredicate: `ti.transaction_id = '${ctx.transactionId}'`,
})}

  INSERT INTO transaction_events (
    id, workspace_id, transaction_id, event_type, actor_id, payload
  ) VALUES (
    gen_random_uuid(), '${ctx.workspaceId}', '${ctx.transactionId}',
    're_extracted', '${ctx.userId}',
    jsonb_build_object(
      'prompt_version', '${PROMPT_VERSION}',
      'model',          '${EXTRACTION_MODEL}'
    )
  );

  COMMIT;
  SQL

IMPORTANT escaping rule: SQL single quotes inside values must be
doubled (\`O''Brien\`). Newlines inside \`raw_text\` are fine inside a
single-quoted SQL literal as long as no single quote is unescaped.
The items JSON and the ocr_audit JSON are dollar-quoted instead
(\`$items$…$items$\`, \`$audit$…$audit$\`), so drop those payloads in
between the markers with NO surrounding single quotes and NO escaping
— that is what keeps apostrophes in product titles ("World's", 12" pan)
from breaking the write. Never revert them to single-quoted literals.

── Phase 3 — Refresh brand identity & icons (#101) ────────────────────

Re-extract refreshes the merchant's brand registry entry AND its
icons. Apply both sub-phases below to the merchant.brand_id of the
transaction (NOT to product brand_ids — those are stub-only in v1).

Layer-3 protection is mandatory: never overwrite a user's choice.
The Phase 4c winner-pick UPDATE is gated on
\`user_chose_at IS NULL\`; user ratings
(\`brand_assets.user_rating\`) and uploads
(\`brand_assets.user_uploaded\`) are not touched by re-extract at all.

Step 1: identify the merchant's brand_id and canonical_name from the
transaction's merchant row:

  psql "\$DATABASE_URL" -c "SELECT m.brand_id, m.canonical_name FROM transactions t JOIN merchants m ON m.id = t.merchant_id WHERE t.id = '${ctx.transactionId}';"

If the SELECT returns NULL (soft-deleted / orphaned tx), skip Phase 3.

Step 2: substitute the returned brand_id for <bid> and the
canonical_name for <canonical_name> in the inlined phases that
follow, then execute them verbatim:

${PHASE_2_6_BRAND_DISCOVERY}

${PHASE_4B_4C_ICON_PIPELINE}

Most re-extracts hit Case A (already-resolved) on the cache pre-check
and complete in one SELECT. Case B (re-judge existing candidates with
no new fetch) is the next most common; full Case D (mechanical fetch
+ judgment) only runs when the brand has never been resolved.

── Done ────────────────────────────────────────────────────────────────

After the psql block exits 0, print ONE line:

  DONE re_extracted tx=${ctx.transactionId} prompt_version=${PROMPT_VERSION}

If you cannot read the receipt at all (unsupported / illegible /
corrupted), do NOT write anything to the database. Print:

  ERROR <one-line reason>

and exit. The service will mark the document accordingly.
`;
}
