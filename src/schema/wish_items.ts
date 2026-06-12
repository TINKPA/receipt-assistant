/**
 * v2 redesign P3 (#149) — the wishlist mirror of `owned_items`.
 *
 * Same machinery as ownership, run forward: a wish carries a target
 * price and a planned lifespan, so the UI can project a $/day before
 * any money moves ("would push your portfolio from $8.32/d to
 * $8.59/d"). Wishes optionally link to a catalog product (price
 * history, variant identity); free-text wishes (a course, a used
 * chair) leave `product_id` NULL and stand on `title` alone.
 *
 * Lifecycle: `status` walks active → converted | declined. Converting
 * records the transaction that realized the wish — the wish row stays
 * as provenance ("wanted for 12 weeks before buying"). `snoozed_until`
 * parks a wish without deciding.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { products } from "./products.js";
import { transactions } from "./transactions.js";

export const wishItems = pgTable(
  "wish_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Optional catalog link; free-text wishes leave this NULL. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    notes: text("notes"),
    /** What you'd pay, in minor units. Drives the projected $/day. */
    targetPriceMinor: integer("target_price_minor"),
    currency: text("currency").notNull().default("USD"),
    /** Planned ownership horizon in days (e.g. 1825 = 5 years). */
    plannedDays: integer("planned_days"),
    /** now | soon | someday — the board's urgency pills. */
    urgency: text("urgency").notNull().default("someday"),
    /** Parked until this date; an active snooze renders as its own pill. */
    snoozedUntil: date("snoozed_until"),
    /** active | converted | declined. */
    status: text("status").notNull().default("active"),
    /** Set when status=converted: the transaction that realized the wish. */
    convertedTransactionId: uuid("converted_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [index("wish_items_workspace_status_idx").on(t.workspaceId, t.status)],
);
