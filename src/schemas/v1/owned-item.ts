/**
 * `owned_items` zod schema (#84 Phase 2). Physical-instance inventory:
 * the agent creates N rows for a quantity-N durable purchase; the user
 * fills in serial / location / warranty / condition / notes per row.
 *
 * Manually-added items (gifts, secondhand, inherited) leave
 * `transaction_item_id = NULL`.
 */
import { z } from "zod";
import {
  IsoDate,
  IsoDateTime,
  Metadata,
  QueryBoolean,
  Uuid,
} from "./common.js";

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
    cost_basis_minor: z.number().int().nonnegative().nullable().openapi({
      description:
        "The instance's full cost in the workspace base currency, minor units, as entered by the user. Set it when the linked receipt line does not carry the price: a carrier-financed phone whose receipt shows only the sales tax, a gift with a known value. Null means the cost is whatever the linked line says (`paid_base_minor`). Extraction never writes it.",
    }),
    sale_proceeds_minor: z.number().int().nonnegative().nullable().openapi({
      description:
        "What the instance was sold or traded in for, workspace base currency, minor units. Null: not sold, or the amount is unknown.",
    }),
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
  /** This instance's share of what the line cost (the line divided by the
   *  units it covers, so each of "3 x" gets a third), **in the currency
   *  the line was recorded in** —
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
  /** What the item cost, base currency: `cost_basis_minor` when the user
   *  set one, else `paid_base_minor`. Null when neither is known. This is
   *  the figure to show and to divide; `paid_base_minor` stays what the
   *  receipt line says. */
  effective_cost_minor: z.number().int().nullable().optional(),
  payee: z.string().nullable().optional(),
  merchant_brand_id: z.string().nullable().optional(),
}).openapi("OwnedItemExpanded");

export const CreateOwnedItemRequest = z
  .object({
    product_id: Uuid,
    /** Optional — manual entries (gifts) skip this. */
    transaction_item_id: Uuid.optional().openapi({
      description:
        "The purchase line this item came from. Pass it whenever the purchase is known: `paid_minor` and the $/day figure derive from the linked line, so an item created without it has both permanently null. Omit only for items with no purchase (gifts, inherited).",
    }),
    instance_index: z.number().int().positive().optional(),
    serial_number: z.string().optional(),
    location: z.string().optional(),
    acquired_on: IsoDate.optional(),
    warranty_until: IsoDate.optional(),
    condition: z.string().optional(),
    cost_basis_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    sale_proceeds_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    notes: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
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
    /** Base currency, minor units; null clears it (the cost falls back to
     *  the linked receipt line). */
    cost_basis_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    sale_proceeds_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("UpdateOwnedItemRequest");

export const ListOwnedItemsQuery = z.object({
  product_id: Uuid.optional(),
  location: z.string().optional(),
  /** Default: false → only currently-owned rows. */
  include_retired: QueryBoolean.optional(),
  /** `product` joins catalog + purchase context (OwnedItemExpanded rows). */
  expand: z.enum(["product"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
