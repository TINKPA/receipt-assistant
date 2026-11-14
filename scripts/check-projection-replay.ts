/**
 * check-projection-replay.ts — does the server applier's projection
 * reproduce the ledger? (wave 1, plan §12.3, §12.4.)
 *
 * Usage:
 *   npx tsx scripts/check-projection-replay.ts --pg=<url> --from-ledger [--verbose] [--workspace=<uuid>]
 *   npx tsx scripts/check-projection-replay.ts --pg=<url> --records     [--verbose] [--workspace=<uuid>]
 *
 * Exit code: 0 when nothing unexplained was found, 1 otherwise, 2 when
 * the check itself could not run.
 *
 * SELECT only, and enforced: the session is opened with
 * `default_transaction_read_only = on` and the script refuses to go on if
 * the server does not confirm it. It is meant to run against production
 * as `receipts_ro`; until the owner asks for that, run it against a copy.
 *
 * --from-ledger (the pre-A/B gate, §12.4)
 *
 *   For every live transaction an ingest wrote, it synthesises in memory
 *   the extraction record the legacy agent's reading amounts to, from the
 *   row's metadata, its live line items, its parties and its postings;
 *   validates it with the real validator; projects it with applier
 *   `APPLIER_VERSION`; and compares the projected postings with the real
 *   ones on account, sign, amount and currency (as multisets). Base
 *   amounts and rates are not compared: both writers leave them to the
 *   post-commit FX and points passes.
 *
 *   How each record field is synthesised, and how circular that is:
 *     flow           `metadata.flow`, else the legs (income leg: income;
 *                    expense negative: refund; else purchase)
 *     total,         the P&L legs in the main currency (a points code when
 *     currency       there is one). Circular by construction: the check is
 *                    about where the amount goes, not what it is.
 *     category       `metadata.merchant.category` (what the agent emitted),
 *                    else the merchant row, else the booked expense
 *                    account (circular, counted).
 *     payment.method the payment text in metadata (`payment_method`,
 *                    `tender`, `payment`, …) read by keyword, else a typed
 *                    `card_last4` (card), else the booked mirror account
 *                    (circular, counted). The plan says so: the mirror
 *                    rule is partly circular here.
 *     income         the booked deposit and income accounts (circular).
 *     points         the programme from the points account's name.
 *
 *   Every row lands in one class. A mismatch class is EXPLAINED only by a
 *   rule written in `explain()` below, with its reason; the exit code
 *   counts unexplained money mismatches on rows whose
 *   `metadata.extraction.prompt_version` is 3.0 or later (the gate).
 *   Older rows are classified and printed, not gated. The rules:
 *     - a statement row: the legacy agent booked one per row; a statement
 *       record books nothing (X10);
 *     - several legs in one currency (a split tender): the contract has
 *       one pair per currency;
 *     - the payment text names a tender §3.3 books away from Credit Card
 *       (cash, a check, a bank transfer, a debit card, a gift card or a
 *       balance) and the row was booked to Credit Card: the legacy
 *       prompt's default mirror (hole 9), which §3.3 replaces with the
 *       stated method;
 *     - the other way round, a tender §3.3 sends to Credit Card (a card
 *       of no stated kind, a mixed tender, another tender) that the
 *       legacy agent booked to Cash or Checking: the table is the plan's.
 *       A debit card booked to Checking and a gift card or balance booked
 *       to Cash match since the owner's tender decisions, and a debit card
 *       or gift card booked anywhere but its own account or Credit Card
 *       is not explained;
 *     - the expense account differs from the `metadata.merchant.category`
 *       the same agent wrote: the record carries one category, and it
 *       picks the account.
 *   A row dated more than 2 days after its upload is a reading the
 *   contract refuses (`future_date`); its money is still checked, judged
 *   as of its own date.
 *
 * --records
 *
 *   For every current valid record in `document_extractions` whose
 *   transaction names it (`metadata.extraction.extraction_id`), it
 *   re-projects the stored record against today's chart of accounts and
 *   compares the fingerprint (`src/ingest/apply/fingerprint.ts`) with the
 *   transaction's. A field that differs is explained only when an
 *   `updated` event records a person changing it since (payee, date,
 *   metadata), so the applier is no longer the field's author. Records
 *   that booked nothing (attached, unsupported, statement, not applied)
 *   are counted, not compared. A record whose apply failed (its run
 *   finished `failed` / `apply`, the ingest `error`) is explained: the
 *   failure is the run's to report, and the record waits for a re-apply.
 *   A record whose transaction was re-extracted since (a legacy re-extract
 *   moves the stamp into `metadata.extraction_history`) is explained and
 *   not compared: a later reading wrote the values. Any other receipt
 *   record that no transaction names is unexplained.
 *
 * Prints counts per class; `--verbose` adds the transaction ids of each
 * class (ids only, no amounts, names or text).
 */
import pg from "pg";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { validateExtraction } from "../src/ingest/contract/validate.js";
import {
  CONTRACT_IDENTIFIER_KEYS,
  EXPENSE_CATEGORIES,
  GOOGLE_PLACE_ID_RE,
  SLUG_RE,
  isReceiptClassification,
  type ExtractionV1,
} from "../src/ingest/contract/v1.js";
import { isPointsCurrency } from "../src/points/codes.js";
import { readAccountCatalog, type AccountCatalog } from "../src/ingest/apply/accounts.js";
import { MIRROR_BY_METHOD, ProjectionError, project, type ApplyDraft } from "../src/ingest/apply/project.js";
import {
  diffFingerprints,
  fingerprintFromDraft,
  readLedgerFingerprint,
} from "../src/ingest/apply/fingerprint.js";
import { APPLIER_VERSION } from "../src/ingest/apply/version.js";

type Db = ReturnType<typeof drizzle>;

// ── Synthesising a record from a ledger row ────────────────────────────

export interface LedgerPosting {
  account_type: string;
  account_name: string;
  account_subtype: string | null;
  amount_minor: number;
  currency: string;
}

export interface LedgerRow {
  id: string;
  workspace_id: string;
  occurred_on: string;
  occurred_at: string | null;
  payee: string | null;
  metadata: Record<string, any>;
  uploaded_at: string;
  merchant_brand_id: string | null;
  merchant_canonical_name: string | null;
  merchant_category: string | null;
  google_place_id: string | null;
  postings: LedgerPosting[];
  items: Record<string, any>[];
  parties: { role: string; display_name: string; brand_id: string | null; line_no: number | null }[];
}

export type Source = "metadata" | "merchant_row" | "legs" | "text" | "card_last4" | "mirror" | "default";

export interface Synthesis {
  raw: Record<string, any>;
  sources: { flow: Source; category: Source; method: Source };
  /** Set when the row cannot be expressed as a record at all. */
  inexpressible: string | null;
}

const PL = new Set(["expense", "income"]);

function str(v: unknown, max = Infinity): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || t.length > max ? null : t;
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "") || "unknown";
}

/** Every string in a metadata value, flattened (payment objects too). */
function texts(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => texts(x, out));
  return out;
}

const PAYMENT_TEXT_KEYS = ["payment_method", "tender", "payment", "tender_type", "payment_type", "card_type", "refund_method", "payout_method"];

/** Gift cards, store credit and balances held in an app or account: the
 *  contract's `gift_card`. A store-branded CARD ("… store card ending
 *  1234") is a credit card, so "store card" is not here. */
const GIFT_TEXT = /gift[ _-]?card|shop[ _-]?card|stored[ _-]?value|store[ _-]?credit|购物卡|储值|\b(?:account|app|wallet|venmo|paypal|cash app) balance\b/;
/** A bank card's own words: debit, or a debit-only network. */
const DEBIT_TEXT = /debit|interac|maestro|interlink|eftpos|girocard|\bcheck ?card\b/;
const BANK_CARD_TEXT = /visa|master ?card|amex|american express|discover|credit|apple (pay|card)|google pay|contactless|\bchip\b|\bcard\b/;

/** The payment method a row's own payment text names, by keyword: one
 *  tender kind gives that method, two or more give `mixed`, none gives
 *  null. A bank card is `debit_card` when the text says debit or names a
 *  debit-only network, else `card`, as the contract defines them;
 *  "credit/debit" says neither, so it is `card`. */
export function methodFromText(md: Record<string, any>): ExtractionV1["payment"]["method"] | null {
  const raw = PAYMENT_TEXT_KEYS.flatMap((k) => texts(md[k])).join(" ").toLowerCase();
  if (raw.trim() === "") return null;
  // "credit/debit", "credit_debit", "debit or credit": either one, so a card of no stated kind.
  const t = raw.replace(/credit\s*(?:\/|_|-|or)\s*debit|debit\s*(?:\/|_|-|or)\s*credit/g, "card");
  const kinds = new Set<ExtractionV1["payment"]["method"]>();
  if (/\bpoints?\b|\bmiles\b|award/.test(t)) kinds.add("points");
  if (/\bcash\b(?!\s*(back|app))|现金|現金/.test(t)) kinds.add("cash");
  if (/\bcheck\b(?!\s*card)|\bcheque\b/.test(t)) kinds.add("check");
  if (/\bach\b|bank transfer|direct deposit|\bwire\b|\beft\b|zelle/.test(t)) kinds.add("bank_transfer");
  if (GIFT_TEXT.test(t)) kinds.add("gift_card");
  // A bank card, once the gift-card and store-credit wording is taken out.
  const rest = t.replace(/(gift|shop)[ _-]?card|store[ _-]?credit/g, "");
  if (DEBIT_TEXT.test(rest)) kinds.add("debit_card");
  else if (BANK_CARD_TEXT.test(rest)) kinds.add("card");
  if (kinds.size === 0 && /paypal|alipay|wechat|支付宝|微信|venmo|cash app|klarna|affirm/.test(t)) kinds.add("other");
  if (kinds.size === 0) return null;
  return kinds.size > 1 ? "mixed" : [...kinds][0]!;
}

const METHOD_BY_MIRROR: Record<string, ExtractionV1["payment"]["method"]> = {
  Cash: "cash",
  Checking: "bank_transfer",
  "Credit Card": "unknown",
};

/**
 * The record a legacy ledger row stands for, as raw JSON for the
 * validator. Fields the row cannot supply are synthesised as noted in the
 * header; `sources` says which ones came from the money itself.
 */
export function synthesiseRecord(row: LedgerRow): Synthesis {
  const md = row.metadata ?? {};
  const mm = (md.merchant && typeof md.merchant === "object" ? md.merchant : {}) as Record<string, unknown>;
  const pl = row.postings.filter((p) => PL.has(p.account_type));
  const sources: Synthesis["sources"] = { flow: "metadata", category: "metadata", method: "text" };
  const none = (why: string): Synthesis => ({ raw: {}, sources, inexpressible: why });
  if (pl.length === 0) return none("no expense or income leg (a transfer)");

  const currencies = [...new Set(pl.map((p) => p.currency))];
  const pointsCur = currencies.find(isPointsCurrency);
  if (!pointsCur && currencies.length > 1) return none("P&L legs in several cash currencies");
  if (currencies.length > 2) return none("P&L legs in more than two currencies");
  const main = pointsCur ?? currencies[0]!;
  const signed = (p: LedgerPosting) => (p.account_type === "income" ? -p.amount_minor : p.amount_minor);
  const total = pl.filter((p) => p.currency === main).reduce((s, p) => s + signed(p), 0);
  const hasIncome = pl.some((p) => p.account_type === "income");
  const hasExpense = pl.some((p) => p.account_type === "expense");
  if (hasIncome && hasExpense) return none("both expense and income legs");

  let flow = str(md.flow);
  if (flow !== "purchase" && flow !== "refund" && flow !== "income") {
    flow = hasIncome ? "income" : total < 0 ? "refund" : "purchase";
    sources.flow = "legs";
  }

  const mirrorLeg = row.postings.find((p) => !PL.has(p.account_type) && p.currency === main);
  const expenseLeg = pl.find((p) => p.account_type === "expense" && p.currency === main);

  let method = methodFromText(md);
  if (method === null && /^\d{4}$/.test(String(md.card_last4 ?? "").trim())) {
    method = "card";
    sources.method = "card_last4";
  }
  if (method === null) {
    sources.method = "mirror";
    method = mirrorLeg?.account_subtype === "points" ? "points" : (METHOD_BY_MIRROR[mirrorLeg?.account_name ?? ""] ?? "unknown");
  }

  const isCategory = (c: unknown): c is string => typeof c === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(c);
  let category: string;
  if (isCategory(mm.category)) category = mm.category;
  else if (isCategory(row.merchant_category)) {
    category = row.merchant_category;
    sources.category = "merchant_row";
  } else if (isCategory(expenseLeg?.account_name)) {
    category = expenseLeg!.account_name;
    sources.category = "legs";
  } else {
    category = "Services";
    sources.category = "default";
  }

  const payee = str(row.payee, 200) ?? str(mm.canonical_name, 200) ?? "Unknown";
  const canonical = str(mm.canonical_name, 120) ?? str(row.merchant_canonical_name, 120) ?? payee.slice(0, 120);
  const brandRaw = str(mm.brand_id, 64) ?? str(row.merchant_brand_id, 64);
  const brandId = brandRaw && SLUG_RE.test(brandRaw) ? brandRaw : slugify(brandRaw ?? canonical);

  const raw: Record<string, any> = {
    contract_version: 1,
    classification: isReceiptClassification(md.classification) ? md.classification : "receipt_image",
    facts: {
      flow,
      occurred_on: row.occurred_on,
      occurred_at: row.occurred_at,
      payee,
      total_minor: total,
      currency: main,
    },
    payment: {
      method,
      ...(/^\d{4}$/.test(String(md.card_last4 ?? "").trim()) ? { card_last4: String(md.card_last4).trim() } : {}),
    },
    identifiers: Object.fromEntries(
      CONTRACT_IDENTIFIER_KEYS.map((k) => [k, str(md[k], 80)]).filter(([, v]) => v !== null),
    ),
    merchant: { canonical_name: canonical, brand_id: brandId, category },
    items: row.items,
    parties: row.parties.map((p) => ({
      role: p.role,
      display_name: p.display_name.slice(0, 200),
      ...(p.brand_id && SLUG_RE.test(p.brand_id) ? { brand_id: p.brand_id } : {}),
      ...(p.line_no !== null ? { line_no: p.line_no } : {}),
    })),
    audit: {
      ocr_raw_payee: payee,
      correction_applied: false,
      date_candidates: [],
      chosen_date_reason: "synthesised from the ledger row",
      year_sanity_ok: true,
    },
  };
  if (row.google_place_id && GOOGLE_PLACE_ID_RE.test(row.google_place_id)) {
    raw.place = { google_place_id: row.google_place_id, resolved_via: "geocode_address" };
  }
  if (pointsCur) {
    const acct = row.postings.find((p) => p.account_subtype === "points" && p.currency === pointsCur);
    raw.points = { programme_name: (acct?.account_name.replace(/\s+points$/i, "") || pointsCur).slice(0, 80) };
    const cash = pl.filter((p) => p.currency !== pointsCur);
    if (cash.length > 0) {
      raw.cash_component = { amount_minor: Math.abs(cash.reduce((s, p) => s + signed(p), 0)), currency: cash[0]!.currency };
    }
  }
  if (flow === "income") {
    const dep = row.postings.find((p) => p.account_type === "asset" && p.currency === main)?.account_name;
    const inc = pl.find((p) => p.account_type === "income")?.account_name;
    raw.income = {
      deposit_account: dep === "Savings" || dep === "Cash" ? dep : "Checking",
      income_account: inc === "Salary" ? "Salary" : "Other",
    };
    sources.method = sources.method === "mirror" ? "legs" : sources.method;
  }
  return { raw, sources, inexpressible: null };
}

/** Validate a synthesised record; when only the line items, parties or
 *  place are what the contract refuses, retry without them, so the money
 *  is still checked. */
export function validateSynthesis(
  raw: Record<string, any>,
  uploadedAt: Date,
): { record: ExtractionV1 | null; stripped: boolean; rules: string[] } {
  const ctx = { uploadedAt, receiptText: "synthesised" };
  const first = validateExtraction(raw, ctx);
  if (first.status === "valid") return { record: first.record, stripped: false, rules: [] };
  const catalogOnly = first.report.errors.every((e) => /^(items|parties|place)\b/.test(e.path));
  if (catalogOnly) {
    const second = validateExtraction({ ...raw, items: [], parties: [], place: undefined }, ctx);
    if (second.status === "valid") return { record: second.record, stripped: true, rules: [] };
    return { record: null, stripped: true, rules: [...new Set(second.report.errors.map((e) => e.rule))] };
  }
  return { record: null, stripped: false, rules: [...new Set(first.report.errors.map((e) => `${e.rule}@${e.path}`))] };
}

// ── Comparing the money ────────────────────────────────────────────────

const postingKey = (account: string, amount: number, currency: string) => `${account} ${amount} ${currency}`;

function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const ma = multiset(a);
  const mb = multiset(b);
  return [...ma].every(([k, n]) => mb.get(k) === n);
}

export interface MoneyDiff {
  kinds: string[];
}

/** What differs between the projected and the booked postings, as kinds:
 *  `expense_account`, `mirror_account`, `leg_count`, `amount_or_sign`,
 *  `currency`. */
export function moneyDiff(draft: ApplyDraft, row: LedgerRow): MoneyDiff {
  const kinds = new Set<string>();
  const projected = draft.postings;
  const booked = row.postings;
  if (projected.length !== booked.length) kinds.add("leg_count");
  const bookedCur = [...new Set(booked.map((p) => p.currency))].sort().join(",");
  const projCur = [...new Set(projected.map((p) => p.currency))].sort().join(",");
  if (bookedCur !== projCur) kinds.add("currency");
  for (const cur of new Set([...booked, ...projected].map((p) => p.currency))) {
    const pe = projected.find((p) => p.currency === cur && (p.role === "expense" || p.role === "cash_expense" || p.role === "income"));
    const be = booked.find((p) => p.currency === cur && PL.has(p.account_type));
    if (pe && be && pe.account.name !== be.account_name) kinds.add("expense_account");
    const pm = projected.find((p) => p.currency === cur && !(p.role === "expense" || p.role === "cash_expense" || p.role === "income"));
    const bm = booked.find((p) => p.currency === cur && !PL.has(p.account_type));
    if (pm && bm && `${pm.account.type}:${pm.account.name}` !== `${bm.account_type}:${bm.account_name}`) kinds.add("mirror_account");
    const pa = projected.filter((p) => p.currency === cur).map((p) => p.amountMinor).sort((x, y) => x - y);
    const ba = booked.filter((p) => p.currency === cur).map((p) => p.amount_minor).sort((x, y) => x - y);
    if (pa.join(",") !== ba.join(",")) kinds.add("amount_or_sign");
  }
  return { kinds: [...kinds].sort() };
}

export function promptAtLeast3(md: Record<string, any>): boolean {
  const v = md?.extraction?.prompt_version;
  if (typeof v !== "string") return false;
  const major = Number(v.split(".")[0]);
  return Number.isFinite(major) && major >= 3;
}

/**
 * The explanation rules. Each returns a reason, or null. A class with no
 * rule is unexplained, which is what the gate counts.
 */
export function explain(row: LedgerRow, syn: Synthesis, diff: MoneyDiff): string | null {
  const kinds = new Set(diff.kinds);
  if (kinds.size === 0) return null;
  const booked = row.postings;
  const mainMirror = booked.find((p) => !PL.has(p.account_type));
  // The contract has one pair per currency; a split tender cannot be expressed.
  if (kinds.has("leg_count") && booked.length > 2 && new Set(booked.map((p) => p.currency)).size === 1) {
    return "legacy shape: several legs in one currency (a split tender), which the contract does not express";
  }
  // §3.3 derives the mirror from the method the record states. The legacy
  // prompt said "Mirror side is Credit Card (default)", so an agent that read
  // a tender §3.3 books elsewhere (cash, a check or bank transfer, and since
  // the owner's tender decisions a debit card, a gift card or a balance)
  // and still booked the card is the rule change of hole 9, not a projector
  // fault. Each method is its own class, so the printout shows which.
  const method = syn.raw.payment?.method as keyof typeof MIRROR_BY_METHOD;
  const projectedMirror = MIRROR_BY_METHOD[method];
  if (kinds.size === 1 && kinds.has("mirror_account") && syn.sources.method === "text") {
    if (mainMirror?.account_name === "Credit Card" && projectedMirror !== "Credit Card") {
      return `hole 9: the payment text names a ${method} tender, which §3.3 books to ${projectedMirror}; the legacy prompt's default mirror was Credit Card`;
    }
    // The other way round: the legacy agent booked a tender §3.3 sends to
    // Credit Card (a card of no stated kind, a mixed tender, another
    // tender) to Cash or Checking. A debit card booked to Checking and a
    // gift card or balance booked to Cash are no longer here: they match.
    if (projectedMirror === "Credit Card") {
      return `§3.3 sends this tender (${method}) to Credit Card; the legacy agent chose ${mainMirror?.account_name}`;
    }
  }
  if (kinds.size === 1 && kinds.has("expense_account") && syn.sources.category === "metadata") {
    return "the legacy agent booked an expense account other than the merchant.category it wrote; the record carries one category and it picks the account (§6.3 d)";
  }
  return null;
}

// ── Reading ────────────────────────────────────────────────────────────

async function openReadOnly(url: string): Promise<{ pool: pg.Pool; db: Db }> {
  const pool = new pg.Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const ro = await pool.query("SHOW default_transaction_read_only");
  if (ro.rows[0]?.default_transaction_read_only !== "on") {
    await pool.end();
    throw new Error("the server did not confirm a read-only session; refusing to run");
  }
  await pool.query("SET statement_timeout = '120s'");
  return { pool, db: drizzle(pool) };
}

export async function loadLedgerRows(pool: pg.Pool, opts: { workspace?: string; ids?: string[] } = {}): Promise<LedgerRow[]> {
  const where = [
    "t.source_ingest_id IS NOT NULL",
    ...(opts.workspace ? ["t.workspace_id = $1::uuid"] : []),
  ];
  const params: unknown[] = opts.workspace ? [opts.workspace] : [];
  if (opts.ids) {
    params.push(opts.ids);
    where.push(`t.id = ANY($${params.length}::uuid[])`);
  }
  const heads = await pool.query(
    `SELECT t.id, t.workspace_id, t.occurred_on::text AS occurred_on,
            to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
            t.payee, t.metadata,
            COALESCE(i.created_at, t.created_at) AS uploaded_at,
            m.brand_id AS merchant_brand_id, m.canonical_name AS merchant_canonical_name, m.category AS merchant_category,
            pl.google_place_id
       FROM ledger_live_transactions t
       LEFT JOIN ingests i ON i.id = t.source_ingest_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
       LEFT JOIN places pl ON pl.id = t.place_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at, t.id`,
    params,
  );
  const ids = heads.rows.map((r) => r.id as string);
  const postings = await pool.query(
    `SELECT p.transaction_id, a.type::text AS account_type, a.name AS account_name, a.subtype AS account_subtype,
            p.amount_minor::text AS amount_minor, p.currency
       FROM postings p JOIN accounts a ON a.id = p.account_id
      WHERE p.transaction_id = ANY($1::uuid[])`,
    [ids],
  );
  const items = await pool.query(
    `SELECT ti.transaction_id, ti.line_no, ti.parent_line_no, ti.raw_name, ti.normalized_name,
            ti.quantity::float8 AS quantity, ti.unit, ti.unit_price_minor, ti.line_total_minor, ti.currency,
            ti.item_class, ti.durability_tier, ti.food_kind, ti.tags, ti.confidence, ti.line_type,
            pr.product_key, pr.brand_id AS product_brand_id, (pr.merchant_id IS NOT NULL) AS product_merchant_exclusive,
            ti.product_variant, ti.tax_minor, ti.tip_share_minor, ti.discount_share_minor
       FROM transaction_items ti
       LEFT JOIN products pr ON pr.id = ti.product_id
      WHERE ti.transaction_id = ANY($1::uuid[]) AND ti.retired_at IS NULL
      ORDER BY ti.transaction_id, ti.line_no`,
    [ids],
  );
  const parties = await pool.query(
    `SELECT tp.transaction_id, tp.role, tp.display_name, tp.brand_id, ti.line_no
       FROM transaction_parties tp
       LEFT JOIN transaction_items ti ON ti.id = tp.transaction_item_id
      WHERE tp.transaction_id = ANY($1::uuid[])`,
    [ids],
  );
  const group = <T extends { transaction_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.transaction_id) ?? [];
      list.push(r);
      m.set(r.transaction_id, list);
    }
    return m;
  };
  const P = group(postings.rows);
  const I = group(items.rows);
  const T = group(parties.rows);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return heads.rows.map((h) => ({
    id: h.id,
    workspace_id: h.workspace_id,
    occurred_on: h.occurred_on,
    occurred_at: h.occurred_at,
    payee: h.payee,
    metadata: h.metadata ?? {},
    uploaded_at: new Date(h.uploaded_at).toISOString(),
    merchant_brand_id: h.merchant_brand_id,
    merchant_canonical_name: h.merchant_canonical_name,
    merchant_category: h.merchant_category,
    google_place_id: h.google_place_id,
    postings: (P.get(h.id) ?? []).map((p) => ({
      account_type: p.account_type,
      account_name: p.account_name,
      account_subtype: p.account_subtype,
      amount_minor: Number(p.amount_minor),
      currency: p.currency,
    })),
    items: (I.get(h.id) ?? []).map((i) => {
      const o: Record<string, unknown> = {
        line_no: i.line_no,
        parent_line_no: i.parent_line_no,
        raw_name: i.raw_name,
        normalized_name: i.normalized_name,
        quantity: i.quantity,
        unit: i.unit,
        unit_price_minor: n(i.unit_price_minor),
        line_total_minor: n(i.line_total_minor),
        currency: i.currency,
        item_class: i.item_class,
        durability_tier: i.durability_tier,
        food_kind: i.food_kind,
        tags: i.tags,
        confidence: i.confidence,
        line_type: i.line_type,
        product_key: i.product_key,
        product_brand_id: i.product_brand_id,
        product_merchant_exclusive: i.product_key ? i.product_merchant_exclusive : null,
        product_variant: i.product_variant,
        tax_minor: n(i.tax_minor),
        tip_share_minor: n(i.tip_share_minor),
        discount_share_minor: n(i.discount_share_minor),
      };
      for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
      return o;
    }),
    parties: (T.get(h.id) ?? []).map((p) => ({ role: p.role, display_name: p.display_name, brand_id: p.brand_id, line_no: p.line_no })),
  }));
}

// ── Reporting ──────────────────────────────────────────────────────────

class Tally {
  /** `eras`: how a gated and an ungated row are labelled. */
  constructor(private readonly eras: { gated: string; other: string } = { gated: "3.x", other: "old" }) {}
  private readonly classes = new Map<string, { gated: boolean; explained: string | null; ids: string[] }>();
  add(cls: string, id: string, gated: boolean, explained: string | null): void {
    const key = `${gated ? this.eras.gated : this.eras.other}\u0000${cls}\u0000${explained ?? ""}`;
    const c = this.classes.get(key) ?? { gated, explained, ids: [] };
    c.ids.push(id);
    this.classes.set(key, c);
  }
  print(verbose: boolean): { unexplainedGated: number } {
    let unexplainedGated = 0;
    const rows = [...this.classes.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [key, c] of rows) {
      const [era, cls] = key.split("\u0000");
      const tag = c.explained === null ? (cls!.startsWith("match") ? "ok" : "UNEXPLAINED") : "explained";
      if (c.gated && tag === "UNEXPLAINED") unexplainedGated += c.ids.length;
      console.log(`  [${era}] ${String(c.ids.length).padStart(5)}  ${tag.padEnd(11)} ${cls}${c.explained ? ` — ${c.explained}` : ""}`);
      if (verbose && tag !== "ok") console.log(`         ${c.ids.join(" ")}`);
    }
    return { unexplainedGated };
  }
}

async function fromLedger(pool: pg.Pool, db: Db, opts: { workspace?: string; verbose: boolean }): Promise<number> {
  const rows = await loadLedgerRows(pool, opts);
  const catalogs = new Map<string, AccountCatalog>();
  const tally = new Tally();
  const circular = { category: new Map<string, number>(), method: new Map<string, number>(), flow: new Map<string, number>() };
  let stripped = 0;
  for (const row of rows) {
    const gated = promptAtLeast3(row.metadata);
    if (!catalogs.has(row.workspace_id)) catalogs.set(row.workspace_id, await readAccountCatalog(db, row.workspace_id));
    if (row.metadata?.classification === "statement_pdf") {
      // X10: the legacy agent booked one transaction per statement row; a
      // statement record books nothing (plan §6.3, owner question 2).
      tally.add("statement row", row.id, gated, "X10: statements are recorded, not booked");
      continue;
    }
    const syn = synthesiseRecord(row);
    if (syn.inexpressible) {
      tally.add(`inexpressible: ${syn.inexpressible}`, row.id, gated, null);
      continue;
    }
    for (const k of ["category", "method", "flow"] as const) {
      if (gated) circular[k].set(syn.sources[k], (circular[k].get(syn.sources[k]) ?? 0) + 1);
    }
    let v = validateSynthesis(syn.raw, new Date(row.uploaded_at));
    let refusedFor = "";
    if (!v.record && v.rules.every((r) => r.startsWith("future_date@"))) {
      // The contract refuses a date more than 2 days after the upload
      // (§4.2), so arm B would ask for a re-read instead of booking it. The
      // money is still checked, judged as of the transaction's own date.
      refusedFor = "dated after its upload (future_date, §4.2); ";
      v = validateSynthesis(syn.raw, new Date(`${row.occurred_on}T00:00:00Z`));
    }
    if (!v.record) {
      tally.add(`record refused: ${v.rules.join(", ")}`, row.id, gated, null);
      continue;
    }
    if (v.stripped) stripped += 1;
    let draft: ApplyDraft;
    try {
      draft = project(v.record, catalogs.get(row.workspace_id)!);
    } catch (e) {
      tally.add(`projection error: ${e instanceof ProjectionError ? e.code : String(e)}`, row.id, gated, null);
      continue;
    }
    const projected = draft.postings.map((p) => postingKey(`${p.account.type}:${p.account.name}`, p.amountMinor, p.currency));
    const booked = row.postings.map((p) => postingKey(`${p.account_type}:${p.account_name}`, p.amount_minor, p.currency));
    if (sameMultiset(projected, booked)) {
      tally.add(
        `${refusedFor ? `${refusedFor}money ` : ""}match (${shapeOf(draft)})`,
        row.id,
        gated,
        refusedFor ? "a reading the contract refuses; its money projects as booked" : null,
      );
      continue;
    }
    const diff = moneyDiff(draft, row);
    tally.add(
      `${refusedFor}mismatch: ${diff.kinds.join("+")} [method from ${syn.sources.method}, category from ${syn.sources.category}]`,
      row.id,
      gated,
      explain(row, syn, diff),
    );
  }
  console.log(`check-projection-replay --from-ledger: ${rows.length} live ingest transactions, applier ${APPLIER_VERSION}`);
  console.log("  classes ([3.x] rows are gated, [old] rows are reported):");
  const { unexplainedGated } = tally.print(opts.verbose);
  const fmt = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n}`).join(", ");
  console.log(`  synthesised from (3.x rows): flow: ${fmt(circular.flow)}; category: ${fmt(circular.category)}; method: ${fmt(circular.method)}`);
  console.log(`  records validated only without their items/parties/place: ${stripped}`);
  console.log(
    unexplainedGated === 0
      ? "  GATE PASS: no unexplained money mismatch on a row with prompt_version >= 3.0"
      : `  GATE FAIL: ${unexplainedGated} unexplained money mismatches on rows with prompt_version >= 3.0`,
  );
  return unexplainedGated === 0 ? 0 : 1;
}

function shapeOf(d: ApplyDraft): string {
  const flowShape = d.postings.some((p) => p.account.kind === "new_points" || /points$/.test(p.account.name)) ? "points" : d.flow;
  const fx = d.postings.some((p) => p.currency !== "USD" && !/_PT$/.test(p.currency)) ? ", foreign currency" : "";
  return `${flowShape}${d.postings.length > 2 ? ", with cash part" : ""}${fx}, mirror ${d.mirror.accountName === "Credit Card" || d.mirror.accountName === "Cash" || d.mirror.accountName === "Checking" || d.mirror.accountName === "Savings" ? d.mirror.accountName : "points account"}`;
}

/**
 * Why an applied record's fingerprint no longer matches its transaction,
 * when every differing field has a recorded cause: a person's edit (an
 * `updated` event naming the field, or the metadata key it is read from),
 * a re-extract or added line items (items), a posting edited by hand
 * (postings), a place the apply could not fetch (the run's
 * `apply_report.warnings[].rule`), or a dedup apply that folded the
 * transaction into another and moved its documents there (ocr_text
 * present: a `deleted` event carrying the proposal). Null when one field
 * has none.
 */
export function explainRecordDiff(
  fields: string[],
  events: { event_type: string; new: Record<string, any> | null; proposal_id?: string | null }[],
  applyReport: { warnings?: { rule?: string }[] } | null,
): string | null {
  const head = new Set<string>();
  const meta = new Set<string>();
  const types = new Set<string>();
  for (const e of events) {
    types.add(e.event_type);
    if (e.event_type === "deleted" && e.proposal_id) types.add("folded");
    if (e.event_type !== "updated" || !e.new) continue;
    for (const k of Object.keys(e.new)) head.add(k);
    if (e.new.metadata && typeof e.new.metadata === "object") for (const k of Object.keys(e.new.metadata)) meta.add(k);
  }
  const warned = new Set((applyReport?.warnings ?? []).map((w) => w.rule));
  const cause: Record<string, () => string | null> = {
    payee: () => (head.has("payee") ? "edited" : null),
    occurred_on: () => (head.has("occurred_on") ? "edited" : null),
    occurred_at: () => (head.has("occurred_at") ? "edited" : null),
    brand_id: () => (meta.has("merchant") ? "edited" : null),
    category: () => (meta.has("merchant") ? "edited" : null),
    flow: () => (meta.has("flow") ? "edited" : null),
    identifiers: () => (CONTRACT_IDENTIFIER_KEYS.some((k) => meta.has(k)) ? "edited" : null),
    card_last4: () => (meta.has("card_last4") || meta.has("payment") ? "edited" : null),
    items: () => (types.has("re_extracted") || types.has("items_added") ? "re-extracted or added to" : null),
    postings: () => ([...types].some((t) => t.startsWith("posting_")) ? "postings edited" : null),
    google_place_id: () =>
      warned.has("place_fetch_failed") || warned.has("place_not_projectable") ? "the place could not be fetched at apply" : null,
    ocr_text_present: () => (types.has("folded") ? "folded by a dedup apply, its documents moved to the survivor" : null),
  };
  const reasons: string[] = [];
  for (const f of fields) {
    const why = cause[f]?.() ?? null;
    if (why === null) return null;
    reasons.push(`${f}: ${why}`);
  }
  return `changed since the apply, with a recorded cause (${reasons.join("; ")})`;
}

async function records(pool: pg.Pool, db: Db, opts: { workspace?: string; verbose: boolean }): Promise<number> {
  const exists = await pool.query("SELECT to_regclass('public.document_extractions') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) {
    console.log("check-projection-replay --records: document_extractions does not exist here (migration 0043 not applied); nothing to replay");
    return 0;
  }
  const recs = await pool.query(
    `SELECT e.id, e.workspace_id, e.document_id, e.classification, e.result, e.raw_text, e.ingest_id,
            d.mime_type, i.status::text AS ingest_status,
            (SELECT t.id FROM transactions t
              WHERE t.metadata->'extraction'->>'extraction_id' = e.id::text
              ORDER BY t.created_at LIMIT 1) AS transaction_id,
            -- A legacy re-extract moves the stamp into extraction_history.
            (SELECT t.id FROM transactions t
              WHERE t.metadata->'extraction_history' @> jsonb_build_array(jsonb_build_object('extraction_id', e.id::text))
              ORDER BY t.created_at LIMIT 1) AS re_extracted_transaction_id,
            (SELECT r.outcome::text || '/' || COALESCE(r.error_class, '') FROM agent_runs r
              WHERE r.extraction_id = e.id
              ORDER BY r.started_at DESC NULLS LAST LIMIT 1) AS last_run
       FROM document_extractions e
       JOIN documents d ON d.id = e.document_id
       LEFT JOIN ingests i ON i.id = e.ingest_id
      WHERE e.status = 'valid' AND e.superseded_at IS NULL
        ${opts.workspace ? "AND e.workspace_id = $1::uuid" : ""}
      ORDER BY e.created_at, e.id`,
    opts.workspace ? [opts.workspace] : [],
  );
  const catalogs = new Map<string, AccountCatalog>();
  const tally = new Tally({ gated: "rec", other: "rec" });
  for (const r of recs.rows) {
    if (!isReceiptClassification(r.classification)) {
      tally.add(`no transaction expected (${r.classification})`, r.id, true, "statements and unsupported documents book nothing");
      continue;
    }
    if (!r.transaction_id && r.re_extracted_transaction_id) {
      // The transaction's current values are a later reading's: the record
      // is no longer their author, so there is nothing to compare.
      tally.add(
        "re-extracted since the apply",
        r.re_extracted_transaction_id,
        true,
        "a re-extract replaced the reading (the record's stamp is in metadata.extraction_history)",
      );
      continue;
    }
    if (!r.transaction_id) {
      const applyFailed = r.ingest_status === "error" && r.last_run === "failed/apply";
      const why =
        r.ingest_status === "near_dup"
          ? "attached to an existing transaction"
          : applyFailed
            ? "the apply failed"
            : `not applied (ingest ${r.ingest_status ?? "gone"})`;
      tally.add(
        `no transaction names the record: ${why}`,
        r.id,
        true,
        r.ingest_status === "near_dup"
          ? "an attach books nothing"
          : applyFailed
            ? "the run records the failure (agent_runs.error); the record waits, valid, for a re-apply"
            : null,
      );
      continue;
    }
    // A valid record's `result` is the record as validated (normalised,
    // defaults applied), so it is projected as stored.
    const record = r.result as ExtractionV1;
    if (!catalogs.has(r.workspace_id)) catalogs.set(r.workspace_id, await readAccountCatalog(db, r.workspace_id));
    let draft: ApplyDraft;
    try {
      draft = project(record, catalogs.get(r.workspace_id)!);
    } catch (e) {
      tally.add(`projection error: ${e instanceof ProjectionError ? e.code : String(e)}`, r.transaction_id, true, null);
      continue;
    }
    const serverText = /rfc822|eml|html/i.test(String(r.mime_type ?? ""));
    const fromDraft = fingerprintFromDraft(record, draft, {
      ocrTextPresent: (typeof r.raw_text === "string" && r.raw_text.trim() !== "") || serverText,
    });
    const fromLedger = await readLedgerFingerprint(db, r.transaction_id);
    if (!fromLedger) {
      tally.add("the transaction is gone", r.transaction_id, true, null);
      continue;
    }
    const fields = diffFingerprints(fromDraft, fromLedger);
    if (fields.length === 0) {
      tally.add("match", r.transaction_id, true, null);
      continue;
    }
    const ev = await pool.query(
      `SELECT ev.event_type, ev.payload->'new' AS new, ev.payload->>'proposal_id' AS proposal_id
         FROM transaction_events ev
        WHERE ev.transaction_id = $1::uuid
          AND ev.event_type IN ('updated', 'items_added', 're_extracted', 'posting_added', 'posting_updated', 'posting_removed',
                                'deleted')`,
      [r.transaction_id],
    );
    const run = await pool.query(
      `SELECT apply_report FROM agent_runs WHERE extraction_id = $1::uuid ORDER BY started_at DESC NULLS LAST LIMIT 1`,
      [r.id],
    );
    const reason = explainRecordDiff(fields, ev.rows, run.rows[0]?.apply_report ?? null);
    tally.add(`differs: ${fields.join(", ")}`, r.transaction_id, true, reason);
  }
  console.log(`check-projection-replay --records: ${recs.rowCount} current valid records, applier ${APPLIER_VERSION}`);
  const { unexplainedGated } = tally.print(opts.verbose);
  console.log(unexplainedGated === 0 ? "  PASS: every applied record re-projects to its transaction" : `  FAIL: ${unexplainedGated} records do not`);
  return unexplainedGated === 0 ? 0 : 1;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("--pg="))?.slice("--pg=".length);
  const workspace = args.find((a) => a.startsWith("--workspace="))?.slice("--workspace=".length);
  const verbose = args.includes("--verbose");
  const mode = args.includes("--from-ledger") ? "from-ledger" : args.includes("--records") ? "records" : null;
  if (!url || !mode) {
    console.error("usage: check-projection-replay.ts --pg=<url> (--from-ledger | --records) [--verbose] [--workspace=<uuid>]");
    return 2;
  }
  const { pool, db } = await openReadOnly(url);
  try {
    return mode === "from-ledger" ? await fromLedger(pool, db, { workspace, verbose }) : await records(pool, db, { workspace, verbose });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-projection-replay: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
