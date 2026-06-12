/**
 * v2 redesign P4 (#149) — the party graph behind every transaction.
 *
 * One row per (role, party) on a transaction or a single line:
 *  - channel  (tx-level):   who charged the card / the platform the
 *                            order went through (Amazon, DoorDash).
 *  - seller   (tx- or line-level): who actually sold it when that
 *                            differs from the channel ("Sold by:
 *                            AnkerDirect", the restaurant behind a
 *                            DoorDash order).
 *  - maker    (line-level): the product's brand when the receipt text
 *                            states it confidently (Anker, rOtring).
 *  - acquirer (tx-level):   payment processor when printed (Stripe,
 *                            Square) — rare, kept for completeness.
 *
 * `display_name` is the string as printed; `brand_id` links to the
 * brands registry when the agent (or backfill) can resolve it —
 * marketplace sellers become brands rows with parent_id pointing at
 * their maker when that relationship is known.
 *
 * Idempotency: UNIQUE NULLS NOT DISTINCT over (transaction_id,
 * transaction_item_id, role, display_name) makes agent re-runs no-ops
 * for both tx-level (NULL item) and line-level rows.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { transactions } from "./transactions.js";
import { transactionItems } from "./transaction_items.js";

export const transactionParties = pgTable(
  "transaction_parties",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** NULL for tx-level roles (channel/acquirer, tx-wide seller). */
    transactionItemId: uuid("transaction_item_id").references(
      () => transactionItems.id,
      { onDelete: "cascade" },
    ),
    /** channel | seller | maker | acquirer */
    role: text("role").notNull(),
    /** The party string as printed on the receipt. */
    displayName: text("display_name").notNull(),
    /** brands.brand_id when resolvable; NULL keeps the row useful as text. */
    brandId: text("brand_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    unique("transaction_parties_identity_uq")
      .on(t.transactionId, t.transactionItemId, t.role, t.displayName)
      .nullsNotDistinct(),
    index("transaction_parties_workspace_brand_idx").on(t.workspaceId, t.brandId, t.role),
    index("transaction_parties_tx_idx").on(t.transactionId),
  ],
);
