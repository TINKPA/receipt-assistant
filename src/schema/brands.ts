/**
 * #101 — global brand registry + multi-candidate asset table.
 *
 * `brands` is shared across workspaces (the same brand resolves to one
 * row regardless of who's looking). `brand_assets` retains every icon
 * candidate ingest acquires; the agent later picks one via
 * `preferred_asset_id`. NULL preferred is a first-class outcome — the
 * frontend renders CategoryIcon fallback.
 *
 * `tier` is provenance ("where this asset came from"), NOT priority.
 * The render path does NOT consult tier; it reads `preferred_asset_id`
 * directly.
 *
 * Layer separation (#80):
 *   - raw      : local_path, source_url, tier, content_hash, dimensions
 *   - derived  : agent_relevance, agent_notes, extraction_version
 *   - user     : user_rating, user_uploaded, user_notes, user_chose_at
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  smallint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const brands = pgTable("brands", {
  /** Stable kebab-case identifier — matches the `brand_id` text on
   *  `merchants.brand_id` (#64) and `products.brand_id` (#84). */
  brandId: text("brand_id").primaryKey(),
  /** Self-FK for sub-brand → parent (e.g. costco-gas → costco). */
  parentId: text("parent_id").references((): AnyPgColumn => brands.brandId, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  domain: text("domain"),
  /** Currently-preferred asset id. NULL → no acceptable candidate
   *  yet; frontend renders CategoryIcon. */
  preferredAssetId: uuid("preferred_asset_id"),
  /** Layer-3 lock — when NOT NULL, re-extract leaves
   *  `preferred_asset_id` alone (user has chosen). */
  userChoseAt: timestamp("user_chose_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
});

export const brandAssets = pgTable(
  "brand_assets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.brandId, { onDelete: "cascade" }),
    tier: text("tier").notNull(),
    sourceUrl: text("source_url"),
    /** Path under `~/Developer/receipt-assistant-data/brand-assets/`,
     *  bind-mounted into the container at `/data/brand-assets`. */
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
    uniqueIndex("brand_assets_brand_hash_uq").on(t.brandId, t.contentHash),
    index("brand_assets_brand_idx").on(t.brandId),
    index("brand_assets_brand_tier_idx").on(t.brandId, t.tier),
    check(
      "brand_assets_tier_ck",
      sql`${t.tier} IN ('itunes','svgl','logo_dev','simple_icons','user_upload','manual_url')`,
    ),
  ],
);
