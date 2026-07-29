ALTER TABLE "transaction_events" DROP CONSTRAINT "transaction_events_transaction_id_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction_events" ALTER COLUMN "transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;