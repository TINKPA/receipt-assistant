-- ═══════════════════════════════════════════════════════════════════════
-- One definition of a LIVE transaction, in the database. DDL ONLY.
--
-- A transaction counts as money when its status is `posted` or
-- `reconciled` AND it has not been soft-deleted. Until now that sentence
-- was re-typed at every call site, and the sites that were written while
-- removal still meant `status = 'voided'` never gained the `deleted_at`
-- half when #171 turned removal into a soft delete (status stays
-- `posted`). Every dedup layer except the agent's own query therefore
-- treated a deleted row as live: a receipt re-uploaded after its wrong
-- transaction was deleted was swallowed as a duplicate of the deleted
-- row, and reconcile could pick a deleted row as the survivor.
--
-- Readers that mean "live" select from this view instead of repeating
-- the predicate. Readers that deliberately include deleted rows
-- (`include_deleted`, restore, hard delete, audit) keep reading
-- `transactions`.
--
-- Notes for whoever edits this later:
--   * `SELECT t.*` is expanded when the view is created. A column added
--     to `transactions` afterwards is NOT visible through the view until
--     a migration re-runs this CREATE OR REPLACE (new columns append, so
--     the replace is legal). A migration that drops or retypes a
--     `transactions` column must DROP this view first and recreate it
--     after, or Postgres refuses the ALTER.
--   * `security_invoker` makes the view check the CALLER's privileges and
--     row-security policies on `transactions`, so it never widens what a
--     restricted role can read.
--   * No view over `postings` or `transaction_items` on purpose: their
--     liveness is their parent's, and a view there would pin column types
--     that other migrations still need to change. Join them to this view.
--   * Safe to re-run, touches no row, queues no trigger event.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW "ledger_live_transactions"
WITH (security_invoker = true) AS
SELECT t.*
  FROM "transactions" t
 WHERE t."status" IN ('posted', 'reconciled')
   AND t."deleted_at" IS NULL;--> statement-breakpoint

COMMENT ON VIEW "ledger_live_transactions" IS
  'Transactions that count as money: status posted or reconciled, not soft-deleted. The one definition of live; read this instead of re-typing the predicate.';
