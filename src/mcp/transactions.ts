/**
 * FastMCP tools for the `/v1/transactions` surface.
 *
 * Thin adapters that call the service functions in
 * `src/routes/transactions.service.ts` directly — no HTTP self-call,
 * no Express round-trip.
 *
 * Workspace + user IDs are pinned to the seeded defaults until auth
 * lands. `if_match` parameters accept either a raw integer version or a
 * standard weak-ETag string `W/"<n>"`.
 */
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { parseEtag } from "../http/etag.js";
import { PreconditionRequiredProblem } from "../http/problem.js";
import { SEED_USER_ID, SEED_WORKSPACE_ID } from "../db/seed.js";
import {
  createTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
  voidTransaction,
} from "../routes/transactions.service.js";
import {
  CreateTransactionRequest,
  UpdateTransactionRequest,
  ListTransactionsQuery,
} from "../schemas/v1/transaction.js";

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Accept either a numeric version or a weak-ETag string. */
function resolveIfMatch(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const n = parseEtag(raw);
  if (n === null) {
    // Allow a bare integer-as-string (e.g. "3").
    const asNum = Number(raw);
    if (Number.isInteger(asNum) && asNum >= 0) return asNum;
    throw new PreconditionRequiredProblem("If-Match");
  }
  return n;
}

export function registerTransactionsMcpTools(mcp: FastMCP): void {
  mcp.addTool({
    name: "create_transaction",
    description:
      "Create a balanced double-entry transaction. Postings must sum to zero in base-currency minor units. " +
      "Optional document_ids[] link receipts/statements. Optional idempotency_key for safe retries.",
    parameters: CreateTransactionRequest,
    execute: async (args) => {
      const out = await createTransaction(SEED_WORKSPACE_ID, SEED_USER_ID, args);
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "list_transactions",
    description:
      "List transactions with filters: occurred_from/to, amount range, payee/narration search (q), " +
      "account_id, status, has_document, trip_id. Keyset-paginated via opaque cursor.",
    parameters: ListTransactionsQuery,
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await listTransactions(SEED_WORKSPACE_ID, args);
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_transaction",
    description: "Fetch a single transaction with its postings and linked documents.",
    parameters: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getTransaction(SEED_WORKSPACE_ID, args.id);
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "update_transaction",
    description:
      "Apply a merge-patch to a transaction's head fields (payee, narration, occurred_on, occurred_at, " +
      "trip_id, metadata). Requires if_match (weak ETag 'W/\"3\"' or bare integer).",
    parameters: z.object({
      id: z.string().uuid(),
      patch: UpdateTransactionRequest,
      if_match: z.string(),
    }),
    execute: async (args) => {
      const version = resolveIfMatch(args.if_match);
      const out = await updateTransaction(
        SEED_WORKSPACE_ID,
        SEED_USER_ID,
        args.id,
        version,
        args.patch,
      );
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "void_transaction",
    description:
      "Void a posted transaction by inserting a mirror with negated postings. The original flips to " +
      "status='voided' and voided_by_id points to the mirror. Requires if_match.",
    parameters: z.object({
      id: z.string().uuid(),
      reason: z.string().optional(),
      if_match: z.string(),
    }),
    execute: async (args) => {
      const version = resolveIfMatch(args.if_match);
      const out = await voidTransaction(
        SEED_WORKSPACE_ID,
        SEED_USER_ID,
        args.id,
        version,
        args.reason,
      );
      return toJson(out);
    },
  });
}
