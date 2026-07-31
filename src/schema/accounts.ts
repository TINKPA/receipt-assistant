import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accountTypeEnum } from "./enums.js";
import { createdAt, updatedAt, version } from "./common.js";
import { workspaces } from "./workspaces.js";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => accounts.id, {
      onDelete: "restrict",
    }),
    code: text("code"),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    subtype: text("subtype"),
    // ISO 4217 for cash accounts, or a points-programme code (`HYATT_PT`)
    // for the per-programme points asset account (#206, 0038). Disjoint
    // by shape — see `src/points/codes.ts`.
    currency: varchar("currency", { length: 16 }).notNull(),
    institution: text("institution"),
    last4: text("last4"),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    version,
    createdAt,
    updatedAt,
  },
  (t) => [
    index("accounts_workspace_idx").on(t.workspaceId),
    index("accounts_parent_idx").on(t.parentId),
    index("accounts_workspace_type_idx").on(t.workspaceId, t.type),
    // One points asset account per programme per workspace (#206). The
    // extraction agent upserts against this index (`ON CONFLICT
    // (workspace_id, currency) WHERE subtype = 'points'`) so an award
    // stay for a programme seen for the first time creates its account
    // inline instead of failing the write for a missing credit leg.
    uniqueIndex("accounts_points_uq")
      .on(t.workspaceId, t.currency)
      .where(sql`${t.subtype} = 'points'`),
  ],
);
