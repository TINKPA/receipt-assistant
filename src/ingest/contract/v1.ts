/**
 * The extraction record, contract version 1 (`ExtractionV1`, wave 1).
 *
 * Under the server writer (`EXTRACTION_WRITER=server_apply`) the
 * extraction agent no longer writes SQL. It reads the document, reasons
 * in plain text, and ends its final message with one fenced ```json
 * object of this shape (see `artefact.ts`). The server validates it
 * (`validate.ts`), stores it in `document_extractions` (`records.ts`) and
 * derives every ledger row from it in code.
 *
 * ONE SOURCE FOR TWO READERS. This zod schema is what the validator
 * enforces, and `renderContractForPrompt()` builds the prompt's
 * description of the record from the same schema, field by field, from
 * each field's `.describe()` text and its checks. The prompt and the
 * validator therefore cannot disagree about a field name, an enum value,
 * a cap or a format (#164 was two hand-kept copies of one contract that
 * drifted apart). A rule that is not a property of one field (required
 * when the classification is a receipt, the sign follows the flow, …)
 * lives in `validate.ts` and is stated in the describe text of the field
 * it governs.
 *
 * CLOSED. Every object is `.strict()`: a key that is not listed here is
 * refused wherever it appears, which is how the keys the model must
 * never hand over (ids of any kind, status, account ids, base amounts,
 * `fx_rate`, provenance, dedup verdicts, email headers, place rows; see
 * `FORBIDDEN_PAYLOAD_KEYS`) are kept out. Ids come from the server's own
 * context, never from the record. The two free bags, `other_references`
 * and `receipt_facts`, take any snake_case key, are size-capped, and are
 * stored under their own metadata key where nothing reads them as a
 * ledger field.
 *
 * NAMES. Field names follow the legacy prompt's template placeholders and
 * `ITEM_SCHEMA` (`line-item-prompt.ts`) verbatim, so the model's job
 * changes from "put these values in SQL" to "put these values in JSON".
 *
 * MONEY. Integers in the currency's own minor unit at the exponent
 * `src/ledger/money.ts` gives it (cents for USD, whole yen for JPY,
 * whole points for a `_PT` programme). Signs follow the legacy
 * convention: a refund's total and lines are negative, a discount line
 * is negative as printed, income stays positive.
 *
 * VERSIONING. Any change to this shape bumps
 * `EXTRACTION_CONTRACT_VERSION`, always together with
 * `RECORD_PROMPT_VERSION` (`prompt-contract.ts`). One exception was
 * taken: `debit_card` joined `PAYMENT_METHODS` inside version 1 (November
 * 2026), because no record had been written outside throwaway and sandbox
 * databases yet, so no stored version-1 record lacks it. Once production
 * holds records, there are no more exceptions.
 */
import { z } from "zod";
import type { IdentifierKey } from "../../reconcile/dedup.js";

export const EXTRACTION_CONTRACT_VERSION = 1 as const;

// ── Vocabularies ───────────────────────────────────────────────────────

export const CLASSIFICATIONS = [
  "receipt_image",
  "receipt_email",
  "receipt_pdf",
  "statement_pdf",
  "unsupported",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** The classifications that book a transaction. */
export const RECEIPT_CLASSIFICATIONS = [
  "receipt_image",
  "receipt_email",
  "receipt_pdf",
] as const satisfies readonly Classification[];

export function isReceiptClassification(c: unknown): boolean {
  return (RECEIPT_CLASSIFICATIONS as readonly unknown[]).includes(c);
}

export const UNSUPPORTED_REASONS = [
  "not_a_receipt",
  "transfer",
  "marketing",
  "unreadable",
  "other",
] as const;

export const SOURCES_USED = [
  "image",
  "pdf_text",
  "pdf_raster",
  "email_body",
  "email_attachment",
  "html",
] as const;

export const FLOWS = ["purchase", "refund", "income"] as const;
export type Flow = (typeof FLOWS)[number];

export const PAYEE_SOURCES = ["printed", "google_check_c", "email_sender"] as const;

export const PAYMENT_METHODS = [
  "card",
  "debit_card",
  "cash",
  "check",
  "bank_transfer",
  "points",
  "gift_card",
  "mixed",
  "other",
  "unknown",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEPOSIT_ACCOUNTS = ["Checking", "Savings", "Cash"] as const;
export const INCOME_ACCOUNTS = ["Salary", "Other"] as const;

/** The seven expense accounts; `merchant.category` names one of them. */
export const EXPENSE_CATEGORIES = [
  "Food & Drinks",
  "Transportation",
  "Shopping",
  "Travel",
  "Entertainment",
  "Health",
  "Services",
] as const;

export const CATEGORY_HINTS = [
  "groceries",
  "dining",
  "retail",
  "cafe",
  "transport",
  "other",
] as const;

export const PLACE_RESOLVED_VIA = [
  "geocode_address",
  "find_place_text",
  "find_place_phone",
  "none",
] as const;

/** `transaction_items.item_class` and `products.item_class` CHECK. */
export const ITEM_CLASSES = ["durable", "consumable", "food_drink", "service", "other"] as const;
export const DURABILITY_TIERS = ["luxury", "standard"] as const;
export const FOOD_KINDS = ["restaurant_dish", "grocery_food", "beverage"] as const;
export const ITEM_CONFIDENCES = ["high", "medium", "low"] as const;

export const PARTY_ROLES = ["channel", "seller", "maker", "acquirer"] as const;

export const STATEMENT_ROW_KINDS = [
  "charge",
  "credit",
  "payment",
  "fee",
  "interest",
  "other",
] as const;

export const REVIEW_FLAGS = [
  "date_unresolved",
  "total_unresolved",
  "handwritten_amount",
  "partial_document",
  "needs_review",
] as const;

/**
 * The closed identifier contract (#204): the only keys dedup reads. The
 * same five as `IDENTIFIER_KEYS` in `src/reconcile/dedup.ts`; the type
 * check below fails the build if the two lists ever differ. (Listed here
 * rather than imported so the contract module loads without the
 * database client that `dedup.ts` pulls in.)
 */
export const CONTRACT_IDENTIFIER_KEYS = [
  "order_number",
  "confirmation_number",
  "invoice_number",
  "payment_id",
  "approval_code",
] as const;
export type ContractIdentifierKey = (typeof CONTRACT_IDENTIFIER_KEYS)[number];
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const IDENTIFIER_KEYS_AGREE: SameKeys<ContractIdentifierKey, IdentifierKey> = true;
void IDENTIFIER_KEYS_AGREE;

/**
 * Keys the record must never carry: the server takes them from its own
 * context or computes them. `.strict()` already refuses every key the
 * schema does not list; this list exists so `check-contract` can prove
 * each of these is refused, and so the prompt can name them.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  "id",
  "transaction_id",
  "document_id",
  "ingest_id",
  "workspace_id",
  "user_id",
  "account_id",
  "merchant_id",
  "place_id",
  "product_id",
  "status",
  "amount_base_minor",
  "fx_rate",
  "extraction",
  "prompt_version",
  "model",
  "near_dup_check",
  "merge_audit",
  "refund_of",
  "allocation_audit",
  "message_id",
  "headers",
  "places",
  "ingest_status",
] as const;

// ── Formats and caps ───────────────────────────────────────────────────

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO-8601 local date-time with an explicit offset (`Z`, `+08:00`, `-0700`). */
export const OFFSET_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
/** A brand slug: lowercase ASCII words joined by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `ITEM_SCHEMA`'s product key format. */
export const PRODUCT_KEY_RE = /^[a-z0-9-]+$/;
export const LINE_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const SNAKE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const GOOGLE_PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const CARD_LAST4_RE = /^\d{4}$/;

/** How the prompt (and the repair text) names each format, instead of
 *  printing the regex. */
const FORMAT_LABELS = new Map<string, string>([
  [DATE_RE.source, "a date YYYY-MM-DD"],
  [OFFSET_DATETIME_RE.source, "an ISO-8601 date-time with offset"],
  [SLUG_RE.source, "a slug of a-z and 0-9 joined by single hyphens"],
  [PRODUCT_KEY_RE.source, "kebab-case a-z, 0-9 and -"],
  [LINE_TYPE_RE.source, "snake_case, 2–40 chars"],
  [SNAKE_KEY_RE.source, "snake_case"],
  [GOOGLE_PLACE_ID_RE.source, "a Google place id"],
  [HOSTNAME_RE.source, "a lowercase hostname"],
  [CARD_LAST4_RE.source, "four digits"],
]);

export const ITEMS_MAX = 400;
export const PARTIES_MAX = 50;
export const STATEMENT_ROWS_MAX = 1000;
export const DATE_CANDIDATES_MAX = 10;
export const TAGS_MAX = 20;
export const OTHER_REFERENCES_MAX_KEYS = 20;
export const RECEIPT_FACTS_MAX_KEYS = 30;
export const RECEIPT_FACTS_MAX_BYTES = 4 * 1024;

/** Issue params that make a zod refinement report a validator rule id
 *  instead of the generic `schema` (see `validate.ts`). */
export interface RuleParams {
  rule: "size_cap";
}

/** The name of a format regex used in this schema, or undefined. */
export function formatLabel(regex: RegExp): string | undefined {
  return FORMAT_LABELS.get(regex.source);
}

// ── Building blocks ────────────────────────────────────────────────────

const minor = () => z.number().int().safe();
const text = (max: number) => z.string().min(1).max(max);

/**
 * A bag of snake_case keys with a key-count cap (and, for
 * `receipt_facts`, a byte cap). Over a cap is the `size_cap` rule.
 */
function bag<V extends z.ZodTypeAny>(value: V, maxKeys: number, maxBytes?: number) {
  return z.record(z.string().regex(SNAKE_KEY_RE), value).superRefine((v, ctx) => {
    const keys = Object.keys(v).length;
    if (keys > maxKeys) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `has ${keys} keys; at most ${maxKeys} are allowed`,
        params: { rule: "size_cap" } satisfies RuleParams,
      });
    }
    if (maxBytes !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(v), "utf8");
      if (bytes > maxBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `is ${bytes} bytes as JSON; at most ${maxBytes} are allowed`,
          params: { rule: "size_cap" } satisfies RuleParams,
        });
      }
    }
  });
}

// ── facts ──────────────────────────────────────────────────────────────

const Facts = z
  .object({
    flow: z
      .enum(FLOWS)
      .describe(
        "Which way the money moved. purchase: money left the user (the default). " +
          "refund: money came back because a purchase was undone or reduced. " +
          "income: money came in and no purchase is being undone (selling something, a payout). " +
          "A transfer between the user's own accounts is not a receipt: classify it unsupported with reason transfer.",
      ),
    occurred_on: z
      .string()
      .regex(DATE_RE)
      .describe(
        "The transaction date as printed, YYYY-MM-DD, and a real calendar date. Never today's date as a fallback. " +
          "Refused when it is more than 2 days after the upload or before 2000-01-01.",
      ),
    occurred_at: z
      .string()
      .regex(OFFSET_DATETIME_RE)
      .nullish()
      .describe(
        "The transaction time as ISO-8601 with its UTC offset (2026-01-31T14:05:00-08:00), or null when no time is printed. " +
          "Its date part must equal occurred_on. For an email: the time in the body, else the envelope Date.",
      ),
    payee: text(200).describe(
      "The merchant name you settle on, after any correction from the place cross-check (Check C).",
    ),
    payee_as_printed: z
      .string()
      .max(200)
      .nullish()
      .describe("The merchant name exactly as printed on the document, before any correction."),
    payee_source: z
      .enum(PAYEE_SOURCES)
      .nullish()
      .describe(
        "Where payee came from: printed (as read), google_check_c (corrected by the place cross-check), " +
          "email_sender (the sender of an email that prints no merchant name).",
      ),
    total_minor: minor().describe(
      "The grand total actually charged, in the currency's minor unit (cents for USD, whole yen for JPY, " +
        "whole points for a points currency). Signed: a purchase or income is zero or positive, a refund is zero or negative.",
    ),
    total_printed: z
      .string()
      .max(40)
      .nullish()
      .describe(
        "The grand total exactly as printed, symbols and separators included (\"$1,234.56\"). Used only to cross-check the scale of total_minor.",
      ),
    currency: z
      .string()
      .min(1)
      .max(16)
      .describe(
        "The ISO 4217 code of the money (USD, CNY, EUR, JPY, …). For a points or miles redemption, the programme code: " +
          "uppercase issuer plus _PT (HYATT_PT, AA_PT), always the same code for the same programme.",
      ),
  })
  .strict()
  .describe(
    "The transaction header. Required when classification is receipt_image, receipt_email or receipt_pdf, and only then.",
  );

// ── payment, points, income ────────────────────────────────────────────

const Payment = z
  .object({
    method: z
      .enum(PAYMENT_METHODS)
      .describe(
        "How total_minor was paid; on a points redemption, how its cash_component was paid (points when there is none). " +
          "card: a credit card, or a card whose kind the document does not say: a label naming both kinds (CREDIT/DEBIT) or " +
          "neither (\"bank card\"), and a phone wallet such as Apple Pay. debit_card: only when the document itself says " +
          "debit: the tender line reads DEBIT on its own or names a debit-only network. gift_card: a gift card, store credit, " +
          "or a balance held in an app or account, never a card linked through one; total_minor is what it left to pay, 0 " +
          "when it paid everything. mixed: two or more tenders that together paid total_minor. other: any other tender. " +
          "unknown when the document does not say. Books to: cash and gift_card → Cash; debit_card, check and bank_transfer " +
          "→ Checking; points → the points account; anything else → Credit Card, and a mixed tender is flagged for review.",
      ),
    card_last4: z
      .string()
      .regex(CARD_LAST4_RE)
      .nullish()
      .describe("The card's last four digits when printed, exactly four digits."),
    card_network: z
      .string()
      .max(30)
      .nullish()
      .describe("The card network as printed (Visa, Mastercard, Amex, …)."),
    as_printed: z
      .string()
      .max(120)
      .nullish()
      .describe("The tender line as printed (\"VISA CONTACTLESS ****1234\")."),
  })
  .strict()
  .default({ method: "unknown" })
  .describe("How the user paid.");

const Points = z
  .object({
    programme_name: text(80).describe("The loyalty programme's name as printed (\"World of Example\")."),
  })
  .strict()
  .describe(
    "Required when currency is a points code (ending in _PT), and only then.",
  );

const CashComponent = z
  .object({
    amount_minor: minor()
      .positive()
      .describe("The cash charged alongside the points, in that currency's minor unit, positive."),
    currency: z
      .string()
      .min(1)
      .max(16)
      .describe("The ISO 4217 code of the cash part. Never a points code, never the same as facts.currency."),
  })
  .strict()
  .describe("Only with points: the cash part of a stay or order paid with points and cash.");

const Income = z
  .object({
    deposit_account: z.enum(DEPOSIT_ACCOUNTS).describe("Where the money arrived."),
    income_account: z.enum(INCOME_ACCOUNTS).describe("Salary for pay, Other for anything else."),
  })
  .strict()
  .describe(
    "Only when facts.flow is income. When left out, Checking and Other are used and the record carries a warning.",
  );

// ── merchant and place ─────────────────────────────────────────────────

const Merchant = z
  .object({
    canonical_name: text(120).describe(
      "The brand's display name with store numbers, locations and punctuation suffixes stripped " +
        "(\"Example Store #479\" becomes \"Example Store\"). An independent merchant keeps its full name.",
    ),
    brand_id: z
      .string()
      .max(64)
      .regex(SLUG_RE)
      .describe(
        "A stable lowercase slug for the brand: ASCII letters and digits joined by single hyphens " +
          "(\"example-store\"). The same brand always gets the same slug.",
      ),
    brand_name: z
      .string()
      .max(120)
      .nullish()
      .describe("The brand's own name when it differs from canonical_name. Defaults to canonical_name."),
    category: z
      .enum(EXPENSE_CATEGORIES)
      .describe(
        "The kind of spend for the whole payment, which is the expense account. Chosen from the merchant and what was bought, " +
          "independent of the lines' item_class (an auto shop is Transportation even when every line is a service).",
      ),
    category_hint: z
      .enum(CATEGORY_HINTS)
      .nullish()
      .describe("The finer hint. Vehicle spending is transport."),
    domain_hint: z
      .string()
      .regex(HOSTNAME_RE)
      .nullish()
      .describe(
        "The merchant's web domain, only when it is printed on the document or is the email sender's domain. Never looked up.",
      ),
    name_zh_printed: z
      .string()
      .max(80)
      .nullish()
      .describe("The merchant's Chinese name when the document itself prints one."),
  })
  .strict()
  .describe(
    "The merchant. Required when classification is receipt_image, receipt_email or receipt_pdf, and only then.",
  );

const Place = z
  .object({
    google_place_id: z
      .string()
      .regex(GOOGLE_PLACE_ID_RE)
      .nullable()
      .describe(
        "The Google place id you resolved for this merchant location, or null when none passed your quality and locality checks.",
      ),
    resolved_via: z
      .enum(PLACE_RESOLVED_VIA)
      .describe("How you found it."),
    address_printed: z
      .string()
      .max(300)
      .nullish()
      .describe("The merchant address exactly as printed, when one is."),
  })
  .strict()
  .describe("The merchant's location as you resolved it. The server fetches and stores the place record itself.");

// ── items ──────────────────────────────────────────────────────────────

const optText = (max: number, d: string) => z.string().max(max).nullish().describe(d);
const optMinor = (d: string) => minor().nullish().describe(d);

const Item = z
  .object({
    line_no: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .describe("1-based position in the order printed. Unique within the record."),
    parent_line_no: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .nullish()
      .describe(
        "For a paid modifier or add-on, the line_no of the item it belongs to; null for top-level lines and tax, tip and discount rows. " +
          "Must name another item of this record.",
      ),
    raw_name: text(300).describe("The line exactly as printed, abbreviations and codes kept."),
    normalized_name: optText(300, "A clean human-readable name, brand stripped; null when raw_name is already clean."),
    quantity: z
      .number()
      .finite()
      .nullish()
      .describe("The quantity as printed (2, 0.5); 1 when unprinted."),
    unit: optText(20, "ct, lb, kg, oz, ea, ml, … as printed; null when not printed."),
    unit_price_minor: optMinor("The unit price in minor units when printed."),
    line_total_minor: minor().describe(
      "The line's total in minor units. Signed: negative for a discount or coupon line, and on a refund every line is negative.",
    ),
    currency: z
      .string()
      .min(1)
      .max(16)
      .nullish()
      .describe(
        "Defaults to facts.currency. Only a points-and-cash record may price lines in the cash_component currency.",
      ),
    line_type: z
      .string()
      .regex(LINE_TYPE_RE)
      .nullish()
      .describe(
        "Which kind of money the row is: product (the default), tax, tip, discount, shipping, surcharge, service_fee, gift_card, " +
          "or another snake_case label for a novel case.",
      ),
    item_class: z.enum(ITEM_CLASSES),
    durability_tier: z
      .enum(DURABILITY_TIERS)
      .nullish()
      .describe("Only for a durable item."),
    food_kind: z
      .enum(FOOD_KINDS)
      .nullish()
      .describe("Only for food_drink."),
    tags: z
      .array(z.string().min(1).max(40))
      .max(TAGS_MAX)
      .nullish()
      .describe("Free low-trust signals (alcohol, organic, sale, handwritten, unclear, …)."),
    confidence: z.enum(ITEM_CONFIDENCES).describe("How sure the reading of this line is."),
    product_key: z
      .string()
      .max(120)
      .regex(PRODUCT_KEY_RE)
      .nullish()
      .describe(
        "Kebab-case canonical key of the product; required for product lines, null for tax, tip and discount rows. " +
          "The same product always gets the same key, variants get distinct keys.",
      ),
    product_brand_id: z
      .string()
      .max(64)
      .regex(SLUG_RE)
      .nullish()
      .describe("The manufacturer brand's slug (not the seller's), same rules as merchant.brand_id."),
    product_merchant_exclusive: z
      .boolean()
      .nullish()
      .describe("true when the product exists only at this merchant (a house dish, a private label); false when portable."),
    product_model: optText(200, "Model as printed."),
    product_color: optText(200, "Colour as printed."),
    product_size: optText(200, "Size as printed (L, 12 ct, 750 ml)."),
    product_variant: optText(
      200,
      "The line's zero-cost customisations joined with \", \" (less sugar, no ice). Never a paid add-on.",
    ),
    product_sku: optText(200, "SKU when printed."),
    product_manufacturer: optText(200, "The manufacturer when it differs from the brand."),
    tax_minor: optMinor("This line's share of the printed tax; null on non-taxable lines and on the tax row itself."),
    tip_share_minor: optMinor("This line's share of the printed tip."),
    discount_share_minor: optMinor("This line's share of a printed discount, positive (it always reduces)."),
    track_as_owned: z
      .boolean()
      .nullish()
      .describe("true for a durable product worth tracking as something the user now owns, one instance per unit."),
  })
  .strict();

// ── the rest of the top level ──────────────────────────────────────────

const Identifiers = z
  .object(
    Object.fromEntries(
      CONTRACT_IDENTIFIER_KEYS.map((k) => [
        k,
        z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            {
              order_number: "Order, check or POS transaction number.",
              confirmation_number: "Hotel or travel confirmation, booking reference.",
              invoice_number: "Invoice or folio number.",
              payment_id: "A payment processor's id (Square, Stripe, PayPal).",
              approval_code: "Card authorisation or approval code.",
            }[k],
          ),
      ]),
    ) as Record<ContractIdentifierKey, z.ZodOptional<z.ZodString>>,
  )
  .strict()
  .default({})
  .describe(
    "Printed reference numbers that identify THIS purchase, under exactly these five keys, verbatim as printed " +
      "(leading zeros, dashes and prefixes kept). Never a SKU, serial, tracking, loyalty or store number. " +
      "A reference that fits none of them goes in other_references and is ALSO copied to the closest key here.",
  );

const SoldItem = z
  .object({
    product_key: z
      .string()
      .max(120)
      .regex(PRODUCT_KEY_RE)
      .nullish()
      .describe("The product_key the item was bought under, when you know it."),
    name_as_printed: text(200).describe("The sold item's name as printed."),
  })
  .strict()
  .describe("Only when facts.flow is income: the owned item this sale disposes of.");

const Party = z
  .object({
    role: z
      .enum(PARTY_ROLES)
      .describe(
        "channel: the platform or storefront the user dealt with (exactly one per receipt). seller: who actually sold, " +
          "when different from the channel. maker: a line's brand. acquirer: a payment processor only.",
      ),
    display_name: text(200).describe("The party's name as printed."),
    brand_id: z.string().max(64).regex(SLUG_RE).nullish().describe("The party's brand slug, when it has one."),
    line_no: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .nullish()
      .describe("For a line-level party (a maker), the item's line_no; null for transaction-level parties."),
  })
  .strict();

const PrintedTotals = z
  .object({
    subtotal_minor: optMinor("The printed subtotal."),
    tax_minor: optMinor("The printed tax total."),
    tip_minor: optMinor("The printed tip."),
    discount_minor: optMinor("The printed discount total."),
    fees_minor: optMinor("Printed fees (service, delivery, surcharge) added together."),
  })
  .strict()
  .describe("The document's printed subtotal, tax, tip, discount and fees, in minor units, each only when printed.");

const StatementRow = z
  .object({
    occurred_on: z.string().regex(DATE_RE).describe("The row's date, YYYY-MM-DD."),
    description: text(200).describe("The row's description as printed."),
    amount_minor: minor().describe("The row's amount in minor units, signed as the statement prints it."),
    currency: z.string().min(1).max(16).describe("The row's ISO 4217 code."),
    kind: z.enum(STATEMENT_ROW_KINDS),
  })
  .strict();

const Audit = z
  .object({
    ocr_raw_payee: z.string().max(200).nullable().describe("What you read from the document's header."),
    google_name: z.string().max(200).nullish().describe("The name the place lookup returned, or null."),
    correction_applied: z.boolean().describe("true when the payee was corrected from what was printed."),
    date_candidates: z
      .array(z.string().min(1).max(60))
      .max(DATE_CANDIDATES_MAX)
      .describe("Every date-like string on the document, as printed."),
    chosen_date_reason: text(1000).describe("Why the chosen one is the transaction date."),
    year_sanity_ok: z.boolean().describe("The result of the year check."),
    note: z.string().max(1000).nullish().describe("Any observation worth keeping (faded thermal paper, bilingual name)."),
    review_flags: z
      .array(z.enum(REVIEW_FLAGS))
      .max(REVIEW_FLAGS.length)
      .nullish()
      .describe("Problems a person should look at."),
  })
  .strict()
  .describe(
    "Your self-check of the reading. Required when classification is receipt_image, receipt_email or receipt_pdf.",
  );

export const ExtractionV1Schema = z
  .object({
    contract_version: z.literal(EXTRACTION_CONTRACT_VERSION).describe("Always 1."),
    classification: z
      .enum(CLASSIFICATIONS)
      .describe(
        "The document's format. receipt_image: a photo or scan of a receipt. receipt_email: an email or HTML confirmation. " +
          "receipt_pdf: a PDF of one receipt or invoice. statement_pdf: a card or bank statement. " +
          "unsupported: anything else (not a receipt, a transfer, marketing, unreadable).",
      ),
    unsupported: z
      .object({
        reason: z.enum(UNSUPPORTED_REASONS),
        note: z.string().max(300).nullish().describe("One short sentence on what the document is."),
      })
      .strict()
      .nullish()
      .describe("Required when classification is unsupported, and only then."),
    source_used: z
      .enum(SOURCES_USED)
      .nullish()
      .describe("Which form of the document you read."),
    facts: Facts.nullish(),
    payment: Payment,
    points: Points.nullish(),
    cash_component: CashComponent.nullish(),
    income: Income.nullish(),
    identifiers: Identifiers,
    other_references: bag(z.string().min(1).max(80), OTHER_REFERENCES_MAX_KEYS)
      .nullish()
      .describe(
        `Any other printed reference worth keeping, under a snake_case name you choose, at most ${OTHER_REFERENCES_MAX_KEYS}, ` +
          "each at most 80 characters. Never read by duplicate detection.",
      ),
    merchant: Merchant.nullish(),
    place: Place.nullish(),
    items: z
      .array(Item)
      .max(ITEMS_MAX)
      .default([])
      .describe(
        "Every printed line, in order, with the shape below. Expected on every receipt; a receipt with no lines carries a warning.",
      ),
    sold_item: SoldItem.nullish(),
    parties: z
      .array(Party)
      .max(PARTIES_MAX)
      .default([])
      .describe(
        "Who was involved. When no channel is given, the merchant is added as the channel.",
      ),
    printed_totals: PrintedTotals.nullish(),
    statement_rows: z
      .array(StatementRow)
      .max(STATEMENT_ROWS_MAX)
      .nullish()
      .describe("Required when classification is statement_pdf, and only then: every row of the statement."),
    audit: Audit.nullish(),
    receipt_facts: bag(
      z.union([z.string().max(200), z.number().finite(), z.boolean()]),
      RECEIPT_FACTS_MAX_KEYS,
      RECEIPT_FACTS_MAX_BYTES,
    )
      .nullish()
      .describe(
        `Other facts printed on the document worth keeping (table number, cashier, pump), under snake_case names, ` +
          `at most ${RECEIPT_FACTS_MAX_KEYS} keys and ${RECEIPT_FACTS_MAX_BYTES} bytes, each value text (≤200), a number or true/false.`,
      ),
    lesson_proposal: z
      .string()
      .max(600)
      .nullish()
      .describe("One specific, evidence-based lesson for future extractions, if this document taught you one."),
  })
  .strict();

/** A record as the validator returns it (defaults applied). */
export type ExtractionV1 = z.output<typeof ExtractionV1Schema>;
/** A record as the model writes it (defaults not yet applied). */
export type ExtractionV1Input = z.input<typeof ExtractionV1Schema>;
export type ExtractionV1Item = ExtractionV1["items"][number];
export type ExtractionV1Party = ExtractionV1["parties"][number];

// ── The prompt's description of the record, built from the schema ──────

export interface FieldShape {
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  description?: string;
  core: z.ZodTypeAny;
}

/** Peel optional / nullable / default / refinement wrappers, collecting
 *  what they say and the outermost description. */
export function peelSchema(schema: z.ZodTypeAny): FieldShape {
  const shape: FieldShape = { optional: false, nullable: false, hasDefault: false, core: schema };
  let s: z.ZodTypeAny = schema;
  for (;;) {
    if (shape.description === undefined && s.description) shape.description = s.description;
    if (s instanceof z.ZodOptional) {
      shape.optional = true;
      s = s.unwrap();
    } else if (s instanceof z.ZodNullable) {
      shape.nullable = true;
      s = s.unwrap();
    } else if (s instanceof z.ZodDefault) {
      shape.hasDefault = true;
      shape.optional = true;
      shape.defaultValue = s._def.defaultValue();
      s = s._def.innerType;
    } else if (s instanceof z.ZodEffects) {
      s = s.innerType();
    } else {
      break;
    }
  }
  shape.core = s;
  return shape;
}

const SAFE = Number.MAX_SAFE_INTEGER;

function describeString(s: z.ZodString): string {
  let min: number | undefined;
  let max: number | undefined;
  const regexes: RegExp[] = [];
  for (const c of s._def.checks) {
    if (c.kind === "min") min = c.value;
    else if (c.kind === "max") max = c.value;
    else if (c.kind === "regex") regexes.push(c.regex);
  }
  const formats = regexes.map((r) => {
    const label = formatLabel(r);
    if (!label) throw new Error(`renderContractForPrompt: no format label for /${r.source}/`);
    return label;
  });
  const parts: string[] = formats.length > 0 ? formats : ["text"];
  // A format already bounds the length; say a cap only when it is tighter.
  if (max !== undefined) parts.push(min !== undefined && min > 0 ? `${min}–${max} chars` : `≤${max} chars`);
  else if (min !== undefined && min > 0 && formats.length === 0) parts.push("non-empty");
  return parts.join(", ");
}

function describeNumber(n: z.ZodNumber): string {
  let int = false;
  const bounds: string[] = [];
  for (const c of n._def.checks) {
    if (c.kind === "int") int = true;
    else if (c.kind === "min" && Math.abs(c.value) < SAFE) bounds.push(`${c.inclusive ? "≥" : ">"} ${c.value}`);
    else if (c.kind === "max" && Math.abs(c.value) < SAFE && c.value < 100000) {
      bounds.push(`${c.inclusive ? "≤" : "<"} ${c.value}`);
    }
  }
  return [int ? "integer" : "number", ...bounds].join(" ");
}

function describeScalar(core: z.ZodTypeAny): string {
  if (core instanceof z.ZodString) return describeString(core);
  if (core instanceof z.ZodNumber) return describeNumber(core);
  if (core instanceof z.ZodBoolean) return "true or false";
  if (core instanceof z.ZodLiteral) return `the value ${JSON.stringify(core.value)}`;
  if (core instanceof z.ZodEnum) return `one of ${(core.options as string[]).join(" | ")}`;
  if (core instanceof z.ZodUnion) {
    return (core.options as z.ZodTypeAny[]).map((o) => describeScalar(peelSchema(o).core)).join(", or ");
  }
  if (core instanceof z.ZodRecord) {
    return `an object of snake_case keys, each value ${describeScalar(peelSchema(core.valueSchema).core)}`;
  }
  throw new Error(`renderContractForPrompt: no description for ${core.constructor.name}`);
}

function presence(f: FieldShape): string {
  const bits: string[] = [];
  bits.push(f.optional ? "optional" : "required");
  if (f.nullable) bits.push("may be null");
  if (f.hasDefault) bits.push(`default ${JSON.stringify(f.defaultValue)}`);
  return bits.join(", ");
}

function renderFields(shape: z.ZodRawShape, indent: string, out: string[]): void {
  for (const [key, schema] of Object.entries(shape)) {
    const f = peelSchema(schema);
    const desc = f.description ? ` ${f.description}` : "";
    const core = f.core;
    if (core instanceof z.ZodObject) {
      out.push(`${indent}${key} (object; ${presence(f)}).${desc}`);
      renderFields(core.shape as z.ZodRawShape, `${indent}  `, out);
    } else if (core instanceof z.ZodArray) {
      const max = core._def.maxLength?.value;
      const cap = max !== undefined ? ` of at most ${max}` : "";
      const el = peelSchema(core.element);
      if (el.core instanceof z.ZodObject) {
        out.push(`${indent}${key} (list${cap}; ${presence(f)}).${desc} Each element is an object:`);
        renderFields(el.core.shape as z.ZodRawShape, `${indent}  `, out);
      } else {
        out.push(`${indent}${key} (list${cap} of ${describeScalar(el.core)}; ${presence(f)}).${desc}`);
      }
    } else {
      out.push(`${indent}${key} (${describeScalar(core)}; ${presence(f)}).${desc}`);
    }
  }
}

/**
 * The record's field list for the prompt, generated from
 * `ExtractionV1Schema`: every key with its type, its caps or format, its
 * presence, and its describe text, nested as the JSON nests. Rules that
 * span fields are stated in those describe texts. A field added to the
 * schema appears here without anyone editing prompt text.
 */
export function renderContractForPrompt(): string {
  const lines: string[] = [];
  renderFields(ExtractionV1Schema.shape as z.ZodRawShape, "  ", lines);
  return `── The extraction record (contract version ${EXTRACTION_CONTRACT_VERSION}) ───────────────────────────────

One JSON object with exactly the keys below, nested as shown. A key that is
not listed is refused wherever it appears. "optional" means leave the key
out (or null where null is allowed) when the document does not say; never
invent a value to fill a field. Amounts are integers in the currency's minor
unit. Never put in the record: ids of any kind, a status, account ids,
base-currency amounts or exchange rates, provenance, duplicate verdicts,
email headers, or place rows. The server has all of these already.

${lines.join("\n")}`;
}
