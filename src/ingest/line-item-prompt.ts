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
further below.`;

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
whenever the source shows any separable price.`;

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
export const LINE_ITEM_COVERAGE_AND_BRIDGE = `── Coverage + arithmetic invariant ───────────────────────────────────

  Σ line_total_minor across rows with line_type IN ('product','other')
  SHOULD approximate the receipt's printed SUBTOTAL (within \$0.01
  rounding). 'other' counts toward coverage because the TOTAL-ONLY row
  below stands in for product lines the source would not let you read.

  The remaining rows — tax / tip / discount / shipping / surcharge /
  service_fee / gift_card — carry the rest (discount rows are
  negative), so Σ of ALL rows ≈ the printed GRAND TOTAL.

  If the coverage sum is off by more than \$0.50, drop confidence to
  "low" on the items that look most suspect.

  Self-check before COMMIT:
    Σ tax rows      ≈ the printed tax
    Σ discount rows ≈ the printed discount (negative)
    Σ product effective_total ≈ the transaction total

If you cannot itemize at all (total-only receipt, unreadable item
section, illegible thermal print) emit exactly ONE item with

  line_type='other', item_class='other', confidence='low',
  raw_name='TOTAL ONLY', line_total_minor=<TOTAL_MINOR>,
  parent_line_no=NULL, product_key=NULL,
  tags=['no-item-section']

— one label for "money the source would not let me itemize" keeps
every downstream product-scoped sum a two-value check instead of an
open-ended one.`;

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

Costco gas (single line):
  items = [
    {"line_no":1, "raw_name":"GAS REG", "normalized_name":"Regular Gas",
     "quantity":12.345, "unit":"gal", "unit_price_minor":419,
     "line_total_minor":5176, "currency":"USD",
     "item_class":"consumable", "tags":["fuel"], "confidence":"high"}
  ]

AYCE sushi dinner ($46.20):
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
