ALTER TABLE "transactions" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
-- #170/#171: eliminate the void double-count and migrate off the void model.
-- Delete the negated "VOID:" mirror transactions (identified by the
-- metadata.voided marker written only by void); their postings cascade via FK,
-- and each original's voided_by_id is set NULL by the FK onDelete rule.
DELETE FROM "transactions" WHERE "status" = 'posted' AND jsonb_exists("metadata", 'voided');
--> statement-breakpoint
-- Convert the (now mirror-less) voided originals into soft-deleted tombstones.
-- They were duplicates removed by dedup; under the new model a removed row is
-- hidden via deleted_at, not reversed. Money queries filter deleted_at IS NULL,
-- so they stop counting exactly as before — but without the double-count.
UPDATE "transactions" SET "status" = 'posted', "deleted_at" = now() WHERE "status" = 'voided';
