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
import multer from "multer";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishItems, products, places } from "../schema/index.js";
import { startCapture, retryCapture, wishImageRoot } from "../wish/capture.js";
import { resolveStoredFile, sendStoredFile, setStoredImageHeaders, storedImageEtag } from "../http/files.js";
import { metadataPatchSet } from "../projection/metadata-patch.js";
import { parseOrThrow } from "../http/validate.js";
import {
  WishItem,
  CreateWishItemRequest,
  UpdateWishItemRequest,
  ListWishItemsQuery,
  CaptureWishForm,
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

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** `SELECT … FROM wish_items w` with the matched place beside it. Every
 *  read goes through this so a row looks the same from every route. */
const WISH_SELECT = sql`
  SELECT w.*,
         pl.google_place_id AS pl_google_place_id,
         coalesce(pl.custom_name, pl.display_name_en) AS pl_name,
         pl.display_name_zh AS pl_name_zh,
         coalesce(pl.formatted_address_en, pl.formatted_address) AS pl_formatted_address,
         pl.lat AS pl_lat, pl.lng AS pl_lng,
         pl.google_maps_uri AS pl_google_maps_uri,
         pl.primary_type AS pl_primary_type,
         pl.rating AS pl_rating,
         comp.locality AS pl_locality,
         comp.neighborhood AS pl_neighborhood
    FROM wish_items w
    LEFT JOIN places pl ON pl.id = w.place_id
    LEFT JOIN LATERAL (
      SELECT max(c->>'longText') FILTER (WHERE c->'types' ? 'locality') AS locality,
             max(c->>'longText') FILTER (WHERE c->'types' ? 'neighborhood' OR c->'types' ? 'sublocality_level_1') AS neighborhood
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(pl.raw_response->'v1'->'en'->'addressComponents') = 'array'
                    THEN pl.raw_response->'v1'->'en'->'addressComponents' ELSE '[]'::jsonb END) c
    ) comp ON TRUE`;

async function loadWish(workspaceId: string, id: string) {
  const res = await db.execute(
    sql`${WISH_SELECT} WHERE w.id = ${id}::uuid AND w.workspace_id = ${workspaceId}::uuid`,
  );
  if (res.rows.length === 0) throw new NotFoundProblem("WishItem", id);
  return rowToDto(res.rows[0]);
}

function rowToDto(row: any) {
  const placeId = row.placeId ?? row.place_id ?? null;
  return {
    id: row.id,
    kind: row.kind ?? "thing",
    place_id: placeId,
    place:
      placeId && row.pl_google_place_id
        ? {
            id: placeId,
            google_place_id: row.pl_google_place_id,
            name: row.pl_name ?? null,
            name_zh: row.pl_name_zh ?? null,
            formatted_address: row.pl_formatted_address ?? null,
            locality: row.pl_locality ?? null,
            neighborhood: row.pl_neighborhood ?? null,
            lat: numOrNull(row.pl_lat),
            lng: numOrNull(row.pl_lng),
            google_maps_uri: row.pl_google_maps_uri ?? null,
            primary_type: row.pl_primary_type ?? null,
            rating: numOrNull(row.pl_rating),
          }
        : null,
    source_url: row.sourceUrl ?? row.source_url ?? null,
    has_image: Boolean(row.imagePath ?? row.image_path),
    capture_status: row.captureStatus ?? row.capture_status ?? null,
    capture: row.capture ?? null,
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

async function assertPlaceExists(placeId: string): Promise<void> {
  const rows = await db.select({ id: places.id }).from(places).where(eq(places.id, placeId));
  if (rows.length === 0) {
    throw new ValidationProblem([{ path: "place_id", code: "not_found", message: `Place ${placeId} does not exist` }]);
  }
}

// ── POST /v1/wish-items/capture ────────────────────────────────────────
//
// One image in, one wish out, at once: the row comes back with
// `capture_status: "reading"` and a placeholder title, and fills in when
// the reading ends (src/wish/capture.ts). Clients poll the row.

const captureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

wishItemsRouter.post(
  "/capture",
  captureUpload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new ValidationProblem([{ path: "file", code: "required", message: "Send one image in the multipart field `file`" }]);
      }
      const note = typeof req.body?.note === "string" && req.body.note.trim() !== "" ? req.body.note.trim().slice(0, 2000) : null;
      const id = await startCapture({ workspaceId: req.ctx.workspaceId, bytes: req.file.buffer, note });
      res.status(202).json(await loadWish(req.ctx.workspaceId, id));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/wish-items/:id/capture/retry ──────────────────────────────

wishItemsRouter.post(
  "/:id/capture/retry",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      await loadWish(req.ctx.workspaceId, id); // 404 before 409
      await retryCapture(req.ctx.workspaceId, id);
      res.status(202).json(await loadWish(req.ctx.workspaceId, id));
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/wish-items/:id/image ───────────────────────────────────────

wishItemsRouter.get(
  "/:id/image",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const rows = await db
        .select({ path: wishItems.imagePath, sha: wishItems.imageSha256, mime: wishItems.imageMimeType })
        .from(wishItems)
        .where(and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)));
      const abs = await resolveStoredFile(wishImageRoot(), rows[0]?.path);
      if (!abs || !rows[0]?.sha) throw new NotFoundProblem("WishItem image", id);
      const etag = storedImageEtag(rows[0].sha);
      setStoredImageHeaders(res, rows[0].mime);
      res.setHeader("ETag", etag);
      // The bytes behind a sha never change; private because it is the
      // person's own screenshot.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      await sendStoredFile(res, abs);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/wish-items ─────────────────────────────────────────────────

wishItemsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListWishItemsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<WishItemsCursor>(query.cursor ?? undefined, [
        "updated_at",
        "id",
      ]);

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`w.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (query.status) conditions.push(sql`w.status = ${query.status}`);
      if (query.urgency) conditions.push(sql`w.urgency = ${query.urgency}`);
      if (query.kind) conditions.push(sql`w.kind = ${query.kind}`);
      if (cursor) {
        conditions.push(
          sql`(w.updated_at, w.id) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`${WISH_SELECT} WHERE ${where} ORDER BY w.updated_at DESC, w.id DESC LIMIT ${limit + 1}`,
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
      res.json(await loadWish(req.ctx.workspaceId, String(req.params.id)));
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
      if (body.place_id) await assertPlaceExists(body.place_id);
      const inserted = await db
        .insert(wishItems)
        .values({
          workspaceId: req.ctx.workspaceId,
          productId: body.product_id ?? null,
          kind: body.kind ?? "thing",
          placeId: body.place_id ?? null,
          sourceUrl: body.source_url ?? null,
          title: body.title,
          notes: body.notes ?? null,
          targetPriceMinor: body.target_price_minor ?? null,
          currency: body.currency ?? "USD",
          plannedDays: body.planned_days ?? null,
          urgency: body.urgency ?? "someday",
          snoozedUntil: body.snoozed_until ?? null,
          metadata: body.metadata ?? {},
        })
        .returning({ id: wishItems.id });
      res.status(201).json(await loadWish(req.ctx.workspaceId, inserted[0]!.id));
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
      if (body.kind !== undefined) updates["kind"] = body.kind;
      if (body.place_id !== undefined) {
        if (body.place_id) await assertPlaceExists(body.place_id);
        updates["placeId"] = body.place_id;
      }
      if (body.source_url !== undefined) updates["sourceUrl"] = body.source_url;
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
      if (Object.keys(updates).length === 0 && body.metadata === undefined) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/wish-items/:id needs at least one field to update.",
        );
      }
      const where = and(
        eq(wishItems.id, id),
        eq(wishItems.workspaceId, req.ctx.workspaceId),
      );
      await db.transaction(async (tx) => {
        const current = await tx.select().from(wishItems).where(where).for("update");
        if (current.length === 0) throw new NotFoundProblem("WishItem", id);
        // `metadata` is a JSON Merge Patch over the stored object, never a
        // replacement for it (src/projection/metadata-patch.ts): `{}`
        // changes nothing, `null` removes a key.
        if (body.metadata !== undefined) {
          const set = metadataPatchSet(
            wishItems.metadata,
            current[0]!.metadata,
            body.metadata,
          );
          if (set !== undefined) updates["metadata"] = set;
        }
        if (Object.keys(updates).length === 0) return current[0]!;
        updates["updatedAt"] = new Date();
        const updated = await tx
          .update(wishItems)
          .set(updates)
          .where(where)
          .returning();
        return updated[0]!;
      });
      res.json(await loadWish(req.ctx.workspaceId, id));
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
  registry.register("CaptureWishForm", CaptureWishForm);

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
    method: "post",
    path: "/v1/wish-items/capture",
    summary: "Save a wish from an image (a screenshot of a post, a chat, a map; a photo)",
    description:
      "Stores the image and answers at once with a wish whose `capture_status` is `reading` and whose title is a placeholder. " +
      "The image is then read in the background: the title, kind, notes, source link and, for a place, the matched `place` are filled in and " +
      "`capture_status` becomes `done`, or `failed` with `capture.error`. Poll `GET /v1/wish-items/{id}`. " +
      "Nothing the reading fills overwrites a note sent with the upload.",
    tags: ["wish-items"],
    request: { body: { content: { "multipart/form-data": { schema: CaptureWishForm } } } },
    responses: {
      202: { description: "Accepted; reading", content: { "application/json": { schema: WishItem } } },
      422: { description: "Not an image this endpoint reads", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wish-items/{id}/capture/retry",
    summary: "Read a captured image again",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      202: { description: "Accepted; reading", content: { "application/json": { schema: WishItem } } },
      404: { description: "Not Found", content: problemContent },
      409: { description: "No image, or it is being read now", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items/{id}/image",
    summary: "The image a wish was captured from",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "The image bytes" },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/wish-items/{id}",
    summary: "Patch a wish (fields, urgency, snooze, convert / decline)",
    description:
      "JSON Merge Patch (RFC 7396). `metadata` merges into the stored object rather than " +
      "replacing it (`null` removes a key, `{}` changes nothing).",
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
