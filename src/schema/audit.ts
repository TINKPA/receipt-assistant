import { pgTable, uuid, text, jsonb, index } from "drizzle-orm/pg-core";
import { createdAt } from "./common.js";
import { transactions } from "./transactions.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Append-only audit log for transaction mutations.
 *
 * Emitted by the service layer (not DB triggers) so cross-request
 * correlation (actor_id, request_id) can be attached explicitly.
 *
 * event_type examples:
 *   created | updated | posting_added | posting_updated | posting_removed
 *   voided  | reconciled | document_linked | document_unlinked
 *   hard_deleted
 */
export const transactionEvents = pgTable(
  "transaction_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Nullable, `ON DELETE SET NULL` — deliberately NOT `cascade`.
     *
     * A hard delete writes its own `hard_deleted` event and then drops
     * the parent row in the SAME db transaction; under `cascade` that
     * delete destroyed the event it had just written, along with the
     * row's entire created/updated history — the audit log erased
     * exactly the mutation it exists to record. With `set null` the
     * trail survives the parent: `workspace_id`, `event_type`,
     * `actor_id`, `occurred_at` and `payload` stay intact, and the
     * originating id is carried inside `payload.transaction_id` so the
     * history is still queryable after this column goes null.
     */
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").notNull(),
    occurredAt: createdAt,
  },
  (t) => [index("txn_events_txn_idx").on(t.transactionId, t.occurredAt)],
);
