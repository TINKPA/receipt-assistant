import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { txnStatusEnum } from "./enums.js";
import { createdAt, updatedAt, version } from "./common.js";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { ingests } from "./ingests.js";
import { places } from "./places.js";

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    occurredOn: date("occurred_on").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    payee: text("payee"),
    narration: text("narration"),
    status: txnStatusEnum("status").notNull().default("posted"),
    voidedById: uuid("voided_by_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "set null" },
    ),
    // FK to `ingests` added in `0002_batch_ingest.sql`. Originally
    // introduced as a bare UUID in 0000_init.sql because `ingests`
    // didn't exist yet; the Drizzle definition now uses `.references()`
    // so future schema changes stay consistent.
    sourceIngestId: uuid("source_ingest_id").references(
      (): AnyPgColumn => ingests.id,
      { onDelete: "set null" },
    ),
    // trip_id is a forward-reference to the future trips table.
    tripId: uuid("trip_id"),
    // FK to `places` for merchant geolocation; nullable because the
    // extraction agent may legitimately decline to geocode (no address
    // and no locality hint → geo:null). Written by the ingest worker
    // from the agent's Phase 3 geo block.
    placeId: uuid("place_id").references(() => places.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").notNull().default({}),
    version,
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Keyset pagination: (workspace, occurred_on DESC, id DESC)
    index("transactions_keyset_idx").on(
      t.workspaceId,
      t.occurredOn.desc(),
      t.id.desc(),
    ),
    // Keyset pagination for sort=created_at (the new default ordering).
    // Mirrors transactions_keyset_idx but keyed on created_at so the
    // "newest uploads first" path is index-scannable.
    index("transactions_created_at_keyset_idx").on(
      t.workspaceId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("transactions_status_idx").on(t.workspaceId, t.status),
    index("transactions_source_ingest_idx").on(t.sourceIngestId),
    index("transactions_trip_idx").on(t.tripId),
    index("transactions_place_idx").on(t.placeId),
  ],
);
