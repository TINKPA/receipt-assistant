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
import { products } from "./products.js";

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
    /** Free-text but the prompt recommends `product`, `tax`, `tip`,
     *  `discount`, `shipping`, `surcharge`, `service_fee`,
     *  `gift_card`. Non-product rows audit-balance the totals; the
     *  agent invents a snake_case label for novel cases. */
    lineType: text("line_type").notNull().default("product"),
    /** Catalog linkage (#84). Nullable when line_type is non-product
     *  (tax/tip/discount rows have no product) or when the agent
     *  judges the line not worth canonicalizing (generic produce,
     *  unbranded fuel). */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** Per-line allocation of the receipt's printed tax total.
     *  Agent computes from line-level taxability markers or, in
     *  their absence, proportionally to `line_total_minor`. NULL on
     *  non-taxable lines and on the tax/tip/discount rows themselves. */
    taxMinor: bigint("tax_minor", { mode: "number" }),
    tipShareMinor: bigint("tip_share_minor", { mode: "number" }),
    discountShareMinor: bigint("discount_share_minor", { mode: "number" }),
    /** All-in cost the user effectively paid for this line.
     *  `effective_total_minor = line_total + tax + tip - discount`.
     *  Stored generated column for index-friendliness. */
    effectiveTotalMinor: bigint("effective_total_minor", {
      mode: "number",
    }).generatedAlwaysAs(
      sql`line_total_minor + COALESCE(tax_minor, 0) + COALESCE(tip_share_minor, 0) - COALESCE(discount_share_minor, 0)`,
    ),
    /** Monotonic counter per re-extract of the parent transaction.
     *  Stays 1 for first ingest; bumped on every `POST
     *  /v1/documents/:id/re-extract`. Old rows soft-deleted via
     *  `retired_at`; aggregates read from `retired_at IS NULL`. */
    extractionRun: integer("extraction_run").notNull().default(1),
    /** Soft-delete cursor — supersedes the row on re-extract. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** Prompt version stamp (text). #105/#106 used this column;
     *  retained as semantic audit ("which prompt produced this row")
     *  alongside the numeric `extractionRun` counter (#84). */
    extractionVersion: text("extraction_version").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    // (transaction_id, line_no, extraction_run) — re-extract appends
    // a new run rather than colliding with the live row of the same
    // line_no. Replaces the (transaction_id, line_no) unique from
    // #81 Phase 2 which would have made versioning impossible.
    uniqueIndex("transaction_items_line_no_run_uq").on(
      t.transactionId,
      t.lineNo,
      t.extractionRun,
    ),
    index("transaction_items_tx_idx").on(t.transactionId),
    index("transaction_items_workspace_class_created_idx").on(
      t.workspaceId,
      t.itemClass,
      t.createdAt.desc(),
    ),
  ],
);
