/**
 * Zod schemas for `/v1/transactions` and its nested `postings`.
 */
import { z } from "zod";
import {
  AmountMinor,
  CurrencyCode,
  IsoDate,
  IsoDateTime,
  Metadata,
  Uuid,
} from "./common.js";
import { Place } from "./place.js";

export const TxnStatus = z.enum([
  "draft",
  "posted",
  "voided",
  "reconciled",
  "error",
]);

export const Posting = z
  .object({
    id: Uuid,
    transaction_id: Uuid,
    account_id: Uuid,
    amount_minor: AmountMinor,
    currency: CurrencyCode,
    fx_rate: z.string().nullable(), // numeric returned as string from pg
    amount_base_minor: AmountMinor.nullable(),
    memo: z.string().nullable(),
    created_at: IsoDateTime,
  })
  .openapi("Posting");

export const NewPosting = z
  .object({
    account_id: Uuid,
    amount_minor: AmountMinor,
    currency: CurrencyCode.optional(),
    fx_rate: z.string().optional(),
    amount_base_minor: AmountMinor.optional(),
    memo: z.string().optional(),
  })
  .openapi("NewPosting");

export const TransactionDocumentRef = z
  .object({
    id: Uuid,
    kind: z.string(),
  })
  .openapi("TransactionDocumentRef");

// Place schema moved to ./place.ts (#74). The Place is now a richer
// multilingual record — see src/schemas/v1/place.ts.

export const Transaction = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    occurred_on: IsoDate,
    occurred_at: IsoDateTime.nullable(),
    payee: z.string().nullable(),
    narration: z.string().nullable(),
    status: TxnStatus,
    voided_by_id: Uuid.nullable(),
    source_ingest_id: Uuid.nullable(),
    trip_id: Uuid.nullable(),
    metadata: Metadata,
    version: z.number().int(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    postings: z.array(Posting),
    documents: z.array(TransactionDocumentRef),
    place: Place.nullable(),
  })
  .openapi("Transaction");

export const CreateTransactionRequest = z
  .object({
    occurred_on: IsoDate,
    occurred_at: IsoDateTime.optional(),
    payee: z.string().optional(),
    narration: z.string().optional(),
    status: TxnStatus.optional(), // defaults to 'posted'
    postings: z.array(NewPosting).min(2),
    document_ids: z.array(Uuid).optional(),
    trip_id: Uuid.optional(),
    metadata: Metadata.optional(),
  })
  .openapi("CreateTransactionRequest");

export const UpdateTransactionRequest = z
  .object({
    occurred_on: IsoDate.optional(),
    occurred_at: IsoDateTime.nullable().optional(),
    payee: z.string().nullable().optional(),
    narration: z.string().nullable().optional(),
    trip_id: Uuid.nullable().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateTransactionRequest");

export const VoidTransactionRequest = z
  .object({
    reason: z.string().optional(),
  })
  .openapi("VoidTransactionRequest");

export const UnreconcileTransactionRequest = z
  .object({
    reason: z.string().optional(),
  })
  .openapi("UnreconcileTransactionRequest");

export const UpdatePostingRequest = z
  .object({
    account_id: Uuid.optional(),
    amount_minor: AmountMinor.optional(),
    currency: CurrencyCode.optional(),
    fx_rate: z.string().optional(),
    amount_base_minor: AmountMinor.optional(),
    memo: z.string().nullable().optional(),
  })
  .openapi("UpdatePostingRequest");

// Filter surface for GET /v1/transactions
export const ListTransactionsQuery = z.object({
  occurred_from: IsoDate.optional(),
  occurred_to: IsoDate.optional(),
  amount_min_minor: z.coerce.number().int().optional(),
  amount_max_minor: z.coerce.number().int().optional(),
  account_id: Uuid.optional(),
  payee_contains: z.string().optional(),
  q: z.string().optional(),
  status: TxnStatus.optional(),
  trip_id: Uuid.optional(),
  has_document: z.coerce.boolean().optional(),
  source_ingest_id: Uuid.optional(),
  sort: z.enum(["occurred_on", "amount", "created_at"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const ListPostingsQuery = z.object({
  transaction_id: Uuid.optional(),
  account_id: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// Bulk operations (RPC-style)
export const BulkOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), id: Uuid, if_match: z.string(), patch: UpdateTransactionRequest }),
  z.object({ op: z.literal("void"),   id: Uuid, if_match: z.string(), reason: z.string().optional() }),
  z.object({ op: z.literal("reconcile"), id: Uuid, if_match: z.string() }),
]);

export const BulkRequest = z
  .object({ operations: z.array(BulkOperation).min(1).max(100) })
  .openapi("BulkRequest");

export const BulkResultItem = z
  .object({
    index: z.number().int(),
    status: z.number().int(),
    body: z.unknown(),
  })
  .openapi("BulkResultItem");

export const BulkResponse = z
  .object({ results: z.array(BulkResultItem) })
  .openapi("BulkResponse");
