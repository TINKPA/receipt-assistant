/**
 * `/v1/owned-items` — physical-inventory CRUD.
 *
 * Auto-creation happens inside the ingest prompt (Phase 4a-bis); this
 * router is the user-facing CRUD surface: list (paginated, location-
 * filterable), create (for gifts / secondhand / "I just remembered"),
 * patch (fill in serial / location / warranty / condition / notes),
 * retire (sold / broken / given away).
 *
 * No special hooks back to `products` aggregates — owned_items doesn't
 * affect spend stats, just inventory.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql, eq, and, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { ownedItems, products } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  OwnedItem,
  CreateOwnedItemRequest,
  UpdateOwnedItemRequest,
  ListOwnedItemsQuery,
} from "../schemas/v1/owned-item.js";
import { ProblemDetails, paginated, Uuid } from "../schemas/v1/common.js";
import {
  HttpProblem,
  NotFoundProblem,
  ValidationProblem,
} from "../http/problem.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  emitNextLink,
} from "../http/pagination.js";

export const ownedItemsRouter: Router = Router();

// `application/merge-patch+json` (RFC 7396) — the app-level
// `express.json()` only handles `application/json`. Without this,
// PATCH bodies arrive empty and zod fails validation with
// "Required" on the root object.
ownedItemsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "1mb" }),
);

interface OwnedItemsCursor {
  updated_at: string;
  id: string;
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toIsoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  return String(v);
}

function rowToDto(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspaceId ?? row.workspace_id,
    product_id: row.productId ?? row.product_id,
    transaction_item_id:
      row.transactionItemId ?? row.transaction_item_id ?? null,
    instance_index: Number(row.instanceIndex ?? row.instance_index ?? 1),
    serial_number: row.serialNumber ?? row.serial_number ?? null,
    location: row.location ?? null,
    acquired_on: toIsoDateOrNull(row.acquiredOn ?? row.acquired_on),
    warranty_until: toIsoDateOrNull(row.warrantyUntil ?? row.warranty_until),
    condition: row.condition ?? null,
    retired_at:
      (row.retiredAt ?? row.retired_at) === null ||
      (row.retiredAt ?? row.retired_at) === undefined
        ? null
        : toIsoString(row.retiredAt ?? row.retired_at),
    notes: row.notes ?? null,
    metadata: row.metadata ?? {},
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

// ── GET /v1/owned-items ────────────────────────────────────────────────

ownedItemsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListOwnedItemsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<OwnedItemsCursor>(
        query.cursor ?? undefined,
      );

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`o.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (!query.include_retired) {
        conditions.push(sql`o.retired_at IS NULL`);
      }
      if (query.product_id) {
        conditions.push(sql`o.product_id = ${query.product_id}::uuid`);
      }
      if (query.location) {
        conditions.push(sql`o.location = ${query.location}`);
      }
      if (cursor) {
        conditions.push(
          sql`(o.updated_at, o.id) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`SELECT * FROM owned_items o WHERE ${where} ORDER BY o.updated_at DESC, o.id DESC LIMIT ${limit + 1}`,
      );
      const rows = rowsRes.rows as any[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map(rowToDto);
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

// ── GET /v1/owned-items/:id ────────────────────────────────────────────

ownedItemsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const rows = await db
        .select()
        .from(ownedItems)
        .where(
          and(
            eq(ownedItems.id, id),
            eq(ownedItems.workspaceId, req.ctx.workspaceId),
          ),
        );
      if (rows.length === 0) throw new NotFoundProblem("OwnedItem", id);
      res.json(rowToDto(rows[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/owned-items ───────────────────────────────────────────────

ownedItemsRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOrThrow(CreateOwnedItemRequest, req.body);
      // Validate product is in the workspace.
      const prodRows = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, body.product_id),
            eq(products.workspaceId, req.ctx.workspaceId),
          ),
        );
      if (prodRows.length === 0) {
        throw new ValidationProblem(
          [
            {
              path: "product_id",
              code: "not_found",
              message: `Product ${body.product_id} not in workspace`,
            },
          ],
        );
      }
      const inserted = await db
        .insert(ownedItems)
        .values({
          workspaceId: req.ctx.workspaceId,
          productId: body.product_id,
          transactionItemId: body.transaction_item_id ?? null,
          instanceIndex: body.instance_index ?? 1,
          serialNumber: body.serial_number ?? null,
          location: body.location ?? null,
          acquiredOn: body.acquired_on ?? null,
          warrantyUntil: body.warranty_until ?? null,
          condition: body.condition ?? null,
          notes: body.notes ?? null,
          metadata: body.metadata ?? {},
        })
        .returning();
      res.status(201).json(rowToDto(inserted[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/owned-items/:id ──────────────────────────────────────────

ownedItemsRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const body = parseOrThrow(UpdateOwnedItemRequest, req.body);
      const updates: Record<string, unknown> = {};
      if (body.serial_number !== undefined) updates["serialNumber"] = body.serial_number;
      if (body.location !== undefined) updates["location"] = body.location;
      if (body.acquired_on !== undefined) updates["acquiredOn"] = body.acquired_on;
      if (body.warranty_until !== undefined) updates["warrantyUntil"] = body.warranty_until;
      if (body.condition !== undefined) updates["condition"] = body.condition;
      if (body.notes !== undefined) updates["notes"] = body.notes;
      if (body.metadata !== undefined) updates["metadata"] = body.metadata;
      if (body.retired_at !== undefined) {
        updates["retiredAt"] = body.retired_at ? new Date(body.retired_at) : null;
      }
      if (Object.keys(updates).length === 0) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/owned-items/:id needs at least one field to update.",
        );
      }
      updates["updatedAt"] = new Date();
      const updated = await db
        .update(ownedItems)
        .set(updates)
        .where(
          and(
            eq(ownedItems.id, id),
            eq(ownedItems.workspaceId, req.ctx.workspaceId),
          ),
        )
        .returning();
      if (updated.length === 0) throw new NotFoundProblem("OwnedItem", id);
      res.json(rowToDto(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /v1/owned-items/:id ─────────────────────────────────────────

ownedItemsRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const deleted = await db
        .delete(ownedItems)
        .where(
          and(
            eq(ownedItems.id, id),
            eq(ownedItems.workspaceId, req.ctx.workspaceId),
          ),
        )
        .returning({ id: ownedItems.id });
      if (deleted.length === 0) throw new NotFoundProblem("OwnedItem", id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerOwnedItemsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("OwnedItem", OwnedItem);
  registry.register("CreateOwnedItemRequest", CreateOwnedItemRequest);
  registry.register("UpdateOwnedItemRequest", UpdateOwnedItemRequest);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/owned-items",
    summary: "List owned physical-instance items",
    tags: ["owned-items"],
    request: { query: ListOwnedItemsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(OwnedItem) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/owned-items/{id}",
    summary: "Fetch one owned item",
    tags: ["owned-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: OwnedItem } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/owned-items",
    summary: "Manually add an owned item (gift / secondhand / inherited)",
    tags: ["owned-items"],
    request: {
      body: {
        content: {
          "application/json": { schema: CreateOwnedItemRequest },
        },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: OwnedItem } },
      },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/owned-items/{id}",
    summary: "Patch serial / location / warranty / condition / notes",
    tags: ["owned-items"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateOwnedItemRequest },
          "application/json": { schema: UpdateOwnedItemRequest },
        },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: OwnedItem } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/owned-items/{id}",
    summary: "Hard-delete an owned item (typically used by undo of manual create)",
    tags: ["owned-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
