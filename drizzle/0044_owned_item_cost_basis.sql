-- Owned items: what a thing cost in full, and what it was sold for.
-- Additive and nullable: the previous image ignores both columns, so an
-- image rollback needs no data step.
--
--   cost_basis_minor     the instance's full cost, workspace base currency,
--                        minor units. Set by the user when the linked
--                        receipt line does not carry the price (a financed
--                        phone whose receipt shows only the sales tax).
--   sale_proceeds_minor  what it was sold or traded in for, same unit.
--
-- No grant: `receipts_agent` updates owned_items per column and neither
-- column is in its list, so extraction cannot write them.
ALTER TABLE "owned_items" ADD COLUMN "cost_basis_minor" bigint;--> statement-breakpoint
ALTER TABLE "owned_items" ADD COLUMN "sale_proceeds_minor" bigint;--> statement-breakpoint
ALTER TABLE "owned_items" ADD CONSTRAINT "owned_items_amounts_nonnegative" CHECK ("owned_items"."cost_basis_minor" >= 0 AND "owned_items"."sale_proceeds_minor" >= 0);
