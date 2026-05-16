/**
 * `GET /v1/items` — line-item listing for admin / aggregation.
 *
 * Lives at the top level (not nested under `/v1/transactions/:id/items`)
 * because the use case is "show me every durable I bought in 2026",
 * not "show me what's on this one receipt". Use the transaction
 * endpoint (`GET /v1/transactions/:id`) for the latter — items are
 * already embedded in that response.
 *
 * Filters mirror the index in migration 0015:
 *   (workspace_id, item_class, created_at DESC) — fast for "give me
 *   every durable, newest first" without a sequential scan.
 *
 * Pagination uses the same keyset pattern as transactions; cursor
 * encodes `(created_at, id)`.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { parseOrThrow } from "../http/validate.js";
import { paginated, ProblemDetails } from "../schemas/v1/common.js";
import { TransactionItem } from "../schemas/v1/transaction.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
} from "../http/pagination.js";
import { emitNextLink } from "../http/pagination.js";

export const itemsRouter: Router = Router();

const ItemClassEnum = z.enum([
  "durable",
  "consumable",
  "food_drink",
  "service",
  "other",
]);

const ListItemsQuery = z.object({
  class: ItemClassEnum.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  transaction_id: z.string().uuid().optional(),
  tag: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

interface ItemsCursor {
  created_at: string;
  id: string;
}

itemsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListItemsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<ItemsCursor>(query.cursor ?? undefined);

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`ti.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (query.class) conditions.push(sql`ti.item_class = ${query.class}`);
      if (query.transaction_id) {
        conditions.push(sql`ti.transaction_id = ${query.transaction_id}::uuid`);
      }
      if (query.tag) conditions.push(sql`${query.tag} = ANY(ti.tags)`);
      if (query.from) {
        conditions.push(
          sql`ti.created_at >= (${query.from}::date)::timestamptz`,
        );
      }
      if (query.to) {
        conditions.push(
          sql`ti.created_at < ((${query.to}::date) + INTERVAL '1 day')::timestamptz`,
        );
      }
      if (cursor) {
        conditions.push(
          sql`(ti.created_at, ti.id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`SELECT * FROM transaction_items ti WHERE ${where} ORDER BY ti.created_at DESC, ti.id DESC LIMIT ${limit + 1}`,
      );
      const rows = rowsRes.rows as any[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map((r) => ({
        line_no: Number(r.line_no),
        raw_name: r.raw_name,
        normalized_name: r.normalized_name ?? null,
        quantity: r.quantity === null ? null : Number(r.quantity),
        unit: r.unit ?? null,
        unit_price_minor:
          r.unit_price_minor === null ? null : Number(r.unit_price_minor),
        line_total_minor: Number(r.line_total_minor),
        currency: r.currency,
        item_class: r.item_class,
        durability_tier: r.durability_tier ?? null,
        food_kind: r.food_kind ?? null,
        tags: Array.isArray(r.tags) ? r.tags : null,
        confidence: r.confidence,
        // Extras only on the listing endpoint — handy for admin
        // aggregation views without round-tripping to /transactions/:id.
        id: r.id,
        transaction_id: r.transaction_id,
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
      }));

      const nextCursor = hasMore
        ? encodeCursor({
            created_at:
              page[page.length - 1]!.created_at instanceof Date
                ? page[page.length - 1]!.created_at.toISOString()
                : String(page[page.length - 1]!.created_at),
            id: page[page.length - 1]!.id,
          })
        : null;

      emitNextLink(req, res, nextCursor);
      res.json({ items, next_cursor: nextCursor });
    } catch (err) {
      next(err);
    }
  },
);

export function registerItemsOpenApi(registry: OpenAPIRegistry): void {
  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  // Listing item shape: TransactionItem plus row-level fields useful
  // for cross-receipt aggregation.
  const ListedItem = TransactionItem.extend({
    id: z.string().uuid(),
    transaction_id: z.string().uuid(),
    created_at: z.string(),
  }).openapi("ListedTransactionItem");
  registry.register("ListedTransactionItem", ListedItem);

  registry.registerPath({
    method: "get",
    path: "/v1/items",
    summary: "List transaction items (admin / aggregation)",
    tags: ["items"],
    request: { query: ListItemsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(ListedItem) } },
      },
      400: { description: "Bad request", content: problemContent },
    },
  });
}
