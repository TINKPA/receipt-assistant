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
    /**
     * Layer-3 user override (#79 Phase C). Brand-level rename that
     * `displayName()` prefers over Google/OCR-derived names when no
     * per-place override is set. Workspace-scoped via the merchants
     * row; re-extract never touches this field.
     */
    custom_name: z.string().nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Merchant");

/**
 * PATCH /v1/merchants/:id body (#79 Phase C). Currently exposes only
 * the brand-level rename; other merchant fields are agent-owned via
 * the ingest extractor and not user-editable from this endpoint.
 *
 * Pass `null` to clear the override (revert to displayName cascade).
 */
export const UpdateMerchantRequest = z
  .object({
    custom_name: z.string().max(200).nullable().optional(),
  })
  .strict()
  .openapi("UpdateMerchantRequest");

/** Shared wording: every money figure on the merchant and brand
 *  endpoints is a base-currency amount, whatever the receipt was in. */
export const BASE_AMOUNT_DESCRIPTION =
  "In the workspace base currency (`currency`), summed from the " +
  "postings' base amounts. A receipt in another currency counts at the " +
  "rate it was converted at, and a loyalty-points leg at its programme " +
  "valuation, exactly as in `/v1/reports/summary`.";

export const BASE_CURRENCY_DESCRIPTION =
  "The workspace base currency. Always an ISO 4217 code, never a " +
  "points-programme code.";

/**
 * Aggregated KPIs computed by the merchant detail endpoint. Both spend
 * figures are sums of base-currency amounts, so a merchant with receipts
 * in several currencies (or paid partly in points) still adds up to one
 * meaningful number, and it matches the merchant's row in
 * `/v1/reports/summary?group_by=payee`.
 */
export const MerchantStats = z
  .object({
    transaction_count: z.number().int().nonnegative(),
    lifetime_spend_minor: z
      .number()
      .int()
      .openapi({ description: BASE_AMOUNT_DESCRIPTION }),
    current_month_spend_minor: z
      .number()
      .int()
      .openapi({ description: BASE_AMOUNT_DESCRIPTION }),
    last_transaction_date: z.string().nullable(),
    currency: z.string().openapi({ description: BASE_CURRENCY_DESCRIPTION }),
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
 *  transaction shape is still reachable via `/v1/transactions/:id`.
 *
 *  `total_minor` is the signed expense total in the workspace base
 *  currency and `currency` is that base currency on every row. The
 *  amount and currency the receipt itself was in are on the full
 *  transaction's postings. */
export const MerchantTransactionRow = z
  .object({
    id: Uuid,
    occurred_on: z.string(),
    payee: z.string().nullable(),
    status: z.enum(["draft", "posted", "reconciled", "error"]),
    total_minor: z.number().int().openapi({
      description:
        "Signed expense total (negative for a refund). " +
        BASE_AMOUNT_DESCRIPTION,
    }),
    currency: z.string().openapi({ description: BASE_CURRENCY_DESCRIPTION }),
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
