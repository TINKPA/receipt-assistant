/**
 * Projection: an extraction record to the ledger rows it stands for
 * (wave 1, plan §6.3, rules a–o). Pure: no database, no clock, no ids.
 *
 * `project(record, catalog)` takes a VALID receipt record (`receipt_image`,
 * `receipt_email`, `receipt_pdf`; see `contract/validate.ts`) and the
 * workspace's accounts (`accounts.ts`), and returns a draft: what the
 * server writer inserts, in order, inside the one apply transaction. The
 * writer adds only what comes from its own context (new ids, the
 * workspace owner, the merchant and place rows it upserts); every value
 * that comes from the reading is decided here, so a stored record can be
 * re-projected later (`scripts/check-projection-replay.ts`) and reach the
 * same rows.
 *
 * POSTINGS (§6.3 g). The total is signed as the legacy prompt signs it:
 * a refund's total is negative. One pair per currency, so each currency
 * balances within itself:
 *
 *   purchase, refund   (expense, +T)  (mirror, −T)
 *   income             (deposit, +T)  (income, −T)
 *   points (`_PT`)     (expense, +N)  (points account, −N), and for a
 *                      `cash_component` a second pair in that currency,
 *                      (expense, ±C)  (cash mirror, ∓C)
 *
 * The expense account is the record's `merchant.category` (one of the
 * seven), as it was the legacy prompt's. The MIRROR account is derived
 * from `payment.method` (§3.3), not chosen by the model:
 *
 *   cash → Cash · check, bank_transfer → Checking · points → the points
 *   account · card, gift_card, mixed, other, unknown → Credit Card
 *
 * Two cases the plan's table leaves open, decided here and warned about
 * as `account_overridden`: `points` on a cash currency names no
 * programme, so it books to Credit Card; income in a points currency is
 * deposited in the points account, whatever `income.deposit_account`
 * says. The cash part of a points-and-cash record follows the method too,
 * with `points` (the usual method on such a record) meaning Credit Card,
 * as the legacy prompt's "the real credit card account" did.
 *
 * Every posting carries `amount_base_minor = amount_minor` and no
 * `fx_rate`, exactly as the agent wrote them: that NULL is what the FX
 * pass and the points valuation (`normalizeFxSafely`, `valuePointsSafely`)
 * look for after commit. Amounts are the record's minor units, untouched:
 * 5,000 yen stays 5000 and 1.250 KWD stays 1250 (`src/ledger/money.ts`).
 *
 * A missing account is a seeding fault, never something to send back to
 * the model: `ProjectionError('account_missing')`, which the writer turns
 * into a failed apply.
 *
 * LINE ITEMS (§6.3 i). The record's items in the ITEM_SCHEMA shape the
 * bound `itemsWriteSql` takes (`src/ingest/items-sql.ts`), `currency` and
 * `line_type` defaulted, `extraction_version = RECORD_PROMPT_VERSION`.
 * `track_as_owned` is not an item column; it becomes the owned-items
 * intent (§6.3 k).
 */
import type { ValidationWarning } from "../contract/validate.js";
import {
  isReceiptClassification,
  type ExtractionV1,
  type ExtractionV1Item,
  type Flow,
  type PaymentMethod,
} from "../contract/v1.js";
import { isPointsCurrency } from "../../points/codes.js";
import { RECORD_PROMPT_VERSION } from "../prompt-contract.js";
import {
  findAccount,
  findAssetsRoot,
  findPointsAccount,
  type AccountCatalog,
  type AccountType,
  type CatalogAccount,
} from "./accounts.js";
import { APPLIER_VERSION } from "./version.js";

export type ReceiptClassification = "receipt_image" | "receipt_email" | "receipt_pdf";

/** Which account a posting goes to: one the catalog has, or the points
 *  account the writer creates first (`draft.pointsAccount.create`). */
export type AccountRef =
  | { kind: "existing"; id: string; type: AccountType; name: string }
  | { kind: "new_points"; type: "asset"; name: string; currency: string };

export type PostingRole = "expense" | "mirror" | "deposit" | "income" | "cash_expense" | "cash_mirror";

export interface DraftPosting {
  role: PostingRole;
  account: AccountRef;
  amountMinor: number;
  currency: string;
  /** Always `amountMinor`; `fx_rate` stays NULL for the post-commit passes. */
  amountBaseMinor: number;
}

/** One row for `itemsWriteSql`: ITEM_SCHEMA's 27 keys, nothing else. */
export interface DraftItem {
  line_no: number;
  parent_line_no: number | null;
  raw_name: string;
  normalized_name: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price_minor: number | null;
  line_total_minor: number;
  currency: string;
  item_class: string;
  durability_tier: string | null;
  food_kind: string | null;
  tags: string[] | null;
  confidence: string;
  line_type: string;
  product_key: string | null;
  product_brand_id: string | null;
  product_merchant_exclusive: boolean | null;
  product_model: string | null;
  product_color: string | null;
  product_size: string | null;
  product_variant: string | null;
  product_sku: string | null;
  product_manufacturer: string | null;
  tax_minor: number | null;
  tip_share_minor: number | null;
  discount_share_minor: number | null;
}

export interface DraftParty {
  role: string;
  displayName: string;
  brandId: string | null;
  /** The item's `line_no` for a line-level party; the writer resolves it
   *  to the `transaction_item_id` of the run it just wrote. */
  lineNo: number | null;
}

export interface ApplyDraft {
  applierVersion: string;
  classification: ReceiptClassification;
  flow: Flow;
  /** `transactions` (§6.3 f). Status is always `posted`. */
  header: { payee: string; occurredOn: string; occurredAt: string | null; status: "posted" };
  /** `brands` upsert for the merchant (§6.3 a): a real name is never
   *  overwritten, only a slug stub is upgraded (the writer's SQL). */
  merchantBrand: { brandId: string; name: string; domain: string | null };
  /** `merchants` upsert (§6.3 e). */
  merchant: { brandId: string; canonicalName: string; category: string };
  categoryHint: string | null;
  /** How the paying (or, for income, receiving) side was chosen;
   *  `metadata.mirror_account` records `accountName`. */
  mirror: { method: PaymentMethod; accountName: string };
  /** Present for a points record (§6.3 c): the existing account, or the
   *  one to create under the `Assets` root. */
  pointsAccount: { existingId: string | null; create: { name: string; currency: string; parentId: string } | null } | null;
  postings: DraftPosting[];
  items: DraftItem[];
  /** The rest of `itemsWriteSql`'s parameters that the record decides. */
  itemsWrite: { run: 1; extractionVersion: string };
  /** §6.3 k: lines to track, and how many instances that makes. */
  owned: { lineNos: number[]; instanceCount: number; acquiredOn: string };
  /** §6.3 l, income only. */
  soldItem: { productKey: string | null; nameAsPrinted: string } | null;
  parties: DraftParty[];
  /** §6.3 o: what the writer fetches and links, when a place was resolved. */
  place: {
    googlePlaceId: string;
    resolvedVia: string;
    addressPrinted: string | null;
    nameZhPrinted: string | null;
  } | null;
  /** Apply-time warnings the projection can decide. */
  warnings: ValidationWarning[];
}

export class ProjectionError extends Error {
  constructor(
    readonly code: "not_a_receipt" | "account_missing",
    message: string,
    readonly missing: readonly string[] = [],
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}

/** §3.3: the account a payment method pays from. `points` names the
 *  programme's account; the others name a seeded account. */
export const MIRROR_BY_METHOD: Readonly<Record<PaymentMethod, "Cash" | "Checking" | "Credit Card" | "points">> = {
  cash: "Cash",
  check: "Checking",
  bank_transfer: "Checking",
  points: "points",
  card: "Credit Card",
  gift_card: "Credit Card",
  mixed: "Credit Card",
  other: "Credit Card",
  unknown: "Credit Card",
};

const MIRROR_TYPE = { Cash: "asset", Checking: "asset", "Credit Card": "liability" } as const;

/** Postgres's `numeric::int`: round half away from zero. */
function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

function draftItem(it: ExtractionV1Item, currency: string): DraftItem {
  return {
    line_no: it.line_no,
    parent_line_no: it.parent_line_no ?? null,
    raw_name: it.raw_name,
    normalized_name: it.normalized_name ?? null,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    unit_price_minor: it.unit_price_minor ?? null,
    line_total_minor: it.line_total_minor,
    currency: it.currency ?? currency,
    item_class: it.item_class,
    durability_tier: it.durability_tier ?? null,
    food_kind: it.food_kind ?? null,
    tags: it.tags ?? null,
    confidence: it.confidence,
    line_type: it.line_type ?? "product",
    product_key: it.product_key ?? null,
    product_brand_id: it.product_brand_id ?? null,
    product_merchant_exclusive: it.product_merchant_exclusive ?? null,
    product_model: it.product_model ?? null,
    product_color: it.product_color ?? null,
    product_size: it.product_size ?? null,
    product_variant: it.product_variant ?? null,
    product_sku: it.product_sku ?? null,
    product_manufacturer: it.product_manufacturer ?? null,
    tax_minor: it.tax_minor ?? null,
    tip_share_minor: it.tip_share_minor ?? null,
    discount_share_minor: it.discount_share_minor ?? null,
  };
}

const ref = (a: CatalogAccount): AccountRef => ({ kind: "existing", id: a.id, type: a.type, name: a.name });

/**
 * The draft for one valid receipt record. `existingMerchant` is the
 * workspace's `merchants` row for the record's brand, if there is one:
 * the first sight of a merchant fixes its category (parity), so a record
 * that disagrees gets `category_differs_from_merchant`, while its own
 * category still picks the expense account.
 */
export function project(
  record: ExtractionV1,
  catalog: AccountCatalog,
  opts: { existingMerchant?: { category: string | null } | null } = {},
): ApplyDraft {
  const { facts, merchant } = record;
  if (!isReceiptClassification(record.classification) || !facts || !merchant) {
    throw new ProjectionError(
      "not_a_receipt",
      `only a receipt record is projected, not ${record.classification}`,
    );
  }
  const warnings: ValidationWarning[] = [];
  const missing: string[] = [];
  const need = (type: AccountType, name: string): AccountRef | null => {
    const a = findAccount(catalog, type, name);
    if (!a) missing.push(`${type} ${name}`);
    return a ? ref(a) : null;
  };

  const flow = facts.flow;
  const currency = facts.currency;
  const total = facts.total_minor;
  const method = record.payment.method;
  const points = isPointsCurrency(currency);

  // The points account (§6.3 c), whenever the main currency is points.
  let pointsAccount: ApplyDraft["pointsAccount"] = null;
  let pointsRef: AccountRef | null = null;
  if (points) {
    const existing = findPointsAccount(catalog, currency);
    if (existing) {
      pointsAccount = { existingId: existing.id, create: null };
      pointsRef = ref(existing);
    } else {
      const assets = findAssetsRoot(catalog);
      if (!assets) missing.push("asset Assets (the parent of a new points account)");
      const name = `${record.points?.programme_name ?? currency} points`;
      pointsAccount = assets ? { existingId: null, create: { name, currency, parentId: assets.id } } : null;
      pointsRef = { kind: "new_points", type: "asset", name, currency };
    }
  }

  /** The paying account of a cash currency for this method. */
  const cashMirror = (path: string): AccountRef | null => {
    let name = MIRROR_BY_METHOD[method];
    if (name === "points") {
      if (!points) {
        warnings.push({
          rule: "account_overridden",
          path,
          message: "payment method points on a cash currency names no programme; Credit Card was used",
          money: true,
        });
      }
      name = "Credit Card";
    }
    return need(MIRROR_TYPE[name], name);
  };

  const postings: DraftPosting[] = [];
  const pair = (
    debit: { role: PostingRole; account: AccountRef | null },
    credit: { role: PostingRole; account: AccountRef | null },
    amount: number,
    cur: string,
  ) => {
    if (!debit.account || !credit.account) return;
    postings.push({ role: debit.role, account: debit.account, amountMinor: amount, currency: cur, amountBaseMinor: amount });
    postings.push({ role: credit.role, account: credit.account, amountMinor: -amount, currency: cur, amountBaseMinor: -amount });
  };

  let mirrorName: string;
  if (flow === "income") {
    const income = record.income ?? { deposit_account: "Checking" as const, income_account: "Other" as const };
    const incomeAcct = need("income", income.income_account);
    let deposit: AccountRef | null;
    if (points) {
      warnings.push({
        rule: "account_overridden",
        path: "income.deposit_account",
        message: "points income is deposited in the programme's points account",
        money: true,
      });
      deposit = pointsRef;
    } else {
      deposit = need("asset", income.deposit_account);
    }
    mirrorName = deposit?.name ?? income.deposit_account;
    pair({ role: "deposit", account: deposit }, { role: "income", account: incomeAcct }, total, currency);
    if (record.cash_component) {
      const cashDeposit = need("asset", income.deposit_account);
      pair(
        { role: "deposit", account: cashDeposit },
        { role: "income", account: incomeAcct },
        record.cash_component.amount_minor,
        record.cash_component.currency,
      );
    }
  } else {
    const expense = need("expense", merchant.category);
    const mirror = points ? pointsRef : cashMirror("payment.method");
    mirrorName = mirror?.name ?? MIRROR_BY_METHOD[method];
    pair({ role: "expense", account: expense }, { role: "mirror", account: mirror }, total, currency);
    if (record.cash_component) {
      // The cash part moves the same way as the points: negative on a refund.
      const sign = flow === "refund" ? -1 : 1;
      pair(
        { role: "cash_expense", account: expense },
        { role: "cash_mirror", account: cashMirror("cash_component") },
        sign * record.cash_component.amount_minor,
        record.cash_component.currency,
      );
    }
  }
  if (missing.length > 0) {
    throw new ProjectionError(
      "account_missing",
      `the workspace has no ${missing.join(", ")} account; the chart of accounts is not seeded as the applier expects`,
      missing,
    );
  }

  if (opts.existingMerchant?.category && opts.existingMerchant.category !== merchant.category) {
    warnings.push({
      rule: "category_differs_from_merchant",
      path: "merchant.category",
      message: `the merchant is filed under ${opts.existingMerchant.category}; this receipt says ${merchant.category}`,
    });
  }

  const items = record.items.map((it) => draftItem(it, currency));

  // §6.3 k: only a purchase adds to what the user owns, only a durable
  // product line has a product row to own, one instance per unit.
  const owned = { lineNos: [] as number[], instanceCount: 0, acquiredOn: facts.occurred_on };
  record.items.forEach((it, i) => {
    if (!it.track_as_owned) return;
    const why =
      flow !== "purchase"
        ? `only a purchase adds owned items, not a ${flow}`
        : it.item_class !== "durable"
          ? "only a durable line is tracked as owned"
          : (it.line_type ?? "product") !== "product" || !it.product_key
            ? "the line has no product to own (not a product line, or no product_key)"
            : null;
    if (why) {
      warnings.push({ rule: "owned_items_skipped", path: `items[${i}].track_as_owned`, message: why });
      return;
    }
    owned.lineNos.push(it.line_no);
    owned.instanceCount += Math.max(0, roundHalfAway(it.quantity ?? 1));
  });

  // One row per (line, role, name): the identity the table keeps unique.
  const parties: DraftParty[] = [];
  const seen = new Set<string>();
  for (const p of record.parties) {
    const key = `${p.line_no ?? ""}\u0000${p.role}\u0000${p.display_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parties.push({ role: p.role, displayName: p.display_name, brandId: p.brand_id ?? null, lineNo: p.line_no ?? null });
  }

  const place =
    record.place?.google_place_id != null
      ? {
          googlePlaceId: record.place.google_place_id,
          resolvedVia: record.place.resolved_via,
          addressPrinted: record.place.address_printed ?? null,
          nameZhPrinted: merchant.name_zh_printed ?? null,
        }
      : null;

  return {
    applierVersion: APPLIER_VERSION,
    classification: record.classification as ReceiptClassification,
    flow,
    header: {
      payee: facts.payee,
      occurredOn: facts.occurred_on,
      occurredAt: facts.occurred_at ?? null,
      status: "posted",
    },
    merchantBrand: {
      brandId: merchant.brand_id,
      name: merchant.brand_name ?? merchant.canonical_name,
      domain: merchant.domain_hint ?? null,
    },
    merchant: { brandId: merchant.brand_id, canonicalName: merchant.canonical_name, category: merchant.category },
    categoryHint: merchant.category_hint ?? null,
    mirror: { method, accountName: mirrorName },
    pointsAccount,
    postings,
    items,
    itemsWrite: { run: 1, extractionVersion: RECORD_PROMPT_VERSION },
    owned,
    soldItem:
      flow === "income" && record.sold_item
        ? { productKey: record.sold_item.product_key ?? null, nameAsPrinted: record.sold_item.name_as_printed }
        : null,
    parties,
    place,
    warnings,
  };
}

/**
 * The currencies whose postings do not sum to zero (§6.3 j). The database
 * trigger checks only the base-currency sum; the writer asserts this one
 * after `SET CONSTRAINTS ALL IMMEDIATE`, and `project` never returns a
 * draft that fails it.
 */
export function unbalancedCurrencies(postings: readonly { amountMinor: number | bigint | string; currency: string }[]): string[] {
  const sums = new Map<string, bigint>();
  for (const p of postings) sums.set(p.currency, (sums.get(p.currency) ?? 0n) + BigInt(p.amountMinor));
  return [...sums.entries()].filter(([, s]) => s !== 0n).map(([c]) => c).sort();
}
