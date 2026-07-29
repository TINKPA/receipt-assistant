/**
 * Party-graph reads (v2 redesign P4, #149).
 *
 * GET /v1/transactions/:id/parties     all rows for one transaction
 * GET /v1/brands/:brandId/party-summary  role counts + marketplace share
 *
 * Writes happen inside the extraction prompt (4a-ter) and the channel
 * backfill script — no user-facing write surface.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { parseOrThrow } from "../http/validate.js";
import { TransactionParty, BrandPartySummary } from "../schemas/v1/party.js";
import { Uuid } from "../schemas/v1/common.js";

export const partiesRouter: Router = Router();

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToDto(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    transaction_id: row.transaction_id,
    transaction_item_id: row.transaction_item_id ?? null,
    role: row.role,
    display_name: row.display_name,
    brand_id: row.brand_id ?? null,
    metadata: row.metadata ?? {},
    created_at: toIsoString(row.created_at),
  };
}

// Mounted at /v1 — full paths declared here for clarity.

partiesRouter.get(
  "/transactions/:id/parties",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate before the query, not after: `${id}::uuid` hands the
      // raw param straight to Postgres, which raises SQLSTATE 22P02 on
      // anything non-uuid. That is neither an `HttpProblem` nor a
      // `ZodError`, so `problemHandler` can only render it as a generic
      // 500 — while the OpenAPI registration below already promises the
      // caller `params: { id: Uuid }`. Same idiom as transactions.ts /
      // postings.ts: 422 with violations.
      const { id } = parseOrThrow(z.object({ id: Uuid }), req.params);
      const result = await db.execute(sql`
        SELECT * FROM transaction_parties
        WHERE workspace_id = ${req.ctx.workspaceId}::uuid AND transaction_id = ${id}::uuid
        ORDER BY role, transaction_item_id NULLS FIRST, display_name
      `);
      res.json({ items: (result.rows as any[]).map(rowToDto) });
    } catch (err) {
      next(err);
    }
  },
);

partiesRouter.get(
  "/brands/:brandId/party-summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Deliberately NOT validated as a Uuid: `brand_id` is a kebab-case
      // slug (`MerchantBrandId` in schemas/v1/merchant.ts), the column is
      // `text`, and it is bound as a plain parameter with no `::uuid`
      // cast — so there is no 22P02 path to guard here, and a Uuid schema
      // would reject every legitimate id. Matches the OpenAPI
      // registration below (`brandId: z.string()`) and brands.ts, which
      // reads the same param raw. An unknown slug simply yields zero
      // counts.
      const brandId = String(req.params.brandId);
      const ws = req.ctx.workspaceId;
      const counts = await db.execute(sql`
        SELECT
          COUNT(DISTINCT transaction_id) FILTER (WHERE role = 'channel') AS channel_tx,
          COUNT(*) FILTER (WHERE role = 'seller') AS seller_lines,
          COUNT(*) FILTER (WHERE role = 'maker') AS maker_lines
        FROM transaction_parties
        WHERE workspace_id = ${ws}::uuid AND brand_id = ${brandId}
      `);
      const sellers = await db.execute(sql`
        SELECT s.display_name, s.brand_id, COUNT(*) AS line_count
        FROM transaction_parties c
        JOIN transaction_parties s
          ON s.transaction_id = c.transaction_id AND s.role = 'seller'
        WHERE c.workspace_id = ${ws}::uuid AND c.role = 'channel' AND c.brand_id = ${brandId}
        GROUP BY s.display_name, s.brand_id
        ORDER BY line_count DESC
        LIMIT 6
      `);
      const c = (counts.rows as any[])[0] ?? {};
      res.json({
        brand_id: brandId,
        as_channel_tx_count: Number(c.channel_tx ?? 0),
        as_seller_line_count: Number(c.seller_lines ?? 0),
        as_maker_line_count: Number(c.maker_lines ?? 0),
        top_sellers: (sellers.rows as any[]).map((r) => ({
          display_name: r.display_name,
          brand_id: r.brand_id ?? null,
          line_count: Number(r.line_count),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerPartiesOpenApi(registry: OpenAPIRegistry): void {
  registry.register("TransactionParty", TransactionParty);
  registry.register("BrandPartySummary", BrandPartySummary);

  registry.registerPath({
    method: "get",
    path: "/v1/transactions/{id}/parties",
    summary: "Party graph rows for one transaction (channel/seller/maker/acquirer)",
    tags: ["parties"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(TransactionParty) }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/brands/{brandId}/party-summary",
    summary: "Role counts + marketplace-seller share for a brand",
    tags: ["parties"],
    request: { params: z.object({ brandId: z.string() }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: BrandPartySummary } },
      },
    },
  });
}
