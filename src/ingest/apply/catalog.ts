/**
 * The catalog writes of the server applier (wave 1; docs/server-writer.md,
 * "The insert, in order", steps a–e, i and k–n): brands, the points
 * account, the merchant, products and line items, owned items, the
 * sold-item retire, product statistics and the party graph.
 * Every function runs on the caller's apply transaction and takes its
 * values from the draft (`project.ts`) and the server's own context, never
 * from the record directly, and every value is a bound parameter.
 *
 * Where a rule differs from the legacy prompt's SQL, on purpose:
 *
 *   brands (a)      a real name is never overwritten. The legacy upsert
 *                   set `name = EXCLUDED.name` on every visit, so the last
 *                   receipt's spelling won (hole 2). Only a slug stub (a
 *                   row whose name is its own brand_id, as `brandFkGuard`
 *                   creates them) is upgraded to the record's name; the
 *                   domain fills only an empty one; `user_chose_at` and
 *                   `metadata` are never written.
 *   points account  created under the workspace's `Assets` root (hole 7:
 *   (c)             the legacy upsert left it without a parent).
 *   sold item (l)   matched on `product_key`, never by name (`ILIKE` on
 *                   the canonical name contradicted lessons.md), and
 *                   retired only when exactly ONE live instance of that
 *                   product is owned. Otherwise nothing is retired and
 *                   the reason goes in `metadata.owned_items_note`.
 *   product stats   the shared `recomputeProductStats` over live
 *   (m)             transactions only (X12).
 *   parties (n)     inside the ledger transaction (#265: the legacy
 *                   statement ran after COMMIT), `line_no` resolved to the
 *                   line item this apply just wrote.
 *
 * Kept as the legacy prompt has it (parity): the merchant row is frozen
 * at first sight (an existing row only gets `updated_at`), product brand
 * stubs and the products upsert and items insert are the very SQL the
 * prompt renders (`items-sql.ts`, bound), owned items are one per unit.
 */
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";
import { recomputeProductStats, type ProductStats } from "../../catalog/product-stats.js";
import { newId } from "../../http/uuid.js";
import { itemsBrandGuardSql, itemsWriteSql } from "../items-sql.js";
import type { ValidationWarning } from "../contract/validate.js";
import type { ApplyDraft, DraftParty } from "./project.js";

type Executor = Pick<typeof db, "execute">;

/** Insert step a: the merchant's brand. Returns whether the stored name was kept
 *  over the record's (a real name that differs). */
export async function upsertMerchantBrand(
  tx: Executor,
  brand: ApplyDraft["merchantBrand"],
): Promise<{ created: boolean; nameKept: boolean }> {
  const res = await tx.execute(sql`
    INSERT INTO brands (brand_id, name, domain)
    VALUES (${brand.brandId}, ${brand.name}, ${brand.domain})
    ON CONFLICT (brand_id) DO UPDATE
      SET name       = CASE WHEN brands.name = brands.brand_id THEN EXCLUDED.name ELSE brands.name END,
          domain     = COALESCE(brands.domain, EXCLUDED.domain),
          updated_at = now()
    RETURNING name, (xmax = 0) AS created`);
  const row = res.rows[0] as { name: string; created: boolean };
  return { created: row.created, nameKept: row.name !== brand.name };
}

/** Insert step b: a stub for every product brand the lines name
 *  (`brandFkGuard`). */
export async function ensureProductBrands(tx: Executor, items: ApplyDraft["items"]): Promise<void> {
  if (!items.some((i) => i.product_brand_id !== null)) return;
  await tx.execute(itemsBrandGuardSql(items));
}

/**
 * Insert step c: the points account the draft names, created when it does not
 * exist yet. Returns its id, or null when the record is not in points.
 */
export async function ensurePointsAccount(
  tx: Executor,
  workspaceId: string,
  pointsAccount: ApplyDraft["pointsAccount"],
): Promise<{ id: string; created: boolean } | null> {
  if (!pointsAccount) return null;
  if (pointsAccount.existingId) return { id: pointsAccount.existingId, created: false };
  const c = pointsAccount.create!;
  const res = await tx.execute(sql`
    INSERT INTO accounts (id, workspace_id, parent_id, name, type, subtype, currency)
    VALUES (${newId()}::uuid, ${workspaceId}::uuid, ${c.parentId}::uuid, ${c.name}, 'asset', 'points', ${c.currency})
    ON CONFLICT (workspace_id, currency) WHERE subtype = 'points'
      DO UPDATE SET updated_at = now()
    RETURNING id, (xmax = 0) AS created`);
  const row = res.rows[0] as { id: string; created: boolean };
  return { id: row.id, created: row.created };
}

/** The workspace's merchant row for a brand, if any (read before the
 *  projection: first sight fixes the category). */
export async function readMerchant(
  tx: Executor,
  workspaceId: string,
  brandId: string,
): Promise<{ id: string; category: string | null } | null> {
  const res = await tx.execute(sql`
    SELECT id, category FROM merchants WHERE workspace_id = ${workspaceId}::uuid AND brand_id = ${brandId}`);
  return (res.rows[0] as { id: string; category: string | null } | undefined) ?? null;
}

/** Insert step e: today's upsert. An existing row keeps its name and
 *  category. */
export async function upsertMerchant(
  tx: Executor,
  workspaceId: string,
  m: ApplyDraft["merchant"],
): Promise<{ id: string; created: boolean }> {
  const res = await tx.execute(sql`
    INSERT INTO merchants (id, workspace_id, brand_id, canonical_name, category)
    VALUES (${newId()}::uuid, ${workspaceId}::uuid, ${m.brandId}, ${m.canonicalName}, ${m.category})
    ON CONFLICT (workspace_id, brand_id) DO UPDATE SET updated_at = now()
    RETURNING id, (xmax = 0) AS created`);
  const row = res.rows[0] as { id: string; created: boolean };
  return { id: row.id, created: row.created };
}

export interface WrittenItem {
  id: string;
  line_no: number;
  product_id: string | null;
}

/**
 * Insert step i: the products upsert and the line items, run 1, as one statement
 * (`itemsWriteSql`), each row pointing at the record (`extraction_id`).
 * Product brand stubs must exist first (`ensureProductBrands`).
 */
export async function writeItems(
  tx: Executor,
  p: {
    workspaceId: string;
    transactionId: string;
    merchantId: string;
    extractionId: string;
    draft: Pick<ApplyDraft, "items" | "itemsWrite">;
  },
): Promise<WrittenItem[]> {
  if (p.draft.items.length === 0) return [];
  const res = await tx.execute(
    itemsWriteSql({
      items: p.draft.items,
      workspaceId: p.workspaceId,
      transactionId: p.transactionId,
      merchantId: p.merchantId,
      run: p.draft.itemsWrite.run,
      extractionVersion: p.draft.itemsWrite.extractionVersion,
      extractionId: p.extractionId,
      returning: "id, line_no, product_id",
    }),
  );
  return res.rows as unknown as WrittenItem[];
}

/**
 * Insert step k: one `owned_items` row per unit of each line the draft tracks,
 * the legacy statement's rules (durable, with a product, live run).
 * Returns how many rows were inserted.
 */
export async function addOwnedItems(
  tx: Executor,
  p: { workspaceId: string; transactionId: string; owned: ApplyDraft["owned"] },
): Promise<number> {
  if (p.owned.lineNos.length === 0) return 0;
  const res = await tx.execute(sql`
    INSERT INTO owned_items (workspace_id, product_id, transaction_item_id, instance_index, acquired_on)
    SELECT ${p.workspaceId}::uuid, ti.product_id, ti.id, gs.idx, ${p.owned.acquiredOn}::date
      FROM transaction_items ti
     CROSS JOIN LATERAL generate_series(1, COALESCE(ti.quantity, 1)::int) gs(idx)
     WHERE ti.transaction_id = ${p.transactionId}::uuid
       AND ti.retired_at IS NULL
       AND ti.line_no IN (SELECT (jsonb_array_elements_text(${JSON.stringify(p.owned.lineNos)}::jsonb))::int)
       AND ti.item_class = 'durable'
       AND ti.product_id IS NOT NULL
    ON CONFLICT (transaction_item_id, instance_index) DO NOTHING
    RETURNING id`);
  return res.rows.length;
}

export interface SoldItemResult {
  /** The owned instance retired, or null. */
  retiredId: string | null;
  /** What `metadata.owned_items_note` says when nothing was retired. */
  note: string | null;
  warning: ValidationWarning | null;
}

/**
 * Insert step l, income only: retire the one live owned instance of the product
 * the record says was sold. Matched on `product_key` across the
 * workspace's products (a merchant-exclusive and a portable product may
 * share a key; their instances are counted together). Exactly one live
 * instance is retired; none, several or no key retire nothing.
 */
export async function retireSoldItem(
  tx: Executor,
  p: { workspaceId: string; soldItem: ApplyDraft["soldItem"]; payee: string; occurredOn: string },
): Promise<SoldItemResult> {
  const nothing: SoldItemResult = { retiredId: null, note: null, warning: null };
  if (!p.soldItem) return nothing;
  const skip = (note: string): SoldItemResult => ({
    retiredId: null,
    note,
    warning: { rule: "owned_items_skipped", path: "sold_item", message: note },
  });
  if (!p.soldItem.productKey) {
    return skip("the sold item names no product_key, so no owned item was retired");
  }
  const live = await tx.execute(sql`
    SELECT o.id
      FROM owned_items o
      JOIN products pr ON pr.id = o.product_id
     WHERE o.workspace_id = ${p.workspaceId}::uuid
       AND pr.workspace_id = ${p.workspaceId}::uuid
       AND pr.product_key = ${p.soldItem.productKey}
       AND o.retired_at IS NULL
     ORDER BY o.id
       FOR UPDATE OF o`);
  const ids = (live.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return skip("no live owned item of the sold product, so nothing was retired");
  if (ids.length > 1) {
    return skip(`${ids.length} live owned items of the sold product; which one was sold cannot be told, so none was retired`);
  }
  await tx.execute(sql`
    UPDATE owned_items
       SET retired_at = now(),
           condition  = COALESCE(condition, 'sold'),
           notes      = CONCAT_WS(' ', notes, ${`sold via ${p.payee} ${p.occurredOn}`}::text),
           updated_at = now()
     WHERE id = ${ids[0]}::uuid`);
  return { ...nothing, retiredId: ids[0]! };
}

/** Insert step m: the statistics of the products this apply's lines point at,
 *  over live transactions only. */
export async function recomputeTouchedProducts(
  tx: Executor,
  workspaceId: string,
  items: readonly WrittenItem[],
): Promise<ProductStats[]> {
  const productIds = [...new Set(items.map((i) => i.product_id).filter((x): x is string => x !== null))];
  return recomputeProductStats(tx, { workspaceId, productIds, liveOnly: true });
}

/**
 * Insert step n: one row per party, a line-level one pointing at the line item
 * of this apply with its `line_no`. Duplicates by the table's identity
 * are skipped. Returns how many rows were inserted.
 */
export async function writeParties(
  tx: Executor,
  p: { workspaceId: string; transactionId: string; parties: readonly DraftParty[]; items: readonly WrittenItem[] },
): Promise<number> {
  if (p.parties.length === 0) return 0;
  const byLine = new Map(p.items.map((i) => [i.line_no, i.id]));
  let inserted = 0;
  for (const party of p.parties) {
    const itemId = party.lineNo === null ? null : (byLine.get(party.lineNo) ?? null);
    if (party.lineNo !== null && itemId === null) {
      // The validator drops a party whose line_no names no item; a line
      // the items insert did not return is a writer fault, not the model's.
      throw new Error(`apply: party line_no ${party.lineNo} has no line item in this run`);
    }
    const res = await tx.execute(sql`
      INSERT INTO transaction_parties (workspace_id, transaction_id, transaction_item_id, role, display_name, brand_id)
      VALUES (${p.workspaceId}::uuid, ${p.transactionId}::uuid, ${itemId}::uuid, ${party.role}, ${party.displayName}, ${party.brandId})
      ON CONFLICT ON CONSTRAINT transaction_parties_identity_uq DO NOTHING
      RETURNING id`);
    inserted += res.rows.length;
  }
  return inserted;
}
