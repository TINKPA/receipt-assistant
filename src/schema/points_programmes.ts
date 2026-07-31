import { pgTable, varchar, text, jsonb } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./common.js";

/**
 * Loyalty-programme registry (#206).
 *
 * World-level, like `fx_rates`: "World of Hyatt points are called
 * HYATT_PT and one point is the whole unit" is a fact about the world,
 * not about a tenant. What a point is *worth* is emphatically not — that
 * is a personal judgement and lives per workspace in `points_valuations`.
 *
 * The table is a naming registry, not a constraint: `postings.currency`
 * carries no FK to it, because the currency-shape CHECK already keeps the
 * cash and points namespaces disjoint (see `src/points/codes.ts`) and a
 * hard FK would fail an ingest for an unregistered programme rather than
 * recording the stay and flagging it. An unregistered code is a visible
 * gap in the reports, not a write error.
 */
export const pointsProgrammes = pgTable("points_programmes", {
  /** Points currency code, e.g. `HYATT_PT`. Matches POINTS_CURRENCY_RE. */
  code: varchar("code", { length: 16 }).primaryKey(),
  /** Display name, e.g. "World of Hyatt points". */
  name: text("name").notNull(),
  /** Optional link to the issuing brand in `brands.brand_id`. */
  issuerBrandId: text("issuer_brand_id"),
  /**
   * Free-form provenance / caveats, e.g. where a seeded valuation came
   * from and what still needs the owner's confirmation.
   */
  notes: text("notes"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt,
  updatedAt,
});
