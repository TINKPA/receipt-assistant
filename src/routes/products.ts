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
import {
  products,
  transactionItems,
  ownedItems,
  derivationEvents,
} from "../schema/index.js";
import { buildInfo } from "../generated/build-info.js";
import { PROMPT_VERSION } from "../ingest/prompt.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Product,
  UpdateProductRequest,
  ListProductsQuery,
  MergeProductRequest,
  MergeProductResponse,
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

// ── POST /v1/products/:id/merge_into ───────────────────────────────────

/**
 * Recompute aggregate stats for one product from its live
 * transaction_items set. Used by merge_into and the admin endpoint.
 * Returns `purchase_count` etc. so callers can echo the new state.
 */
async function recomputeProductStats(
  workspaceId: string,
  productId: string,
): Promise<{
  purchase_count: number;
  total_spent_minor: number;
  first_purchased_on: string | null;
  last_purchased_on: string | null;
}> {
  const res = await db.execute(
    sql`
      WITH stats AS (
        SELECT
          MIN(t.occurred_on) AS first_on,
          MAX(t.occurred_on) AS last_on,
          COUNT(DISTINCT ti.transaction_id) AS purchases,
          COALESCE(SUM(ti.effective_total_minor), 0) AS total_minor
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        WHERE ti.product_id = ${productId}::uuid
          AND ti.workspace_id = ${workspaceId}::uuid
          AND ti.retired_at IS NULL
          AND ti.line_type = 'product'
      )
      UPDATE products p SET
        first_purchased_on = stats.first_on,
        last_purchased_on  = stats.last_on,
        purchase_count     = COALESCE(stats.purchases, 0),
        total_spent_minor  = stats.total_minor,
        updated_at         = NOW()
      FROM stats
      WHERE p.id = ${productId}::uuid
        AND p.workspace_id = ${workspaceId}::uuid
      RETURNING
        p.purchase_count,
        p.total_spent_minor,
        p.first_purchased_on,
        p.last_purchased_on
    `,
  );
  const r = res.rows[0] as any;
  return {
    purchase_count: Number(r?.purchase_count ?? 0),
    total_spent_minor: Number(r?.total_spent_minor ?? 0),
    first_purchased_on: r?.first_purchased_on
      ? toIsoDate(r.first_purchased_on)
      : null,
    last_purchased_on: r?.last_purchased_on
      ? toIsoDate(r.last_purchased_on)
      : null,
  };
}

productsRouter.post(
  "/:id/merge_into",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sourceId = String(req.params.id);
      const body = MergeProductRequest.parse(req.body);
      if (sourceId === body.target_id) {
        throw new HttpProblem(
          400,
          "self-merge",
          "Cannot merge a product into itself",
          "POST /v1/products/:id/merge_into requires target_id != source id.",
        );
      }

      const result = await db.transaction(async (tx) => {
        // Load both rows (workspace-scoped).
        const both = await tx
          .select()
          .from(products)
          .where(
            and(
              eq(products.workspaceId, req.ctx.workspaceId),
              sql`${products.id} IN (${sql.raw(`'${sourceId}', '${body.target_id}'`)})`,
            ),
          );
        const source = both.find((r) => r.id === sourceId);
        const target = both.find((r) => r.id === body.target_id);
        if (!source) throw new NotFoundProblem("Product", sourceId);
        if (!target) {
          throw new NotFoundProblem("Product", body.target_id);
        }
        if (source.retiredFromCatalogAt) {
          throw new HttpProblem(
            409,
            "already-retired",
            "Source product is already retired",
            `Product ${sourceId} was retired at ${source.retiredFromCatalogAt.toISOString()}; cannot re-merge.`,
          );
        }

        // Snapshot before for the audit event.
        const beforeSnap = {
          source: {
            id: source.id,
            product_key: source.productKey,
            canonical_name: source.canonicalName,
            purchase_count: Number(source.purchaseCount),
            total_spent_minor: Number(source.totalSpentMinor),
            retired_from_catalog_at: source.retiredFromCatalogAt,
          },
          target: {
            id: target.id,
            product_key: target.productKey,
            canonical_name: target.canonicalName,
            purchase_count: Number(target.purchaseCount),
            total_spent_minor: Number(target.totalSpentMinor),
          },
        };

        // Re-point transaction_items.
        const tiMoved = await tx
          .update(transactionItems)
          .set({ productId: body.target_id })
          .where(
            and(
              eq(transactionItems.productId, sourceId),
              eq(transactionItems.workspaceId, req.ctx.workspaceId),
            ),
          )
          .returning({ id: transactionItems.id });

        // Re-point owned_items.
        const oiMoved = await tx
          .update(ownedItems)
          .set({ productId: body.target_id })
          .where(
            and(
              eq(ownedItems.productId, sourceId),
              eq(ownedItems.workspaceId, req.ctx.workspaceId),
            ),
          )
          .returning({ id: ownedItems.id });

        // Retire source. Also push the source's product_key into
        // target's metadata.aliases so a future agent canonicalization
        // pass can collapse the old key to the new id without human
        // input.
        await tx
          .update(products)
          .set({
            retiredFromCatalogAt: new Date(),
            updatedAt: new Date(),
            purchaseCount: 0,
            totalSpentMinor: 0,
          })
          .where(eq(products.id, sourceId));

        await tx.execute(
          sql`UPDATE products SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{aliases}',
                COALESCE(metadata->'aliases', '[]'::jsonb) || ${JSON.stringify([source.productKey])}::jsonb
              )
              WHERE id = ${body.target_id}::uuid`,
        );

        // No `recomputeProductStats` call inside this txn — it uses
        // db.execute directly which would deadlock against the same
        // transaction. Compute via raw sql inline:
        await tx.execute(
          sql`
            WITH stats AS (
              SELECT
                MIN(t.occurred_on) AS first_on,
                MAX(t.occurred_on) AS last_on,
                COUNT(DISTINCT ti.transaction_id) AS purchases,
                COALESCE(SUM(ti.effective_total_minor), 0) AS total_minor
              FROM transaction_items ti
              JOIN transactions t ON t.id = ti.transaction_id
              WHERE ti.product_id = ${body.target_id}::uuid
                AND ti.workspace_id = ${req.ctx.workspaceId}::uuid
                AND ti.retired_at IS NULL
                AND ti.line_type = 'product'
            )
            UPDATE products p SET
              first_purchased_on = stats.first_on,
              last_purchased_on  = stats.last_on,
              purchase_count     = COALESCE(stats.purchases, 0),
              total_spent_minor  = stats.total_minor,
              updated_at         = NOW()
            FROM stats
            WHERE p.id = ${body.target_id}::uuid
          `,
        );

        // Re-read target for the audit snapshot.
        const [refreshedTarget] = await tx
          .select()
          .from(products)
          .where(eq(products.id, body.target_id));

        const afterSnap = {
          source: {
            id: sourceId,
            retired_from_catalog_at: new Date(),
          },
          target: {
            id: body.target_id,
            purchase_count: Number(refreshedTarget!.purchaseCount),
            total_spent_minor: Number(refreshedTarget!.totalSpentMinor),
          },
        };

        const [evt] = await tx
          .insert(derivationEvents)
          .values({
            workspaceId: req.ctx.workspaceId,
            entityType: "product",
            entityId: body.target_id,
            promptVersion: PROMPT_VERSION,
            promptGitSha: buildInfo.gitSha,
            model: "ts-deterministic",
            before: beforeSnap,
            after: afterSnap,
            changedKeys: ["merged_in", "purchase_count", "total_spent_minor"],
          })
          .returning({ id: derivationEvents.id });

        return {
          source_id: sourceId,
          target_id: body.target_id,
          moved_transaction_items: tiMoved.length,
          moved_owned_items: oiMoved.length,
          derivation_event_id: evt!.id,
        };
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/products/:id/recompute ────────────────────────────────────
//
// Idempotent: recomputes one product's aggregates from the live
// transaction_items set. Useful after a manual data fix or if you
// suspect drift. Returns the new stats.

productsRouter.post(
  "/:id/recompute",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const exists = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, id),
            eq(products.workspaceId, req.ctx.workspaceId),
          ),
        );
      if (exists.length === 0) throw new NotFoundProblem("Product", id);
      const stats = await recomputeProductStats(req.ctx.workspaceId, id);
      res.json({ id, ...stats });
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerProductsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Product", Product);
  registry.register("UpdateProductRequest", UpdateProductRequest);
  registry.register("MergeProductRequest", MergeProductRequest);
  registry.register("MergeProductResponse", MergeProductResponse);

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

  registry.registerPath({
    method: "post",
    path: "/v1/products/{id}/merge_into",
    summary: "Merge this product into the target — re-points transaction_items + owned_items, retires source",
    tags: ["products"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        content: { "application/json": { schema: MergeProductRequest } },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: MergeProductResponse } },
      },
      400: { description: "Bad request (e.g. self-merge)", content: problemContent },
      404: { description: "Source or target not found", content: problemContent },
      409: { description: "Source already retired", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/products/{id}/recompute",
    summary: "Recompute aggregate stats from the live transaction_items set",
    tags: ["products"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              id: Uuid,
              purchase_count: z.number().int(),
              total_spent_minor: z.number().int(),
              first_purchased_on: z.string().nullable(),
              last_purchased_on: z.string().nullable(),
            }),
          },
        },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
