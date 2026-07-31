import {
  pgTable,
  uuid,
  varchar,
  char,
  date,
  text,
  numeric,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./common.js";
import { workspaces } from "./workspaces.js";
import { pointsProgrammes } from "./points_programmes.js";

/**
 * What one point is worth, per workspace, versioned by effective date
 * (#206).
 *
 * This is the deliberate counterpart to `fx_rates`, and the differences
 * are the whole design:
 *
 * | | `fx_rates` | `points_valuations` |
 * |---|---|---|
 * | scope | world | **workspace** — a valuation is a judgement, not a fact |
 * | source | ECB publication | **the owner**, or a marked-provisional seed |
 * | key | the date asked for | the date range it is **effective** for |
 * | resolution | exact date match | newest `effective_from <= occurred_on` |
 *
 * Versioning by `effective_from` rather than by observation date is what
 * makes a re-valuation safe: changing what a point is worth *going
 * forward* leaves last year's stays valued at last year's number, so a
 * report re-run does not quietly rewrite history. Re-valuing the past is
 * possible but has to be asked for explicitly (insert a row with an
 * earlier `effective_from` and re-run the valuation pass with `force`).
 *
 * ## `confirmed_at` — provisional numbers are visible, not silent
 *
 * A valuation the owner has not signed off on carries `confirmed_at
 * NULL`. It is still applied (a stay valued at a marked-provisional rate
 * is closer to the owner's "積分房一定要算" than a stay valued at zero),
 * but every report that includes it says how much of the total depends
 * on an unconfirmed number. Confirming is a one-row UPDATE; changing the
 * number is one INSERT plus a `force` re-run.
 */
export const pointsValuations = pgTable(
  "points_valuations",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Points currency being valued, e.g. `HYATT_PT`. */
    currency: varchar("currency", { length: 16 })
      .notNull()
      .references(() => pointsProgrammes.code, { onDelete: "restrict" }),
    /** Cash currency the valuation is expressed in — the workspace base. */
    quote: char("quote", { length: 3 }).notNull(),
    /** First date this valuation applies to (inclusive). */
    effectiveFrom: date("effective_from").notNull(),
    /**
     * Base-currency **minor units** per one point. 1.7 US cents per Hyatt
     * point is `1.7`, not `0.017`: points have no subunit, so one point
     * is one minor unit of its own currency and the conversion is a plain
     * minor→minor multiply — exactly the semantics of
     * `postings.fx_rate`, which this value is written to. numeric(20,10)
     * mirrors that column so the number round-trips without loss.
     */
    minorPerPoint: numeric("minor_per_point", {
      precision: 20,
      scale: 10,
    }).notNull(),
    /** Where the number came from, e.g. `owner`, `issue-206-example`. */
    source: text("source").notNull(),
    /** NULL until the owner has confirmed the number. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    note: text("note"),
    createdAt,
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.currency, t.effectiveFrom] }),
    // Resolution path: "newest valuation for this pair effective on or
    // before D".
    index("points_valuations_lookup_idx").on(
      t.workspaceId,
      t.currency,
      t.effectiveFrom.desc(),
    ),
  ],
);
