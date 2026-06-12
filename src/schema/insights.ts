/**
 * v2 redesign P5 (#149) — discovered insight cards (board screen 18).
 *
 * Rows are produced by the rule engine in `src/insights/discover.ts`
 * (anomaly / trend / milestone families over the ledger) and are
 * idempotent per `dedupe_key`: re-running refresh updates the body of
 * an existing card instead of duplicating it. Dismissal is a timestamp
 * so a dismissed card stays dismissed across refreshes.
 *
 * `payload` carries presentation data the frontend renders verbatim —
 * a `deep_link` (in-app URL), optional `bars` (mini viz series), and
 * the numbers behind the headline. Free-shape by design: rules evolve
 * faster than columns.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const insights = pgTable(
  "insights",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** anomaly | trend | milestone | opportunity */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Rule identity, e.g. "category-spike:Dining:2026-06". */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("insights_workspace_dedupe_uq").on(t.workspaceId, t.dedupeKey),
    index("insights_workspace_active_idx").on(t.workspaceId, t.dismissedAt),
  ],
);
