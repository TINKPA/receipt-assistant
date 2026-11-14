/**
 * check-items-sql-parity.ts — the server's bound items SQL writes the same
 * rows as the SQL the extraction prompts give the agent.
 *
 * `src/ingest/items-sql.ts` renders the products upsert, the
 * `transaction_items` insert, the product-brand guard and the stats
 * recompute twice: with literal values pasted in (the prompts, as the agent
 * fills them) and with bound parameters (`itemsBrandGuardSql`,
 * `itemsWriteSql`, `itemsRecomputeSql`, for the server applier). This runs
 * both against the same starting state and compares what they leave in
 * `transaction_items`, `products` and `brands`.
 *
 * Each case runs twice, once per writer, each time inside a transaction
 * that is rolled back. Two kinds of case:
 *
 *   fixture  synthetic item lists in a workspace the check creates (and
 *            rolls back): plain lines, a repeated product_key (the
 *            DISTINCT ON path, #181), a merchant-exclusive product,
 *            two-level lines, catalog conflicts with existing products,
 *            non-product lines only, an empty list, and a re-extract past a
 *            surviving manual line (#192). The ingest cases use the prompt's
 *            Turn B statement; the re-extract case its Phase 2 statements.
 *   ledger   (`--ledger=N`, default 6) the re-extract statements replayed
 *            on existing transactions of the database, each with its own
 *            current line items as the new item list: real item shapes and
 *            real catalog conflicts. Picked to include two-level lines,
 *            repeated products, merchant-exclusive products, a later run,
 *            and a quantity printed with trailing zeros.
 *
 * Compared: every column of the item rows except ids and timestamps (the
 * product as `product_key` + exclusive flag), the touched products'
 * catalog and stats columns, and the product-brand rows. `quantity` is
 * compared by value. Its text scale is reported separately: the agent's
 * JSON reaches Postgres as written ("1.10"), the server's goes through
 * `JSON.parse` first ("1.1"), so the scale can differ while the value
 * cannot.
 *
 * Prints case names, counts and the names of differing fields, never a
 * value, so it can be pointed at a production-shaped copy. It still writes
 * (and rolls back), takes row locks and, without migration 0043, adds the
 * `extraction_id` column inside a rolled-back transaction: give it a
 * throwaway database, never the ledger.
 *
 *   npx tsx scripts/check-items-sql-parity.ts --pg=postgresql://postgres:postgres@127.0.0.1:<port>/receipts [--ledger=6]
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  brandFkGuard,
  itemsCte,
  productsUpsert,
  transactionItemsInsert,
  productAggregateRecompute,
  itemsBrandGuardSql,
  itemsWriteSql,
  itemsRecomputeSql,
} from "../src/ingest/items-sql.js";
import { PROMPT_VERSION } from "../src/ingest/prompt-contract.js";

const argv = process.argv.slice(2);
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PG_URL = arg("pg");
const LEDGER_CASES = Number(arg("ledger") ?? 6);
if (!PG_URL) {
  console.error("usage: npx tsx scripts/check-items-sql-parity.ts --pg=<throwaway postgres url> [--ledger=N]");
  process.exit(2);
}

const dialect = new PgDialect();
async function run(c: pg.Client, stmt: SQL | string): Promise<pg.QueryResult> {
  if (typeof stmt === "string") return c.query(stmt);
  const q = dialect.sqlToQuery(stmt);
  return c.query(q.sql, q.params as unknown[]);
}

// ── What is compared ──────────────────────────────────────────────────

interface Snapshot {
  items: Record<string, unknown>[];
  products: Record<string, unknown>[];
  brands: Record<string, unknown>[];
  quantityText: string[];
  extractionIds: (string | null)[];
}

async function snapshot(c: pg.Client, ws: string, tx: string, extraProductIds: string[]): Promise<Snapshot> {
  const items = await c.query(
    `SELECT ti.extraction_run, ti.line_no, ti.parent_line_no, ti.raw_name, ti.normalized_name,
            ti.product_variant, trim_scale(ti.quantity)::text AS quantity, ti.unit,
            ti.unit_price_minor::text AS unit_price_minor, ti.line_total_minor::text AS line_total_minor,
            ti.currency, ti.item_class, ti.durability_tier, ti.food_kind, ti.tags, ti.confidence,
            ti.line_type, ti.tax_minor::text AS tax_minor, ti.tip_share_minor::text AS tip_share_minor,
            ti.discount_share_minor::text AS discount_share_minor,
            ti.effective_total_minor::text AS effective_total_minor,
            ti.extraction_version, ti.source, ti.metadata, ti.retired_at IS NOT NULL AS retired,
            p.product_key, p.merchant_id IS NOT NULL AS product_exclusive
       FROM transaction_items ti
       LEFT JOIN products p ON p.id = ti.product_id
      WHERE ti.transaction_id = $1
      ORDER BY ti.extraction_run, ti.line_no, ti.source`,
    [tx],
  );
  const scale = await c.query(
    `SELECT COALESCE(quantity::text, '') AS q FROM transaction_items
      WHERE transaction_id = $1 ORDER BY extraction_run, line_no, source`,
    [tx],
  );
  const hasCol = await extractionIdColumnExists(c);
  const ext = hasCol
    ? await c.query(
        `SELECT extraction_id::text AS e FROM transaction_items
          WHERE transaction_id = $1 AND retired_at IS NULL AND source <> 'manual'
          ORDER BY line_no`,
        [tx],
      )
    : { rows: [] };
  const products = await c.query(
    `SELECT p.product_key, p.merchant_id IS NOT NULL AS exclusive, p.canonical_name, p.item_class,
            p.brand_id, p.model, p.color, p.size, p.variant, p.sku, p.manufacturer,
            p.first_purchased_on::text AS first_purchased_on, p.last_purchased_on::text AS last_purchased_on,
            p.purchase_count, p.total_spent_minor::text AS total_spent_minor, p.source, p.custom_name,
            p.metadata, p.retired_from_catalog_at IS NOT NULL AS retired
       FROM products p
      WHERE p.workspace_id = $1
        AND (p.id IN (SELECT product_id FROM transaction_items WHERE transaction_id = $2)
             OR p.id = ANY($3::uuid[]))
      ORDER BY p.product_key, p.merchant_id IS NOT NULL`,
    [ws, tx, extraProductIds],
  );
  const brands = await c.query(
    `SELECT b.brand_id, b.name, b.domain FROM brands b
      WHERE b.brand_id IN (SELECT p.brand_id FROM products p
                            JOIN transaction_items ti ON ti.product_id = p.id
                           WHERE ti.transaction_id = $1)
      ORDER BY b.brand_id`,
    [tx],
  );
  return {
    items: items.rows,
    products: products.rows,
    brands: brands.rows,
    quantityText: scale.rows.map((r) => r.q as string),
    extractionIds: ext.rows.map((r) => r.e as string | null),
  };
}

function diffFields(a: Record<string, unknown>[], b: Record<string, unknown>[]): string[] {
  if (a.length !== b.length) return [`row count ${a.length} vs ${b.length}`];
  const out = new Set<string>();
  a.forEach((row, i) => {
    for (const k of new Set([...Object.keys(row), ...Object.keys(b[i]!)])) {
      if (JSON.stringify(row[k]) !== JSON.stringify(b[i]![k])) out.add(k);
    }
  });
  return [...out].sort();
}

let extractionIdColumn: boolean | null = null;
async function extractionIdColumnExists(c: pg.Client): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transaction_items' AND column_name = 'extraction_id'`,
  );
  return r.rowCount! > 0;
}

// ── Fixtures ──────────────────────────────────────────────────────────

interface Fixture {
  ws: string;
  user: string;
  ingest: string;
  doc: string;
  brand: string;
  merchantName: string;
}

function newFixture(): Fixture {
  const nonce = randomUUID().slice(0, 8);
  return {
    ws: randomUUID(),
    user: randomUUID(),
    ingest: randomUUID(),
    doc: randomUUID(),
    brand: `zz-parity-${nonce}`,
    merchantName: "Parity Fixture Shop",
  };
}

async function seedFixture(c: pg.Client, f: Fixture): Promise<void> {
  await c.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'items parity check')`, [
    f.user,
    `items-parity-${f.brand}@receipts.local`,
  ]);
  await c.query(
    `INSERT INTO workspaces (id, owner_id, name, base_currency) VALUES ($1, $2, 'items parity check', 'USD')`,
    [f.ws, f.user],
  );
  await c.query(
    `INSERT INTO accounts (id, workspace_id, name, type, subtype, currency) VALUES
       (gen_random_uuid(), $1, 'Shopping', 'expense', NULL, 'USD'),
       (gen_random_uuid(), $1, 'Credit Card', 'liability', 'credit_card', 'USD')`,
    [f.ws],
  );
  await c.query(
    `INSERT INTO ingests (id, workspace_id, filename, file_path, status)
     VALUES ($1, $2, 'parity.pdf', 'parity.pdf', 'processing')`,
    [f.ingest, f.ws],
  );
  await c.query(`INSERT INTO documents (id, workspace_id, kind, sha256) VALUES ($1, $2, 'receipt_pdf', $3)`, [
    f.doc,
    f.ws,
    `zz-parity-${f.brand}`,
  ]);
  // The merchant brand row, as Turn B (1) writes it, before either writer.
  await c.query(`INSERT INTO brands (brand_id, name, domain) VALUES ($1, $2, NULL)`, [f.brand, f.merchantName]);
}

const fillItems = (text: string, itemsJson: string) => text.split("<ITEMS_JSON_ARRAY>").join(itemsJson);
const total = (items: Item[]) => items.reduce((s, i) => s + Number(i.line_total_minor ?? 0), 0);

type Item = Record<string, unknown>;

/** Turn B (2)–(3), (4) and (7) of the ingest prompt, filled in as the agent fills them. */
async function ingestByTemplate(c: pg.Client, f: Fixture, items: Item[], occurredOn: string): Promise<string> {
  const json = JSON.stringify(items);
  await c.query(fillItems(brandFkGuard(), json));
  const t = total(items);
  const res = await c.query(
    fillItems(
      `WITH
${itemsCte()},
    expense AS (SELECT id FROM accounts WHERE workspace_id = '${f.ws}' AND type = 'expense' AND name = 'Shopping' LIMIT 1),
    credit  AS (SELECT id FROM accounts WHERE workspace_id = '${f.ws}' AND type = 'liability' AND name = 'Credit Card' LIMIT 1),
    m AS (
      INSERT INTO merchants (workspace_id, brand_id, canonical_name, category)
      VALUES ('${f.ws}', '${f.brand}', '${f.merchantName}', 'Shopping')
      ON CONFLICT (workspace_id, brand_id) DO UPDATE
        SET updated_at = NOW()
      RETURNING id
    ),
    tx AS (
      INSERT INTO transactions (
        id, workspace_id, occurred_on, occurred_at, payee, status,
        source_ingest_id, merchant_id, metadata, created_by
      ) VALUES (
        gen_random_uuid(), '${f.ws}', '${occurredOn}', NULL, '${f.merchantName}', 'posted',
        '${f.ingest}', (SELECT id FROM m),
        jsonb_build_object('source', 'ingest', 'flow', 'purchase', 'items', (SELECT j FROM raw)),
        '${f.user}'
      )
      RETURNING id
    ),
    p1 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${f.ws}', expense.id, ${t}, 'USD', ${t}
      FROM tx, expense
      RETURNING id
    ),
    p2 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${f.ws}', credit.id, -${t}, 'USD', -${t}
      FROM tx, credit
      RETURNING id
    ),
    dl AS (
      INSERT INTO document_links (document_id, transaction_id)
      SELECT '${f.doc}', tx.id FROM tx
      ON CONFLICT DO NOTHING
      RETURNING transaction_id
    ),
${productsUpsert({ workspaceId: f.ws, merchantIdExpr: "(SELECT id FROM m)" })},
    ti AS (
${transactionItemsInsert({
  workspaceId: f.ws,
  txIdExpr: "tx.id",
  runExpr: "1",
  merchantIdExpr: "(SELECT id FROM m)",
  fromPrefix: "tx,",
  returning: "id, product_id",
})}
    )
  SELECT tx.id AS tx_id FROM tx`,
      json,
    ),
  );
  await c.query("SET CONSTRAINTS ALL IMMEDIATE");
  await c.query(productAggregateRecompute({ workspaceId: f.ws, touchedPredicate: `t.source_ingest_id = '${f.ingest}'` }));
  return res.rows[0].tx_id as string;
}

/** The same write by the server: the ledger rows by hand, the items by the bound builders. */
async function ingestByServer(
  c: pg.Client,
  f: Fixture,
  items: Item[],
  occurredOn: string,
  extractionId: string | null,
): Promise<string> {
  const t = total(items);
  const m = await c.query(
    `INSERT INTO merchants (workspace_id, brand_id, canonical_name, category)
     VALUES ($1, $2, $3, 'Shopping')
     ON CONFLICT (workspace_id, brand_id) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [f.ws, f.brand, f.merchantName],
  );
  const merchantId = m.rows[0].id as string;
  const txId = randomUUID();
  await c.query(
    `INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, source_ingest_id, merchant_id, metadata, created_by)
     VALUES ($1, $2, $3, $4, 'posted', $5, $6, '{}'::jsonb, $7)`,
    [txId, f.ws, occurredOn, f.merchantName, f.ingest, merchantId, f.user],
  );
  await c.query(
    `INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
     SELECT gen_random_uuid(), $1, $2, a.id, CASE a.type WHEN 'expense' THEN $3::bigint ELSE -$3::bigint END, 'USD',
            CASE a.type WHEN 'expense' THEN $3::bigint ELSE -$3::bigint END
       FROM accounts a
      WHERE a.workspace_id = $2 AND a.name IN ('Shopping', 'Credit Card')`,
    [txId, f.ws, t],
  );
  await c.query(`INSERT INTO document_links (document_id, transaction_id) VALUES ($1, $2)`, [f.doc, txId]);
  const parsed = JSON.parse(JSON.stringify(items)) as Item[];
  await run(c, itemsBrandGuardSql(parsed));
  await run(
    c,
    itemsWriteSql({
      items: parsed,
      workspaceId: f.ws,
      transactionId: txId,
      merchantId,
      run: 1,
      extractionVersion: PROMPT_VERSION,
      extractionId,
      returning: "id, line_no, product_id",
    }),
  );
  await c.query("SET CONSTRAINTS ALL IMMEDIATE");
  await run(c, itemsRecomputeSql({ workspaceId: f.ws, transactionId: txId }));
  return txId;
}

/** Phase 2 of the re-extract prompt: retire, insert the next run past the manual lines, recompute. */
async function reExtractByTemplate(c: pg.Client, ws: string, tx: string, items: Item[] | string): Promise<void> {
  const json = typeof items === "string" ? items : JSON.stringify(items);
  const merchantIdExpr = `(SELECT merchant_id FROM transactions WHERE id = '${tx}')`;
  await c.query(fillItems(brandFkGuard(), json));
  await c.query(
    `UPDATE transaction_items SET retired_at = NOW()
      WHERE transaction_id = '${tx}' AND retired_at IS NULL AND source <> 'manual'`,
  );
  await c.query(
    fillItems(
      `  WITH next_run AS (
    SELECT COALESCE(MAX(extraction_run), 0) + 1 AS run
    FROM transaction_items
    WHERE transaction_id = '${tx}'
  ),
  manual_offset AS (
    SELECT COALESCE(MAX(line_no), 0) AS n
    FROM transaction_items
    WHERE transaction_id = '${tx}'
      AND retired_at IS NULL
      AND source = 'manual'
  ),
${itemsCte()},
${productsUpsert({ workspaceId: ws, merchantIdExpr })}
${transactionItemsInsert({
  workspaceId: ws,
  txIdExpr: `'${tx}'`,
  runExpr: "(SELECT run FROM next_run)",
  merchantIdExpr,
  lineNoOffsetExpr: "(SELECT n FROM manual_offset)",
})};`,
      json,
    ),
  );
  await c.query(productAggregateRecompute({ workspaceId: ws, touchedPredicate: `ti.transaction_id = '${tx}'` }));
}

async function reExtractByServer(c: pg.Client, ws: string, tx: string, items: Item[]): Promise<void> {
  await run(c, itemsBrandGuardSql(items));
  await c.query(
    `UPDATE transaction_items SET retired_at = NOW()
      WHERE transaction_id = $1 AND retired_at IS NULL AND source <> 'manual'`,
    [tx],
  );
  const r = await c.query(
    `SELECT t.merchant_id,
            (SELECT COALESCE(MAX(extraction_run), 0) + 1 FROM transaction_items WHERE transaction_id = t.id) AS run,
            (SELECT COALESCE(MAX(line_no), 0) FROM transaction_items
              WHERE transaction_id = t.id AND retired_at IS NULL AND source = 'manual') AS offset
       FROM transactions t WHERE t.id = $1`,
    [tx],
  );
  await run(
    c,
    itemsWriteSql({
      items,
      workspaceId: ws,
      transactionId: tx,
      merchantId: r.rows[0].merchant_id as string | null,
      run: Number(r.rows[0].run),
      extractionVersion: PROMPT_VERSION,
      lineNoOffset: Number(r.rows[0].offset),
    }),
  );
  await run(c, itemsRecomputeSql({ workspaceId: ws, transactionId: tx }));
}

// ── Synthetic item lists ──────────────────────────────────────────────

function item(lineNo: number, o: Item): Item {
  return {
    line_no: lineNo,
    parent_line_no: null,
    raw_name: `ITEM ${lineNo}`,
    normalized_name: null,
    quantity: 1,
    unit: null,
    unit_price_minor: null,
    line_total_minor: 100,
    currency: "USD",
    item_class: "other",
    durability_tier: null,
    food_kind: null,
    tags: [],
    confidence: "high",
    line_type: "product",
    product_key: null,
    product_brand_id: null,
    product_merchant_exclusive: false,
    tax_minor: null,
    tip_share_minor: null,
    discount_share_minor: null,
    ...o,
  };
}

function ingestCases(f: Fixture): { name: string; items: Item[]; before?: (c: pg.Client) => Promise<void> }[] {
  const maker = `${f.brand}-maker`;
  return [
    {
      name: "plain lines, a product brand stub, a tax line",
      items: [
        item(1, { raw_name: "WIDGET", normalized_name: "Widget", product_key: "zz-widget", product_brand_id: maker, item_class: "durable", durability_tier: "standard", unit_price_minor: 1999, line_total_minor: 1999, tax_minor: 160 }),
        item(2, { raw_name: "SOAP", product_key: "zz-soap", item_class: "consumable", line_total_minor: 350, tax_minor: 28 }),
        item(3, { raw_name: "TAX", line_type: "tax", line_total_minor: 188, item_class: "other" }),
      ],
    },
    {
      name: "repeated product_key, a merchant-exclusive product, a discount, line_type omitted",
      items: [
        item(1, { raw_name: "LATTE", normalized_name: "Latte", product_key: "zz-latte", item_class: "food_drink", food_kind: "beverage", line_total_minor: 525 }),
        item(2, { raw_name: "LATTE LG", normalized_name: "Latte (large)", product_key: "zz-latte", item_class: "food_drink", line_total_minor: 575 }),
        item(3, { raw_name: "HOUSE CAKE", product_key: "zz-house-cake", product_merchant_exclusive: true, item_class: "food_drink", line_total_minor: 800 }),
        item(4, { raw_name: "COUPON", line_type: "discount", line_total_minor: -100 }),
        (() => {
          const i = item(5, { raw_name: "STRAW", product_key: "zz-straw", line_total_minor: 0 });
          delete i.line_type;
          return i;
        })(),
      ],
    },
    {
      name: "two-level lines, tags, fractional quantities, allocations",
      items: [
        item(1, { raw_name: "BOWL", normalized_name: "Bowl", product_key: "zz-bowl", item_class: "food_drink", food_kind: "restaurant_dish", line_total_minor: 1200, tax_minor: 96, tip_share_minor: 180, discount_share_minor: 50, tags: ["lunch", "hot"] }),
        item(2, { parent_line_no: 1, raw_name: "+ EGG", product_key: "zz-egg-addon", item_class: "food_drink", line_total_minor: 150, tax_minor: 12, tip_share_minor: 20 }),
        item(3, { parent_line_no: 1, raw_name: "+ EXTRA RICE", product_variant: "no salt", line_total_minor: 100, tax_minor: 8, tip_share_minor: 10 }),
        item(4, { raw_name: "APPLES", normalized_name: "Apples", product_key: "zz-apples", quantity: 1.1, unit: "lb", unit_price_minor: 299, line_total_minor: 329, item_class: "food_drink", food_kind: "grocery_food" }),
        item(5, { raw_name: "HALF LOAF", product_key: "zz-loaf", quantity: 0.5, line_total_minor: 250, confidence: "low" }),
        item(6, { raw_name: "TIP", line_type: "tip", line_total_minor: 210 }),
      ],
    },
    {
      name: "catalog conflicts with existing products (COALESCE on conflict, stats over two purchases)",
      before: async (c) => {
        // An earlier purchase of the same products, written by the template.
        const prior = { ...f, ingest: randomUUID(), doc: randomUUID() };
        await c.query(
          `INSERT INTO ingests (id, workspace_id, filename, file_path, status) VALUES ($1, $2, 'p.pdf', 'p.pdf', 'done')`,
          [prior.ingest, f.ws],
        );
        await c.query(`INSERT INTO documents (id, workspace_id, kind, sha256) VALUES ($1, $2, 'receipt_pdf', $3)`, [
          prior.doc,
          f.ws,
          `zz-parity-prior-${f.brand}`,
        ]);
        await ingestByTemplate(
          c,
          prior,
          [
            item(1, { raw_name: "OLD NAME", product_key: "zz-known", item_class: "other", line_total_minor: 400 }),
            item(2, { raw_name: "HOUSE BLEND", product_key: "zz-house-blend", product_merchant_exclusive: true, line_total_minor: 900 }),
          ],
          "2025-12-01",
        );
      },
      items: [
        item(1, { raw_name: "KNOWN THING", normalized_name: "Known Thing", product_key: "zz-known", product_brand_id: maker, item_class: "durable", line_total_minor: 450 }),
        item(2, { raw_name: "HOUSE BLEND 12OZ", normalized_name: null, product_key: "zz-house-blend", product_merchant_exclusive: true, item_class: "food_drink", line_total_minor: 950 }),
        item(3, { raw_name: "NEW THING", product_key: "zz-new", product_merchant_exclusive: null, line_total_minor: 10 }),
      ],
    },
    {
      name: "non-product lines only",
      items: [
        item(1, { raw_name: "SERVICE FEE", line_type: "service_fee", line_total_minor: 300 }),
        item(2, { raw_name: "SHIPPING", line_type: "shipping", line_total_minor: 599, product_key: "zz-ignored-on-non-product" }),
      ],
    },
    { name: "empty item list", items: [] },
  ];
}

// ── Runner ────────────────────────────────────────────────────────────

let failures = 0;
let checked = 0;
let scaleDiffs = 0;

function report(name: string, a: Snapshot, b: Snapshot, extractionId?: string | null): void {
  checked += 1;
  const problems: string[] = [];
  for (const part of ["items", "products", "brands"] as const) {
    const d = diffFields(a[part], b[part]);
    if (d.length > 0) problems.push(`${part}: ${d.join(", ")}`);
  }
  if (extractionId !== undefined && b.extractionIds.some((e) => e !== extractionId)) {
    problems.push("items: extraction_id not the bound value");
  }
  const scale = a.quantityText.filter((q, i) => q !== b.quantityText[i]).length;
  scaleDiffs += scale;
  const counts = `${a.items.length} items, ${a.products.length} products, ${a.brands.length} product brands`;
  if (problems.length > 0) {
    failures += 1;
    console.log(`  FAIL  ${name} (${counts})\n          ${problems.join("\n          ")}`);
  } else {
    console.log(`  ok    ${name} (${counts}${scale ? `; quantity text scale differs on ${scale}` : ""})`);
  }
}

async function inRolledBack<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    return await fn();
  } finally {
    await c.query("ROLLBACK");
  }
}

async function main(): Promise<void> {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    await c.query("SET statement_timeout = '60s'");
    extractionIdColumn = await extractionIdColumnExists(c);
    console.log(
      `items SQL parity — template (agent) vs bound (server), every case rolled back` +
        `\n  extraction_id column: ${extractionIdColumn ? "present (bound NULL, FK-safe)" : "absent (added inside the rolled-back server arm)"}`,
    );

    console.log("\nfixture cases (ingest, Turn B)");
    const f = newFixture();
    for (const cs of ingestCases(f)) {
      const a = await inRolledBack(c, async () => {
        await seedFixture(c, f);
        await cs.before?.(c);
        const tx = await ingestByTemplate(c, f, cs.items, "2026-01-15");
        return snapshot(c, f.ws, tx, []);
      });
      let bound: string | null = null;
      const b = await inRolledBack(c, async () => {
        await seedFixture(c, f);
        await cs.before?.(c);
        if (!extractionIdColumn) {
          await c.query("ALTER TABLE transaction_items ADD COLUMN extraction_id uuid");
          bound = randomUUID();
        }
        const tx = await ingestByServer(c, f, cs.items, "2026-01-15", bound);
        return snapshot(c, f.ws, tx, []);
      });
      report(cs.name, a, b, bound);
    }

    console.log("\nfixture case (re-extract, Phase 2)");
    {
      const first = [
        item(1, { raw_name: "A", product_key: "zz-a", line_total_minor: 100 }),
        item(2, { raw_name: "B", product_key: "zz-b", line_total_minor: 200 }),
      ];
      const next = [
        item(1, { raw_name: "A", normalized_name: "A renamed", product_key: "zz-a", line_total_minor: 100 }),
        item(2, { raw_name: "C", product_key: "zz-c", line_total_minor: 150 }),
        item(3, { raw_name: "C ADD-ON", parent_line_no: 2, line_total_minor: 50 }),
      ];
      const setup = async () => {
        await seedFixture(c, f);
        const tx = await ingestByTemplate(c, f, first, "2026-01-15");
        await c.query(
          `INSERT INTO transaction_items (id, workspace_id, transaction_id, line_no, raw_name, line_total_minor, currency,
                                          item_class, confidence, line_type, extraction_run, extraction_version, source)
           VALUES (gen_random_uuid(), $1, $2, 3, 'HAND ENTERED', 75, 'USD', 'other', 'high', 'product', 1, NULL, 'manual')`,
          [f.ws, tx],
        );
        const dropped = await c.query(`SELECT id FROM products WHERE workspace_id = $1 AND product_key = 'zz-b'`, [f.ws]);
        return { tx, dropped: dropped.rows.map((r) => r.id as string) };
      };
      const a = await inRolledBack(c, async () => {
        const { tx, dropped } = await setup();
        await reExtractByTemplate(c, f.ws, tx, next);
        return snapshot(c, f.ws, tx, dropped);
      });
      const b = await inRolledBack(c, async () => {
        const { tx, dropped } = await setup();
        await reExtractByServer(c, f.ws, tx, JSON.parse(JSON.stringify(next)) as Item[]);
        return snapshot(c, f.ws, tx, dropped);
      });
      report("re-extract past a surviving manual line, one product dropped out", a, b);
    }

    if (LEDGER_CASES > 0) {
      console.log(`\nledger cases (re-extract replayed on existing transactions, their own items as the new list)`);
      const picks = await c.query(
        `WITH live AS (
           SELECT ti.transaction_id, t.workspace_id,
                  bool_or(ti.parent_line_no IS NOT NULL) AS two_level,
                  count(ti.product_id) > count(DISTINCT ti.product_id) AS repeated,
                  bool_or(p.merchant_id IS NOT NULL) AS exclusive,
                  max(ti.extraction_run) > 1 AS later_run,
                  bool_or(ti.quantity::text ~ '\\.\\d*0$') AS trailing_zero
             FROM transaction_items ti
             JOIN transactions t ON t.id = ti.transaction_id
             LEFT JOIN products p ON p.id = ti.product_id
            WHERE ti.retired_at IS NULL AND ti.source <> 'manual'
            GROUP BY ti.transaction_id, t.workspace_id
         ),
         -- One transaction per feature first, then the most varied others.
         firsts AS (
           SELECT DISTINCT ON (f) f, transaction_id
             FROM live
            CROSS JOIN LATERAL (VALUES
                    ('two_level', two_level), ('repeated', repeated), ('exclusive', exclusive),
                    ('later_run', later_run), ('trailing_zero', trailing_zero)) AS v(f, has)
            WHERE has
            ORDER BY f, md5(transaction_id::text)
         )
         SELECT l.transaction_id, l.workspace_id
           FROM live l
          ORDER BY (l.transaction_id IN (SELECT transaction_id FROM firsts)) DESC,
                   (two_level::int + repeated::int + exclusive::int + later_run::int + trailing_zero::int) DESC,
                   md5(l.transaction_id::text)
          LIMIT $1`,
        [LEDGER_CASES],
      );
      let n = 0;
      for (const p of picks.rows as { transaction_id: string; workspace_id: string }[]) {
        n += 1;
        const itemsText = (
          await c.query(
            `SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'line_no', ti.line_no, 'parent_line_no', ti.parent_line_no,
                      'raw_name', ti.raw_name, 'normalized_name', ti.normalized_name,
                      'quantity', ti.quantity, 'unit', ti.unit,
                      'unit_price_minor', ti.unit_price_minor, 'line_total_minor', ti.line_total_minor,
                      'currency', ti.currency, 'item_class', ti.item_class,
                      'durability_tier', ti.durability_tier, 'food_kind', ti.food_kind,
                      'tags', ti.tags, 'confidence', ti.confidence, 'line_type', ti.line_type,
                      'product_key', pr.product_key, 'product_brand_id', pr.brand_id,
                      'product_merchant_exclusive', pr.merchant_id IS NOT NULL,
                      'product_model', pr.model, 'product_color', pr.color, 'product_size', pr.size,
                      'product_variant', ti.product_variant, 'product_sku', pr.sku,
                      'product_manufacturer', pr.manufacturer,
                      'tax_minor', ti.tax_minor, 'tip_share_minor', ti.tip_share_minor,
                      'discount_share_minor', ti.discount_share_minor)
                    ORDER BY ti.line_no), '[]'::jsonb)::text AS items
               FROM transaction_items ti
               LEFT JOIN products pr ON pr.id = ti.product_id
              WHERE ti.transaction_id = $1 AND ti.retired_at IS NULL AND ti.source <> 'manual'`,
            [p.transaction_id],
          )
        ).rows[0].items as string;
        const a = await inRolledBack(c, async () => {
          await reExtractByTemplate(c, p.workspace_id, p.transaction_id, itemsText);
          return snapshot(c, p.workspace_id, p.transaction_id, []);
        });
        const b = await inRolledBack(c, async () => {
          await reExtractByServer(c, p.workspace_id, p.transaction_id, JSON.parse(itemsText) as Item[]);
          return snapshot(c, p.workspace_id, p.transaction_id, []);
        });
        report(`ledger transaction #${n}`, a, b);
      }
    }
  } finally {
    await c.end();
  }

  console.log(
    `\n${checked - failures}/${checked} cases write the same rows` +
      (scaleDiffs ? `; quantity text scale differs on ${scaleDiffs} row(s), values equal` : ""),
  );
  if (failures > 0) process.exit(1);
}

await main();
