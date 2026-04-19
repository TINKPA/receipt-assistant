/**
 * Zod schemas for `/v1/accounts` and its derived views.
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

export const AccountType = z.enum([
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

const baseAccountFields = {
  id: Uuid,
  workspace_id: Uuid,
  parent_id: Uuid.nullable(),
  code: z.string().nullable(),
  name: z.string().min(1),
  type: AccountType,
  subtype: z.string().nullable(),
  currency: CurrencyCode,
  institution: z.string().nullable(),
  last4: z.string().nullable(),
  opening_balance_minor: AmountMinor,
  closed_at: IsoDateTime.nullable(),
  metadata: Metadata,
  version: z.number().int(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
};

export const Account = z.object(baseAccountFields).openapi("Account");

export const AccountTreeNode: z.ZodType<any> = z
  .object({
    ...baseAccountFields,
    children: z.lazy(() => z.array(AccountTreeNode)).default([]),
  })
  .openapi("AccountTreeNode");

export const CreateAccountRequest = z
  .object({
    parent_id: Uuid.optional(),
    code: z.string().optional(),
    name: z.string().min(1),
    type: AccountType,
    subtype: z.string().optional(),
    currency: CurrencyCode.optional(), // inherit from parent if omitted
    institution: z.string().optional(),
    last4: z.string().optional(),
    opening_balance_minor: AmountMinor.optional(),
    metadata: Metadata.optional(),
  })
  .openapi("CreateAccountRequest");

export const UpdateAccountRequest = z
  .object({
    code: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    subtype: z.string().nullable().optional(),
    institution: z.string().nullable().optional(),
    last4: z.string().nullable().optional(),
    parent_id: Uuid.nullable().optional(),
    closed_at: IsoDateTime.nullable().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateAccountRequest");

export const AccountBalance = z
  .object({
    account_id: Uuid,
    as_of: IsoDate,
    balance_minor: AmountMinor,
    currency: CurrencyCode,
    posting_count: z.number().int(),
    includes_children: z.boolean(),
  })
  .openapi("AccountBalance");

export const RegisterCounterPosting = z
  .object({
    account_id: Uuid,
    name: z.string(),
    amount_minor: AmountMinor,
  })
  .openapi("RegisterCounterPosting");

export const RegisterDocumentRef = z
  .object({
    id: Uuid,
    kind: z.string(),
  })
  .openapi("RegisterDocumentRef");

export const RegisterItem = z
  .object({
    posting_id: Uuid,
    transaction_id: Uuid,
    transaction_version: z.number().int(),
    occurred_on: IsoDate,
    payee: z.string().nullable(),
    narration: z.string().nullable(),
    amount_minor: AmountMinor,
    currency: CurrencyCode,
    running_balance_after_minor: AmountMinor,
    counter_postings: z.array(RegisterCounterPosting),
    documents: z.array(RegisterDocumentRef),
  })
  .openapi("RegisterItem");

export const AccountRegister = z
  .object({
    account_id: Uuid,
    items: z.array(RegisterItem),
    next_cursor: z.string().nullable(),
  })
  .openapi("AccountRegister");

export const ListAccountsQuery = z.object({
  flat: z.coerce.boolean().optional(),
  include_closed: z.coerce.boolean().optional(),
});

export const BalanceQuery = z.object({
  as_of: IsoDate.optional(),
  currency: CurrencyCode.optional(),
  include_children: z.coerce.boolean().optional(),
});

export const RegisterQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  include_voided: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
