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
  smallint,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { merchants } from "./merchants.js";
import { brands } from "./brands.js";

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
    /** FK into the global `brands` registry (#101). Manufacturer brand,
     *  may differ from the seller (Crunchwrap branded `taco-bell` sold
     *  at a Best Buy → `brand_id='taco-bell'` here, merchant separately
     *  identifies Best Buy). Nullable: line items without a recognizable
     *  brand (raw groceries, services) leave it NULL. */
    brandId: text("brand_id").references(() => brands.brandId),
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

    // Product imagery (#159, mirrors the #101 brand-asset pattern).
    // `productAssets` retains every candidate; the chosen one is pointed
    // at here. NULL preferred → frontend renders a category fallback.
    preferredAssetId: uuid("preferred_asset_id"),
    /** Layer-3 lock — when NOT NULL, re-extract / re-seed leaves
     *  `preferred_asset_id` alone (a choice has been made). */
    preferredAssetChosenAt: timestamp("preferred_asset_chosen_at", {
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

/**
 * #159 — multi-candidate product imagery, mirroring `brand_assets`
 * (#101). Each row is one product hero/photo candidate. `tier` is
 * provenance ("where this image came from"), NOT priority. The render
 * path does NOT consult tier; it reads `products.preferred_asset_id`.
 *
 * Layer separation:
 *   - raw      : local_path, source_url, tier, content_hash, dimensions
 *   - derived  : agent_relevance, agent_notes, extraction_version
 *   - user     : user_rating, user_uploaded, user_notes
 */
export const productAssets = pgTable(
  "product_assets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: "cascade" }),
    tier: text("tier").notNull(),
    sourceUrl: text("source_url"),
    /** Path under `~/Developer/receipt-assistant-data/product-assets/`,
     *  bind-mounted into the container at `/data/product-assets`. */
    localPath: text("local_path").notNull(),
    /** Content-addressable dedup key. */
    contentHash: text("content_hash").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    /** Bumped on byte-equal re-acquisition. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),

    // Derived layer.
    agentRelevance: smallint("agent_relevance"),
    agentNotes: text("agent_notes"),
    extractionVersion: integer("extraction_version").notNull().default(1),

    // User-truth layer.
    userRating: smallint("user_rating"),
    userUploaded: boolean("user_uploaded").notNull().default(false),
    userNotes: text("user_notes"),

    retiredAt: timestamp("retired_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    uniqueIndex("product_assets_product_hash_uq").on(t.productId, t.contentHash),
    index("product_assets_product_idx").on(t.productId),
    check(
      "product_assets_tier_ck",
      sql`${t.tier} IN ('manual_seed','user_upload','agent_fetch')`,
    ),
  ],
);
