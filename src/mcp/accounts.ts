/**
 * FastMCP tools for the `/v1/accounts` surface.
 *
 * Thin adapters: each tool calls the service function exported from
 * `src/routes/accounts.ts` directly (no HTTP self-call). The workspace
 * and user IDs are pinned to the seeded defaults until the auth epic
 * lands and an auth-resolving context becomes available to MCP tools.
 */
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { parseEtag } from "../http/etag.js";
import { PreconditionRequiredProblem } from "../http/problem.js";
import { SEED_WORKSPACE_ID } from "../db/seed.js";
import {
  listAccountsService,
  createAccountService,
  updateAccountService,
  getBalanceService,
  getRegisterService,
  getAccountService,
} from "../routes/accounts.js";
import {
  CreateAccountRequest,
  UpdateAccountRequest,
} from "../schemas/v1/account.js";

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerAccountsMcpTools(mcp: FastMCP): void {
  mcp.addTool({
    name: "list_accounts",
    description:
      "List chart-of-accounts. Default returns a nested tree (root accounts with children[]). " +
      "Pass flat=true for a flat list. Pass include_closed=true to include soft-closed accounts.",
    parameters: z.object({
      flat: z.boolean().optional(),
      include_closed: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await listAccountsService({
        workspaceId: SEED_WORKSPACE_ID,
        flat: args.flat,
        includeClosed: args.include_closed,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_account",
    description: "Fetch a single account by id.",
    parameters: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getAccountService(SEED_WORKSPACE_ID, args.id);
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "create_account",
    description:
      "Create a new account. If parent_id is supplied the parent's type must match; " +
      "currency is inherited from parent when omitted.",
    parameters: CreateAccountRequest,
    execute: async (args) => {
      const out = await createAccountService({
        workspaceId: SEED_WORKSPACE_ID,
        body: args,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "update_account",
    description:
      "Apply a merge-patch to an account. Requires if_match (weak ETag, e.g. 'W/\"3\"').",
    parameters: z.object({
      id: z.string().uuid(),
      patch: UpdateAccountRequest,
      if_match: z.string(),
    }),
    execute: async (args) => {
      const v = parseEtag(args.if_match);
      if (v === null) {
        throw new PreconditionRequiredProblem("If-Match");
      }
      const out = await updateAccountService({
        workspaceId: SEED_WORKSPACE_ID,
        id: args.id,
        patch: args.patch,
        ifMatchVersion: v,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "close_account",
    description:
      "Soft-close an account by setting closed_at=NOW(). Convenience wrapper over update_account. " +
      "Requires if_match.",
    parameters: z.object({
      id: z.string().uuid(),
      if_match: z.string(),
    }),
    execute: async (args) => {
      const v = parseEtag(args.if_match);
      if (v === null) {
        throw new PreconditionRequiredProblem("If-Match");
      }
      const out = await updateAccountService({
        workspaceId: SEED_WORKSPACE_ID,
        id: args.id,
        patch: { closed_at: new Date().toISOString() },
        ifMatchVersion: v,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_account_balance",
    description:
      "Point-in-time balance. Defaults: as_of=today, currency=workspace base, include_children=false.",
    parameters: z.object({
      id: z.string().uuid(),
      as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      include_children: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getBalanceService({
        workspaceId: SEED_WORKSPACE_ID,
        accountId: args.id,
        asOf: args.as_of,
        currency: args.currency,
        includeChildren: args.include_children,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_account_register",
    description:
      "Checkbook-style register with running balance, counter-postings, and linked documents. " +
      "Keyset-paginated via an opaque cursor.",
    parameters: z.object({
      id: z.string().uuid(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      include_voided: z.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getRegisterService({
        workspaceId: SEED_WORKSPACE_ID,
        accountId: args.id,
        from: args.from,
        to: args.to,
        includeVoided: args.include_voided,
        cursor: args.cursor,
        limit: args.limit,
      });
      return toJson(out);
    },
  });
}
