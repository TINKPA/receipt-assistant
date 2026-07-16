ALTER TABLE "transactions" DROP CONSTRAINT "transactions_voided_by_id_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "voided_by_id";