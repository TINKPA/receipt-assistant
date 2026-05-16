/**
 * `owned_items` zod schema (#84 Phase 2). Physical-instance inventory:
 * the agent creates N rows for a quantity-N durable purchase; the user
 * fills in serial / location / warranty / condition / notes per row.
 *
 * Manually-added items (gifts, secondhand, inherited) leave
 * `transaction_item_id = NULL`.
 */
import { z } from "zod";
import { IsoDate, IsoDateTime, Metadata, Uuid } from "./common.js";

export const OwnedItem = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    product_id: Uuid,
    /** NULL for gifts / secondhand / manually-added inventory. */
    transaction_item_id: Uuid.nullable(),
    instance_index: z.number().int().positive(),
    serial_number: z.string().nullable(),
    /** Free-text location ("书桌抽屉", "客厅", "妈妈家"). */
    location: z.string().nullable(),
    acquired_on: IsoDate.nullable(),
    warranty_until: IsoDate.nullable(),
    /** Free text. Recommended: new / used / broken / sold / gifted_away. */
    condition: z.string().nullable(),
    /** Sold / broken / given-away timestamp. NULL → still owned. */
    retired_at: IsoDateTime.nullable(),
    notes: z.string().nullable(),
    metadata: Metadata,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("OwnedItem");

export const CreateOwnedItemRequest = z
  .object({
    product_id: Uuid,
    /** Optional — manual entries (gifts) skip this. */
    transaction_item_id: Uuid.optional(),
    instance_index: z.number().int().positive().optional(),
    serial_number: z.string().optional(),
    location: z.string().optional(),
    acquired_on: IsoDate.optional(),
    warranty_until: IsoDate.optional(),
    condition: z.string().optional(),
    notes: z.string().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("CreateOwnedItemRequest");

export const UpdateOwnedItemRequest = z
  .object({
    serial_number: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    acquired_on: IsoDate.nullable().optional(),
    warranty_until: IsoDate.nullable().optional(),
    condition: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    /** Sold / broken / given-away. Setting to non-null retires the
     *  instance; null un-retires (rare but supported). */
    retired_at: IsoDateTime.nullable().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateOwnedItemRequest");

export const ListOwnedItemsQuery = z.object({
  product_id: Uuid.optional(),
  location: z.string().optional(),
  /** Default: false → only currently-owned rows. */
  include_retired: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
