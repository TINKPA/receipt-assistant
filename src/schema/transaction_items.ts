/**
 * #81 Phase 2 — relational line-items table.
 *
 * The shape mirrors `TransactionItem` in `src/schemas/v1/transaction.ts`
 * one-to-one. Phase 1 (#105) shipped items inside `transactions.metadata.items`;
 * this table is the canonical store going forward. The transactions
 * service falls back to `metadata.items` when no rows exist, so old
 * receipts keep rendering unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { transactions } from "./transactions.js";

export const transactionItems = pgTable(
  "transaction_items",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    rawName: text("raw_name").notNull(),
    normalizedName: text("normalized_name"),
    quantity: numeric("quantity"),
    unit: text("unit"),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }),
    lineTotalMinor: bigint("line_total_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    itemClass: text("item_class").notNull(),
    durabilityTier: text("durability_tier"),
    foodKind: text("food_kind"),
    tags: text("tags").array(),
    confidence: text("confidence").notNull(),
    extractionVersion: text("extraction_version").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("transaction_items_line_no_uq").on(t.transactionId, t.lineNo),
    index("transaction_items_tx_idx").on(t.transactionId),
    index("transaction_items_workspace_class_created_idx").on(
      t.workspaceId,
      t.itemClass,
      t.createdAt.desc(),
    ),
  ],
);
