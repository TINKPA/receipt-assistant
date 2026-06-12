/**
 * `transaction_parties` zod schema (v2 redesign P4, #149).
 */
import { z } from "zod";
import { IsoDateTime, Metadata, Uuid } from "./common.js";

export const PartyRole = z.enum(["channel", "seller", "maker", "acquirer"]);

export const TransactionParty = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    transaction_id: Uuid,
    /** NULL for tx-level roles. */
    transaction_item_id: Uuid.nullable(),
    role: PartyRole,
    /** The party string as printed on the receipt. */
    display_name: z.string(),
    /** brands.brand_id when resolved; NULL keeps the row useful as text. */
    brand_id: z.string().nullable(),
    metadata: Metadata,
    created_at: IsoDateTime,
  })
  .openapi("TransactionParty");

export const BrandPartySummary = z
  .object({
    brand_id: z.string(),
    /** Transactions where this brand was the channel. */
    as_channel_tx_count: z.number().int(),
    /** Lines where this brand was the seller. */
    as_seller_line_count: z.number().int(),
    /** Lines where this brand made the product. */
    as_maker_line_count: z.number().int(),
    /** Top sellers seen through this brand as a channel (marketplace share). */
    top_sellers: z.array(
      z.object({
        display_name: z.string(),
        brand_id: z.string().nullable(),
        line_count: z.number().int(),
      }),
    ),
  })
  .openapi("BrandPartySummary");
