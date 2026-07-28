import {
  pgTable,
  char,
  date,
  text,
  numeric,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Daily FX rate cache (#184).
 *
 * Every non-base-currency posting is converted to the workspace base
 * currency at **the receipt's own date** — not at ingest time, not at
 * report time. That makes `amount_base_minor` a stable historical fact:
 * re-running a report next year yields the same number it does today.
 *
 * Rows are keyed by the date that was **asked for** (`as_of`), not the
 * date the source published. ECB publishes on TARGET business days only,
 * so a Saturday receipt resolves to Friday's rate; `as_of_actual` records
 * which publication was actually used. Keying on the requested date keeps
 * lookups a single point-read — the alternative ("newest rate <= date")
 * silently returns a stale cached row when a fresher upstream one exists.
 *
 * `rate` is base → quote, matching `postings.fx_rate` (posting currency →
 * workspace base currency). numeric(20,10) mirrors that column exactly so
 * a rate round-trips through both without precision loss.
 *
 * The table is workspace-agnostic: an FX rate is a property of the world,
 * not of a tenant. It is also append-mostly — a published historical rate
 * never changes, so there is no update path beyond the provisional-row
 * case described in `src/fx/rates.ts`.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    /** The date conversion was requested for — i.e. the receipt date. */
    asOf: date("as_of").notNull(),
    /** Source currency (the posting's currency). */
    base: char("base", { length: 3 }).notNull(),
    /** Target currency (the workspace's base currency). */
    quote: char("quote", { length: 3 }).notNull(),
    /** 1 unit of `base` expressed in `quote`. */
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    /**
     * The publication date the rate actually came from. Equals `as_of`
     * on a business day; earlier on weekends/holidays. Surfaced in the
     * UI next to the converted amount so a surprising number can be
     * traced to a specific published rate rather than guessed at.
     */
    asOfActual: date("as_of_actual").notNull(),
    /** Provenance, e.g. `frankfurter/ecb`. `identity` for base==quote. */
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    primaryKey({ columns: [t.asOf, t.base, t.quote] }),
    // Fallback path: "newest rate we hold for this pair at or before D",
    // used only when the upstream source is unreachable.
    index("fx_rates_pair_idx").on(t.base, t.quote, t.asOf),
  ],
);
