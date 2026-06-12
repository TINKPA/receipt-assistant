/**
 * `/v1/wish-items` — wishlist CRUD (v2 redesign P3, tracking #149).
 *
 * The mirror of owned-items, run forward: target price + planned days
 * project a $/day before purchase. Lifecycle via PATCH `status`:
 * active → converted (optionally carrying the realizing transaction)
 * | declined; snoozing is a date, not a status, so a parked wish keeps
 * its urgency.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishItems, products } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  WishItem,
  CreateWishItemRequest,
  UpdateWishItemRequest,
  ListWishItemsQuery,
} from "../schemas/v1/wish-item.js";
import { ProblemDetails, paginated, Uuid } from "../schemas/v1/common.js";
import { HttpProblem, NotFoundProblem, ValidationProblem } from "../http/problem.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  emitNextLink,
} from "../http/pagination.js";

export const wishItemsRouter: Router = Router();

// `application/merge-patch+json` (RFC 7396) — see owned-items.ts for why.
wishItemsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "1mb" }),
);

interface WishItemsCursor {
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
    product_id: row.productId ?? row.product_id ?? null,
    title: row.title,
    notes: row.notes ?? null,
    target_price_minor:
      (row.targetPriceMinor ?? row.target_price_minor) === null ||
      (row.targetPriceMinor ?? row.target_price_minor) === undefined
        ? null
        : Number(row.targetPriceMinor ?? row.target_price_minor),
    currency: row.currency ?? "USD",
    planned_days:
      (row.plannedDays ?? row.planned_days) === null ||
      (row.plannedDays ?? row.planned_days) === undefined
        ? null
        : Number(row.plannedDays ?? row.planned_days),
    urgency: row.urgency ?? "someday",
    snoozed_until: toIsoDateOrNull(row.snoozedUntil ?? row.snoozed_until),
    status: row.status ?? "active",
    converted_transaction_id:
      row.convertedTransactionId ?? row.converted_transaction_id ?? null,
    metadata: row.metadata ?? {},
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

// ── GET /v1/wish-items ─────────────────────────────────────────────────

wishItemsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListWishItemsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<WishItemsCursor>(query.cursor ?? undefined);

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`w.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (query.status) conditions.push(sql`w.status = ${query.status}`);
      if (query.urgency) conditions.push(sql`w.urgency = ${query.urgency}`);
      if (cursor) {
        conditions.push(
          sql`(w.updated_at, w.id) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`SELECT * FROM wish_items w WHERE ${where} ORDER BY w.updated_at DESC, w.id DESC LIMIT ${limit + 1}`,
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

// ── GET /v1/wish-items/:id ─────────────────────────────────────────────

wishItemsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const rows = await db
        .select()
        .from(wishItems)
        .where(
          and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("WishItem", id);
      res.json(rowToDto(rows[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/wish-items ────────────────────────────────────────────────

wishItemsRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOrThrow(CreateWishItemRequest, req.body);
      if (body.product_id) {
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
          throw new ValidationProblem([
            {
              path: "product_id",
              code: "not_found",
              message: `Product ${body.product_id} not in workspace`,
            },
          ]);
        }
      }
      const inserted = await db
        .insert(wishItems)
        .values({
          workspaceId: req.ctx.workspaceId,
          productId: body.product_id ?? null,
          title: body.title,
          notes: body.notes ?? null,
          targetPriceMinor: body.target_price_minor ?? null,
          currency: body.currency ?? "USD",
          plannedDays: body.planned_days ?? null,
          urgency: body.urgency ?? "someday",
          snoozedUntil: body.snoozed_until ?? null,
          metadata: body.metadata ?? {},
        })
        .returning();
      res.status(201).json(rowToDto(inserted[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/wish-items/:id ───────────────────────────────────────────

wishItemsRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const body = parseOrThrow(UpdateWishItemRequest, req.body);
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates["title"] = body.title;
      if (body.product_id !== undefined) updates["productId"] = body.product_id;
      if (body.notes !== undefined) updates["notes"] = body.notes;
      if (body.target_price_minor !== undefined)
        updates["targetPriceMinor"] = body.target_price_minor;
      if (body.planned_days !== undefined) updates["plannedDays"] = body.planned_days;
      if (body.urgency !== undefined) updates["urgency"] = body.urgency;
      if (body.snoozed_until !== undefined) updates["snoozedUntil"] = body.snoozed_until;
      if (body.status !== undefined) updates["status"] = body.status;
      if (body.converted_transaction_id !== undefined)
        updates["convertedTransactionId"] = body.converted_transaction_id;
      if (body.metadata !== undefined) updates["metadata"] = body.metadata;
      if (Object.keys(updates).length === 0) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/wish-items/:id needs at least one field to update.",
        );
      }
      updates["updatedAt"] = new Date();
      const updated = await db
        .update(wishItems)
        .set(updates)
        .where(
          and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)),
        )
        .returning();
      if (updated.length === 0) throw new NotFoundProblem("WishItem", id);
      res.json(rowToDto(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /v1/wish-items/:id ──────────────────────────────────────────

wishItemsRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const deleted = await db
        .delete(wishItems)
        .where(
          and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)),
        )
        .returning({ id: wishItems.id });
      if (deleted.length === 0) throw new NotFoundProblem("WishItem", id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerWishItemsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("WishItem", WishItem);
  registry.register("CreateWishItemRequest", CreateWishItemRequest);
  registry.register("UpdateWishItemRequest", UpdateWishItemRequest);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items",
    summary: "List wishlist items",
    tags: ["wish-items"],
    request: { query: ListWishItemsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(WishItem) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items/{id}",
    summary: "Fetch one wish",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WishItem } } },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wish-items",
    summary: "Add a wish",
    tags: ["wish-items"],
    request: {
      body: { content: { "application/json": { schema: CreateWishItemRequest } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: WishItem } } },
      422: { description: "Validation failed", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/wish-items/{id}",
    summary: "Patch a wish (fields, urgency, snooze, convert / decline)",
    tags: ["wish-items"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateWishItemRequest },
          "application/json": { schema: UpdateWishItemRequest },
        },
      },
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WishItem } } },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/wish-items/{id}",
    summary: "Hard-delete a wish",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
