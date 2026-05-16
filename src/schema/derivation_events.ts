import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Append-only audit log for Layer 2 re-derivations (#80 / #89).
 *
 * Every overwrite of a derived ("Layer 2") field — by `POST
 * /v1/places/:id/re-derive`, `POST /v1/admin/re-derive`, future
 * `/v1/documents/:id/re-extract` (#91), or any subsequent
 * derivation path — inserts a row here BEFORE the UPDATE lands.
 * The row carries (a) which entity changed, (b) the prompt /
 * model version under which the new derivation ran, and (c) the
 * field-level `before` / `after` diff.
 *
 * Why an audit table rather than versioning Layer 2 itself:
 * Layer 2 stays a flat snapshot that downstream joins read
 * cheaply; the audit log is queried only when (a) we want to
 * diff a projection-version bump after the fact, or (b) we want
 * to roll back a bad re-derivation by writing the `before` jsonb
 * back. Both are rare operations — putting their cost into a
 * separate, ran_at-indexed table keeps the hot path clean.
 *
 * `entity_id` is `text` (not `uuid`) deliberately: for `place`
 * events we sometimes audit by `google_place_id` (a `ChIJ…`
 * string), and future `document` / `transaction` events use
 * UUIDs. A text column accepts both without an extra join.
 *
 * Layer-3 user-truth columns (e.g. `places.custom_name`,
 * `documents.deleted_at`) are NEVER part of `before` / `after`
 * — re-derive omits them from the UPDATE entirely, so they
 * never reach this table. This is enforced at the service layer,
 * not the DB layer; new Layer-3 fields must be added to the
 * service-side allowlist when introduced.
 */
export const derivationEvents = pgTable(
  "derivation_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Workspace whose action triggered the re-derivation. For
     *  shared-across-workspaces entities like `places`, this is the
     *  requester's workspace, not an entity property. */
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** `'place'` (Phase 2 / #89). Future: `'merchant'` (#91),
     *  `'document'`, `'transaction'`, `'place_photo'`. */
    entityType: text("entity_type").notNull(),
    /** Stable identifier of the affected row. For `place` events
     *  this is the `places.id` UUID. */
    entityId: text("entity_id").notNull(),
    /** `PROMPT_VERSION` constant at the time of the run. */
    promptVersion: text("prompt_version").notNull(),
    /** `buildInfo.gitSha` — exactly which commit's projection
     *  code produced the new values. */
    promptGitSha: text("prompt_git_sha").notNull(),
    /** Model identifier. Phase 2 uses a deterministic TS
     *  projection (no LLM call), so this is `'ts-deterministic'`;
     *  future LLM-backed re-derives stamp the actual model name. */
    model: text("model").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    /** JSON object: the Layer-2 field values before the UPDATE,
     *  restricted to the keys this run was eligible to touch. */
    before: jsonb("before").notNull(),
    /** JSON object: the Layer-2 field values after the UPDATE.
     *  Diff against `before` to recover `changed_keys`. */
    after: jsonb("after").notNull(),
    /** Keys whose value actually changed (i.e.
     *  `before[k] !== after[k]`). A row may have zero changed
     *  keys — re-derive still writes the event so we can see
     *  that a version bump touched the row even when the new
     *  projection happened to match the old. */
    changedKeys: text("changed_keys").array().notNull(),
  },
  (t) => [
    // Browse-by-entity: "show me every re-derivation of place X".
    index("derivation_events_entity_idx").on(
      t.entityType,
      t.entityId,
      t.ranAt,
    ),
    // Audit-by-version: "how many rows did prompt_version 2.6 touch?"
    index("derivation_events_version_idx").on(
      t.promptVersion,
      t.ranAt,
    ),
  ],
);
