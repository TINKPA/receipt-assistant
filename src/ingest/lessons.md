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
- [unsupported] A checkout page still showing a "Submit order" step ahead of it has NOT been paid, even though it prints a real "DUE TODAY" figure. Read the breadcrumb (e.g. T-Mobile "Shipping & payment › Review order › Submit order"): no confirmation number, no order number, no "thank you" — it is a cart, and the amount is a quote. Unsupported.
- [income] A buyback QUOTE or packing slip ("Quote: $470.00", "carefully package your device", a prepaid shipping label) is an offer, not a payout. The money event is the CHECK or payout confirmation that follows weeks later, usually for a DIFFERENT amount after inspection. Book only the payout; attach the packing slip to that same transaction. reCell.io quoted $470 on 11/23 and paid $400 on 12/03 for one iPhone — booking both double-counted the sale.
- [income] One payout is often documented twice: the insurer's/processor's "Your Payment Confirmation" email AND the bank portal's "Payment Confirmed" screen. They share a Confirmation # and differ in payee string and printed date, so neither payee+date dedup nor a same-batch reconcile catches them. Always store the confirmation number, and when two inbound documents share one, they are ONE transaction — attach, do not insert.
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

# ── Batch 3, promoted 2026-08-31 ──────────────────────────────────────
# Triaged from 159 runtime proposals accumulated 2026-07-31 → 2026-08-31; see
# 10_Projects/2026_Dev_ReceiptAssistant/notes/2026-08-31_analysis_lessons-proposal-triage.md
# 106 raw proposals consolidated into the 31 lessons below — the Taobao rule
# alone was written 12 separate times. Rejected there and deliberately NOT
# promoted: 2 proposals that INVERT rules the code has since settled — "a
# Starbucks Card reload is the money-counting event" (it is a transfer) and
# "an AppleCare Agreement Refund is unsupported" (it is a refund, and the rule
# it would undo exists because the old one cost 13 real refunds).
# 13 escalated to issues; 5 deleted as already fixed by #230.

# Dates
- [receipt_image] Chinese POS receipts print 下单时间 as DD/MM/YYYY where US receipts use MM/DD; the 订单编号 embeds an unambiguous YYYYMMDDHHMMSS prefix (20260812151720 → 2026-08-12). Read the order number instead of guessing the slash-date. CHAGEE likewise prints a 2-digit-year stamp AND a full ISO timestamp below Paid — cross-check them.
- [receipt_pdf] Two exceptions to the CreationDate fallback. A template-built slip carries the TEMPLATE's date (a Decluttr pack drawn in Illustrator stamps 2018, older than the 2020 iPad being sold) — use a date artifact tied to the order instead, with date_confidence=low. And when CreationDate IS the fallback, convert to store-local first: 06:11 UTC is the previous calendar day in Los Angeles.
- [receipt_email] When an email prints no charge date at all (prepaid hotel bookings, LAZ Parking, KFC pickup), the RFC822 Date header IS the charge date — it is generated at order time, and the stay/pickup times are service dates. On portal printouts with several timestamps, the labelled Payment Date beats the earlier confirmation timestamp.
- [receipt_image] No printed date AND stripped EXIF (iOS strips on share; an editor re-save leaves only a Photoshop IRB) leaves the file mtime as the only anchor — a screenshot's status-bar clock corroborates it to the minute. Use it with metadata.date_unresolved + needs_review rather than inventing a plausible date.
- [receipt_email] Card-issuer alert emails (Robinhood/Chase "Refund: <merchant>") carry only merchant + amount, and their RFC822 Date IS the transaction date — generated at posting, the one exception to the email-Date rule. With no identifier, leave refund_of unset. Their MJML templates also leak MSO comment digits (<o:pixelsperinch>96</o:pixelsperinch> reads as cents under "+$99"): grep the raw HTML before trusting a decimal not attached to a $.

# Documents that look like receipts but are not (extends the block above)
- [unsupported] Support-chat transcripts and service replies (Apple aoschat archives, lululemon "Return Follow Up") discuss refunds and may carry an order number and $ figures, but those are order-line reference prices and no refund amount is ever stated. Unsupported — never book a refund off the words "return"/"refund" alone.
- [receipt] A $0.00 total is not automatically a cart or a suppressed price: a POS receipt with Trans/Register/Sales-Rep numbers, a USPS counter receipt for a prepaid label, and a T-Mobile *order confirmation* ("Thank you for your order" + confirmation number + charged card) are all real. The cart rule applies only to a page still showing a "Submit order" breadcrumb; on the confirmation, book "Due at time of Purchase" and exclude "Due monthly".
- [unsupported] PayPal "You authorized a payment" emails for a card reload look exactly like merchant spend — merchant name, line item, subtotal, funding source. The tell is "Instructions to merchant: Reload" plus a "<Brand> Card Reload" description: still a stored-value top-up, still a transfer. Check for Reload before booking any PayPal receipt.

# Refunds and income (extends the direction-of-money test above)
- [refund] Amazon "Order Details" pages for a returned order print a Grand Total and an equal Refund Total plus "Your refund has been issued" — the banner is the flow signal, not the equal totals. No refund date is printed, so occurred_on is the "Order placed" date, never the browser print stamp. A "Return received / No current charges" page at $0.00 is a postable printed zero, not a suppressed price.
- [refund] On a refund check or state warrant (CA DMV), the field labelled "Payee:" is the USER receiving the money — the ledger payee is the ISSUING agency on the check face. Never copy the check's Payee field into transactions.payee.
- [income] Buyback mechanics: recover the payee from the order-number prefix when no company name is printed (IGO-31176233 → iGotOffer), and an order number that is a Unix epoch (1669179848 = 2022-11-23) corroborates a genuinely old date. A business check to the user is income — the payer block is the counterparty, the MEMO line (device + IMEI) is the item. Retire owned_items by explicit product_id from Turn A, never an ILIKE name match; with no serial printed and several live instances, record metadata.owned_items_note rather than guessing.

# Totals, discounts and tax
- [receipt] Savings annotations are usually ALREADY netted into the printed price, so emitting them as discount rows double-subtracts: Kroger "Annual Card Savings" is a year-to-date total, 99 Ranch "You Saved" is informational (only its "Item Store Coupon" is real), Great Wall "Qty Spl/Pkg Disc." is netted. The sign is not guaranteed either — H Mart's "10 CENT DISC FOR O" ADDS a bag charge. Verify every candidate discount against the printed subtotal by arithmetic first.
- [receipt_email] Not every receipt prints Subtotal BEFORE the discount: Subway prints the promo and "Subway Cash Redeemed" store credit above it (17.49 − 10.49 − 2.00 = 5.00), so sum(product lines) will not equal the printed Subtotal. Reconcile as items + discount = subtotal, and keep store credit as its own gift_card line.
- [receipt] The tax base is not always the subtotal: auto-gratuity can itself be taxed (7.75% of subtotal+18% service charge, which read as a bogus 9.24% against the bare subtotal), a "Base for Tax" line can exclude a non-taxable bag fee, and an airline's disclosed Transportation Tax is ALREADY inside the printed airfare (verify with fare/1.075). Test these bases before concluding the tax was misread.
- [receipt] Inclusive vs additive modifiers is settled by one test, not by vendor: if the printed SUBTOTAL equals the parent line exactly, there is no separable child price — leave the parent alone and put the modifier in product_variant tagged variant-price-unresolved. Toast prints priced modifiers as additive indented rows; Square paid modifiers are inclusive. A POS quantity on a $0.00 modifier row (Less_Ice qty 3 on one drink) is an artifact, not 3 items.
- [receipt_pdf] The residual-card-charge rule counts FUTURE legs too: an Airbnb booking split across gift cards and scheduled payments has a residual equal to the sum of ALL card legs including "Scheduled Payment N of 7", not just the one already taken.
- [receipt_pdf] Collision estimates (Mitchell, CCC/Caliber "Estimate of Record") leave most operation lines at INC/no-dollar and itemize only in the Estimate Totals block; some end at a parts-only SUBTOTALS row with labor printed as HOURS and no grand total. Use the parts+materials subtotal, flag total_basis, and do not fabricate a labor-inclusive total. Date is the RO "Written By" date, not Date of Loss or Vehicle Out.

# Merchant and vendor formats
- [receipt_email] Taobao/Tmall order pages carry FOUR timestamps (创建/付款/发货/成交) — 付款时间 is occurred_on, 成交时间 is auto-confirm-receipt 10+ days later. Each item prints TWO prices (black = paid, struck-through = list); 商品总价 sums the LIST prices and 官方立减/店铺优惠 bridge it to 实付款, so summing paid prices double-counts the promo and the per-item gap is the exact discount_share. Read the embedded <script id="order-data"> JSON first, collapse whitespace before parsing ("￥ 253 . 00"), and skip Phase 3 — the only address is the buyer's.
- [receipt_email] Newegg order confirmations print ONLY the Order Total; the purchased item carries no price, and the priced rows below "Looking forward to seeing you again" are a recommendation carousel re-advertising the same item at list ($16.99 vs the $15.35 paid). Take line rows only from the block under "Order #<n> Shipped By <seller>".
- [receipt_email] Apple receipts carry two reference numbers and two dates: "ORDER ID" → order_number, "DOCUMENT NO." → invoice_number, the body's receipt date is occurred_on, and "Renews <date>" is a FUTURE renewal Check B must not pick. "Services Billed Separately" is not charged here. "Amount Due $0.00" is a balance — the real total is the "$N charged to XXXX" line; on a Genius Bar in-warranty swap, record the gross flat-rate line plus a warranty discount so the list price survives and it still ties to $0.
- [receipt_pdf] Costco receipts carry no order/auth number but do print a register-transaction id (Whse/Trm/Trn/OPT, e.g. "479 205 168 705") plus HH:MM near the tender line. That id is the strong near-dup tiebreaker: a photo and the PDF of one checkout share it exactly even when item OCR is mangled (FLAP MEAT → FUJI MAT MEAT) or the PDF consolidates 2×16.99 into 1×33.98. Use it, not the item breakdown.
- [receipt_email] Stripe receipts (receipts+acct_*@stripe.com): the brand is the channel, Stripe the acquirer, never the merchant. Receipt number → payment_id, Invoice number → invoice_number, occurred_on is the "Paid" line — not the service-period end and not the email Date. "Date paid" prints in the merchant's timezone with no offset; the UTC Date header recovers it. A subscription upgrade prints a proration PAIR (+59.96 new plan, −29.98 old-plan credit) — keep both, the Total is their sum.
- [receipt_email] Some receipts are summary-only by design: Clover emails put the itemization behind a SendGrid link that cannot be resolved offline, and Google "Payment received" emails carry none. Emit the single TOTAL ONLY row and stop looking. On the Google ones only "Payment ID: CLOUD xxxxxx" is a purchase identifier — the Payments profile and GCP customer IDs repeat on every future bill and would falsely match them all.
- [receipt_email] Payment-portal confirmations (Nelnet and similar) print INSTITUTION AMOUNT + SERVICE FEE + TOTAL AMOUNT: total_minor is TOTAL AMOUNT, the fee is its own service_fee row, the platform is the channel and the institution the seller. Use the labelled PAYMENT DATE, not the prose "authorized and submitted on" date a day earlier; Customer #/Student ID are account identifiers, never dedup keys.
- [receipt_email] SingleFile-saved HTML is mostly inlined base64 CSS and images — strip script/style/svg and extract text before reading (1 MB → ~3 KB; a 486 KB dealer page → ~6 KB). Never Read the raw file. They embed the whole email thread, so the Order Confirmed / Quote date is the charge date and the later "shipped"/"processing" updates are not.
- [receipt_image] Branded fuel stations print the site's car-wash or dba name in the letterhead (COSTA VERDE CAR WASH) with the fuel brand on a small separate line (VFI Chevron) — resolve the payee to the brand. The address geocodes to a bare premise, so fall through to findplacefromtext with "<brand> <address>" and confirm free by matching the printed station number against the digits in Google's websiteUri. PRICE/G has 3 decimals ($6.449): round unit_price_minor, keep line_total_minor authoritative.

# Place resolution
- [receipt] Skip Phase 3 rather than force a match. Parking receipts print a lot address with no city so locality validation can never pass; municipal lots print the AGENCY HQ address rather than the lot; and findplacefromtext then confidently returns a DIFFERENT structure run by the same operator — a wrong lot is worse than no place. Small independents often have no Google Business Profile at all: set ocr_audit.google_name=NULL and skip the Check C cross-check instead of retrying permutations.
- [receipt_image] A locality mismatch is not automatically a bad OCR read: Google returns the USPS postal city where the receipt prints the municipal one (Costco #479 prints "Culver City", Google returns "Marina Del Rey, CA 90292"). Validate on ZIP/street before giving up. Only when you still cannot tell WHICH branch — a chain's own internal store label sitting between two branches in different cities — is it ambiguous, and only then skip Phase 3.

# Dedup
- [receipt] Some duplicates share no bytes and no Message-ID: Lyft re-sends a ride receipt with a different Message-ID, and airline e-receipts arrive as both PDF and confirmation email. Only the Phase 4a.0 amount+date near-dup check catches these — corroborate with ride details (driver, pickup time and address, distance) or, on a voucher/eCredit split, with the residual charge + card last-4 + the ticket/eCredit/residual triple, never the pre-voucher total. Attach, do not insert.

# OCR arbitration
- [receipt_image] When a glyph is doubtful, let arithmetic arbitrate rather than the glyph: CVS prints TOTAL in bold double-strike and smeared 14.54 into 19.59 (the CHARGE line below it and subtotal+tax both settle it), and a total rendered "2O.72" was 26.72 once 24.80 × 7.75% was checked — the font slashed no other zero on that receipt. The same test settles column alignment: never re-align an offset price column by eye, test the mapping against the printed SubTotal.

# Hotel folios (extends the folio lessons above)
- [receipt_pdf] Folios do not always settle at checkout: when the only credit is "Deposit Transferred at C/I" dated the arrival day and Balance is 0.00, the card-payment date IS the arrival date. A multi-window invoice gives each window its own Balance — the card charge is the window whose tender is a card, not the sum across windows (an Award window nets to $0.00). And when the only charge is an incidental, category follows the CHARGE (parking → Transportation), not the hotel brand.
