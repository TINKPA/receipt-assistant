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
import { mkdir, stat, writeFile } from "fs/promises";
import { join, isAbsolute, dirname } from "path";
import { createHash } from "crypto";
import multer from "multer";
import { db } from "../db/client.js";
import { brands, brandAssets } from "../schema/index.js";
import { merchants } from "../schema/merchants.js";
import { parseOrThrow } from "../http/validate.js";
import {
  Brand,
  BrandAsset,
  BrandRollup,
  UpdateBrandRequest,
  UploadBrandAssetForm,
} from "../schemas/v1/brand.js";
import { ProblemDetails } from "../schemas/v1/common.js";
import {
  HttpProblem,
  NotFoundProblem,
  ValidationProblem,
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

// Multer for user-uploaded brand icons. Memory storage so we can sha256
// the bytes before writing to disk (UNIQUE (brand_id, content_hash)
// catches re-uploads of the same image).
const uploadBrandAsset = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — icons are small
});

const ACCEPTED_ICON_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/svg+xml",
  "image/webp",
  "image/gif",
]);

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function rowToMerchantDto(m: any) {
  const photoUrl = (m.placeId ?? m.place_id) ? `/v1/merchants/${m.id}/photo` : null;
  return {
    id: m.id,
    workspace_id: m.workspaceId ?? m.workspace_id,
    brand_id: m.brandId ?? m.brand_id,
    canonical_name: m.canonicalName ?? m.canonical_name,
    category: m.category,
    place_id: m.placeId ?? m.place_id ?? null,
    photo_url: photoUrl,
    photo_attribution: m.photoAttribution ?? m.photo_attribution ?? null,
    address: m.address ?? null,
    lat: (m.lat === null || m.lat === undefined) ? null : Number(m.lat),
    lng: (m.lng === null || m.lng === undefined) ? null : Number(m.lng),
    enrichment_status: m.enrichmentStatus ?? m.enrichment_status,
    enrichment_attempted_at:
      m.enrichmentAttemptedAt instanceof Date
        ? m.enrichmentAttemptedAt.toISOString()
        : (m.enrichmentAttemptedAt ?? m.enrichment_attempted_at ?? null),
    custom_name: m.customName ?? m.custom_name ?? null,
    created_at:
      m.createdAt instanceof Date
        ? m.createdAt.toISOString()
        : (m.createdAt ?? m.created_at),
    updated_at:
      m.updatedAt instanceof Date
        ? m.updatedAt.toISOString()
        : (m.updatedAt ?? m.updated_at),
  };
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

// ── POST /v1/brands/:brandId/assets ────────────────────────────────────
//
// User uploads a brand icon (multipart/form-data, field name `file`).
// The upload IS the user's choice — we auto-set preferred_asset_id and
// stamp user_chose_at so re-extract honors it (Layer-3 lock per #101).
//
// Dedup via UNIQUE (brand_id, content_hash). Re-uploading the same bytes
// returns the existing row 200 OK; new bytes 201 Created.
//
// Bytes are stored at `${BRAND_ASSETS_ROOT}/<brand_id>/user-upload/<sha>.<ext>`
// — same directory convention as the agent-fetched tiers so the streaming
// endpoint at /:brandId/assets/:assetId/icon works uniformly.

brandsRouter.post(
  "/:brandId/assets",
  uploadBrandAsset.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const file = req.file;
      if (!file) {
        throw new ValidationProblem([
          { path: "file", code: "required", message: "multipart field `file` is required" },
        ]);
      }
      const mime = (file.mimetype || "application/octet-stream").toLowerCase();
      if (!ACCEPTED_ICON_MIMES.has(mime)) {
        throw new ValidationProblem([
          {
            path: "file",
            code: "unsupported_mime",
            message: `Unsupported icon MIME type "${mime}". Accepted: ${Array.from(ACCEPTED_ICON_MIMES).join(", ")}`,
          },
        ]);
      }
      const brandRows = await db
        .select({ id: brands.brandId })
        .from(brands)
        .where(eq(brands.brandId, brandId));
      if (brandRows.length === 0) throw new NotFoundProblem("Brand", brandId);

      const bytes = file.buffer;
      const sha = createHash("sha256").update(bytes).digest("hex");
      const ext = extensionForMime(mime);
      const relPath = `${brandId}/user-upload/${sha}.${ext}`;
      const absPath = join(BRAND_ASSETS_ROOT, relPath);

      // Dedup: if (brand_id, content_hash) already exists, surface that row.
      // Whether or not we just wrote the bytes (race-safe: writeFile is
      // idempotent for the same payload, and ON CONFLICT short-circuits).
      const existing = await db
        .select()
        .from(brandAssets)
        .where(
          and(
            eq(brandAssets.brandId, brandId),
            eq(brandAssets.contentHash, sha),
          ),
        );

      let assetId: string;
      let created: boolean;
      if (existing.length > 0) {
        const row = existing[0]!;
        // If retired earlier, un-retire it (the user is explicitly choosing it now).
        if (row.retiredAt !== null) {
          await db
            .update(brandAssets)
            .set({ retiredAt: null, lastSeenAt: new Date() })
            .where(eq(brandAssets.id, row.id));
        } else {
          await db
            .update(brandAssets)
            .set({ lastSeenAt: new Date() })
            .where(eq(brandAssets.id, row.id));
        }
        assetId = row.id;
        created = false;
      } else {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, bytes);
        const inserted = await db
          .insert(brandAssets)
          .values({
            brandId,
            tier: "user_upload",
            sourceUrl: null,
            localPath: relPath,
            contentHash: sha,
            contentType: mime,
            bytes: bytes.length,
            userUploaded: true,
            // agent_relevance left null — user upload is by definition
            // the chosen one; doesn't need a numeric score to compete.
          })
          .returning({ id: brandAssets.id });
        assetId = inserted[0]!.id;
        created = true;
      }

      // Layer-3 user-truth: stamp user_chose_at + point preferred at the
      // uploaded asset. Re-extract's Phase 4c never overwrites a row with
      // user_chose_at IS NOT NULL.
      await db
        .update(brands)
        .set({
          preferredAssetId: assetId,
          userChoseAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(brands.brandId, brandId));

      const finalRows = await db
        .select()
        .from(brandAssets)
        .where(eq(brandAssets.id, assetId));
      res.status(created ? 201 : 200).json(rowToAssetDto(finalRows[0]!));
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

// ── GET /v1/brands/:brandId/rollup ─────────────────────────────────────
//
// Brand-level rollup behind the new BrandPage UI: aggregated stats
// across every merchant under this brand, the locations list with
// per-merchant stats, recent transactions across the brand, and any
// sibling brands sharing the same `parent_id` (Costco group case).
// Voided transactions excluded from money sums; location_count is the
// raw merchant row count (independent of activity).

brandsRouter.get(
  "/:brandId/rollup",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const brandId = String(req.params.brandId);
      const workspaceId = req.ctx.workspaceId;

      // 1. Brand row
      const brandRows = await db
        .select()
        .from(brands)
        .where(eq(brands.brandId, brandId));
      if (brandRows.length === 0) throw new NotFoundProblem("Brand", brandId);
      const brand = brandRows[0]!;

      // 2. All merchants for this brand in this workspace
      const merchantRows = await db
        .select()
        .from(merchants)
        .where(and(eq(merchants.workspaceId, workspaceId), eq(merchants.brandId, brandId)));

      // 3. Workspace currency
      const wsRow = await db.execute(sql`
        SELECT base_currency FROM workspaces WHERE id = ${workspaceId}::uuid
      `);
      const currency = ((wsRow.rows[0] as any)?.base_currency as string) ?? "USD";

      // 4. Per-merchant stats (money-counting rows only: posted/reconciled, not deleted)
      const perMerchantStats = new Map<
        string,
        { txnCount: number; lifetime: number; currentMonth: number; lastDate: string | null }
      >();
      let brandTxnCount = 0;
      let brandLifetime = 0;
      let brandCurrentMonth = 0;
      let brandLastDate: string | null = null;

      if (merchantRows.length > 0) {
        const statsResult = await db.execute(sql`
          SELECT
            t.merchant_id::text AS merchant_id,
            COUNT(DISTINCT t.id)::bigint AS txn_count,
            COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint AS lifetime,
            COALESCE(SUM(CASE
              WHEN p.amount_minor > 0
               AND t.occurred_on >= date_trunc('month', CURRENT_DATE)::date
               AND t.occurred_on <  (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
              THEN p.amount_minor ELSE 0
            END), 0)::bigint AS current_month,
            MAX(t.occurred_on)::text AS last_date
          FROM transactions t
          JOIN postings p ON p.transaction_id = t.id
          WHERE t.workspace_id = ${workspaceId}::uuid
            AND t.merchant_id IN (
              SELECT id FROM merchants
              WHERE workspace_id = ${workspaceId}::uuid
                AND brand_id = ${brandId}
            )
            AND t.status IN ('posted', 'reconciled') AND t.deleted_at IS NULL
          GROUP BY t.merchant_id
        `);
        for (const r of statsResult.rows as any[]) {
          const s = {
            txnCount: toInt(r.txn_count),
            lifetime: toInt(r.lifetime),
            currentMonth: toInt(r.current_month),
            lastDate: r.last_date,
          };
          perMerchantStats.set(r.merchant_id, s);
          brandTxnCount += s.txnCount;
          brandLifetime += s.lifetime;
          brandCurrentMonth += s.currentMonth;
          if (s.lastDate && (!brandLastDate || s.lastDate > brandLastDate)) {
            brandLastDate = s.lastDate;
          }
        }
      }

      // 5. Recent transactions across the brand (top 20)
      let recentTxns: any[] = [];
      if (merchantRows.length > 0) {
        const recentResult = await db.execute(sql`
          SELECT
            t.id,
            t.occurred_on::text AS occurred_on,
            t.payee,
            t.status::text AS status,
            t.merchant_id::text AS merchant_id,
            m.canonical_name AS merchant_canonical_name,
            m.custom_name AS merchant_custom_name,
            (
              SELECT COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint
              FROM postings p
              WHERE p.transaction_id = t.id
            ) AS total_minor,
            (
              SELECT p.currency FROM postings p WHERE p.transaction_id = t.id LIMIT 1
            ) AS row_currency,
            (
              SELECT dl.document_id
              FROM document_links dl
              WHERE dl.transaction_id = t.id
              ORDER BY dl.created_at ASC
              LIMIT 1
            ) AS document_id
          FROM transactions t
          JOIN merchants m ON m.id = t.merchant_id
          WHERE t.workspace_id = ${workspaceId}::uuid
            AND m.brand_id = ${brandId}
            AND m.workspace_id = ${workspaceId}::uuid
          ORDER BY t.occurred_on DESC, t.id DESC
          LIMIT 20
        `);
        recentTxns = (recentResult.rows as any[]).map((r) => ({
          id: r.id,
          occurred_on: r.occurred_on,
          payee: r.payee,
          status: r.status,
          total_minor: toInt(r.total_minor),
          currency: r.row_currency ?? currency,
          document_id: r.document_id,
          merchant_id: r.merchant_id,
          merchant_canonical_name: r.merchant_canonical_name,
          merchant_custom_name: r.merchant_custom_name,
        }));
      }

      // 6. Sibling brands (same parent_id, not self) — only if parent exists
      let siblings: any[] = [];
      if (brand.parentId) {
        const siblingRows = await db.execute(sql`
          SELECT
            b.brand_id,
            b.name,
            b.domain,
            b.preferred_asset_id,
            COALESCE((
              SELECT COUNT(*)::bigint
              FROM merchants m2
              WHERE m2.workspace_id = ${workspaceId}::uuid
                AND m2.brand_id = b.brand_id
            ), 0) AS location_count
          FROM brands b
          WHERE b.parent_id = ${brand.parentId}
            AND b.brand_id <> ${brandId}
          ORDER BY b.name
          LIMIT 10
        `);
        siblings = (siblingRows.rows as any[]).map((r) => ({
          brand_id: r.brand_id,
          name: r.name,
          domain: r.domain,
          icon_url: r.preferred_asset_id ? `/v1/brands/${r.brand_id}/icon` : null,
          location_count: toInt(r.location_count),
        }));
      }

      // 7. Build locations array — DTO + per-merchant stats, sorted by spend desc
      const locations = merchantRows.map((m) => {
        const s = perMerchantStats.get(m.id);
        return {
          merchant: rowToMerchantDto(m),
          stats: {
            transaction_count: s?.txnCount ?? 0,
            lifetime_spend_minor: s?.lifetime ?? 0,
            current_month_spend_minor: s?.currentMonth ?? 0,
            last_transaction_date: s?.lastDate ?? null,
            currency,
          },
        };
      });
      locations.sort((a, b) => {
        const d = b.stats.lifetime_spend_minor - a.stats.lifetime_spend_minor;
        if (d !== 0) return d;
        return a.merchant.canonical_name.localeCompare(b.merchant.canonical_name);
      });

      res.json({
        brand: rowToBrandDto(brand),
        stats: {
          location_count: merchantRows.length,
          transaction_count: brandTxnCount,
          lifetime_spend_minor: brandLifetime,
          current_month_spend_minor: brandCurrentMonth,
          last_transaction_date: brandLastDate,
          currency,
        },
        locations,
        recent_transactions: recentTxns,
        sibling_brands: siblings,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerBrandsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Brand", Brand);
  registry.register("BrandAsset", BrandAsset);
  registry.register("BrandRollup", BrandRollup);
  registry.register("UpdateBrandRequest", UpdateBrandRequest);
  registry.register("UploadBrandAssetForm", UploadBrandAssetForm);

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
    method: "post",
    path: "/v1/brands/{brandId}/assets",
    summary: "Upload a user-provided brand icon",
    description:
      "Multipart upload (field name `file`) — saves bytes to the brand-assets bind-mount, inserts a brand_assets row with tier=user_upload, and stamps user_chose_at + preferred_asset_id to the new asset (the upload IS the user's choice; Layer-3 lock per #101). Re-uploading identical bytes returns the existing row 200 OK (UNIQUE on (brand_id, content_hash)); new bytes return 201.",
    tags: ["brands"],
    request: {
      params: z.object({ brandId: z.string() }),
      body: {
        required: true,
        content: {
          "multipart/form-data": { schema: UploadBrandAssetForm },
        },
      },
    },
    responses: {
      200: {
        description: "Dedup hit — existing asset returned",
        content: { "application/json": { schema: BrandAsset } },
      },
      201: {
        description: "New asset created",
        content: { "application/json": { schema: BrandAsset } },
      },
      404: { description: "Brand not found", content: problemContent },
      422: { description: "Validation failed", content: problemContent },
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
    method: "get",
    path: "/v1/brands/{brandId}/rollup",
    summary: "Brand-level rollup — locations, recent transactions, sibling brands",
    description:
      "Aggregates across every merchant row sharing this brand_id within the workspace. " +
      "Powers the BrandPage UI (#XXX). Voided transactions excluded from money sums. " +
      "Sibling brands (same parent_id) included for the Costco-style grouped-brand callout.",
    tags: ["brands"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: BrandRollup } },
      },
      404: { description: "Brand not found", content: problemContent },
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
