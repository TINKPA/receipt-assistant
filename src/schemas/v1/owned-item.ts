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
    /** Achievement-plan horizon in days (1825 = 5 years). NULL = unset. */
    target_days: z.number().int().nullable(),
    notes: z.string().nullable(),
    metadata: Metadata,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("OwnedItem");

/** List rows with `expand=product`: the catalog + purchase context the
 *  Things grid needs in one request (no client-side N+1). All nullable —
 *  manual rows (gifts) have no linked transaction item. */
export const OwnedItemExpanded = OwnedItem.extend({
  product_name: z.string().nullable().optional(),
  item_class: z.string().nullable().optional(),
  /** What the line cost, **in the currency the line was recorded in** —
   *  which is NOT necessarily the workspace base currency, and is not
   *  necessarily even cash. Read it with `paid_currency`; on its own it
   *  is an integer of unknown unit and unknown scale (points are stored
   *  as whole units, cash as hundredths). For anything that sums or
   *  divides — a $/day, a portfolio total — use `paid_base_minor`. */
  paid_minor: z.number().int().nullable().optional(),
  /** Currency of `paid_minor`: an ISO-4217 code, or a points code such as
   *  `HYATT_PT` for an award-acquired item (#206). Added in #216 — before
   *  it, clients had no way to tell a CNY line from a USD one and six live
   *  rows rendered yuan behind a dollar sign. */
  paid_currency: z.string().nullable().optional(),
  /** `paid_minor` converted to the workspace base currency at the rate the
   *  transaction's own posting was converted at, so it is directly
   *  comparable and summable across items.
   *
   *  **Null means the conversion is unknown, not zero** — a non-base line
   *  whose transaction never got an `fx_rate` (e.g. a zero-total receipt).
   *  Clients must suppress derived figures rather than fall back to
   *  `paid_minor`, which is the exact substitution this field exists to
   *  stop. */
  paid_base_minor: z.number().int().nullable().optional(),
  payee: z.string().nullable().optional(),
  merchant_brand_id: z.string().nullable().optional(),
}).openapi("OwnedItemExpanded");

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
    metadata: z.record(z.string(), z.unknown()).optional(),
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
    /** Achievement-plan horizon in days; null clears the plan. */
    target_days: z.number().int().positive().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("UpdateOwnedItemRequest");

export const ListOwnedItemsQuery = z.object({
  product_id: Uuid.optional(),
  location: z.string().optional(),
  /** Default: false → only currently-owned rows. */
  include_retired: z.coerce.boolean().optional(),
  /** `product` joins catalog + purchase context (OwnedItemExpanded rows). */
  expand: z.enum(["product"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
