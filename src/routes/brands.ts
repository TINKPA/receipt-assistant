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
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join, isAbsolute } from "path";
import { db } from "../db/client.js";
import { brands, brandAssets } from "../schema/index.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Brand,
  BrandAsset,
  UpdateBrandRequest,
} from "../schemas/v1/brand.js";
import { ProblemDetails } from "../schemas/v1/common.js";
import {
  HttpProblem,
  NotFoundProblem,
} from "../http/problem.js";

// Where the bind-mount lands inside the container. Phase 4b writes each
// candidate to `<BRAND_ASSETS_ROOT>/<brand_id>/<tier>/<token>.<ext>` and
// stores the relative path (everything after the root) in
// `brand_assets.local_path`. Streaming joins root + local_path.
const BRAND_ASSETS_ROOT = process.env.BRAND_ASSETS_ROOT || "/data/brand-assets";

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

// ── GET /v1/brands/:brandId/assets/:assetId/icon ──────────────────────
//
// Streams the bytes of an arbitrary candidate (NOT just the preferred
// one). Powers the Brand-detail picker UI so the user can visually
// compare candidates before clicking "Pick" — embedding `source_url`
// directly fails for iTunes lookup URLs, logo.dev URLs without the
// token, and any CDN that blocks hotlinking. Scoped by brand_id so an
// asset_id can't be enumerated across brands.

brandsRouter.get(
  "/:brandId/assets/:assetId/icon",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const assetId = String(req.params.assetId);
      const rows = await db
        .select({
          localPath: brandAssets.localPath,
          contentType: brandAssets.contentType,
          retiredAt: brandAssets.retiredAt,
        })
        .from(brandAssets)
        .where(
          and(eq(brandAssets.id, assetId), eq(brandAssets.brandId, brandId)),
        );
      if (rows.length === 0) {
        throw new NotFoundProblem(
          "Brand asset",
          `asset_id=${assetId} not found under brand=${brandId}`,
        );
      }
      const asset = rows[0]!;
      if (asset.retiredAt !== null) {
        throw new NotFoundProblem(
          "Brand asset",
          `asset_id=${assetId} is retired`,
        );
      }
      const absPath = isAbsolute(asset.localPath)
        ? asset.localPath
        : join(BRAND_ASSETS_ROOT, asset.localPath);
      try {
        const st = await stat(absPath);
        if (!st.isFile()) throw new Error("not a file");
      } catch {
        throw new NotFoundProblem(
          "Brand asset",
          `File missing on disk: ${absPath}`,
        );
      }
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      createReadStream(absPath).pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/brands/:brandId/icon ───────────────────────────────────────
//
// Resolves the brand's preferred_asset_id and streams the bytes from
// `${BRAND_ASSETS_ROOT}/<local_path>`. Returns 404 if the brand is
// missing, no asset is preferred, the asset row is retired, or the
// file is missing on disk. The frontend falls back to CategoryIcon on
// any 404; never to a different candidate (per #101 spec: no inter-
// candidate cascade — the agent already picked the winner at ingest).

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
      const assetRows = await db
        .select({
          localPath: brandAssets.localPath,
          contentType: brandAssets.contentType,
          contentHash: brandAssets.contentHash,
          retiredAt: brandAssets.retiredAt,
        })
        .from(brandAssets)
        .where(eq(brandAssets.id, preferredId));
      if (assetRows.length === 0) {
        throw new NotFoundProblem(
          "Brand icon",
          `preferred_asset_id=${preferredId} not found for brand=${brandId}`,
        );
      }
      const asset = assetRows[0]!;
      if (asset.retiredAt !== null) {
        // Stale pointer — UI fallback. Re-extract should clear this.
        throw new NotFoundProblem(
          "Brand icon",
          `preferred_asset_id=${preferredId} is retired for brand=${brandId}`,
        );
      }
      const absPath = isAbsolute(asset.localPath)
        ? asset.localPath
        : join(BRAND_ASSETS_ROOT, asset.localPath);
      try {
        const st = await stat(absPath);
        if (!st.isFile()) throw new Error("not a file");
      } catch {
        throw new NotFoundProblem(
          "Brand icon",
          `File missing on disk: ${absPath}`,
        );
      }
      // Strong ETag is the asset's content_hash. The URL stays stable
      // (`/brands/<id>/icon`) while the underlying bytes flip whenever
      // a user re-picks `preferred_asset_id` — so `immutable` would be
      // wrong here. `max-age=0, must-revalidate` makes every request a
      // conditional GET; the 304 path is cheap (no read) and the user's
      // Pick takes effect the next time anything renders the icon.
      const etag = `"${asset.contentHash}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("Content-Type", asset.contentType);
      createReadStream(absPath).pipe(res);
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
    path: "/v1/brands/{brandId}/assets/{assetId}/icon",
    summary: "Stream an individual candidate asset's bytes",
    description:
      "Streams any candidate (not just preferred) so the UI picker can render thumbnails. Scoped by brand_id to prevent cross-brand asset_id enumeration. 404 if missing, retired, or the file is gone from disk.",
    tags: ["brands"],
    request: {
      params: z.object({ brandId: z.string(), assetId: z.string() }),
    },
    responses: {
      200: { description: "Asset bytes" },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/brands/{brandId}/icon",
    summary: "Stream the brand's preferred icon bytes",
    description:
      "Resolves preferred_asset_id and streams the file. 404 when the brand is missing, no asset is preferred, the asset is retired, or the file is missing on disk. Frontend falls back to CategoryIcon on 404 — never to a different candidate.",
    tags: ["brands"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: { description: "Icon bytes" },
      404: { description: "Brand or icon unavailable", content: problemContent },
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
