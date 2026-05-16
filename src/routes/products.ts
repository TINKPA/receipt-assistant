/**
 * `/v1/products` — catalog browse + edit.
 *
 * The catalog is the canonical "what is this thing" registry; ingest
 * writes rows here via `ON CONFLICT (workspace_id, merchant_id,
 * product_key) DO UPDATE` and re-points `transaction_items.product_id`
 * at the surviving row. This router only exposes read + user-truth
 * edits. The merge endpoint and admin recompute land in #84 Phase 3.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { products } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Product,
  UpdateProductRequest,
  ListProductsQuery,
} from "../schemas/v1/product.js";
import { ProblemDetails, paginated, Uuid } from "../schemas/v1/common.js";
import {
  HttpProblem,
  NotFoundProblem,
} from "../http/problem.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  emitNextLink,
} from "../http/pagination.js";

export const productsRouter: Router = Router();

// `application/merge-patch+json` body parser — see owned-items.ts.
productsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "1mb" }),
);

interface ProductsCursor {
  updated_at: string;
  id: string;
}

function rowToProductDto(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspaceId ?? row.workspace_id,
    product_key: row.productKey ?? row.product_key,
    canonical_name: row.canonicalName ?? row.canonical_name,
    merchant_id: row.merchantId ?? row.merchant_id ?? null,
    brand_id: row.brandId ?? row.brand_id ?? null,
    item_class: row.itemClass ?? row.item_class,
    model: row.model ?? null,
    color: row.color ?? null,
    size: row.size ?? null,
    variant: row.variant ?? null,
    sku: row.sku ?? null,
    manufacturer: row.manufacturer ?? null,
    first_purchased_on:
      (row.firstPurchasedOn ?? row.first_purchased_on) === null ||
      (row.firstPurchasedOn ?? row.first_purchased_on) === undefined
        ? null
        : toIsoDate(row.firstPurchasedOn ?? row.first_purchased_on),
    last_purchased_on:
      (row.lastPurchasedOn ?? row.last_purchased_on) === null ||
      (row.lastPurchasedOn ?? row.last_purchased_on) === undefined
        ? null
        : toIsoDate(row.lastPurchasedOn ?? row.last_purchased_on),
    purchase_count: Number(row.purchaseCount ?? row.purchase_count ?? 0),
    total_spent_minor: Number(row.totalSpentMinor ?? row.total_spent_minor ?? 0),
    custom_name: row.customName ?? row.custom_name ?? null,
    notes: row.notes ?? null,
    retired_from_catalog_at:
      (row.retiredFromCatalogAt ?? row.retired_from_catalog_at) === null ||
      (row.retiredFromCatalogAt ?? row.retired_from_catalog_at) === undefined
        ? null
        : toIsoString(row.retiredFromCatalogAt ?? row.retired_from_catalog_at),
    metadata: row.metadata ?? {},
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  return String(v);
}

// ── GET /v1/products ───────────────────────────────────────────────────

productsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListProductsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<ProductsCursor>(query.cursor ?? undefined);

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`p.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (!query.include_retired) {
        conditions.push(sql`p.retired_from_catalog_at IS NULL`);
      }
      if (query.class) conditions.push(sql`p.item_class = ${query.class}`);
      if (query.brand_id) conditions.push(sql`p.brand_id = ${query.brand_id}`);
      if (query.merchant_id) {
        conditions.push(sql`p.merchant_id = ${query.merchant_id}::uuid`);
      }
      if (query.q) {
        const needle = `%${query.q}%`;
        conditions.push(
          sql`(p.canonical_name ILIKE ${needle} OR COALESCE(p.custom_name, '') ILIKE ${needle} OR p.product_key ILIKE ${needle})`,
        );
      }
      if (cursor) {
        conditions.push(
          sql`(p.updated_at, p.id) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`SELECT * FROM products p WHERE ${where} ORDER BY p.updated_at DESC, p.id DESC LIMIT ${limit + 1}`,
      );
      const rows = rowsRes.rows as any[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map(rowToProductDto);
      const nextCursor = hasMore
        ? encodeCursor({
            updated_at: toIsoString(page[page.length - 1]!.updated_at),
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

// ── GET /v1/products/:id ───────────────────────────────────────────────

productsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const rows = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.id, id),
            eq(products.workspaceId, req.ctx.workspaceId),
          ),
        );
      if (rows.length === 0) throw new NotFoundProblem("Product", id);
      res.json(rowToProductDto(rows[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/products/:id ─────────────────────────────────────────────

productsRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const body = parseOrThrow(UpdateProductRequest, req.body);
      const updates: Record<string, unknown> = {};
      if (body.custom_name !== undefined) updates["customName"] = body.custom_name;
      if (body.notes !== undefined) updates["notes"] = body.notes;
      if (body.brand_id !== undefined) updates["brandId"] = body.brand_id;
      if (body.merchant_id !== undefined) updates["merchantId"] = body.merchant_id;
      if (body.retired_from_catalog_at !== undefined) {
        updates["retiredFromCatalogAt"] = body.retired_from_catalog_at
          ? new Date(body.retired_from_catalog_at)
          : null;
      }
      if (Object.keys(updates).length === 0) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/products/:id needs at least one field to update.",
        );
      }
      updates["updatedAt"] = new Date();
      const updated = await db
        .update(products)
        .set(updates)
        .where(
          and(
            eq(products.id, id),
            eq(products.workspaceId, req.ctx.workspaceId),
          ),
        )
        .returning();
      if (updated.length === 0) throw new NotFoundProblem("Product", id);
      res.json(rowToProductDto(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerProductsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Product", Product);
  registry.register("UpdateProductRequest", UpdateProductRequest);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/products",
    summary: "List products in the workspace catalog",
    tags: ["products"],
    request: { query: ListProductsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(Product) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/products/{id}",
    summary: "Fetch a single product",
    tags: ["products"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: Product } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/products/{id}",
    summary: "Patch product user-truth fields",
    tags: ["products"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateProductRequest },
          "application/json": { schema: UpdateProductRequest },
        },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: Product } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
