/**
 * Shared `items[]` → SQL fragments for the extraction and re-extraction
 * prompts (#164).
 *
 * Both prompts inline these fragments verbatim so the agent — which runs
 * inside a container that doesn't have the source files — gets the
 * full instructions in its prompt window. Don't reference these
 * fragments by source-file path from the prompt; the agent will go
 * looking for `src/ingest/prompt.ts` and waste turns when it can't
 * find it.
 *
 * Before #164 the brand FK guard, the 26-column `jsonb_to_recordset`
 * type list, the products upsert, the `transaction_items` insert and
 * the product-aggregate recompute existed as EIGHT hand-maintained
 * copies across the two prompts. The only genuine deltas between the
 * two copies are the four parameters below:
 *
 *   • merchant-id expression — `(SELECT id FROM m)` at ingest vs.
 *     `(SELECT merchant_id FROM transactions WHERE id = TX)` on re-extract
 *   • transaction-id expression — `tx.id` (a CTE) vs. a literal uuid
 *   • extraction-run number — `1` vs. `(SELECT run FROM next_run)`
 *   • the version constant — now shared (`prompt-contract.ts`)
 *
 * Plain template literals, never `String.raw` — see `prompt-contract.ts`.
 */
import { PROMPT_VERSION } from "./prompt-contract.js";

/**
 * The items JSON is ALWAYS embedded via PostgreSQL dollar-quoting.
 * A single-quoted `'...'::jsonb` literal hard-fails on `McDonald's` /
 * `12" pan` and silently rolls back the whole write — which is exactly
 * what the re-extract path did on every apostrophe-bearing receipt
 * before #164.
 */
export const ITEMS_JSON_EXPR = `$items$<ITEMS_JSON_ARRAY>$items$::jsonb`;

/** The 26-column record type for `jsonb_to_recordset`. One copy. */
const ITEM_RECORD_COLUMNS = `line_no int, parent_line_no int, raw_name text, normalized_name text,
quantity numeric, unit text,
unit_price_minor bigint, line_total_minor bigint, currency text,
item_class text, durability_tier text, food_kind text,
tags text[], confidence text,
line_type text, product_key text, product_brand_id text,
product_merchant_exclusive boolean, product_model text,
product_color text, product_size text, product_variant text,
product_sku text, product_manufacturer text,
tax_minor bigint, tip_share_minor bigint, discount_share_minor bigint`;

function indentBlock(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/**
 * `jsonb_to_recordset(<items>) AS item(<26 columns>)`.
 *
 * @param pad leading whitespace for the continuation lines, so the
 *            fragment lines up wherever it is spliced in.
 */
export function itemsRecordset(pad = ""): string {
  return `jsonb_to_recordset(${ITEMS_JSON_EXPR}) AS item(
${indentBlock(ITEM_RECORD_COLUMNS, `${pad}  `)}
${pad})`;
}

/**
 * Defensive `brands` upsert for every distinct `product_brand_id` in
 * `items[]`. `products.brand_id` is FK into `brands`, so the products
 * upsert fails without it (#101).
 *
 * Its own statement, never a sibling CTE: `WITH` sub-statements cannot
 * see each other's effects on target tables and RI checks are AFTER-ROW.
 */
export function brandFkGuard(): string {
  return `  psql "\$DATABASE_URL" <<'SQL'
    INSERT INTO brands (brand_id, name)
    SELECT DISTINCT product_brand_id, product_brand_id
      FROM jsonb_to_recordset(${ITEMS_JSON_EXPR})
        AS item(product_brand_id text)
     WHERE product_brand_id IS NOT NULL
    ON CONFLICT (brand_id) DO NOTHING;
  SQL`;
}

/**
 * The `p_upsert` CTE — #84 Phase 1 products SSOT upsert, keyed by
 * (workspace_id, merchant_id, product_key).
 *
 * Returned WITHOUT a trailing comma so the call site can place it
 * anywhere in a `WITH` list.
 */
export function productsUpsert(opts: {
  workspaceId: string;
  /** SQL expression yielding the merchant id for merchant-exclusive
   *  products, e.g. `(SELECT id FROM m)`. */
  merchantIdExpr: string;
}): string {
  return `    -- #84 Phase 1: products SSOT upsert. The agent emits a
    -- product_key per item; this CTE upserts the catalog row keyed by
    -- (workspace_id, merchant_id, product_key) and returns its id.
    -- merchant_id is NULL when product_merchant_exclusive=false (the
    -- product is portable across stores) and this receipt's merchant_id
    -- when true (in-store private label / dish).
    -- Non-product lines (line_type ∈ tax/tip/discount/shipping/…) get
    -- product_key=NULL and skip this step entirely (filtered by the
    -- WHERE clause). NULLS NOT DISTINCT in the unique index makes
    -- merchant_id=NULL participate.
    p_upsert AS (
      INSERT INTO products (
        workspace_id, merchant_id, product_key, canonical_name,
        item_class, brand_id, model, color, size, variant, sku,
        manufacturer
      )
      SELECT '${opts.workspaceId}',
             CASE WHEN item.product_merchant_exclusive THEN ${opts.merchantIdExpr} ELSE NULL END,
             item.product_key,
             COALESCE(item.normalized_name, item.raw_name),
             item.item_class, item.product_brand_id,
             item.product_model, item.product_color, item.product_size,
             item.product_variant, item.product_sku, item.product_manufacturer
      FROM ${itemsRecordset("      ")}
      WHERE COALESCE(item.line_type, 'product') = 'product' AND item.product_key IS NOT NULL
      ON CONFLICT (workspace_id, merchant_id, product_key) DO UPDATE
        SET updated_at = NOW(),
            canonical_name = COALESCE(EXCLUDED.canonical_name, products.canonical_name),
            brand_id       = COALESCE(EXCLUDED.brand_id,       products.brand_id),
            item_class     = COALESCE(EXCLUDED.item_class,     products.item_class)
      RETURNING id, product_key, merchant_id
    )`;
}

/**
 * The `transaction_items` INSERT — #81 Phase 2 + #84 relational line
 * items with the `product_id` link and the per-line allocation columns.
 *
 * Returns a bare `INSERT … SELECT … FROM …` (no trailing semicolon, no
 * CTE wrapper) so the ingest path can wrap it as `ti AS ( … )` and the
 * re-extract path can terminate it with `;`.
 */
export function transactionItemsInsert(opts: {
  workspaceId: string;
  /** SQL expression yielding the transaction id, e.g. `tx.id`. */
  txIdExpr: string;
  /** SQL expression yielding the extraction_run number, e.g. `1`. */
  runExpr: string;
  /** SQL expression yielding the merchant id for merchant-exclusive
   *  products — must match `productsUpsert`'s. */
  merchantIdExpr: string;
  /** Extra FROM-list entries placed before the recordset, e.g. `"tx,"`
   *  when the transaction id comes from a sibling CTE. */
  fromPrefix?: string;
  /** RETURNING column list, when the caller wraps this in a CTE. */
  returning?: string;
}): string {
  const from = opts.fromPrefix ? `${opts.fromPrefix}\n        ` : "";
  const returning = opts.returning ? `\n      RETURNING ${opts.returning}` : "";
  return `      INSERT INTO transaction_items (
        id, workspace_id, transaction_id, line_no, parent_line_no,
        raw_name, normalized_name, product_variant, quantity, unit,
        unit_price_minor, line_total_minor, currency,
        item_class, durability_tier, food_kind, tags, confidence,
        line_type, product_id, tax_minor, tip_share_minor,
        discount_share_minor, extraction_run, extraction_version
      )
      SELECT gen_random_uuid(), '${opts.workspaceId}', ${opts.txIdExpr}, item.line_no,
             item.parent_line_no,
             item.raw_name, item.normalized_name, item.product_variant,
             item.quantity, item.unit,
             item.unit_price_minor, item.line_total_minor, item.currency,
             item.item_class, item.durability_tier, item.food_kind,
             item.tags, item.confidence,
             COALESCE(item.line_type, 'product'),
             (SELECT pu.id FROM p_upsert pu
                WHERE pu.product_key = item.product_key
                  AND pu.merchant_id IS NOT DISTINCT FROM
                      (CASE WHEN item.product_merchant_exclusive THEN ${opts.merchantIdExpr} ELSE NULL END)
                LIMIT 1),
             item.tax_minor, item.tip_share_minor, item.discount_share_minor,
             ${opts.runExpr}, '${PROMPT_VERSION}'
      FROM ${from}${itemsRecordset("        ")}${returning}`;
}

/**
 * Recompute `products` aggregate stats for every product THIS run
 * touched — the recompute-not-increment rule from #84.
 *
 * The `touched` CTE is the point: recomputing the whole workspace on
 * every run is O(N) per receipt → O(N²) over a backfill. The re-extract
 * copy did exactly that while its own comment claimed otherwise.
 *
 * `touched` deliberately does NOT filter `retired_at IS NULL` — on a
 * re-extract, a product that dropped out of the new run must still be
 * recomputed, and it only appears among the now-retired rows.
 *
 * Returns a bare statement (terminated with `;`, no heredoc wrapper).
 */
export function productAggregateRecompute(opts: {
  workspaceId: string;
  /** SQL predicate selecting the `transaction_items ti JOIN transactions t`
   *  rows this run touched, e.g. `t.source_ingest_id = '<uuid>'`. */
  touchedPredicate: string;
}): string {
  return `  WITH touched AS (
    -- Only the products THIS run touched — recomputing the whole
    -- workspace every time is O(N) per receipt → O(N²) over a backfill.
    SELECT DISTINCT ti.product_id
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE ${opts.touchedPredicate}
      AND ti.product_id IS NOT NULL
  ),
  stats AS (
    SELECT ti.product_id,
           MIN(t.occurred_on)          AS first_on,
           MAX(t.occurred_on)          AS last_on,
           COUNT(DISTINCT ti.transaction_id) AS purchases,
           SUM(ti.effective_total_minor)    AS total_minor
    FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE ti.workspace_id = '${opts.workspaceId}'
      AND ti.product_id IN (SELECT product_id FROM touched)
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
    AND p.workspace_id = '${opts.workspaceId}';`;
}
