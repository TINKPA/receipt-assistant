/**
 * #84 Phase 1 — canonical product catalog.
 *
 * Variant granularity is per-row: iPhone-Black-256 and iPhone-White-256
 * are two distinct products. color / model / size / variant live on
 * the row, so each variant is its own catalog entry.
 *
 * Multi-currency: the same product bought in different currencies stays
 * one row. Aggregate stats (`purchase_count`, `total_spent_minor`,
 * `first_purchased_on`, `last_purchased_on`) are recomputed from the
 * live (`retired_at IS NULL`) set of `transaction_items` pointing at
 * the product — never incremented, no drift under re-extract / merge.
 *
 * Hard-coding budget: only `item_class` carries a CHECK constraint
 * because it's the primary downstream filter. Everything else
 * (`condition`, `line_type`, free-text variant fields) is recommended
 * via the prompt but stored as plain text so the agent can invent a
 * snake_case label when the recommended set doesn't fit.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { merchants } from "./merchants.js";

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productKey: text("product_key").notNull(),
    canonicalName: text("canonical_name").notNull(),
    /** NULL → portable across merchants (iPhone); NOT NULL → exclusive
     *  to that merchant (Crunchwrap @ Taco Bell). User-editable. */
    merchantId: uuid("merchant_id").references(() => merchants.id, {
      onDelete: "set null",
    }),
    /** Text, not FK — the manufacturer (`apple`) can differ from the
     *  seller (`best-buy`). A soft join against `merchants.brand_id`
     *  covers cases where the brand is itself a known merchant. */
    brandId: text("brand_id"),
    itemClass: text("item_class").notNull(),

    // Product-level attribute facets — each variant gets its own row.
    model: text("model"),
    color: text("color"),
    size: text("size"),
    variant: text("variant"),
    sku: text("sku"),
    manufacturer: text("manufacturer"),

    // Aggregate stats — recomputed from live transaction_items, never
    // incremented. All money in workspace base currency.
    firstPurchasedOn: date("first_purchased_on"),
    lastPurchasedOn: date("last_purchased_on"),
    purchaseCount: integer("purchase_count").notNull().default(0),
    totalSpentMinor: bigint("total_spent_minor", { mode: "number" })
      .notNull()
      .default(0),

    // Layer-3 (user truth) — never overwritten by re-extract.
    customName: text("custom_name"),
    notes: text("notes"),
    retiredFromCatalogAt: timestamp("retired_from_catalog_at", {
      withTimezone: true,
    }),

    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    // Aggregation key — NULLS NOT DISTINCT so merchant_id=NULL
    // (portable products) participate. Drizzle's unique index doesn't
    // expose nulls-not-distinct directly; the migration SQL adds the
    // clause manually.
    uniqueIndex("products_workspace_merchant_key_uq").on(
      t.workspaceId,
      t.merchantId,
      t.productKey,
    ),
    index("products_workspace_class_idx").on(t.workspaceId, t.itemClass),
    index("products_workspace_brand_idx").on(t.workspaceId, t.brandId),
    index("products_workspace_merchant_idx").on(t.workspaceId, t.merchantId),
    check(
      "products_item_class_ck",
      sql`${t.itemClass} IN ('durable','consumable','food_drink','service','other')`,
    ),
  ],
);
