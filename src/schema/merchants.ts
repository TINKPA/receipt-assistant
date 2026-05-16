import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { merchantEnrichmentStatusEnum } from "./enums.js";
import { createdAt, updatedAt } from "./common.js";
import { workspaces } from "./workspaces.js";
import { brands } from "./brands.js";

/**
 * Canonicalized merchants, the aggregation root behind the merchant page
 * (issue #33). Populated by the ingest extractor when it emits a
 * `merchant` block (`{ canonical_name, brand_id, category, locality }`);
 * subsequent receipts at the same brand reuse the existing row.
 *
 * Workspace-scoped: each workspace maintains its own merchant list so
 * different tenants can disagree about canonical names without poisoning
 * each other. The same brand visited by two users is two rows.
 *
 * `place_id`/`photo_url`/`address`/`lat`/`lng` are populated by an
 * asynchronous Google Places enrichment job after the merchant row is
 * created. Until that job runs, `enrichment_status='pending'` and the
 * frontend falls back to a category-color hero on the merchant page.
 */
export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Kebab-case stable identifier emitted by the extractor — same brand
     * should always collapse to the same id (e.g. `starbucks`, `apple-store`).
     * Used in frontend URLs as the path segment for the merchant page.
     * FK into the global `brands` registry (#101) — every merchant row's
     * `brand_id` must correspond to a `brands.brand_id` PK. Phase 2.6
     * of the ingest prompt upserts the brand row before the merchant
     * UPSERT in Phase 4.
     */
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.brandId),
    /** Display name (e.g. "Starbucks", "Apple Store"). */
    canonicalName: text("canonical_name").notNull(),
    /**
     * One of the seven spending categories (see frontend `CATEGORIES`).
     * Nullable when the extractor was uncertain — frontend renders the
     * neutral "uncategorized" fallback.
     */
    category: text("category"),
    /** Google Places `place_id` once enrichment lands. */
    placeId: text("place_id"),
    /** CDN URL of the cached Places photo (Google's photo URLs are short-lived). */
    photoUrl: text("photo_url"),
    /** Required by Google Places ToS — store the HTML attribution string. */
    photoAttribution: text("photo_attribution"),
    address: text("address"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    enrichmentStatus: merchantEnrichmentStatusEnum("enrichment_status")
      .notNull()
      .default("pending"),
    /** Last attempt at enrichment; used to back off retries on `failed`. */
    enrichmentAttemptedAt: timestamp("enrichment_attempted_at", {
      withTimezone: true,
    }),
    /**
     * Layer-3 user override (#79 Phase C). Brand-level rename — when
     * set, frontend `displayName()` prefers this over Google/OCR-derived
     * names when no per-place override is set. One rename here
     * propagates to every place row under this brand_id within the
     * workspace; users who've been to N branches no longer have to
     * rename each individually. Workspace-scoped (re: the table-level
     * contract), and never touched by re-extract.
     */
    customName: text("custom_name"),
    createdAt,
    updatedAt,
  },
  (t) => [
    // brand_id is unique per workspace, not globally — see header.
    uniqueIndex("merchants_workspace_brand_idx").on(t.workspaceId, t.brandId),
    // Trigram fuzzy search on canonical_name is useful for admin merge UX
    // but requires pg_trgm; defer the index until that extension is enabled.
    index("merchants_workspace_idx").on(t.workspaceId),
    index("merchants_enrichment_pending_idx").on(t.enrichmentStatus),
    // Defense in depth: keep brand_id well-formed at the DB layer too.
    check(
      "merchants_brand_id_format",
      sql`${t.brandId} ~ '^[a-z0-9-]+$'`,
    ),
  ],
);
