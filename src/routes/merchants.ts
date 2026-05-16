/**
 * `/v1/merchants/*` — read-only merchant aggregation endpoints behind
 * the frontend merchant page (issue #33). Backend canonicalization +
 * Places enrichment are the write paths; see issue #64.
 *
 * Identifier semantics: routes accept either a UUID (the row's `id`) or
 * a kebab-case `brand_id`. The frontend uses brand_id for shareable URLs
 * (`/merchant/starbucks`); UUID is for internal cross-references.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { createReadStream } from "fs";
import { stat } from "fs/promises";

import { db } from "../db/client.js";
import { merchants } from "../schema/merchants.js";
import { places, placePhotos } from "../schema/places.js";
import { parseOrThrow } from "../http/validate.js";
import { HttpProblem, NotFoundProblem } from "../http/problem.js";
import {
  MerchantDetail,
  MerchantPathParams,
  MerchantTransactionsQuery,
  MerchantTransactionsResponse,
  Merchant,
  UpdateMerchantRequest,
} from "../schemas/v1/merchant.js";
import { ProblemDetails } from "../schemas/v1/common.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

async function resolveMerchant(workspaceId: string, identifier: string) {
  const matchCol = UUID_RE.test(identifier) ? merchants.id : merchants.brandId;
  const rows = await db
    .select()
    .from(merchants)
    .where(and(eq(merchants.workspaceId, workspaceId), eq(matchCol, identifier)))
    .limit(1);
  return rows[0] ?? null;
}

function rowToMerchantDto(m: typeof merchants.$inferSelect) {
  // `photo_url` post-#67 is a relative proxy URL to the merchant
  // photo endpoint when a Google place_id is linked. The endpoint
  // resolves to a cached `place_photos.rank=0` byte stream when
  // available, or 404s otherwise — CSS-background heroes degrade
  // naturally to the category-color fallback in either case.
  // The original `m.photoUrl` column (Google short-lived attribution
  // URL) is no longer surfaced; it would expire after ~24h anyway.
  const photoUrl = m.placeId ? `/v1/merchants/${m.id}/photo` : null;
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    brand_id: m.brandId,
    canonical_name: m.canonicalName,
    category: m.category,
    place_id: m.placeId,
    photo_url: photoUrl,
    photo_attribution: m.photoAttribution,
    address: m.address,
    lat: m.lat !== null ? Number(m.lat) : null,
    lng: m.lng !== null ? Number(m.lng) : null,
    enrichment_status: m.enrichmentStatus,
    enrichment_attempted_at:
      m.enrichmentAttemptedAt instanceof Date
        ? m.enrichmentAttemptedAt.toISOString()
        : m.enrichmentAttemptedAt,
    custom_name: m.customName ?? null,
    created_at:
      m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updated_at:
      m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
  };
}

export const merchantsRouter = Router({ mergeParams: true });

// PATCH body parser — accepts both application/json and merge-patch+json
// per RFC 7396. Body is small (one nullable string), 1mb limit is more
// than generous and matches the brands router precedent.
merchantsRouter.use(
  express.json({
    type: ["application/json", "application/merge-patch+json"],
    limit: "1mb",
  }),
);

/**
 * GET /v1/merchants/:id — single merchant + KPIs.
 *
 * `:id` accepts uuid or brand_id. Voided transactions are excluded from
 * KPIs (lifetime/current-month spend); they remain visible in the
 * companion `/transactions` endpoint so the merchant page can render
 * them with strikethrough.
 */
merchantsRouter.get(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    const statsRow = await db.execute(sql`
      WITH s AS (
        SELECT
          COUNT(DISTINCT t.id)::bigint AS txn_count,
          COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint AS lifetime_spend,
          COALESCE(SUM(CASE
            WHEN p.amount_minor > 0
             AND t.occurred_on >= date_trunc('month', CURRENT_DATE)::date
             AND t.occurred_on <  (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
            THEN p.amount_minor ELSE 0
          END), 0)::bigint AS current_month_spend,
          MAX(t.occurred_on)::text AS last_date
        FROM transactions t
        JOIN postings p ON p.transaction_id = t.id
        WHERE t.workspace_id = ${req.ctx.workspaceId}::uuid
          AND t.merchant_id = ${merchant.id}::uuid
          AND t.status <> 'voided'
      )
      SELECT
        s.txn_count, s.lifetime_spend, s.current_month_spend, s.last_date,
        (SELECT base_currency FROM workspaces WHERE id = ${req.ctx.workspaceId}::uuid) AS currency
      FROM s
    `);
    const row = statsRow.rows[0] as {
      txn_count: string | number;
      lifetime_spend: string | number;
      current_month_spend: string | number;
      last_date: string | null;
      currency: string | null;
    };

    const body = {
      merchant: rowToMerchantDto(merchant),
      stats: {
        transaction_count: toInt(row.txn_count),
        lifetime_spend_minor: toInt(row.lifetime_spend),
        current_month_spend_minor: toInt(row.current_month_spend),
        last_transaction_date: row.last_date,
        currency: row.currency ?? "USD",
      },
    };
    res.json(body);
  }),
);

/**
 * GET /v1/merchants/:id/transactions — paginated list for the merchant
 * detail page. Sort is fixed at `occurred_on DESC, id DESC` (the same
 * keyset the ledger uses) so this can ride the
 * `transactions_merchant_idx` index. Cursor encodes "<date>|<id>".
 */
merchantsRouter.get(
  "/:id/transactions",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const q = parseOrThrow(MerchantTransactionsQuery, req.query);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    const limit = q.limit ?? 50;
    let cursorClause = sql``;
    if (q.cursor) {
      const [cDate, cId] = q.cursor.split("|");
      if (cDate && cId) {
        cursorClause = sql`AND (t.occurred_on, t.id) < (${cDate}::date, ${cId}::uuid)`;
      }
    }

    const result = await db.execute(sql`
      SELECT
        t.id,
        t.occurred_on::text AS occurred_on,
        t.payee,
        t.status::text AS status,
        (
          SELECT COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint
          FROM postings p
          WHERE p.transaction_id = t.id
        ) AS total_minor,
        (
          SELECT p.currency FROM postings p WHERE p.transaction_id = t.id LIMIT 1
        ) AS currency,
        (
          SELECT dl.document_id
          FROM document_links dl
          WHERE dl.transaction_id = t.id
          ORDER BY dl.created_at ASC
          LIMIT 1
        ) AS document_id
      FROM transactions t
      WHERE t.workspace_id = ${req.ctx.workspaceId}::uuid
        AND t.merchant_id = ${merchant.id}::uuid
        ${cursorClause}
      ORDER BY t.occurred_on DESC, t.id DESC
      LIMIT ${limit + 1}
    `);

    const rows = result.rows as Array<{
      id: string;
      occurred_on: string;
      payee: string | null;
      status: "draft" | "posted" | "voided" | "reconciled" | "error";
      total_minor: string | number;
      currency: string | null;
      document_id: string | null;
    }>;

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      id: r.id,
      occurred_on: r.occurred_on,
      payee: r.payee,
      status: r.status,
      total_minor: toInt(r.total_minor),
      currency: r.currency ?? "USD",
      document_id: r.document_id,
    }));
    const next_cursor =
      hasMore && items.length > 0
        ? `${items[items.length - 1].occurred_on}|${items[items.length - 1].id}`
        : null;

    res.json({ items, next_cursor });
  }),
);

// ── GET /v1/merchants/:id/photo (#67) ──────────────────────────────────

merchantsRouter.get(
  "/:id/photo",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    // Option A from #67 explore: reuse the existing place_photos
    // cache from #74. The merchant's Google place_id maps to a
    // places row, which has place_photos rows with bytes already on
    // disk under /data/uploads/places/<google_place_id>/<rank>.jpg.
    // No new schema, no duplicated bytes, no new enrichment hop.
    if (!merchant.placeId) {
      throw new NotFoundProblem("MerchantPhoto", id);
    }

    const photoRows = await db
      .select({ filePath: placePhotos.filePath, mimeType: placePhotos.mimeType })
      .from(placePhotos)
      .innerJoin(places, eq(places.id, placePhotos.placeId))
      .where(
        and(
          eq(places.googlePlaceId, merchant.placeId),
          sql`${placePhotos.filePath} IS NOT NULL`,
        ),
      )
      .orderBy(placePhotos.rank)
      .limit(1);

    if (photoRows.length === 0) {
      throw new NotFoundProblem("MerchantPhoto", id);
    }
    const photo = photoRows[0]!;
    if (!photo.filePath) {
      throw new NotFoundProblem("MerchantPhoto", id);
    }

    // Sanity-check the file is still on disk — hard delete moves
    // files into .trash/ rather than unlinking (#73).
    try {
      const st = await stat(photo.filePath);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      throw new NotFoundProblem("MerchantPhoto", id);
    }

    res.setHeader("Content-Type", photo.mimeType ?? "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    createReadStream(photo.filePath).pipe(res);
  }),
);

// ── PATCH /v1/merchants/:id (#79 Phase C) ──────────────────────────────
//
// Currently exposes only `custom_name` — Layer-3 brand-level rename
// override. Other merchant fields are agent-owned via the ingest
// extractor and not user-editable from this endpoint. Accepts either
// brand_id slug or UUID in `:id`.

merchantsRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    const body = parseOrThrow(UpdateMerchantRequest, req.body);
    const updates: Record<string, unknown> = {};
    if ("custom_name" in body) {
      const cn = body.custom_name ?? null;
      updates["customName"] = cn === null ? null : cn.trim() === "" ? null : cn.trim();
    }
    if (Object.keys(updates).length === 0) {
      throw new HttpProblem(
        400,
        "no-fields",
        "No editable fields supplied",
        "PATCH /v1/merchants/:id needs at least one field. Currently only `custom_name` is editable.",
      );
    }
    updates["updatedAt"] = new Date();

    const updated = await db
      .update(merchants)
      .set(updates)
      .where(
        and(eq(merchants.workspaceId, req.ctx.workspaceId), eq(merchants.id, merchant.id)),
      )
      .returning();
    res.json(rowToMerchantDto(updated[0]!));
  }),
);

// ── OpenAPI registration ───────────────────────────────────────────────

const problemResponse = {
  content: { "application/problem+json": { schema: ProblemDetails } },
};

export function registerMerchantsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Merchant", Merchant);
  registry.register("MerchantDetail", MerchantDetail);
  registry.register("MerchantTransactionsResponse", MerchantTransactionsResponse);
  registry.register("UpdateMerchantRequest", UpdateMerchantRequest);

  registry.registerPath({
    method: "get",
    path: "/v1/merchants/{id}",
    summary: "Merchant detail + KPIs",
    description:
      "`id` accepts either the merchant row's UUID or its kebab-case `brand_id`.",
    tags: ["merchants"],
    request: {
      params: MerchantPathParams,
    },
    responses: {
      200: {
        description: "Merchant with aggregated stats",
        content: { "application/json": { schema: MerchantDetail } },
      },
      404: { description: "Merchant not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/merchants/{id}/photo",
    summary: "Stream the cached hero photo for a merchant (#67).",
    description:
      "Resolves to the merchant's linked `places.id` and serves the " +
      "first `place_photos` row with cached bytes. Returns 404 when " +
      "the merchant has no linked place or no cached photos for that " +
      "place. Reuses the `place_photos` cache from #74 — no separate " +
      "merchant_photos table.",
    tags: ["merchants"],
    request: { params: MerchantPathParams },
    responses: {
      200: {
        description: "Image bytes",
        content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
      },
      404: { description: "Merchant or photo not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/merchants/{id}/transactions",
    summary: "Transactions for a merchant, newest first, keyset-paginated",
    tags: ["merchants"],
    request: {
      params: MerchantPathParams,
      query: MerchantTransactionsQuery,
    },
    responses: {
      200: {
        description: "Paginated transactions",
        content: {
          "application/json": { schema: MerchantTransactionsResponse },
        },
      },
      404: { description: "Merchant not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/merchants/{id}",
    summary: "Update a merchant — brand-level Layer-3 custom_name override (#79)",
    description:
      "Currently only `custom_name` is editable. Other merchant fields are " +
      "agent-owned via the ingest extractor and not user-editable from this endpoint. " +
      "Pass `custom_name: null` to clear the override.",
    tags: ["merchants"],
    request: {
      params: MerchantPathParams,
      body: {
        content: {
          "application/json": { schema: UpdateMerchantRequest },
          "application/merge-patch+json": { schema: UpdateMerchantRequest },
        },
      },
    },
    responses: {
      200: {
        description: "Updated merchant",
        content: { "application/json": { schema: Merchant } },
      },
      400: { description: "No editable fields supplied", ...problemResponse },
      404: { description: "Merchant not found", ...problemResponse },
    },
  });
}
