import {
  pgTable,
  uuid,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt } from "./common.js";
import { batchStatusEnum } from "./enums.js";
import { workspaces } from "./workspaces.js";

/**
 * One row per multi-file upload. Children live in `ingests`.
 *
 * Phase 1 (#32) only populates a subset of the status machine —
 * `reconciling`/`reconciled`/`reconcile_error` are reserved for Phase 2
 * when the reconcile endpoints land, but the column type already carries
 * them so we don't re-migrate the enum later.
 *
 * `auto_reconcile` is persisted even though Phase 1 has no reconcile
 * logic; it's part of the documented `POST /v1/ingest/batch` contract
 * and client code already sends it.
 */
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: batchStatusEnum("status").notNull().default("pending"),
    fileCount: integer("file_count").notNull(),
    autoReconcile: boolean("auto_reconcile").notNull().default(true),
    createdAt,
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  },
  (t) => [
    index("batches_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt.desc(),
    ),
    index("batches_status_idx").on(t.workspaceId, t.status),
  ],
);
