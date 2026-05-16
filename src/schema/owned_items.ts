/**
 * #84 Phase 2 — physical-instance inventory.
 *
 * The agent decides at ingest whether a `durable` line item is worth
 * tracking as a real-world thing (price × uniqueness × warranty-
 * relevance × likely-to-need-serial). No threshold; pure judgment.
 *
 * Quantity > 1 spawns N rows (instance_index 1..N). The user fills in
 * serial / location / warranty / condition / notes per row.
 *
 * `transaction_item_id` is nullable because gifts, secondhand,
 * inherited items deserve to be in inventory without a fabricated
 * receipt. Manually-created rows leave it NULL.
 *
 * Idempotency: UNIQUE (transaction_item_id, instance_index) makes
 * the auto-create step a no-op on re-run. PG treats NULLs as
 * distinct → manual rows are unconstrained, each its own entry.
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { products } from "./products.js";
import { transactionItems } from "./transaction_items.js";

export const ownedItems = pgTable(
  "owned_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** NULL for gifts / secondhand / manually-added inventory. */
    transactionItemId: uuid("transaction_item_id").references(
      () => transactionItems.id,
      { onDelete: "set null" },
    ),
    instanceIndex: integer("instance_index").notNull().default(1),
    serialNumber: text("serial_number"),
    /** Free-text location string ("书桌抽屉", "客厅", "妈妈家"). */
    location: text("location"),
    /** Defaults to the linked tx's `occurred_on`; user-editable. */
    acquiredOn: date("acquired_on"),
    warrantyUntil: date("warranty_until"),
    /** Free text. Prompt recommends new / used / broken / sold /
     *  gifted_away — the agent invents a snake_case label otherwise. */
    condition: text("condition"),
    /** Sold / broken / given-away timestamp. NULL → still owned. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    notes: text("notes"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("owned_items_tx_item_instance_uq").on(
      t.transactionItemId,
      t.instanceIndex,
    ),
    index("owned_items_workspace_product_idx").on(
      t.workspaceId,
      t.productId,
    ),
  ],
);
