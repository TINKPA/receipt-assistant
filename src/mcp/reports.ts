/**
 * FastMCP tools for the `/v1/reports/*` surface.
 *
 * Thin adapters: each tool calls the service function exported from
 * `src/routes/reports.ts` directly. Workspace is pinned to the seeded
 * default until the auth epic lands (same pattern as accounts.ts).
 */
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { SEED_WORKSPACE_ID } from "../db/seed.js";
import {
  getSummaryReport,
  getTrendsReport,
  getNetWorthReport,
  getCashflowReport,
} from "../routes/reports.js";

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);

export function registerReportsMcpTools(mcp: FastMCP): void {
  mcp.addTool({
    name: "get_summary_report",
    description:
      "Aggregate spend over a date range, grouped by category (default), account, or payee. " +
      "Returns per-group count + total + average, plus a grand total. " +
      "Voided transactions are excluded.",
    parameters: z.object({
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      group_by: z.enum(["category", "account", "payee"]).optional(),
      currency: Currency.optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getSummaryReport({
        workspaceId: SEED_WORKSPACE_ID,
        from: args.from,
        to: args.to,
        groupBy: args.group_by,
        currency: args.currency,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_trends_report",
    description:
      "Time-series trend of expense spend. period=month (default) or year. " +
      "group_by=total (default) for a single series, category for one series per category.",
    parameters: z.object({
      period: z.enum(["month", "year"]).optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      group_by: z.enum(["category", "total"]).optional(),
      currency: Currency.optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getTrendsReport({
        workspaceId: SEED_WORKSPACE_ID,
        period: args.period,
        from: args.from,
        to: args.to,
        groupBy: args.group_by,
        currency: args.currency,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_net_worth_report",
    description:
      "Point-in-time net worth: assets + liabilities + equity (liabilities are " +
      "typically negative; the sum is the intuitive 'what I own minus what I owe'). " +
      "Includes a per-account balance breakdown.",
    parameters: z.object({
      as_of: IsoDate.optional(),
      currency: Currency.optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getNetWorthReport({
        workspaceId: SEED_WORKSPACE_ID,
        asOf: args.as_of,
        currency: args.currency,
      });
      return toJson(out);
    },
  });

  mcp.addTool({
    name: "get_cashflow_report",
    description:
      "Inflows vs. outflows over a range, bucketed by month. income - expense = net. " +
      "Voided transactions are excluded.",
    parameters: z.object({
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      currency: Currency.optional(),
    }),
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const out = await getCashflowReport({
        workspaceId: SEED_WORKSPACE_ID,
        from: args.from,
        to: args.to,
        currency: args.currency,
      });
      return toJson(out);
    },
  });
}
