-- Data cleanup for #170/#171. Runs AFTER the schema DDL (0032 add
-- deleted_at, 0033 drop voided_by_id) so no ALTER TABLE follows this DML
-- inside the migrator's transaction — otherwise the deferred balance
-- triggers queued here would trip "cannot ALTER TABLE ... pending trigger
-- events" (55006).
--
-- Delete the negated "VOID:" mirror transactions (identified by the
-- metadata.voided marker written only by void); their postings cascade via
-- FK. The deferred postings_balance_ck skips deleted transactions.
DELETE FROM "transactions" WHERE "status" = 'posted' AND jsonb_exists("metadata", 'voided');
--> statement-breakpoint
-- Convert the (now mirror-less) voided originals into soft-deleted
-- tombstones. They were duplicates removed by dedup; under the new model a
-- removed row is hidden via deleted_at, not reversed. Money queries filter
-- deleted_at IS NULL, so they stop counting exactly as before — without the
-- double-count.
UPDATE "transactions" SET "status" = 'posted', "deleted_at" = now() WHERE "status" = 'voided';
