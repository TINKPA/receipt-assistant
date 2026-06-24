/**
 * `products` SSOT zod schema (#84 Phase 1). The catalog row is shared
 * across all transactions that link to it; aggregate stats are
 * recomputed from the live `transaction_items` set, never incremented.
 */
import { z } from "zod";
import { IsoDate, IsoDateTime, Metadata, Uuid } from "./common.js";

export const ProductItemClass = z.enum([
  "durable",
  "consumable",
  "food_drink",
  "service",
  "other",
]);

export const ProductAssetTier = z.enum([
  "manual_seed",
  "user_upload",
  "agent_fetch",
]);

/**
 * Multipart form for `POST /v1/products/:id/assets`. Zod can't fully
 * model multipart bodies; this exists so the OpenAPI doc reflects the
 * expected field shape. The actual parsing is done by multer.
 */
export const UploadProductAssetForm = z
  .object({
    file: z.any().openapi({ type: "string", format: "binary" }),
  })
  .openapi("UploadProductAssetForm");

/**
 * One product image candidate (#159, mirrors BrandAsset). The chosen
 * one is pointed at by `products.preferred_asset_id`. `tier` is
 * provenance, not priority.
 */
export const ProductAsset = z
  .object({
    id: Uuid,
    product_id: Uuid,
    tier: ProductAssetTier,
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
  .openapi("ProductAsset");

export const Product = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    /** Kebab-case canonical key, scoped under (workspace, merchant). */
    product_key: z.string(),
    canonical_name: z.string(),
    /** NULL → portable across merchants (iPhone, Coke). NOT NULL →
     *  exclusive to one merchant (Crunchwrap @ Taco Bell, AYCE set). */
    merchant_id: Uuid.nullable(),
    /** Manufacturer brand id, NOT the seller's. Text, not FK. */
    brand_id: z.string().nullable(),
    item_class: ProductItemClass,

    model: z.string().nullable(),
    color: z.string().nullable(),
    size: z.string().nullable(),
    variant: z.string().nullable(),
    sku: z.string().nullable(),
    manufacturer: z.string().nullable(),

    first_purchased_on: IsoDate.nullable(),
    last_purchased_on: IsoDate.nullable(),
    purchase_count: z.number().int(),
    total_spent_minor: z.number().int(),

    custom_name: z.string().nullable(),
    notes: z.string().nullable(),
    retired_from_catalog_at: IsoDateTime.nullable(),

    /** Currently-preferred image asset id (#159). NULL → no image. */
    preferred_asset_id: Uuid.nullable(),
    /** Computed URL: `null` when `preferred_asset_id` is null, else
     *  `/v1/products/:id/image` (the resolved-image endpoint). */
    image_url: z.string().nullable(),

    metadata: Metadata,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Product");

export const UpdateProductRequest = z
  .object({
    custom_name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    /** PATCH the manufacturer brand id. The user can correct the
     *  agent's initial judgment (Costco Kirkland gray-area, etc). */
    brand_id: z.string().nullable().optional(),
    /** Move portable ↔ merchant-exclusive. NULL → portable.
     *  Setting NOT NULL collapses the row's scope to one merchant. */
    merchant_id: Uuid.nullable().optional(),
    /** Soft-archive the row. */
    retired_from_catalog_at: IsoDateTime.nullable().optional(),
    /** Layer-3 preferred image override (#159). Setting non-null stamps
     *  `preferred_asset_chosen_at=now()` so re-seed honors the choice. */
    preferred_asset_id: Uuid.nullable().optional(),
  })
  .openapi("UpdateProductRequest");

export const ListProductsQuery = z.object({
  class: ProductItemClass.optional(),
  brand_id: z.string().optional(),
  merchant_id: Uuid.optional(),
  q: z.string().optional(),
  include_retired: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * `POST /v1/products/:id/merge_into` body. Collapses two products
 * into one: all `transaction_items` and `owned_items` re-point to
 * `target_id`; the source product is retired and its aggregates
 * zeroed. The target's aggregates are recomputed from the live
 * `transaction_items` set.
 */
export const MergeProductRequest = z
  .object({
    target_id: Uuid,
  })
  .openapi("MergeProductRequest");

export const MergeProductResponse = z
  .object({
    source_id: Uuid,
    target_id: Uuid,
    moved_transaction_items: z.number().int(),
    moved_owned_items: z.number().int(),
    derivation_event_id: Uuid,
  })
  .openapi("MergeProductResponse");
