# Curated extractor lessons — human-reviewed, one per line.
#
# These are promoted (via the agent-evolver skill / a human) from the
# runtime `lessons.proposed.md` the agent appends to on the mini. Every
# non-'#' line below is injected VERBATIM into the extractor prompt as
# high-priority guidance, so keep each one short, specific, and evidence-
# based. Lines starting with '#' are comments and are NOT injected.
#
# Promotion is a normal repo change: add the line here, commit, deploy.
# See .claude/skills/agent-evolver/SKILL.md (Diagnose → Step 0).

- [receipt_pdf] The printed transaction date can differ from the PDF's CreationDate metadata (the template/software date). Trust the printed receipt date, not the file metadata. (Promoted 2026-07-19 from an AAA/Club Assist invoice.)
- [receipt_pdf] Dealer/service invoices (Lexus/CDK and similar layouts) print vehicle-registration dates (DEL DATE / PROD DATE) near the top; the transaction date is the INV DATE / R.O.-opened date. Do not grab the earliest date on the page. (Promoted 2026-07-19.)
- [receipt] When a voucher / Groupon / gift card splits the tender, total_minor is the residual card charge that reconciles to the bank/card statement, NOT the pre-voucher printed total. Treat the voucher like a gift card. (Promoted 2026-07-19.)
- [receipt] California service receipts often tax parts only (labor is tax-exempt): recover the rate from tax ÷ parts_subtotal and allocate tax across the parts lines, not labor. (Promoted 2026-07-19.)
