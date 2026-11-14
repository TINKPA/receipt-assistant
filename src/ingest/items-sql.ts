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
 * #181 added `itemsCte()`: the `<ITEMS_JSON_ARRAY>` placeholder and the
 * 26-column type list now appear ONCE per statement instead of once per
 * fragment. `productsUpsert` and `transactionItemsInsert` read the
 * resulting `item` CTE and must not be spliced into a statement that
 * lacks it.
 *
 * Two consumers (wave 1). The prompts render the fragments with their
 * defaults: a dollar-quoted `<ITEMS_JSON_ARRAY>` placeholder, the
 * workspace id quoted in as a literal, `PROMPT_VERSION` as the version.
 * Those defaults are the legacy rendering, and
 * `scripts/check-prompt-render.ts` proves they still render byte for byte.
 * The server writes the same rows with the same SQL: `itemsBrandGuardSql`,
 * `itemsWriteSql` and `itemsRecomputeSql` at the bottom pass bound
 * parameters (`$1::jsonb`, `$2::uuid`, …) as the expressions, so the
 * DISTINCT ON upsert, the COALESCE rules and the line_no rules exist once.
 *
 * Plain template literals, never `String.raw` — see `prompt-contract.ts`.
 */
import { sql, type SQL } from "drizzle-orm";
import { PROMPT_VERSION } from "./prompt-contract.js";

/**
 * The items JSON is ALWAYS embedded via PostgreSQL dollar-quoting.
 * A single-quoted `'...'::jsonb` literal hard-fails on `McDonald's` /
 * `12" pan` and silently rolls back the whole write — which is exactly
 * what the re-extract path did on every apostrophe-bearing receipt
 * before #164.
 */
export const ITEMS_JSON_EXPR = `$items$<ITEMS_JSON_ARRAY>$items$::jsonb`;

/**
 * Where a fragment takes the workspace id from: quoted into the text as a
 * literal (`workspaceId`, the prompts) or an SQL expression
 * (`workspaceIdExpr`, the server's bound parameter).
 */
export type WorkspaceRef =
  | { workspaceId: string; workspaceIdExpr?: undefined }
  | { workspaceIdExpr: string; workspaceId?: undefined };

function workspaceSql(ref: WorkspaceRef): string {
  return ref.workspaceIdExpr ?? `'${ref.workspaceId}'`;
}

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
 * The `raw` + `item` leading CTEs (#181).
 *
 * Before #181 every fragment that needed the line items pasted the
 * whole `<ITEMS_JSON_ARRAY>` placeholder AND the 26-column
 * `jsonb_to_recordset` type list of its own — four array copies and two
 * type lists in the ingest write, three and two on re-extract. The array
 * is the agent's OUTPUT, so each duplicate is retyped in full.
 *
 * CTEs are per-STATEMENT in PostgreSQL, so this dedups within one
 * statement only: the brand FK guard stays a separate statement (RI
 * checks are AFTER-ROW and `WITH` sub-statements cannot see each
 * other's effects on target tables) and keeps its own one-column
 * recordset.
 *
 * Place these FIRST in the `WITH` list; everything downstream reads
 * `item`.
 */
export function itemsCte(opts: {
  /** SQL expression yielding the items array as jsonb. Default: the
   *  prompts' dollar-quoted `<ITEMS_JSON_ARRAY>` placeholder. */
  itemsJsonExpr?: string;
} = {}): string {
  return `    -- #181: the items[] array enters this statement EXACTLY ONCE, here.
    -- Every CTE below reads \`item\` — do NOT paste the array again.
    raw AS (SELECT ${opts.itemsJsonExpr ?? ITEMS_JSON_EXPR} AS j),
    item AS (
      SELECT i.*
        FROM raw, jsonb_to_recordset(raw.j) AS i(
${indentBlock(ITEM_RECORD_COLUMNS, "          ")}
        )
    )`;
}

/**
 * Defensive `brands` upsert for every distinct `product_brand_id` in
 * `items[]`. `products.brand_id` is FK into `brands`, so the products
 * upsert fails without it (#101).
 *
 * Its own statement, never a sibling CTE: `WITH` sub-statements cannot
 * see each other's effects on target tables and RI checks are AFTER-ROW.
 *
 * Returned WITHOUT a `psql … <<'SQL'` wrapper, so the caller batches it
 * into its own larger heredoc (#181 Turn B). It keeps its own one-column
 * recordset — CTEs are per-statement, so it cannot read `itemsCte()`'s
 * `item`.
 */
export function brandFkGuard(opts: {
  /** As `itemsCte`'s. */
  itemsJsonExpr?: string;
} = {}): string {
  const stmt = `INSERT INTO brands (brand_id, name)
SELECT DISTINCT product_brand_id, product_brand_id
  FROM jsonb_to_recordset(${opts.itemsJsonExpr ?? ITEMS_JSON_EXPR})
    AS item(product_brand_id text)
 WHERE product_brand_id IS NOT NULL
ON CONFLICT (brand_id) DO NOTHING;`;
  return indentBlock(stmt, "  ");
}

/**
 * The `p_upsert` CTE — #84 Phase 1 products SSOT upsert, keyed by
 * (workspace_id, merchant_id, product_key).
 *
 * Requires `itemsCte()` earlier in the same `WITH` list — it reads
 * `item`, it does not paste the array itself (#181).
 *
 * Returned WITHOUT a trailing comma so the call site can place it
 * anywhere in a `WITH` list.
 */
export function productsUpsert(opts: WorkspaceRef & {
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
    -- DISTINCT ON (#181): two lines on one receipt may legitimately
    -- share a product_key (the same dish ordered twice). Feeding both
    -- to ON CONFLICT DO UPDATE raises PG 21000 "command cannot affect
    -- row a second time" and rolls back the whole write. This dedups
    -- the CATALOG upsert source only — transaction_items below still
    -- gets one row per printed line.
    p_upsert AS (
      INSERT INTO products (
        workspace_id, merchant_id, product_key, canonical_name,
        item_class, brand_id, model, color, size, variant, sku,
        manufacturer
      )
      SELECT DISTINCT ON (item.product_key, COALESCE(item.product_merchant_exclusive, false))
             ${workspaceSql(opts)},
             CASE WHEN item.product_merchant_exclusive THEN ${opts.merchantIdExpr} ELSE NULL END,
             item.product_key,
             COALESCE(item.normalized_name, item.raw_name),
             item.item_class, item.product_brand_id,
             item.product_model, item.product_color, item.product_size,
             item.product_variant, item.product_sku, item.product_manufacturer
      FROM item
      WHERE COALESCE(item.line_type, 'product') = 'product' AND item.product_key IS NOT NULL
      ORDER BY item.product_key, COALESCE(item.product_merchant_exclusive, false), item.line_no
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
 * Requires `itemsCte()` earlier in the same `WITH` list — it selects
 * `FROM item` rather than re-pasting the array (#181).
 *
 * Returns a bare `INSERT … SELECT … FROM …` (no trailing semicolon, no
 * CTE wrapper) so the ingest path can wrap it as `ti AS ( … )` and the
 * re-extract path can terminate it with `;`.
 */
export function transactionItemsInsert(opts: WorkspaceRef & {
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
  /** SQL expression added to every `line_no`, so a run can be shifted past
   *  rows that survived it. Re-extract passes the highest live manual line
   *  (#192): manual rows are no longer retired, and since the unique index is
   *  (transaction_id, line_no, extraction_run) a new run may legally reuse a
   *  survivor's number — leaving two LIVE rows with the same line_no and an
   *  ambiguous rendered order. Ingest passes nothing; it has no survivors. */
  lineNoOffsetExpr?: string;
  /** SQL expression yielding `extraction_version`. Default: this source
   *  tree's `PROMPT_VERSION` as a literal. */
  versionExpr?: string;
  /** SQL expression yielding `extraction_id`, the extraction record the
   *  rows were projected from. Absent: the column is not named at all,
   *  which is the prompts' form. */
  extractionIdExpr?: string;
}): string {
  const from = opts.fromPrefix ? `${opts.fromPrefix} ` : "";
  const returning = opts.returning ? `\n      RETURNING ${opts.returning}` : "";
  const off = opts.lineNoOffsetExpr ? ` + ${opts.lineNoOffsetExpr}` : "";
  const version = opts.versionExpr ?? `'${PROMPT_VERSION}'`;
  const extractionCol = opts.extractionIdExpr ? ", extraction_id" : "";
  const extractionVal = opts.extractionIdExpr ? `, ${opts.extractionIdExpr}` : "";
  return `      INSERT INTO transaction_items (
        id, workspace_id, transaction_id, line_no, parent_line_no,
        raw_name, normalized_name, product_variant, quantity, unit,
        unit_price_minor, line_total_minor, currency,
        item_class, durability_tier, food_kind, tags, confidence,
        line_type, product_id, tax_minor, tip_share_minor,
        discount_share_minor, extraction_run, extraction_version${extractionCol}
      )
      SELECT gen_random_uuid(), ${workspaceSql(opts)}, ${opts.txIdExpr}, item.line_no${off},
             CASE WHEN item.parent_line_no IS NULL THEN NULL
                  ELSE item.parent_line_no${off} END,
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
             ${opts.runExpr}, ${version}${extractionVal}
      FROM ${from}item${returning}`;
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
export function productAggregateRecompute(opts: WorkspaceRef & {
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
    WHERE ti.workspace_id = ${workspaceSql(opts)}
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
    AND p.workspace_id = ${workspaceSql(opts)};`;
}

// ── The same SQL for the server, with every value bound ──────────────

/**
 * Splice bound parameters into fragment text. A fragment is built with a
 * marker (`param("items")`) where a value goes, and this turns each marker
 * into a drizzle parameter: node-postgres then sends the statement with
 * `$1`, `$2`, … in those places and the values beside it, so nothing the
 * extraction produced is ever part of the SQL text.
 */
const MARKER = /\u0000([a-z_]+)\u0000/g;
const param = (name: string) => `\u0000${name}\u0000`;

function bindMarkers(text: string, values: Record<string, unknown>): SQL {
  const out = sql.empty();
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const name = m[1]!;
    if (!(name in values)) throw new Error(`items-sql: no value bound for ${name}`);
    out.append(sql.raw(text.slice(last, m.index)));
    out.append(sql`${values[name]}`);
    last = m.index! + m[0].length;
  }
  out.append(sql.raw(text.slice(last)));
  return out;
}

/** `JSON.stringify` the items array for a `::jsonb` parameter. A bare JS
 *  array would be sent as a Postgres array literal instead. */
function itemsJson(items: readonly unknown[]): string {
  return JSON.stringify(items);
}

/**
 * `brandFkGuard` for the server: a `brands` stub for every distinct
 * `product_brand_id` in `items`, `ON CONFLICT DO NOTHING`. Its own
 * statement, run before `itemsWriteSql` (see `brandFkGuard`).
 */
export function itemsBrandGuardSql(items: readonly unknown[]): SQL {
  const text = brandFkGuard({ itemsJsonExpr: `${param("items")}::jsonb` }).trim();
  return bindMarkers(text, { items: itemsJson(items) });
}

/**
 * The products upsert and the `transaction_items` insert for the server:
 * one statement, `WITH raw, item, p_upsert INSERT …`, built from
 * `itemsCte`, `productsUpsert` and `transactionItemsInsert` with bound
 * values, so it is the SQL the prompts render, row rules included:
 * `DISTINCT ON` the catalog upsert (#181), COALESCE on conflict, one row
 * per printed line, `parent_line_no` shifted with `line_no`.
 *
 * Product brands must exist first (`itemsBrandGuardSql`).
 */
export function itemsWriteSql(opts: {
  /** The ITEM_SCHEMA array, as validated. */
  items: readonly unknown[];
  workspaceId: string;
  transactionId: string;
  /** The transaction's merchant, used for merchant-exclusive products;
   *  NULL makes every product portable, as the SQL does today when the
   *  merchant expression yields nothing. */
  merchantId: string | null;
  /** `extraction_run`: 1 at ingest, the next run on a re-extract. */
  run: number;
  /** `extraction_version`, e.g. `RECORD_PROMPT_VERSION`. */
  extractionVersion: string;
  /** `extraction_id`. Omit (undefined) to leave the column unnamed. */
  extractionId?: string | null;
  /** Added to every `line_no` and `parent_line_no` (re-extract shifts a
   *  run past surviving manual lines, #192). Omit at ingest. */
  lineNoOffset?: number;
  /** RETURNING column list, e.g. `id, line_no, product_id`. */
  returning?: string;
}): SQL {
  const merchantIdExpr = `${param("merchant")}::uuid`;
  const ws = { workspaceIdExpr: `${param("workspace")}::uuid` };
  const text = `WITH
${itemsCte({ itemsJsonExpr: `${param("items")}::jsonb` })},
${productsUpsert({ ...ws, merchantIdExpr })}
${transactionItemsInsert({
  ...ws,
  txIdExpr: `${param("tx")}::uuid`,
  runExpr: `${param("run")}::int`,
  merchantIdExpr,
  versionExpr: `${param("version")}::text`,
  ...(opts.extractionId !== undefined ? { extractionIdExpr: `${param("extraction")}::uuid` } : {}),
  ...(opts.lineNoOffset !== undefined ? { lineNoOffsetExpr: `${param("line_offset")}::int` } : {}),
  ...(opts.returning ? { returning: opts.returning } : {}),
})}`;
  return bindMarkers(text, {
    items: itemsJson(opts.items),
    workspace: opts.workspaceId,
    merchant: opts.merchantId,
    tx: opts.transactionId,
    run: opts.run,
    version: opts.extractionVersion,
    extraction: opts.extractionId ?? null,
    line_offset: opts.lineNoOffset ?? 0,
  });
}

/**
 * `productAggregateRecompute` for the server, scoped to the products one
 * transaction's line items touch: the recompute the prompts run, bound.
 *
 * It keeps that SQL's semantics, which are not the route's: a product
 * with no live product line left is not updated, and deleted
 * transactions count. `recomputeProductStats` (src/catalog/product-stats.ts)
 * is the helper with a `liveOnly` switch; this one exists so the server
 * can reproduce exactly what the agent's write does.
 */
export function itemsRecomputeSql(opts: { workspaceId: string; transactionId: string }): SQL {
  const text = productAggregateRecompute({
    workspaceIdExpr: `${param("workspace")}::uuid`,
    touchedPredicate: `ti.transaction_id = ${param("tx")}::uuid`,
  }).trim();
  return bindMarkers(text, { workspace: opts.workspaceId, tx: opts.transactionId });
}
