/**
 * Brand + brand_assets zod schemas (#101).
 *
 * brands is global (shared across workspaces) keyed on a stable
 * kebab-case `brand_id`. brand_assets retains every icon candidate
 * acquired for the brand; the agent picks one via
 * `brands.preferred_asset_id`. NULL preferred is a first-class
 * outcome — frontend falls to CategoryIcon.
 */
import { z } from "zod";
import { IsoDateTime, Metadata, Uuid } from "./common.js";

export const BrandAssetTier = z.enum([
  "itunes",
  "svgl",
  "logo_dev",
  "simple_icons",
  "user_upload",
  "manual_url",
]);

export const BrandAsset = z
  .object({
    id: Uuid,
    brand_id: z.string(),
    tier: BrandAssetTier,
    source_url: z.string().nullable(),
    local_path: z.string(),
    content_hash: z.string(),
    content_type: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    bytes: z.number().int().nullable(),
    acquired_at: IsoDateTime,
    last_seen_at: IsoDateTime,
    agent_relevance: z.number().int().nullable(),
    agent_notes: z.string().nullable(),
    extraction_version: z.number().int(),
    user_rating: z.number().int().nullable(),
    user_uploaded: z.boolean(),
    user_notes: z.string().nullable(),
    retired_at: IsoDateTime.nullable(),
    metadata: Metadata,
  })
  .openapi("BrandAsset");

export const Brand = z
  .object({
    brand_id: z.string(),
    parent_id: z.string().nullable(),
    name: z.string(),
    domain: z.string().nullable(),
    preferred_asset_id: Uuid.nullable(),
    /** Computed URL: `null` when `preferred_asset_id` is null, else
     *  `/v1/brands/:brand_id/icon` (the resolved-icon endpoint). */
    icon_url: z.string().nullable(),
    user_chose_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Brand");

/**
 * PATCH body. `preferred_asset_id=null` clears the preference.
 * Setting it to a non-null asset id also stamps `user_chose_at=now()`
 * so re-extract treats this as Layer-3 user-truth.
 */
export const UpdateBrandRequest = z
  .object({
    preferred_asset_id: Uuid.nullable().optional(),
    name: z.string().optional(),
    domain: z.string().nullable().optional(),
  })
  .openapi("UpdateBrandRequest");
