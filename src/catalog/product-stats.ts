/**
 * Product aggregate stats (`purchase_count`, `total_spent_minor`,
 * `first_purchased_on`, `last_purchased_on`): the one server-side
 * recompute.
 *
 * The stats are recomputed from line items, never incremented (#84).
 * Before this module the products route held two copies of the same SQL
 * (the recompute endpoint, and the merge handler, which could not call
 * the first because it ran on `db` outside the merge's transaction).
 * Both now call this, on whatever runner they hold, and the server
 * applier will too. The third writer is the agent's ingest and
 * re-extract SQL (`productAggregateRecompute` in src/ingest/items-sql.ts),
 * which is prompt text and stays as it is.
 *
 * What counts: live (`retired_at IS NULL`) `line_type = 'product'` rows
 * of the product, in the workspace. Money is `effective_total_minor`, the
 * native line amount: see CLAUDE.md "Money", this is not a base-currency
 * sum.
 *
 * `liveOnly` decides whether line items under a transaction that is not
 * live (soft-deleted, draft, error) count. The products route and the
 * agent's SQL count them (`liveOnly: false`): nothing retires a deleted
 * transaction's items, and the three writers have to agree while the
 * agent still writes. The server applier passes `true` (wave 1 plan,
 * X12). It is a required argument so every caller says which it means.
 *
 * Unlike the agent's SQL, a product with no counted line left is reset to
 * zero and NULL dates instead of keeping its old numbers.
 */
import { sql } from "drizzle-orm";
import type { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";

export interface ProductStats {
  product_id: string;
  purchase_count: number;
  total_spent_minor: number;
  /** `YYYY-MM-DD`, or NULL when nothing counted. */
  first_purchased_on: string | null;
  last_purchased_on: string | null;
}

/**
 * Recompute and store the stats of `productIds` (the ones in
 * `workspaceId`; others are ignored), returning the stored values.
 * Writes nothing for an empty list.
 */
export async function recomputeProductStats(
  runner: Pick<typeof db, "execute">,
  params: {
    workspaceId: string;
    productIds: readonly string[];
    liveOnly: boolean;
  },
): Promise<ProductStats[]> {
  const { workspaceId, productIds, liveOnly } = params;
  if (productIds.length === 0) return [];
  const parents = liveOnly ? liveTransactions : sql.raw("transactions");
  const res = await runner.execute(sql`
    WITH target AS (
      SELECT p.id
        FROM products p
       WHERE p.workspace_id = ${workspaceId}::uuid
         AND p.id IN (${sql.join(
           [...new Set(productIds)].map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
    ),
    stats AS (
      SELECT ti.product_id,
             MIN(t.occurred_on)                AS first_on,
             MAX(t.occurred_on)                AS last_on,
             COUNT(DISTINCT ti.transaction_id) AS purchases,
             SUM(ti.effective_total_minor)     AS total_minor
        FROM transaction_items ti
        JOIN ${parents} t ON t.id = ti.transaction_id
       WHERE ti.workspace_id = ${workspaceId}::uuid
         AND ti.product_id IN (SELECT id FROM target)
         AND ti.retired_at IS NULL
         AND ti.line_type = 'product'
       GROUP BY ti.product_id
    )
    UPDATE products p SET
      first_purchased_on = s.first_on,
      last_purchased_on  = s.last_on,
      purchase_count     = COALESCE(s.purchases, 0),
      total_spent_minor  = COALESCE(s.total_minor, 0),
      updated_at         = NOW()
      FROM target
      LEFT JOIN stats s ON s.product_id = target.id
     WHERE p.id = target.id
    RETURNING p.id AS product_id,
              p.purchase_count,
              p.total_spent_minor,
              p.first_purchased_on::text AS first_purchased_on,
              p.last_purchased_on::text  AS last_purchased_on
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    product_id: String(r.product_id),
    purchase_count: Number(r.purchase_count ?? 0),
    total_spent_minor: Number(r.total_spent_minor ?? 0),
    first_purchased_on: (r.first_purchased_on as string | null) ?? null,
    last_purchased_on: (r.last_purchased_on as string | null) ?? null,
  }));
}
