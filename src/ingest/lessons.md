# Curated extractor lessons — human-reviewed, one per line.
#
# These are promoted (via the agent-evolver skill / a human) from the
# runtime `lessons.proposed.md` the agent appends to on the mini. Every
# non-'#' line below is injected VERBATIM into the extractor prompt as
# high-priority guidance, so keep each one short, specific, and evidence-
# based. Lines starting with '#' are comments and are NOT injected.
#
# Promotion is a normal repo change: add the line here, commit, deploy.
# The curator is the `agent-evolver` skill, which owns the curation cadence at
# its Diagnose → Step 0. It lives in the PROJECT SHELL, not in this repo:
#   ~/Documents/10_Projects/2026_Dev_ReceiptAssistant/.claude/skills/agent-evolver/
# A bare ".claude/skills/..." path here reads as repo-relative and sends you
# looking in the wrong tree (it did, on 2026-07-30).
#
# EVERY line below is injected into EVERY extractor prompt, so length is a
# recurring cost paid on every ingest (#181 was a token-burn fix). Keep each
# lesson to one tight sentence or two; prefer deleting a lesson the code has
# since fixed over letting the block grow.
#
# ── Batch 1, promoted 2026-07-19 ──────────────────────────────────────

- [receipt_pdf] The printed transaction date can differ from the PDF's CreationDate metadata (the template/software date). Trust the printed receipt date, not the file metadata. (Promoted 2026-07-19 from an AAA/Club Assist invoice.)
- [receipt_pdf] Dealer/service invoices (Lexus/CDK and similar layouts) print vehicle-registration dates (DEL DATE / PROD DATE) near the top; the transaction date is the INV DATE / R.O.-opened date. Do not grab the earliest date on the page. (Promoted 2026-07-19.)
- [receipt] When a voucher / Groupon / gift card splits the tender, total_minor is the residual card charge that reconciles to the bank/card statement, NOT the pre-voucher printed total. Treat the voucher like a gift card. (Promoted 2026-07-19.)
- [receipt] California service receipts often tax parts only (labor is tax-exempt): recover the rate from tax ÷ parts_subtotal and allocate tax across the parts lines, not labor. (Promoted 2026-07-19.)

# ── Batch 2, promoted 2026-07-30 ──────────────────────────────────────
# Triaged from 126 runtime proposals; see
# 10_Projects/2026_Dev_ReceiptAssistant/notes/2026-07-29_analysis_lessons-proposal-triage.md
# Rejected there and deliberately NOT promoted: 11 proposals the code has
# since fixed (#181 DISTINCT ON + itemsCte), and 4 that would now cause harm
# (guessing an FX rate suppresses the real #184 conversion).

# Dates
- [receipt_email] An email `Date:` header is when the mail was SENT, not when the purchase happened; receipt emails get re-sent years later (Lyft especially). Trust the in-body date ("YOUR RIDE ... ON <date>", the machine-readable dt-transaction), and do not let the multi-year gap trip the Check A year-sanity prompt.
- [receipt_pdf] Bank "Transaction details" printouts (Chase and similar) carry THREE dates: a browser print timestamp in the header, "Transaction date", and "Posted date". Use the Transaction date; the header stamp can legitimately be years later.
- [receipt_pdf] Bookings print a payment date AND a separate service date (facility rentals, tours, activities). occurred_on is the payment/charge date, never the later date you actually use the thing.
- [receipt_pdf] Hotel folios: occurred_on is the checkout / card-payment date, not arrival. "Balance 0.00" means paid in full, not free.
- [receipt_pdf] Chinese 发票 printed years in the past are usually genuine archival scans. 开票日期 is authoritative and legitimately fails the Check A year-sanity prompt; keep what the paper says.
- [receipt_pdf] Exception to "trust the printed date, not the file metadata": when NO date is printed anywhere on the document (Costco Same-Day / Instacart order receipts), the PDF CreationDate is all there is and IS the correct fallback.

# Documents that look like receipts but are not
- [refund] Direction-of-money test, part 1 (SUPERSEDES the old "money flowing TO the user is unsupported" rule, which cost 13 real refunds): money coming back because a purchase was undone is a REFUND. Refund checks and remittance advices (CA DMV), "your refund has been issued" emails, return receipts, AppleCare cancellations, chargebacks. Book it with a NEGATIVE total against the ORIGINAL category, never as income and never as unsupported.
- [income] Direction-of-money test, part 2: money coming in with no purchase of the user's being undone is INCOME. Buyback / trade-in packing slips ("OFFER #", "You will be paid by PayPal"), insurance and purchase-protection payouts. Asset debit + Income credit, and retire the owned_items row for the thing sold.
- [unsupported] Direction-of-money test, part 3: money that merely MOVES — received P2P transfers (Zelle, Venmo, PayPal "X sent you $N"), gift-card and stored-value top-ups (Amazon Reload) — is neither spend nor income and is still unsupported. Reason: "transfer — not spend, not income".
- [unsupported] Boarding passes, eTickets, "Travel Document" PDFs and admission tickets print an itinerary and sometimes a REFERENCE price (baggage max fee, ticket face value) but never a charged total. Classify unsupported; never build a total out of a reference price.
- [unsupported] Packing lists and slips with zero or absent prices (often stamped "DO NOT INCLUDE THIS PACKING SLIP") mean prices were SUPPRESSED, not that the goods were free. Unsupported, not a $0 receipt.
- [unsupported] Booking confirmations and vouchers whose Total cells are empty (salon appointments, GetYourGuide, "Your Bill Is Ready" emails that only carry a login link) announce a future or unbilled event. Unsupported.
- [unsupported] Priceless shop printouts (wheel-alignment / CEMB reports, CA Smog Check VIR certificates) are certificates, not receipts, despite the automotive context. Do not invent a service fee.
- [receipt_pdf] A hotel folio whose charges table is entirely BLANK (not a printed "0.00") has no amount to post: unsupported. But if that same blank folio names an award/points redemption ("World of Hyatt Award"), it IS a real stay: record it in POINTS (#206) — total_minor = the points redeemed, currency = the programme code — never as a $0 stay, and never as unsupported.

# Split tender (extends the voucher lesson above)
- [receipt] Points and miles are the ONE tender that is not "the residual card charge" (#206): they are a currency of their own, so an award redemption is recorded in the programme's own units (total_minor = points redeemed, currency = HYATT_PT / BONVOY_PT / AA_PT), not as a $0 or residual-only charge. Gift cards and store credit still follow the residual rule below.
- [receipt] The voucher/gift-card rule also covers insurance deductibles ("Amount to collect from Customer"), the PAYMENT column on medical/optometry ledgers, and prepaid account credit ("Applied balance", store credit). total_minor is always the residual card charge. "Amount expected from insurance" is a pending balance that was never charged, so exclude it.
- [receipt_pdf] The inverse also happens: government payment portals (NICUSA, parking-citation payments) charge MORE than the printed fee. Use the "amount charged" / "NICServices total" line as total_minor and itemize the unlabeled convenience surcharge.

# Tax
- [receipt] Before recovering the CA parts-only rate, subtract non-taxable fees bundled INTO the printed parts subtotal (hazardous waste fee, extra oil charge). Skipping that step yields a too-low rate (9.24% where the real rate is 9.5%).
- [receipt_pdf] On carbon-form auto estimates, the totals-box "Mechanical ___ Hrs" line is the LABOR dollar total, not a parts amount; "Parts Less" is the taxable parts subtotal.

# Regional formats
- [receipt_pdf] EU and German invoices write "1.990,00 €" with period as thousands separator and comma as decimal. Parse that as 1990.00, never 1.99.
- [receipt_pdf] Chinese 发票: the payee is the issuer named in the round 发票专用章 seal (it carries the 税号), NOT a handwritten 顾客 name, which is the buyer. Cross-check the 大写 amount against the digits, use 价税合计 as the amount charged, and treat a range in 规格型号 as a service period rather than a date.

# Merchant recognition
- [receipt_pdf] Costco receipts never print the word "Costco", only the warehouse city and number ("CULVER CITY #479"). Recognize them by the member number, the item-code layout, and the "INSTANT SAVINGS" line.
- [receipt_pdf] Generic "Order Summary" e-commerce PDFs may print no merchant name anywhere. Infer it from distinctive signature products, otherwise set payee="Unknown Merchant" with brand discovery_failed, and skip Phase 3: the only address on the page is the buyer's own shipping address.
