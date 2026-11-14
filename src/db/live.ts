/**
 * The one definition of a LIVE transaction.
 *
 * `ledger_live_transactions` is a database view (migration 0040) over
 * `transactions` that keeps only rows with status `posted` or
 * `reconciled` and `deleted_at IS NULL`. It has exactly the columns of
 * `transactions`, so a query that means "live" swaps the table name for
 * this fragment and drops its own status / deleted_at predicates:
 *
 *     sql`SELECT t.id FROM ${liveTransactions} t WHERE t.workspace_id = ${ws}`
 *
 * Why a view and not a helper that returns the predicate: the predicate
 * was already "shared by convention", and that is how the dedup probes
 * came to treat soft-deleted rows as live — they kept the status half
 * and never gained the `deleted_at` half when void became soft delete
 * (#171). A relation cannot be half-applied.
 *
 * Do NOT use it where deleted rows are wanted on purpose: restore,
 * `include_deleted`, hard delete, audit lookups, and any check that has
 * to tell "missing" from "deleted" read `transactions` directly.
 *
 * Postings and line items have no view of their own. Their liveness is
 * their parent's: join them to this relation.
 */
import { sql } from "drizzle-orm";

export const LIVE_TRANSACTIONS_VIEW = "ledger_live_transactions";

/** SQL identifier for the live-transactions view, for `sql` templates. */
export const liveTransactions = sql.raw(`"${LIVE_TRANSACTIONS_VIEW}"`);
