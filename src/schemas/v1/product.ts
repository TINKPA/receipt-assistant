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
