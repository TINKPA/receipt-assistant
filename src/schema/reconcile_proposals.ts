import {
  pgTable,
  uuid,
  text,
  jsonb,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createdAt } from "./common.js";
import { batches } from "./batches.js";

/**
 * Placeholder for Phase 2 reconcile logic (#32 acceptance criteria).
 * Schema is frozen now so we don't re-migrate once `POST
 * /v1/batches/:id/reconcile` lands. Phase 1 does not write any rows.
 *
 * `kind` values (agreed in issue): dedup | payment_link | trip_group | inventory
 * `status`: proposed | auto_applied | user_applied | rejected
 */
export const reconcileProposals = pgTable(
  "reconcile_proposals",
  {
    id: uuid("id").primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    score: real("score"),
    status: text("status").notNull(),
    createdAt,
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("reconcile_proposals_batch_idx").on(t.batchId),
    index("reconcile_proposals_kind_idx").on(t.batchId, t.kind),
  ],
);
