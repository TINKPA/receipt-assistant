/**
 * Shared line-item contract for the extraction and re-extraction
 * prompts (#164) — the `items[]` schema, the `line_type` vocabulary,
 * the two-level modifier rule, the coverage/arithmetic invariant, the
 * per-line allocation logic, and the worked examples.
 *
 * Both prompts inline these phases verbatim so the agent — which runs
 * inside a container that doesn't have the source files — gets the
 * full instructions in its prompt window. Don't reference these phases
 * by source-file path from the prompt; the agent will go looking for
 * `src/ingest/prompt.ts` and waste turns when it can't find it.
 *
 * Why one module: `prompt.ts` and `reextract-prompt.ts` each carried a
 * hand-maintained copy of this contract and they DRIFTED. Measured on
 * production rows before #164: re-extract dropped `product_id` on 28.5%
 * of product lines (283/396) vs 0.2% at ingest, and `tax_minor` on
 * 94.4%, because its SQL required 11 fields its prose never named.
 *
 * Plain template literals, never `String.raw` — see `prompt-contract.ts`.
 */

/**
 * The full `items[]` object shape — all 26 fields, including the #84
 * product-catalog and per-line allocation columns the SQL requires.
 */
export const ITEM_SCHEMA = `── items[] shape (per line on the receipt) ───────────────────────────

Each \`item\` object has these fields:

  line_no            int      1-based, preserves the order printed
                              on the receipt
  parent_line_no     int|null  #162 CANONICAL TWO-LEVEL RULE. When this
                              line is a PAID modifier / add-on / topping /
                              size-upgrade that belongs to another item,
                              set this to that owning item's line_no. NULL
                              for top-level items and for tax/tip/discount
                              audit rows. See the "Two-level line-items"
                              block below — this is how a "+$3.00 Fish
                              Cutlet" add-on attaches to its parent dish
                              instead of floating as a peer line.
  raw_name           text     the line as printed, verbatim (don't
                              normalize — preserve abbreviations,
                              brand prefixes, codes)
  normalized_name    text|null brand-stripped human-readable form
                              (e.g. "KS PPR TWLS 12CT" → "Paper
                              Towels"). NULL when the raw name is
                              already clean or impossible to clean.
                              #162: this is the CLEAN ITEM NAME ONLY —
                              never append a relational suffix like
                              "(curry modifier)" / "(curry topping)".
                              A modifier's name is just "Fish Cutlet",
                              and parent_line_no carries the relationship.
  quantity           num|null  2, 0.5, 1 default if unprinted
  unit               text|null "ct", "lb", "kg", "oz", "ea", "ml",
                              or NULL when not printed
  unit_price_minor   int|null  minor units (cents for USD), NULL when
                              not printed (single line items often omit)
  line_total_minor   int       REQUIRED. Minor units. Signed —
                              negative for line-level discounts /
                              coupons / store-applied promos
  currency           text      ISO 4217, same as the transaction
  item_class         enum      one of:
                                 durable      — expected life ≥ 1 year
                                                (electronics, furniture,
                                                appliances, clothing,
                                                kitchenware, tools)
                                 consumable   — used up in weeks/months
                                                (cleaning supplies,
                                                toiletries, batteries,
                                                fuel, OTC meds, paper
                                                products, light bulbs)
                                 food_drink   — anything edible/potable
                                 service      — non-physical (massage,
                                                haircut, delivery fee,
                                                itemized service charge)
                                 other        — refunds, gift cards,
                                                tax appearing as its
                                                own line. Rare; if you
                                                use this often, the
                                                receipt is probably
                                                ambiguous — flag in tags.
  durability_tier    enum|null only when item_class='durable':
                                 luxury   — line total > \$200 OR brand
                                            is luxury-list (Apple
                                            high-end, LV, Hermès, …)
                                 standard — otherwise
                                NULL for non-durable items.
  food_kind          enum|null only when item_class='food_drink':
                                 restaurant_dish — dining/cafe merchant
                                 grocery_food    — market for home cook
                                 beverage        — drinks bought as
                                                   drinks (latte, water,
                                                   beer). Alcohol →
                                                   add "alcohol" tag.
                                NULL for non-food items.
  tags               text[]|null freeform low-trust signals:
                                ["alcohol","cold","organic","sale",
                                 "imported","handwritten","unclear"]
  confidence         enum      one of:
                                 high   — line crisp, totals tie
                                 medium — readable but ambiguous
                                 low    — thermal-paper smudge,
                                          ink fade, partial occlusion

  ── Phase 1 of #84: products SSOT + allocation fields ──

  line_type          text       which KIND of money this row is
                                (product / tax / tip / discount / …).
                                Default 'product'. The recommended
                                values, the open-vocabulary rule, and
                                the naming rules live in the "line_type
                                vocabulary + naming" block immediately
                                after this schema — read it, it is not
                                optional.

  product_key        text|null  kebab-case canonical key. REQUIRED for
                                line_type='product'; NULL for tax/tip/
                                discount rows. Format: ^[a-z0-9-]+\$.
                                Same product → same key forever.
                                Variants get distinct keys:
                                  iphone-15-pro-natural-titanium-256
                                  iphone-15-pro-blue-titanium-256
                                  kirkland-paper-towels-12ct
                                  starbucks-grande-latte
                                  costco-gas-regular   (NOT just "gas")
                                Don't include the merchant id in the key
                                — merchant scoping lives on a separate
                                column.

  product_brand_id   text|null  the manufacturer brand, NOT the seller.
                                "apple" for iPhone, "kirkland" for KS
                                products, "starbucks" for in-store
                                espresso. Mirror the merchant block's
                                brand_id rules.

  product_merchant_exclusive bool|null
                                true  → this product only exists at
                                        this merchant (Crunchwrap @
                                        Taco Bell, AYCE @ Sichuan Spicy
                                        Bay, in-store private label).
                                        Phase 4 binds product.merchant_id
                                        to this receipt's merchant.
                                false → portable / cross-merchant
                                        (iPhone, Coke, brand-name goods).
                                        product.merchant_id stays NULL
                                        and the row shares across stores.

  product_model      text|null   "M3 13\\" 256GB", "iPad Pro 11\\""
  product_color      text|null   "Natural Titanium", "Black", "Red"
  product_size       text|null   "L", "12 ct", "750 ml"
  product_variant    text|null   #162 CANONICAL: a single human-readable
                                string of THIS line's ZERO-COST
                                customizations — free options that change
                                the item but add no price (少糖 / 半糖 /
                                去冰 / "Less Sugar" / "Ice Blended" /
                                "no cilantro" / a free spice level).
                                Join multiple with ", ". NEVER put a PAID
                                add-on here (those become their own priced
                                child line via parent_line_no). Also used
                                as the catalog product's free-text variant
                                (flavor, fit, finish). NULL when the line
                                has no free customizations.
  product_sku        text|null   when printed on the receipt
  product_manufacturer text|null when the brand and the manufacturer
                                differ ("kirkland" brand made by
                                "georgia-pacific" manufacturer); leave
                                NULL when they match.

  tax_minor          int|null    per-line tax share allocated from the
                                printed tax aggregate. See the per-line
                                allocation logic below. NULL on tax/tip/
                                discount rows themselves and on lines
                                you decide are non-taxable.
  tip_share_minor    int|null    per-line tip share from printed tip.
  discount_share_minor int|null  per-line discount share. Signed
                                positive (always reduces). NULL when
                                no discount applies.`;

/**
 * `line_type` is an OPEN vocabulary — there is no DB enum, no zod enum
 * and no CHECK constraint behind the column (`transaction.ts` types it
 * `z.string()`), and production already holds 18 distinct values. A
 * closed list in ONE prompt only guarantees the two prompts disagree.
 *
 * Bare `fee` is deliberately absent from the recommended list: it
 * overlaps `service_fee` / `surcharge` and only ever existed because
 * the two prompts disagreed.
 */
export const LINE_TYPE_VOCAB_AND_NAMES = `── line_type vocabulary + naming (OPEN vocabulary) ────────────────────

\`line_type\` says which KIND of money a row is. These are the
RECOMMENDED values — a starting point, not a closed enum:

  product      — the default, an actual purchased line
  tax          — printed tax aggregate row
  tip          — printed tip aggregate row
  discount     — store discount / promo aggregate row (negative)
  shipping     — printed shipping / delivery charge
  surcharge    — printed surcharge (CRV, fuel, kitchen, card fee)
  service_fee  — printed service / convenience / platform fee
  gift_card    — a gift card sold, or store credit applied, as its
                 own line
  other        — money the source would not let you itemize (the
                 TOTAL-ONLY row below), or a printed row you genuinely
                 cannot label

Invent a snake_case label when none of these fit. There is no database
enum and no CHECK constraint behind this column, so an honest new label
is always better than forcing a row into a wrong one.

ALWAYS emit the printed tax / tip / discount / fee / surcharge rows
THEMSELVES as named items with the matching line_type and
product_key=NULL — e.g. a "Snackpass Credit" −\$5.00 row is
line_type='discount' (tags=['promo']); a "Taxes & Fees" \$0.51 row is
line_type='tax'. Keep the printed NAME in raw_name / normalized_name.
NEVER collapse them into the top-level tax_minor / discount_minor
numbers only — that loses the name. parent_line_no is NULL on these
rows. They are the audit baseline against the per-line allocations
further below.

NAME PRESERVATION — the printed name is the only copy.

  raw_name is the row EXACTLY as printed, verbatim: brand prefixes,
  regulatory prefixes, store codes, CJK, punctuation, spacing.

  normalized_name may expand an abbreviation or add an English gloss,
  but it MUST still identify the SAME specific thing:
    "KS PPR TWLS 12CT"     -> "Paper Towels"           OK (brand stripped)
    "CRV / REDEMPTION FEE" -> "CRV Redemption Fee"     OK (expanded)
    "CRV / REDEMPTION FEE" -> "Sales Fee"              WRONG (generalized)
    "Tax(7.75%)"           -> "Sales Tax"              OK
  Replacing a SPECIFIC printed name with a generic category word
  destroys information that exists nowhere else — the UI renders this
  string and never re-reads the image. When you cannot decode an
  abbreviation, set normalized_name = NULL. NULL is honest; a plausible
  generic label is a silent lie. This applies to tax / tip / discount /
  fee / surcharge rows exactly as it applies to products.

Two absolute rules on line_type:
  * NEVER force a row into a label that misdescribes it. 'surcharge' is
    not 'fee'; 'service_fee' is not 'tax'.
  * NEVER DROP a printed row because you could not label it. 'other'
    always exists. A dropped row is money that vanishes; a row labelled
    'other' is money that stays auditable.`;

/** The #162 two-level modifier rule, including BOTH the ADDITIVE and
 *  the INCLUSIVE branch. An agent given only the INCLUSIVE branch has
 *  exactly one directive about parent prices and it is "REDUCE" — the
 *  direct cause of #165. */
export const LINE_ITEM_TWO_LEVEL_RULE = `── Two-level line-items — the ONE rule for modifiers (#162) ───────────

Restaurant / cafe / boba receipts print a dish or drink followed by
its modifiers (toppings, add-ons, size upgrades, sugar/ice levels,
spice levels). Decide each modifier's fate by ONE test — does it have
a PRICE?

  PRICED add-on  → it is a LINE.
    Emit it as its OWN item object with a real line_total_minor, and
    set parent_line_no = the owning dish/drink's line_no. Give it a
    clean normalized_name ("Fish Cutlet", "Large Rice", "Soybean
    Mousse") — NO "(curry modifier)" / "(topping)" relational suffix;
    parent_line_no already encodes the relationship.
    Keep item_class/food_kind consistent with the parent (a paid
    topping on a dish is still food_drink / restaurant_dish).

    ADDITIVE vs INCLUSIVE pricing — get the parent's line_total right:
    • ADDITIVE (e.g. CoCo): the dish shows a base price and each paid
      modifier is printed with its own price ADDED on top. Keep the
      parent at its base; the children carry their own prices; they
      sum naturally.
    • INCLUSIVE (common on Snackpass / boba / combo receipts): the
      item shows ONE all-in customized price and the modifier prices
      are COMPONENTS of it, not charged on top. To split without
      double-counting, REDUCE the parent's line_total to the base =
      (displayed price − Σ priced add-ons); the children then re-add
      up to the displayed price.
    INVARIANT either way: parent base + Σ its child add-ons = the price
    actually charged for that item. NEVER leave the parent at the
    all-in price AND also emit priced children — that double-counts and
    breaks Σ line_total = subtotal.

    GUARD — INCLUSIVE fires ONLY when this line HAS priced children.
    "Σ priced add-ons" means exactly this: the sum of
    line_total_minor over the child rows YOU ARE EMITTING with
    parent_line_no = this line's line_no. Nothing else on the receipt
    counts toward it. When that sum is ZERO — the line has no children,
    or its children are printed at \$0.00 — then base = displayed, and
    you MUST leave the parent's line_total EXACTLY as printed.
      NEVER reduce or zero a printed price unless you are emitting
      priced child rows that add back up to it. A price you removed
      with nothing re-adding it is money DELETED from the receipt, not
      money re-shaped, and it is strictly worse than double-counting
      because nothing downstream can detect it.
      Per-line cross-check, run it on every line you reduced:
        (reduced parent base) + sum(that line's children's line_total)
          == the price printed on that line
      If that does not hold, your reduction was wrong. Put the printed
      price back and re-derive the children.

    ADDITIVE is the DEFAULT. Assume the printed price stands unless the
    receipt gives you positive evidence that one all-in price already
    contains its add-ons.

    INVARIANT, stated in BOTH directions:
      parent base + sum(its child add-ons) = the price actually charged
      for that item — no MORE (never leave the parent at the all-in
      price AND also emit priced children: that double-counts) and no
      LESS (never zero or shrink a parent without children re-adding
      the difference: that deletes money).

  ZERO-COST option → it is an ATTRIBUTE.
    Do NOT emit a separate line. Fold it into the PARENT item's
    product_variant string ("Less Sugar", "No Ice", "Spice Level 2",
    "no cilantro"). Multiple free options join with ", ".

Never do the reverse: never bury a priced add-on inside a
product_variant string (it would vanish from the ledger totals), and
never spawn a peer line for a free customization (it would double the
item count and break Σ line_total).

If a modifier's price is genuinely not itemized on the source (some
receipts bundle "Milk Tea +Boba" at one blended price with no
breakout), you cannot invent a split: keep the add-on name in the
parent's product_variant and add a "variant-price-unresolved" tag on
the parent so the limitation is auditable. Prefer a priced child line
whenever the source shows any separable price.

── Fixed-price PACKAGE / prix-fixe / AYCE / combo charges ─────────────

A DIFFERENT shape from the modifier case above, and the one most often
mangled. Some receipts charge ONE fixed package price and then list
everything the package covers at \$0.00 each: all-you-can-eat, hot-pot
"chang xuan" / "fang ti" selections, prix-fixe and tasting menus,
banquet sets, "combo" meals, bundled service plans. Signals: a line
whose price is large relative to the receipt and whose name contains
AYCE / All You Can Eat / Package / Set / Course / Combo / Prix Fixe /
per-person pricing, followed by a run of items printed at \$0.00 or with
no price column at all.

  1. THE PACKAGE CHARGE IS ITS OWN TOP-LEVEL PRODUCT LINE.
     line_type='product', parent_line_no=NULL,
     line_total_minor = the printed package price,
     raw_name = the package line exactly as printed,
     normalized_name = a clean gloss ("All-You-Can-Eat Package"),
     product_merchant_exclusive=true, quantity = the guest / cover
     count when printed.
     NEVER fold the package price onto one of the items it covers. A
     \$349.93 charge sitting on a "Green Bamboo Shoot" line is wrong
     three times over: the package disappears as a purchasable thing,
     a \$0 side dish acquires a \$349.93 price history, and no human
     reading the ledger can reconstruct what was bought.

  2. THE \$0.00 COVERED ITEMS ARE CHILDREN OF THE PACKAGE LINE.
     parent_line_no = the package line's line_no,
     line_total_minor = 0 (the printed price — do not impute one),
     item_class / food_kind inherited from the parent.
     They are the MANIFEST of what the package delivered. Keep every
     one, keep them at zero, and keep duplicates as separate rows when
     the receipt prints the same item more than once. Do NOT fold them
     into the package's product_variant — product_variant is for
     zero-cost CUSTOMIZATIONS of one item, not a list of distinct
     dishes.

  3. ANYTHING PRICED OUTSIDE THE PACKAGE KEEPS ITS PRINTED PRICE as its
     own TOP-LEVEL line: soup bases and pot charges, a-la-carte dishes,
     drinks, table / cover charges, sauce-bar fees. A soup base printed
     at \$90.98 is NOT "included in" the package merely because the
     package charge is larger. This is the INCLUSIVE GUARD restated: it
     has no priced children, so it gets no reduction. Do not zero it.

  4. TIE CHECK, before you write:
       sum(top-level line_type='product' lines)
         = package charge + everything priced outside the package
         = the printed SUBTOTAL
     The \$0.00 children contribute nothing by construction, so they
     cannot break this sum. If it misses the subtotal you either
     transplanted the package price onto a covered item or zeroed
     something printed. Fix the shape; do not paper over it.`;

/**
 * The arithmetic invariant + the TOTAL-ONLY fallback.
 *
 * Coverage is summed over `line_type IN ('product','other')`, not
 * `'product'` alone: the TOTAL-ONLY row (and, from #166 onward, the
 * occlusion-bridge row) stands in for product lines the source would
 * not let the agent read, so excluding it makes every receipt that
 * needs one fail its own tie check.
 *
 * PR #165/#166 extends this export with the occlusion-bridge rule.
 */
export const LINE_ITEM_COVERAGE_AND_BRIDGE = `── Coverage: never silently lose money to a region you cannot read ────

Two different failures, two different answers. Do not confuse them.

  NOTHING is itemizable — a total-only receipt, no item section, fully
  illegible thermal print, an image that is only a total:
    emit exactly ONE row —
      line_type='other', item_class='other', confidence='low',
      raw_name='TOTAL ONLY', line_total_minor=<TOTAL_MINOR>,
      parent_line_no=NULL, product_key=NULL,
      tags=['no-item-section'].

  SOME lines are readable but part of the item block is BLOCKED — a
  hand or thumb over the paper, a fold, a glare or flash band, a tear,
  a staple, a crop that cuts lines off — and the printed subtotal is
  materially larger than what you can actually read (gap > \$0.50):
    keep EVERY readable line at its printed price, AND emit ONE BRIDGE
    ROW carrying the difference —

      line_type         'other'
      item_class        'other'
      parent_line_no    NULL
      product_key       NULL
      raw_name          a literal description of what blocked the read:
                        "ITEMS OBSCURED BY HAND (unreadable)"
                        "LINES CUT OFF BY CROP"
                        "FOLD OBSCURES ~3 LINES"
                        "GLARE BAND OVER ITEM BLOCK"
      normalized_name   NULL
      line_total_minor  printed subtotal - sum(readable product lines)
      confidence        'low'
      tags              ['occluded','unreadable'] (or ['cropped'],
                        ['glare'], ['torn'] — describe the cause)
      quantity / unit / unit_price_minor   NULL

    The bridge row makes the gap EXPLICIT and auditable instead of
    silently missing, and it is what lets the receipt still tie.
      Do NOT invent plausible item names to fill the gap.
      Do NOT inflate a readable line to absorb it.
      Do NOT discard the readable lines and fall back to TOTAL ONLY —
        the readable lines are real data and must survive.
      Emit at most ONE bridge row per receipt.

  BRIDGE ONLY FOR SOURCE PROBLEMS. A gap you created yourself — by
  zeroing a parent, by folding a package charge onto a covered dish, by
  dropping a row you could not label — is a BUG to fix, not a gap to
  bridge. Before emitting a bridge row, re-read the two-level rule, the
  INCLUSIVE guard, and the package rule, and confirm the missing money
  is genuinely unreadable ink on the source. A bridge row on a legible
  receipt is a cover-up.

── Reconciliation self-check — run this BEFORE you write ──────────────

  A = sum(line_total_minor) over rows with line_type IN ('product','other')
      (bridge and total-only rows count in A: they stand in for product
       lines the source would not let you read)
  A  ~= the printed SUBTOTAL
  sum(tax rows)      ~= the printed tax
  sum(tip rows)      ~= the printed tip
  sum(discount rows) ~= the printed discount (negative)
  A + tax + tip + discount + shipping/surcharge/service_fee/gift_card
                     ~= the printed GRAND TOTAL

  Off by > \$0.50 with NO bridge row -> you lost or mis-shaped a line.
    Go find it. Usual culprits in order: a parent you zeroed, a package
    charge you transplanted, a printed row you dropped for want of a
    line_type.
  Off by > \$0.50 WITH a bridge row -> recompute the bridge amount from
    the printed subtotal.
  Within \$0.50 but over 1 cent -> keep it, set confidence='low' on the
    lines you least trust, and record
    transactions.metadata.allocation_audit = {kind, expected, got, delta}.
  Never block the write on a residual; log it.`;

/** Phase 2.7 — per-line tax / tip / discount allocation (#84). The
 *  re-extract SQL writes `tax_minor` / `tip_share_minor` /
 *  `discount_share_minor`, so re-extract needs this text too; before
 *  #164 it did not have it and dropped `tax_minor` on 94.4% of lines. */
export const ALLOCATION_LOGIC = `── Phase 2.7 — Per-line tax / tip / discount allocation (#84) ─────────

Receipts print aggregate tax / tip / discount; users want "what did
this specific line cost me, all-in." Allocate per-line at ingest.
Recommended logic (apply real arithmetic; do NOT hard-code rates):

Tax allocation:
  1. Look for per-line taxability markers ("T", "T1/T2", asterisks
     next to specific lines, "Taxable" labels).
  2. If markers present: \`tax_minor\` for each taxable line =
     ROUND(printed-tax-total × line_total_minor / Σ taxable lines).
     Non-taxable lines → tax_minor = NULL.
  3. If no markers: treat all line_type='product' rows as equally
     taxable and allocate proportionally.
  4. Make Σ tax_minor exactly match the printed tax (absorb the
     rounding remainder on the largest line).

Tip allocation (dining receipts):
  Split the printed tip total proportionally across product lines
  by \`line_total_minor\`. Tips are for the whole meal.

Discount allocation:
  Receipt names the target ("20% off Item X") → put it all on that
  line. Whole-order ("\$5 off subtotal") → split proportionally.
  BOGO / "buy 2 get 1 free" / promo edge cases → use judgment;
  record the reasoning in transactions.metadata.allocation_audit.

The printed tax / tip / discount rows themselves are emitted as items
per the line_type vocabulary above. Their tax_minor /
tip_share_minor / discount_share_minor stay NULL — a tax line is not
itself taxed.

Final self-check before COMMIT:
  Σ effective_total_minor (line_type='product') ≈ transactions.total
  Σ tax_minor      ≈ items where line_type='tax'
  Σ tip_share_minor ≈ items where line_type='tip'
  Σ discount_share_minor ≈ items where line_type='discount'
Discrepancies > 1¢ → record in transactions.metadata.allocation_audit
(structured object: \`{kind, expected, got, delta}\`). Don't block
ingest — just log.`;

/**
 * Worked examples, anchored to real fixtures.
 *
 * The CoCo example is the ADDITIVE anchor at **\$14.64 base, line_no 3**,
 * with "Less Sauce" presented as a counterfactual. The re-extract copy
 * that drifted to \$9.00 / line 1 / an actual "Less Sauce" was a
 * hand-retyped corruption and is gone.
 */
export const LINE_ITEM_WORKED_EXAMPLES = `── Worked examples ───────────────────────────────────────────────────

Two-level dish with paid modifiers (#162) — real CoCo Ichibanya order:
two plain dishes, then a "Fried Chicken Curry" $14.64 base with three
separately-PRICED modifiers (Large Rice $1.00, Level 4 spice $0.80,
Fish Cutlet $3.00). Every modifier here is priced, so every one is its
own child line (none go to product_variant); if any had been free
("Less Sauce", "No Onion") it would instead ride on line 3's
product_variant string:
  items = [
    {"line_no":1, "raw_name":"Naan Bread", "normalized_name":"Naan Bread",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "unit_price_minor":250, "line_total_minor":250, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "confidence":"high"},
    {"line_no":2, "raw_name":"Garlic Naan", "normalized_name":"Garlic Naan",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "unit_price_minor":300, "line_total_minor":300, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "confidence":"high"},
    {"line_no":3, "raw_name":"Fried Chicken Curry",
     "normalized_name":"Fried Chicken Curry", "parent_line_no":null,
     "quantity":1, "unit":"ea", "unit_price_minor":1464,
     "line_total_minor":1464, "currency":"USD", "item_class":"food_drink",
     "food_kind":"restaurant_dish", "confidence":"high"},
    {"line_no":4, "raw_name":"Large Rice", "normalized_name":"Large Rice",
     "parent_line_no":3, "quantity":1, "unit":"ea",
     "unit_price_minor":100, "line_total_minor":100, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "confidence":"high"},
    {"line_no":5, "raw_name":"Level 4", "normalized_name":"Spice Level 4",
     "parent_line_no":3, "quantity":1, "unit":"ea",
     "unit_price_minor":80, "line_total_minor":80, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "confidence":"high"},
    {"line_no":6, "raw_name":"Fish Cutlet", "normalized_name":"Fish Cutlet",
     "parent_line_no":3, "quantity":1, "unit":"ea",
     "unit_price_minor":300, "line_total_minor":300, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "confidence":"high"}
    // + a tax line ($1.93) with line_type='tax'. Σ product lines = $24.94
    // subtotal. Modifiers are children of line 3, NOT peers named
    // "Fish Cutlet (curry topping)", NOT folded into product_variant.
  ]

Boba drink, free customizations only (#162)
(3CAT "Brown Sugar Milk Tea" $5.50, Less Sugar + Ice Blended, both free):
  items = [
    {"line_no":1, "raw_name":"Brown Sugar Milk Tea",
     "normalized_name":"Brown Sugar Milk Tea", "parent_line_no":null,
     "product_variant":"Less Sugar, Ice Blended",
     "quantity":1, "unit":"ea", "unit_price_minor":550,
     "line_total_minor":550, "currency":"USD", "item_class":"food_drink",
     "food_kind":"beverage", "confidence":"high"}
  ]
  If that same drink instead showed "+Soybean Mousse $0.75" printed
  with a price, Soybean Mousse becomes line_no 2 with parent_line_no=1
  and line_total_minor=75. If the price is NOT itemized, keep
  "+Soybean Mousse" in product_variant and tag line 1
  "variant-price-unresolved".

Boba drink, INCLUSIVE paid add-ons (#162)
(3CAT "Avomango Sweet Dew" shown at ONE all-in $9.49; its +Soybean
Mousse ($1.25) and +Agar Boba ($0.75) are COMPONENTS of that $9.49,
and Less Sugar / Ice Blended are free). Reduce the parent to base
$7.49 so base + add-ons re-sum to the $9.49 actually charged:
  items = [
    {"line_no":1, "raw_name":"Avomango Sweet Dew",
     "normalized_name":"Avomango Sweet Dew", "parent_line_no":null,
     "product_variant":"Less Sugar, Ice Blended",
     "quantity":1, "unit":"ea", "unit_price_minor":749,
     "line_total_minor":749, "currency":"USD", "item_class":"food_drink",
     "food_kind":"beverage", "confidence":"high"},
    {"line_no":2, "raw_name":"Soybean Mousse",
     "normalized_name":"Soybean Mousse", "parent_line_no":1,
     "quantity":1, "unit":"ea", "unit_price_minor":125,
     "line_total_minor":125, "currency":"USD", "item_class":"food_drink",
     "food_kind":"beverage", "confidence":"high"},
    {"line_no":3, "raw_name":"Agar Boba", "normalized_name":"Agar Boba",
     "parent_line_no":1, "quantity":1, "unit":"ea",
     "unit_price_minor":75, "line_total_minor":75, "currency":"USD",
     "item_class":"food_drink", "food_kind":"beverage", "confidence":"high"}
    // base 749 + 125 + 75 = 949 = the price charged for the drink.
    // Do NOT emit the parent at 949 AND these children — that is 1074,
    // double-counting $1.25+$0.75. If the add-on prices were NOT shown,
    // keep them in product_variant + "variant-price-unresolved" instead.
  ]

Fixed-price PACKAGE with $0.00 covered items (#165) — hot pot, AYCE
"chang xuan" selections. Contrast this against the INCLUSIVE example
directly above: there, the parent was REDUCED because it had priced
children. Here the children are all $0.00, so the GUARD says the
package charge stays EXACTLY as printed. Two top-level product lines
(a soup-base/pot charge priced outside the package, and the package
itself), every covered dish a $0.00 child of the package:
  items = [
    {"line_no":1, "raw_name":"Small Pots", "normalized_name":"Small Pots",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "line_total_minor":9098, "currency":"USD", "item_class":"food_drink",
     "food_kind":"restaurant_dish", "line_type":"product",
     "product_key":"hot-pot-small-pots", "product_merchant_exclusive":true,
     "confidence":"high"},
    {"line_no":2, "raw_name":"AYCE Package (7 guests)",
     "normalized_name":"All-You-Can-Eat Package", "parent_line_no":null,
     "quantity":7, "unit":"ea", "line_total_minor":34993, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "line_type":"product", "product_key":"ayce-package",
     "product_merchant_exclusive":true, "confidence":"high"},
    {"line_no":3, "raw_name":"绿竹笋 Green Bamboo Shoot",
     "normalized_name":"Green Bamboo Shoot", "parent_line_no":2,
     "quantity":1, "unit":"ea", "line_total_minor":0, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "line_type":"product", "confidence":"high"},
    {"line_no":4, "raw_name":"安格斯肥牛 Angus Beef",
     "normalized_name":"Angus Beef", "parent_line_no":2,
     "quantity":1, "unit":"ea", "line_total_minor":0, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "line_type":"product", "confidence":"high"},
    {"line_no":5, "raw_name":"安格斯肥牛 Angus Beef",
     "normalized_name":"Angus Beef", "parent_line_no":2,
     "quantity":1, "unit":"ea", "line_total_minor":0, "currency":"USD",
     "item_class":"food_drink", "food_kind":"restaurant_dish",
     "line_type":"product", "confidence":"high"},
    // … one $0.00 child per printed selection, duplicates kept as
    // separate rows exactly as the receipt printed them …
    {"line_no":20, "raw_name":"Promotion", "normalized_name":"Promotion",
     "parent_line_no":null, "line_total_minor":-7000, "currency":"USD",
     "item_class":"other", "line_type":"discount", "tags":["promo"],
     "confidence":"high"},
    {"line_no":21, "raw_name":"Tax(7.75%)", "normalized_name":"Sales Tax",
     "parent_line_no":null, "line_total_minor":2875, "currency":"USD",
     "item_class":"other", "line_type":"tax", "confidence":"high"}
    // Arithmetic: top-level product lines 9098 + 34993 = 44091 = the
    // printed SUBTOTAL. 44091 - 7000 + 2875 = 39966 = the printed
    // GRAND TOTAL. The $0.00 children add nothing, by construction.
    //
    // BOTH of these shapes are WRONG and both have shipped before:
    //   (a) transplanting the 34993 package price onto line 3, the
    //       covered "Green Bamboo Shoot" — the package vanishes as a
    //       purchasable thing and a side dish gets a $349.93 history;
    //   (b) zeroing the 9098 "Small Pots" line as "included in the
    //       package" — it has NO priced children, so the INCLUSIVE
    //       guard forbids reducing it. That is $90.98 deleted.
  ]

Costco gas (single line):
  items = [
    {"line_no":1, "raw_name":"GAS REG", "normalized_name":"Regular Gas",
     "quantity":12.345, "unit":"gal", "unit_price_minor":419,
     "line_total_minor":5176, "currency":"USD",
     "item_class":"consumable", "tags":["fuel"], "confidence":"high"}
  ]

Occluded item block — the BRIDGE row (#166). A hand covers part of the
item list on a grocery receipt; five lines are readable and sum to
$63.17, but the printed subtotal is $156.09. Keep the readable lines,
carry the $92.92 gap on ONE explicit bridge row, and preserve the
printed fee names:
  items = [
    {"line_no":1, "raw_name":"SPINACH", "normalized_name":"Spinach",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "line_total_minor":1899, "currency":"USD", "item_class":"food_drink",
     "food_kind":"grocery_food", "line_type":"product",
     "product_key":"spinach", "confidence":"high"},
    {"line_no":2, "raw_name":"TOFU FIRM", "normalized_name":"Firm Tofu",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "line_total_minor":1499, "currency":"USD", "item_class":"food_drink",
     "food_kind":"grocery_food", "line_type":"product",
     "product_key":"firm-tofu", "confidence":"high"},
    {"line_no":3, "raw_name":"PORK BELLY", "normalized_name":"Pork Belly",
     "parent_line_no":null, "quantity":1, "unit":"lb",
     "line_total_minor":1299, "currency":"USD", "item_class":"food_drink",
     "food_kind":"grocery_food", "line_type":"product",
     "product_key":"pork-belly", "confidence":"high"},
    {"line_no":4, "raw_name":"KIMCHI 1KG", "normalized_name":"Kimchi 1kg",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "line_total_minor":999, "currency":"USD", "item_class":"food_drink",
     "food_kind":"grocery_food", "line_type":"product",
     "product_key":"kimchi-1kg", "confidence":"high"},
    {"line_no":5, "raw_name":"GREEN ONION", "normalized_name":"Green Onion",
     "parent_line_no":null, "quantity":1, "unit":"ea",
     "line_total_minor":621, "currency":"USD", "item_class":"food_drink",
     "food_kind":"grocery_food", "line_type":"product",
     "product_key":"green-onion", "confidence":"high"},
    {"line_no":6, "raw_name":"ITEMS OBSCURED BY HAND (unreadable)",
     "normalized_name":null, "parent_line_no":null, "quantity":null,
     "unit":null, "unit_price_minor":null, "line_total_minor":9292,
     "currency":"USD", "item_class":"other", "line_type":"other",
     "product_key":null, "tags":["occluded","unreadable"],
     "confidence":"low"},
    {"line_no":7, "raw_name":"SALES TAX", "normalized_name":"Sales Tax",
     "parent_line_no":null, "line_total_minor":360, "currency":"USD",
     "item_class":"other", "line_type":"tax", "confidence":"high"},
    {"line_no":8, "raw_name":"CRV / REDEMPTION FEE",
     "normalized_name":"CRV Redemption Fee", "parent_line_no":null,
     "line_total_minor":10, "currency":"USD", "item_class":"other",
     "line_type":"surcharge", "confidence":"high"}
    // Arithmetic: 6317 (readable products) + 9292 (bridge) = 15609 =
    // the printed SUBTOTAL. 15609 + 360 + 10 = 15979 = the printed
    // GRAND TOTAL.
    // Do NOT collapse 'surcharge' to 'fee', and do NOT generalize
    // "CRV Redemption Fee" to "Sales Fee" — that specific printed name
    // exists nowhere else once the image is filed away.
    // Do NOT invent five more plausible grocery names to fill the
    // $92.92, and do NOT throw the readable lines away for a TOTAL
    // ONLY row.
  ]

AYCE sushi dinner — flat per-cover pricing, NOT a package ($46.20).
Nothing here is printed at $0.00, so there is no package line and no
$0.00 manifest; this is just two ordinary priced lines:
  items = [
    {"line_no":1, "raw_name":"AYCE Lunch", "normalized_name":"All-You-Can-Eat Lunch",
     "quantity":2, "unit":"ea", "unit_price_minor":2199,
     "line_total_minor":4398, "currency":"USD", "item_class":"food_drink",
     "food_kind":"restaurant_dish", "confidence":"high"},
    {"line_no":2, "raw_name":"Hot Tea", "normalized_name":"Hot Tea",
     "quantity":2, "unit":"ea", "unit_price_minor":150,
     "line_total_minor":300, "currency":"USD", "item_class":"food_drink",
     "food_kind":"beverage", "confidence":"high"}
  ]

Best Buy laptop ($1,599):
  items = [
    {"line_no":1, "raw_name":"MBA M3 13 256GB", "normalized_name":"MacBook Air M3 13\" 256GB",
     "quantity":1, "unit":"ea", "unit_price_minor":159900,
     "line_total_minor":159900, "currency":"USD",
     "item_class":"durable", "durability_tier":"luxury",
     "tags":["electronics","apple"], "confidence":"high"}
  ]`;
