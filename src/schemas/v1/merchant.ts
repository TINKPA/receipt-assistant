/**
 * Zod schemas for `/v1/merchants` — the aggregation root behind the
 * frontend merchant page (issue #33). Read-only at this layer; write
 * paths happen indirectly through the ingest extractor emitting a
 * `merchant` block.
 */
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.js";

export const MerchantBrandId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9-]+$/, "brand_id must be kebab-case (lowercase, digits, dashes)");

export const MerchantEnrichmentStatus = z.enum([
  "pending",
  "success",
  "not_found",
  "failed",
]);

export const Merchant = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    brand_id: MerchantBrandId,
    canonical_name: z.string(),
    category: z.string().nullable(),
    place_id: z.string().nullable(),
    photo_url: z.string().nullable(),
    photo_attribution: z.string().nullable(),
    address: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    enrichment_status: MerchantEnrichmentStatus,
    enrichment_attempted_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Merchant");

/**
 * Aggregated KPIs computed by the merchant detail endpoint. Currency is
 * the workspace's base currency; cross-currency rollups are out of scope
 * for this iteration.
 */
export const MerchantStats = z
  .object({
    transaction_count: z.number().int().nonnegative(),
    lifetime_spend_minor: z.number().int(),
    current_month_spend_minor: z.number().int(),
    last_transaction_date: z.string().nullable(),
    currency: z.string(),
  })
  .openapi("MerchantStats");

export const MerchantDetail = z
  .object({
    merchant: Merchant,
    stats: MerchantStats,
  })
  .openapi("MerchantDetail");

/** Compact transaction shape returned by `/v1/merchants/:id/transactions`.
 *  Mirrors the fields the merchant page list rows need; the full
 *  transaction shape is still reachable via `/v1/transactions/:id`. */
export const MerchantTransactionRow = z
  .object({
    id: Uuid,
    occurred_on: z.string(),
    payee: z.string().nullable(),
    status: z.enum(["draft", "posted", "voided", "reconciled", "error"]),
    total_minor: z.number().int(),
    currency: z.string(),
    document_id: Uuid.nullable(),
  })
  .openapi("MerchantTransactionRow");

export const MerchantTransactionsResponse = z
  .object({
    items: z.array(MerchantTransactionRow),
    next_cursor: z.string().nullable(),
  })
  .openapi("MerchantTransactionsResponse");

export const MerchantTransactionsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .openapi("MerchantTransactionsQuery");

/** Path identifier — accepts either a UUID or a brand_id slug. */
export const MerchantIdentifier = z.union([Uuid, MerchantBrandId]);

export const MerchantPathParams = z
  .object({ id: z.string().min(1) })
  .openapi("MerchantPathParams");
