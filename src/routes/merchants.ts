/**
 * `/v1/merchants/*` — read-only merchant aggregation endpoints behind
 * the frontend merchant page (issue #33). Backend canonicalization +
 * Places enrichment are the write paths; see issue #64.
 *
 * Identifier semantics: routes accept either a UUID (the row's `id`) or
 * a kebab-case `brand_id`. The frontend uses brand_id for shareable URLs
 * (`/merchant/starbucks`); UUID is for internal cross-references.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { db } from "../db/client.js";
import { merchants } from "../schema/merchants.js";
import { parseOrThrow } from "../http/validate.js";
import { NotFoundProblem } from "../http/problem.js";
import {
  MerchantDetail,
  MerchantPathParams,
  MerchantTransactionsQuery,
  MerchantTransactionsResponse,
} from "../schemas/v1/merchant.js";
import { ProblemDetails } from "../schemas/v1/common.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

async function resolveMerchant(workspaceId: string, identifier: string) {
  const matchCol = UUID_RE.test(identifier) ? merchants.id : merchants.brandId;
  const rows = await db
    .select()
    .from(merchants)
    .where(and(eq(merchants.workspaceId, workspaceId), eq(matchCol, identifier)))
    .limit(1);
  return rows[0] ?? null;
}

function rowToMerchantDto(m: typeof merchants.$inferSelect) {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    brand_id: m.brandId,
    canonical_name: m.canonicalName,
    category: m.category,
    place_id: m.placeId,
    photo_url: m.photoUrl,
    photo_attribution: m.photoAttribution,
    address: m.address,
    lat: m.lat !== null ? Number(m.lat) : null,
    lng: m.lng !== null ? Number(m.lng) : null,
    enrichment_status: m.enrichmentStatus,
    enrichment_attempted_at:
      m.enrichmentAttemptedAt instanceof Date
        ? m.enrichmentAttemptedAt.toISOString()
        : m.enrichmentAttemptedAt,
    created_at:
      m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updated_at:
      m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
  };
}

export const merchantsRouter = Router({ mergeParams: true });

/**
 * GET /v1/merchants/:id — single merchant + KPIs.
 *
 * `:id` accepts uuid or brand_id. Voided transactions are excluded from
 * KPIs (lifetime/current-month spend); they remain visible in the
 * companion `/transactions` endpoint so the merchant page can render
 * them with strikethrough.
 */
merchantsRouter.get(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    const statsRow = await db.execute(sql`
      WITH s AS (
        SELECT
          COUNT(DISTINCT t.id)::bigint AS txn_count,
          COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint AS lifetime_spend,
          COALESCE(SUM(CASE
            WHEN p.amount_minor > 0
             AND t.occurred_on >= date_trunc('month', CURRENT_DATE)::date
             AND t.occurred_on <  (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
            THEN p.amount_minor ELSE 0
          END), 0)::bigint AS current_month_spend,
          MAX(t.occurred_on)::text AS last_date
        FROM transactions t
        JOIN postings p ON p.transaction_id = t.id
        WHERE t.workspace_id = ${req.ctx.workspaceId}::uuid
          AND t.merchant_id = ${merchant.id}::uuid
          AND t.status <> 'voided'
      )
      SELECT
        s.txn_count, s.lifetime_spend, s.current_month_spend, s.last_date,
        (SELECT base_currency FROM workspaces WHERE id = ${req.ctx.workspaceId}::uuid) AS currency
      FROM s
    `);
    const row = statsRow.rows[0] as {
      txn_count: string | number;
      lifetime_spend: string | number;
      current_month_spend: string | number;
      last_date: string | null;
      currency: string | null;
    };

    const body = {
      merchant: rowToMerchantDto(merchant),
      stats: {
        transaction_count: toInt(row.txn_count),
        lifetime_spend_minor: toInt(row.lifetime_spend),
        current_month_spend_minor: toInt(row.current_month_spend),
        last_transaction_date: row.last_date,
        currency: row.currency ?? "USD",
      },
    };
    res.json(body);
  }),
);

/**
 * GET /v1/merchants/:id/transactions — paginated list for the merchant
 * detail page. Sort is fixed at `occurred_on DESC, id DESC` (the same
 * keyset the ledger uses) so this can ride the
 * `transactions_merchant_idx` index. Cursor encodes "<date>|<id>".
 */
merchantsRouter.get(
  "/:id/transactions",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const q = parseOrThrow(MerchantTransactionsQuery, req.query);
    const merchant = await resolveMerchant(req.ctx.workspaceId, id);
    if (!merchant) throw new NotFoundProblem("Merchant", id);

    const limit = q.limit ?? 50;
    let cursorClause = sql``;
    if (q.cursor) {
      const [cDate, cId] = q.cursor.split("|");
      if (cDate && cId) {
        cursorClause = sql`AND (t.occurred_on, t.id) < (${cDate}::date, ${cId}::uuid)`;
      }
    }

    const result = await db.execute(sql`
      SELECT
        t.id,
        t.occurred_on::text AS occurred_on,
        t.payee,
        t.status::text AS status,
        (
          SELECT COALESCE(SUM(CASE WHEN p.amount_minor > 0 THEN p.amount_minor ELSE 0 END), 0)::bigint
          FROM postings p
          WHERE p.transaction_id = t.id
        ) AS total_minor,
        (
          SELECT p.currency FROM postings p WHERE p.transaction_id = t.id LIMIT 1
        ) AS currency,
        (
          SELECT dl.document_id
          FROM document_links dl
          WHERE dl.transaction_id = t.id
          ORDER BY dl.created_at ASC
          LIMIT 1
        ) AS document_id
      FROM transactions t
      WHERE t.workspace_id = ${req.ctx.workspaceId}::uuid
        AND t.merchant_id = ${merchant.id}::uuid
        ${cursorClause}
      ORDER BY t.occurred_on DESC, t.id DESC
      LIMIT ${limit + 1}
    `);

    const rows = result.rows as Array<{
      id: string;
      occurred_on: string;
      payee: string | null;
      status: "draft" | "posted" | "voided" | "reconciled" | "error";
      total_minor: string | number;
      currency: string | null;
      document_id: string | null;
    }>;

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      id: r.id,
      occurred_on: r.occurred_on,
      payee: r.payee,
      status: r.status,
      total_minor: toInt(r.total_minor),
      currency: r.currency ?? "USD",
      document_id: r.document_id,
    }));
    const next_cursor =
      hasMore && items.length > 0
        ? `${items[items.length - 1].occurred_on}|${items[items.length - 1].id}`
        : null;

    res.json({ items, next_cursor });
  }),
);

// ── OpenAPI registration ───────────────────────────────────────────────

const problemResponse = {
  content: { "application/problem+json": { schema: ProblemDetails } },
};

export function registerMerchantsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("MerchantDetail", MerchantDetail);
  registry.register("MerchantTransactionsResponse", MerchantTransactionsResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/merchants/{id}",
    summary: "Merchant detail + KPIs",
    description:
      "`id` accepts either the merchant row's UUID or its kebab-case `brand_id`.",
    tags: ["merchants"],
    request: {
      params: MerchantPathParams,
    },
    responses: {
      200: {
        description: "Merchant with aggregated stats",
        content: { "application/json": { schema: MerchantDetail } },
      },
      404: { description: "Merchant not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/merchants/{id}/transactions",
    summary: "Transactions for a merchant, newest first, keyset-paginated",
    tags: ["merchants"],
    request: {
      params: MerchantPathParams,
      query: MerchantTransactionsQuery,
    },
    responses: {
      200: {
        description: "Paginated transactions",
        content: {
          "application/json": { schema: MerchantTransactionsResponse },
        },
      },
      404: { description: "Merchant not found", ...problemResponse },
    },
  });
}
