/**
 * `/v1/brands` — brand registry browse + asset management (#101 Phase 1).
 *
 * Schema-only PR: ingest doesn't write to brand_assets yet (agent
 * acquisition + judgment land in #101 Phase 2). These routes are
 * useful immediately for: manual brand creation via PATCH, listing
 * candidate assets the day acquisition starts populating them, and
 * Layer-3 user override of `preferred_asset_id` (stamps
 * `user_chose_at` so re-extract honors the choice).
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql, eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { brands, brandAssets } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Brand,
  BrandAsset,
  UpdateBrandRequest,
} from "../schemas/v1/brand.js";
import { ProblemDetails, Uuid } from "../schemas/v1/common.js";
import {
  HttpProblem,
  NotFoundProblem,
} from "../http/problem.js";

export const brandsRouter: Router = Router();

brandsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "1mb" }),
);

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToBrandDto(row: any) {
  const brandId = row.brandId ?? row.brand_id;
  const preferred = row.preferredAssetId ?? row.preferred_asset_id ?? null;
  return {
    brand_id: brandId,
    parent_id: row.parentId ?? row.parent_id ?? null,
    name: row.name,
    domain: row.domain ?? null,
    preferred_asset_id: preferred,
    icon_url: preferred ? `/v1/brands/${brandId}/icon` : null,
    user_chose_at:
      (row.userChoseAt ?? row.user_chose_at) === null ||
      (row.userChoseAt ?? row.user_chose_at) === undefined
        ? null
        : toIsoString(row.userChoseAt ?? row.user_chose_at),
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

function rowToAssetDto(row: any) {
  return {
    id: row.id,
    brand_id: row.brandId ?? row.brand_id,
    tier: row.tier,
    source_url: row.sourceUrl ?? row.source_url ?? null,
    local_path: row.localPath ?? row.local_path,
    content_hash: row.contentHash ?? row.content_hash,
    content_type: row.contentType ?? row.content_type,
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height:
      row.height === null || row.height === undefined ? null : Number(row.height),
    bytes:
      row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    acquired_at: toIsoString(row.acquiredAt ?? row.acquired_at),
    last_seen_at: toIsoString(row.lastSeenAt ?? row.last_seen_at),
    agent_relevance:
      row.agentRelevance === null || row.agentRelevance === undefined
        ? row.agent_relevance === null || row.agent_relevance === undefined
          ? null
          : Number(row.agent_relevance)
        : Number(row.agentRelevance),
    agent_notes: row.agentNotes ?? row.agent_notes ?? null,
    extraction_version: Number(row.extractionVersion ?? row.extraction_version ?? 1),
    user_rating:
      row.userRating === null || row.userRating === undefined
        ? row.user_rating === null || row.user_rating === undefined
          ? null
          : Number(row.user_rating)
        : Number(row.userRating),
    user_uploaded: !!(row.userUploaded ?? row.user_uploaded ?? false),
    user_notes: row.userNotes ?? row.user_notes ?? null,
    retired_at:
      (row.retiredAt ?? row.retired_at) === null ||
      (row.retiredAt ?? row.retired_at) === undefined
        ? null
        : toIsoString(row.retiredAt ?? row.retired_at),
    metadata: row.metadata ?? {},
  };
}

// ── GET /v1/brands ─────────────────────────────────────────────────────

brandsRouter.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await db.execute(
        sql`SELECT * FROM brands ORDER BY updated_at DESC LIMIT 500`,
      );
      res.json({
        items: (rows.rows as any[]).map(rowToBrandDto),
        next_cursor: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/brands/:brandId ────────────────────────────────────────────

brandsRouter.get(
  "/:brandId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const rows = await db
        .select()
        .from(brands)
        .where(eq(brands.brandId, brandId));
      if (rows.length === 0) throw new NotFoundProblem("Brand", brandId);
      res.json(rowToBrandDto(rows[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/brands/:brandId/assets ─────────────────────────────────────

brandsRouter.get(
  "/:brandId/assets",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const exists = await db
        .select({ id: brands.brandId })
        .from(brands)
        .where(eq(brands.brandId, brandId));
      if (exists.length === 0) throw new NotFoundProblem("Brand", brandId);
      const rows = await db
        .select()
        .from(brandAssets)
        .where(
          and(
            eq(brandAssets.brandId, brandId),
            isNull(brandAssets.retiredAt),
          ),
        );
      res.json({
        items: rows.map(rowToAssetDto),
        next_cursor: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/brands/:brandId/icon ───────────────────────────────────────
//
// Resolves the preferred asset and streams its bytes. Stub for now —
// returns 404 until #101 Phase 2 starts populating brand_assets.

brandsRouter.get(
  "/:brandId/icon",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const rows = await db
        .select({
          preferredAssetId: brands.preferredAssetId,
        })
        .from(brands)
        .where(eq(brands.brandId, brandId));
      if (rows.length === 0) throw new NotFoundProblem("Brand", brandId);
      const preferredId = rows[0]!.preferredAssetId;
      if (!preferredId) {
        throw new NotFoundProblem(
          "Brand icon",
          `No preferred_asset_id for brand=${brandId}`,
        );
      }
      // Placeholder until Phase 2 wires the streaming path:
      // - Look up `brand_assets.local_path` (relative)
      // - Stream from `/data/brand-assets/<local_path>` with the right
      //   Content-Type header and an immutable Cache-Control.
      // For now we 501 so callers know it's not wired yet.
      throw new HttpProblem(
        501,
        "icon-streaming-not-implemented",
        "Brand icon streaming lands in #101 Phase 2",
        `Phase 1 establishes brands + brand_assets schema. Streaming of the resolved asset (id=${preferredId}) is wired by the follow-up PR that adds Phase 5a/5b agent acquisition.`,
      );
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/brands/:brandId ──────────────────────────────────────────

brandsRouter.patch(
  "/:brandId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const body = parseOrThrow(UpdateBrandRequest, req.body);
      const updates: Record<string, unknown> = {};
      if (body.preferred_asset_id !== undefined) {
        updates["preferredAssetId"] = body.preferred_asset_id;
        // Setting to non-null stamps user_chose_at — Layer-3 lock.
        // Clearing (null) leaves user_chose_at intact so a previous
        // override survives an explicit "no, none of these"; if the
        // caller wants to fully reset, they can also PATCH a null
        // user override later via an admin path.
        if (body.preferred_asset_id !== null) {
          updates["userChoseAt"] = new Date();
        }
      }
      if (body.name !== undefined) updates["name"] = body.name;
      if (body.domain !== undefined) updates["domain"] = body.domain;
      if (Object.keys(updates).length === 0) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/brands/:brandId needs at least one field to update.",
        );
      }
      updates["updatedAt"] = new Date();
      const updated = await db
        .update(brands)
        .set(updates)
        .where(eq(brands.brandId, brandId))
        .returning();
      if (updated.length === 0) throw new NotFoundProblem("Brand", brandId);
      res.json(rowToBrandDto(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerBrandsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Brand", Brand);
  registry.register("BrandAsset", BrandAsset);
  registry.register("UpdateBrandRequest", UpdateBrandRequest);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/brands",
    summary: "List brands (global registry)",
    tags: ["brands"],
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(Brand),
              next_cursor: z.string().nullable(),
            }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/brands/{brandId}",
    summary: "Fetch one brand",
    tags: ["brands"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: Brand } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/brands/{brandId}/assets",
    summary: "List candidate icons for a brand",
    tags: ["brands"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(BrandAsset),
              next_cursor: z.string().nullable(),
            }),
          },
        },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/brands/{brandId}/icon",
    summary: "Resolve the preferred icon and stream it (501 until #101 Phase 2)",
    tags: ["brands"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: { description: "Icon bytes" },
      404: { description: "Brand or preferred asset missing", content: problemContent },
      501: { description: "Streaming not implemented yet", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/brands/{brandId}",
    summary: "Update a brand — name / domain / Layer-3 preferred_asset_id override",
    tags: ["brands"],
    request: {
      params: z.object({ brandId: z.string() }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateBrandRequest },
          "application/json": { schema: UpdateBrandRequest },
        },
      },
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: Brand } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
