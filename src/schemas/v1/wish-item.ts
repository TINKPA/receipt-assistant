/**
 * `wish_items` zod schema (v2 redesign P3, tracking #149). The wishlist
 * mirror of `owned_items`: target price + planned lifespan project a
 * $/day before any money moves. Optional catalog link via `product_id`;
 * free-text wishes stand on `title` alone.
 */
import { z } from "zod";
import { IsoDate, IsoDateTime, Metadata, Uuid } from "./common.js";

export const WishUrgency = z.enum(["now", "soon", "someday"]);
export const WishStatus = z.enum(["active", "converted", "declined"]);

export const WishItem = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    /** NULL for free-text wishes (a course, a used chair). */
    product_id: Uuid.nullable(),
    title: z.string(),
    notes: z.string().nullable(),
    /** What you'd pay, in minor units. Drives the projected $/day. */
    target_price_minor: z.number().int().nullable(),
    currency: z.string(),
    /** Planned ownership horizon in days (1825 = 5 years). */
    planned_days: z.number().int().nullable(),
    urgency: WishUrgency,
    /** Parked until this date; an active snooze renders as its own pill. */
    snoozed_until: IsoDate.nullable(),
    status: WishStatus,
    /** Set when status=converted: the transaction that realized the wish. */
    converted_transaction_id: Uuid.nullable(),
    metadata: Metadata,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("WishItem");

export const CreateWishItemRequest = z
  .object({
    title: z.string().min(1),
    product_id: Uuid.optional(),
    notes: z.string().optional(),
    target_price_minor: z.number().int().positive().optional(),
    currency: z.string().optional(),
    planned_days: z.number().int().positive().optional(),
    urgency: WishUrgency.optional(),
    snoozed_until: IsoDate.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateWishItemRequest");

export const UpdateWishItemRequest = z
  .object({
    title: z.string().min(1).optional(),
    product_id: Uuid.nullable().optional(),
    notes: z.string().nullable().optional(),
    target_price_minor: z.number().int().positive().nullable().optional(),
    planned_days: z.number().int().positive().nullable().optional(),
    urgency: WishUrgency.optional(),
    snoozed_until: IsoDate.nullable().optional(),
    /** active → converted | declined; converting may carry the realizing
     *  transaction id. Setting back to active un-decides. */
    status: WishStatus.optional(),
    converted_transaction_id: Uuid.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("UpdateWishItemRequest");

export const ListWishItemsQuery = z.object({
  status: WishStatus.optional(),
  urgency: WishUrgency.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
