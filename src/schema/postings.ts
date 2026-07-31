import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { createdAt } from "./common.js";
import { transactions } from "./transactions.js";
import { accounts } from "./accounts.js";
import { workspaces } from "./workspaces.js";

export const postings = pgTable(
  "postings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    // ISO 4217 for cash, or a points-programme code (`HYATT_PT`) for a
    // loyalty redemption — widened from char(3) in 0038 (#206). The two
    // namespaces are disjoint by shape; see `src/points/codes.ts`.
    currency: varchar("currency", { length: 16 }).notNull(),
    // Rate from posting currency → workspace base currency at occurrence,
    // in minor units. Null when no conversion was needed (same currency).
    // For a points leg this is the programme valuation resolved by
    // `src/points/valuation.ts`, never a published FX rate.
    fxRate: numeric("fx_rate", { precision: 20, scale: 10 }),
    // Base-currency amount persisted so the balance trigger and reports
    // don't need to re-derive FX. Nullable during insert; app fills it
    // before commit. Trigger enforces non-null + balance.
    amountBaseMinor: bigint("amount_base_minor", { mode: "bigint" }),
    memo: text("memo"),
    createdAt,
  },
  (t) => [
    index("postings_transaction_idx").on(t.transactionId),
    index("postings_account_idx").on(t.accountId, t.createdAt.desc()),
    index("postings_workspace_idx").on(t.workspaceId),
  ],
);
