/**
 * check-apply-decide.ts — the server applier's pure half: the duplicate
 * decision (`src/ingest/apply/decide.ts`), the projection to postings and
 * line items (`project.ts`), the metadata key set (`metadata.ts`) and the
 * fingerprint (`fingerprint.ts`) (wave 1; docs/server-writer.md,
 * "Attach or insert", "Accounts and postings" and
 * "Transaction metadata").
 *
 * WHY THIS EXISTS
 *
 * Under the server writer these functions decide what the ledger holds
 * for a receipt: which account each amount goes to, with which sign, and
 * whether a document becomes a new purchase or evidence for one already
 * booked. A rule that quietly changes there books money wrong or merges
 * two purchases into one. Every rule of the duplicate decision and every
 * posting shape is a row of the tables below, run on every build.
 *
 * WHAT IT CHECKS
 *
 *   decide()   the direction gate (flow, legs, unknown) and `refund_of`;
 *              no candidate; strong by identifier (same key, cross key,
 *              short cross key), by the hard tuple and each way the tuple
 *              fails; the three same-merchant tests; an identifier match
 *              blocked by a conflicting key, another total or another
 *              card (partial refunds, split charges, the next invoice of
 *              one order); several strong; a conflict on every candidate;
 *              the uncertain residue; a zero total; the pHash-only note.
 *   project()  purchase, refund, income (defaults and named accounts),
 *              points with an existing and a new account, points plus
 *              cash (by card, cash and debit card), every payment
 *              method's mirror account for a purchase and the tenders'
 *              for a refund, a mixed tender's review flag, JPY and KWD
 *              amounts left as they are, a zero total, the missing-account
 *              and not-a-receipt errors, owned items, parties, place,
 *              the sold item, and per-currency balance of every draft.
 *   metadata   the fixed key set, the extraction stamp, identifiers at
 *              top level, the payment strings, printed totals,
 *              allocation audit, the dedup keys, a mixed tender's flag in
 *              near_dup_check, and that the keys it introduces are
 *              server-owned.
 *   fingerprint  order and offset independence, and that an amount
 *              change shows.
 *
 * No database, no network, no model. Runs in `npm run build` (prebuild).
 *
 *   npm run check:apply-decide            exit 1 on any failure
 *   npm run check:apply-decide -- --list  print every check
 */
import { validateExtraction, type ValidationContext } from "../src/ingest/contract/validate.js";
import type { ExtractionV1 } from "../src/ingest/contract/v1.js";
import type { AccountCatalog, CatalogAccount } from "../src/ingest/apply/accounts.js";
import { decide, type ApplyCandidate, type ApplyDecision } from "../src/ingest/apply/decide.js";
import {
  MIRROR_BY_METHOD,
  MIXED_TENDER_REVIEW,
  ProjectionError,
  project,
  unbalancedCurrencies,
  type ApplyDraft,
} from "../src/ingest/apply/project.js";
import {
  APPLIER_METADATA_KEYS,
  EXTRACTION_STAMP_KEYS,
  buildTransactionMetadata,
  type MetadataRunContext,
} from "../src/ingest/apply/metadata.js";
import { diffFingerprints, fingerprint, fingerprintFromDraft } from "../src/ingest/apply/fingerprint.js";
import { APPLIER_VERSION } from "../src/ingest/apply/version.js";
import { RECORD_PROMPT_VERSION } from "../src/ingest/prompt-contract.js";
import { SERVER_OWNED_TX_METADATA_KEYS } from "../src/projection/metadata-patch.js";

const LIST = process.argv.includes("--list");
let checks = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  if (LIST) console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const json = (v: unknown) => JSON.stringify(v);

// ── Fixtures (synthetic: no real merchant, amount, card or identifier) ──

const CTX: ValidationContext = { uploadedAt: new Date("2026-06-15T12:00:00Z"), receiptText: "EXAMPLE STORE\nWIDGET 12.34" };

type Rec = Record<string, any>;

function base(): Rec {
  return {
    contract_version: 1,
    classification: "receipt_image",
    facts: {
      flow: "purchase",
      occurred_on: "2026-06-10",
      occurred_at: "2026-06-10T12:30:00-07:00",
      payee: "Example Store",
      payee_as_printed: "EXAMPLE STORE #12",
      payee_source: "printed",
      total_minor: 1234,
      currency: "USD",
    },
    payment: { method: "card", card_last4: "0000", card_network: "Visa" },
    identifiers: { order_number: "A-000100" },
    merchant: { canonical_name: "Example Store", brand_id: "example-store", category: "Shopping" },
    items: [
      { line_no: 1, raw_name: "WIDGET", line_total_minor: 1000, item_class: "consumable", confidence: "high", product_key: "example-widget" },
      { line_no: 2, raw_name: "GADGET", line_total_minor: 234, item_class: "consumable", confidence: "high", product_key: "example-gadget" },
    ],
    audit: {
      ocr_raw_payee: "EXAMPLE STORE #12",
      correction_applied: false,
      date_candidates: ["06/10/2026"],
      chosen_date_reason: "printed in the header",
      year_sanity_ok: true,
    },
  };
}

/** A valid record from the base with `mut` applied; fails the run if the
 *  validator refuses it (a fixture bug, not a finding). */
function rec(mut: (r: Rec) => void = () => {}): ExtractionV1 {
  const r = base();
  mut(r);
  const out = validateExtraction(r, CTX);
  if (out.status !== "valid") {
    throw new Error(`fixture refused by the validator: ${json(out.report.errors)}`);
  }
  return out.record;
}

let seq = 0;
const acct = (type: CatalogAccount["type"], name: string, extra: Partial<CatalogAccount> = {}): CatalogAccount => ({
  id: `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`,
  name,
  type,
  subtype: null,
  currency: "USD",
  parentId: "root",
  closed: false,
  ...extra,
});

const ROOT_ASSETS = acct("asset", "Assets", { parentId: null });
const POINTS_STAYCO = acct("asset", "Stayco Rewards points", { subtype: "points", currency: "STAYCO_PT", parentId: null });
const FULL: AccountCatalog = {
  accounts: [
    ROOT_ASSETS,
    acct("asset", "Cash", { subtype: "cash" }),
    acct("asset", "Checking", { subtype: "checking" }),
    acct("asset", "Savings", { subtype: "savings" }),
    acct("liability", "Liabilities", { parentId: null }),
    acct("liability", "Credit Card", { subtype: "credit_card" }),
    acct("income", "Income", { parentId: null }),
    acct("income", "Salary"),
    acct("income", "Other"),
    acct("expense", "Expenses", { parentId: null }),
    ...["Food & Drinks", "Transportation", "Shopping", "Travel", "Entertainment", "Health", "Services"].map((n) =>
      acct("expense", n),
    ),
    POINTS_STAYCO,
  ],
};
const without = (pred: (a: CatalogAccount) => boolean): AccountCatalog => ({
  accounts: FULL.accounts.filter((a) => !pred(a)),
});

/** Postings as `type:name sign amount currency`, sorted. */
const shape = (d: ApplyDraft) =>
  d.postings
    .map((p) => `${p.account.type}:${p.account.name} ${p.amountMinor} ${p.currency}`)
    .sort()
    .join(" | ");

function cand(over: Partial<ApplyCandidate> = {}): ApplyCandidate {
  return {
    id: "c-1",
    occurred_on: "2026-06-10",
    occurred_at: null,
    payee: "Another Shop",
    merchant_id: "m-other",
    merchant_brand_id: "another-shop",
    merchant_canonical_name: "Another Shop",
    status: "posted",
    payment: null,
    card_last4: null,
    flow: "purchase",
    refund_of: null,
    near_dup_check: null,
    identifiers: {},
    pl_class: "expense",
    total: 1234,
    native_total: 1234,
    item_totals: [],
    matched_on: ["amount"],
    date_distance: 0,
    ...over,
  };
}
/** A candidate that is the same merchant as the base record by brand. */
const sameBrand = (over: Partial<ApplyCandidate> = {}) =>
  cand({ merchant_brand_id: "example-store", payee: "EXAMPLE STORE", merchant_canonical_name: "Example Store", ...over });

function expectDecision(
  name: string,
  d: ApplyDecision,
  want: { action: "attach" | "insert"; target?: string; verdict?: string; flagged?: boolean; refundOf?: string | null },
): void {
  const got =
    d.action === "attach"
      ? { action: d.action, target: d.targetId }
      : { action: d.action, verdict: d.verdict, flagged: d.flaggedForReview, refundOf: d.refundOf };
  const ok =
    got.action === want.action &&
    (want.target === undefined || (d.action === "attach" && d.targetId === want.target)) &&
    (want.verdict === undefined || (d.action === "insert" && d.verdict === want.verdict)) &&
    (want.flagged === undefined || (d.action === "insert" && d.flaggedForReview === want.flagged)) &&
    (want.refundOf === undefined || (d.action === "insert" && d.refundOf === want.refundOf));
  check(`decide: ${name}`, ok, `got ${json(got)} (${d.reason})`);
}

// ── decide() ───────────────────────────────────────────────────────────

{
  const r = rec();
  expectDecision("no candidate → insert, nothing to note", decide(r, []), { action: "insert", verdict: "none", flagged: false });
  const d = decide(r, []);
  check("decide: no candidate writes no near_dup_check", d.action === "insert" && d.nearDupCheck === null);
}

// 0. Direction gate.
{
  const r = rec();
  const refund = sameBrand({ flow: "refund", total: -1234, native_total: -1234, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  const d = decide(r, [refund]);
  expectDecision("direction gate: a refund with the same order number is not a purchase's duplicate", d, { action: "insert", verdict: "none" });
  check("decide: the refund is reported dropped for direction", d.dropped.length === 1 && d.dropped[0]!.why === "direction");

  const byLegs = sameBrand({ flow: null, total: -1234, native_total: -1234, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  expectDecision("direction gate: no flow, a negative expense leg reads as a refund", decide(r, [byLegs]), { action: "insert", verdict: "none" });

  const unknown = sameBrand({ flow: null, pl_class: "mixed", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  const du = decide(r, [unknown]);
  expectDecision("direction gate: legs of both kinds and no flow is dropped", du, { action: "insert", verdict: "none" });
  check("decide: unknown direction is reported as such", du.dropped[0]?.why === "direction_unknown");

  const income = rec((x) => {
    x.facts.flow = "income";
  });
  const purchaseCand = sameBrand({ flow: null, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  expectDecision("direction gate: income never attaches to a purchase", decide(income, [purchaseCand]), { action: "insert", verdict: "none" });

  const incomeCand = sameBrand({ flow: null, pl_class: "income", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  expectDecision("direction gate: income attaches to income by its legs", decide(income, [incomeCand]), { action: "attach", target: "c-1" });

  const misbooked = sameBrand({ flow: "refund", total: 1234, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  expectDecision("direction gate: metadata.flow outranks the legs", decide(r, [misbooked]), { action: "insert", verdict: "none" });
}

// refund_of.
{
  const refund = rec((x) => {
    x.facts.flow = "refund";
    x.facts.total_minor = -1234;
    x.items = x.items.map((i: Rec) => ({ ...i, line_total_minor: -i.line_total_minor }));
  });
  const purchase = sameBrand({ id: "p-1", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"], date_distance: 9 });
  expectDecision("refund_of: exactly one purchase shares the order number", decide(refund, [purchase]), {
    action: "insert",
    verdict: "none",
    refundOf: "p-1",
  });

  const two = decide(refund, [purchase, sameBrand({ id: "p-2", identifiers: { invoice_number: "A-000100" }, matched_on: ["identifier"] })]);
  expectDecision("refund_of: two purchases share an identifier → none named", two, { action: "insert", refundOf: null });
  check("decide: refund_of: two purchases → refund_of_dropped warning", two.warnings.some((w) => w.rule === "refund_of_dropped"));

  const shortRefund = rec((x) => {
    x.facts.flow = "refund";
    x.facts.total_minor = -1234;
    x.identifiers = { approval_code: "12345" };
    x.items = [];
  });
  expectDecision(
    "refund_of: a short value under another key is not shared",
    decide(shortRefund, [sameBrand({ id: "p-3", identifiers: { order_number: "12345" }, matched_on: ["identifier"] })]),
    { action: "insert", refundOf: null },
  );

  const other = sameBrand({ id: "p-4", identifiers: { order_number: "B-999999" }, matched_on: ["identifier"] });
  expectDecision("refund_of: a purchase with another number is not named", decide(refund, [other]), { action: "insert", refundOf: null });

  const refundCopy = sameBrand({ id: "r-1", flow: "refund", total: -1234, native_total: -1234, identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"] });
  expectDecision("refund: a second copy of the same refund attaches", decide(refund, [purchase, refundCopy]), { action: "attach", target: "r-1" });
}

// 1. pHash neighbour dropped: still noted.
{
  const r = rec();
  const d = decide(r, [sameBrand({ id: "ph-1", flow: "refund", total: -500, native_total: -500, matched_on: ["phash"] })]);
  expectDecision("pHash neighbour of the other direction → insert", d, { action: "insert", verdict: "none" });
  check(
    "decide: the pHash neighbour is still named in near_dup_check (distinct)",
    d.action === "insert" && d.nearDupCheck?.verdict === "distinct" && json(d.nearDupCheck.candidate_transaction_ids) === json(["ph-1"]),
    json(d.action === "insert" ? d.nearDupCheck : null),
  );
}

// 2. Strong match.
{
  const r = rec();
  const id = sameBrand({ identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"] });
  const d = decide(r, [id]);
  expectDecision("strong: same brand and same order number → attach", d, { action: "attach", target: "c-1" });
  check("decide: strong: the tiebreaker is the identifier", d.action === "attach" && d.tiebreaker === "identifier");

  const cross = sameBrand({ identifiers: { invoice_number: "A-000100" }, matched_on: ["identifier"] });
  expectDecision("strong: the same 6+ character value under another key → attach", decide(r, [cross]), { action: "attach" });

  const short = rec((x) => {
    x.identifiers = { order_number: "77" };
  });
  expectDecision(
    "strong: a short value under another key is no tiebreaker → uncertain",
    decide(short, [sameBrand({ identifiers: { approval_code: "77" }, matched_on: ["identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );

  expectDecision(
    "strong: an identifier match at another merchant is not strong → uncertain",
    decide(r, [cand({ identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );

  expectDecision(
    "same merchant: payee equal after case, width and spacing are folded",
    decide(r, [cand({ payee: "  ｅxample   STORE ", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]),
    { action: "attach" },
  );
  expectDecision(
    "same merchant: metadata.merchant.canonical_name equal",
    decide(r, [cand({ merchant_canonical_name: "example store", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]),
    { action: "attach" },
  );

  const conflictAndMatch = sameBrand({ identifiers: { order_number: "A-000100", approval_code: "ZZ9" }, matched_on: ["identifier"] });
  const rApproval = rec((x) => {
    x.identifiers = { order_number: "A-000100", approval_code: "YY8" };
  });
  const dApproval = decide(rApproval, [conflictAndMatch]);
  expectDecision("strong: a conflicting approval code is not outweighed by a matching order number → uncertain", dApproval, {
    action: "insert",
    verdict: "uncertain",
    flagged: true,
  });
  check("decide: the reason names the conflicting key", dApproval.reason.includes("approval_code"), dApproval.reason);

  // One order, several money events (an identifier alone never attaches).
  const subscription = rec((x) => {
    x.identifiers = { order_number: "A-000100", invoice_number: "INV-000002" };
  });
  expectDecision(
    "strong: same order number, another invoice number, same total (next month's invoice) → uncertain",
    decide(subscription, [sameBrand({ identifiers: { order_number: "A-000100", invoice_number: "INV-000001" }, matched_on: ["identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
  const otherTotal = decide(r, [sameBrand({ total: 2000, native_total: 2000, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]);
  expectDecision("strong: same order number, another total (a split shipment) → uncertain", otherTotal, {
    action: "insert",
    verdict: "uncertain",
    flagged: true,
  });
  check("decide: the reason says the total differs", otherTotal.reason.includes("the total differs"), otherTotal.reason);
  expectDecision(
    "strong: same order number, no P&L leg in the record's currency → uncertain",
    decide(r, [sameBrand({ native_total: null, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
  expectDecision(
    "strong: same order number and total, another card → uncertain",
    decide(r, [sameBrand({ card_last4: "9999", identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
  expectDecision(
    "strong: same order number and total, the same card → attach",
    decide(r, [sameBrand({ card_last4: "0000", identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"] })]),
    { action: "attach" },
  );
  const partial2 = rec((x) => {
    x.facts.flow = "refund";
    x.facts.total_minor = -2000;
    x.identifiers = { order_number: "A-000100" };
    x.items = [];
  });
  expectDecision(
    "strong: a second partial refund of one order (another amount) is booked → uncertain",
    decide(partial2, [sameBrand({ id: "r-9", flow: "refund", total: -3000, native_total: -3000, identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
}

// 2(ii). The hard tuple.
{
  const r = rec((x) => {
    x.identifiers = {};
  });
  const tuple = (over: Partial<ApplyCandidate> = {}) =>
    sameBrand({
      card_last4: "0000",
      occurred_at: "2026-06-10T19:30:41.000Z",
      native_total: 1234,
      item_totals: [234, 1000],
      matched_on: ["amount"],
      ...over,
    });
  const d = decide(r, [tuple()]);
  expectDecision("hard tuple: card, minute (other offset), total, line totals (other order) → attach", d, { action: "attach" });
  check("decide: hard tuple: tiebreaker named", d.action === "attach" && d.tiebreaker === "hard_tuple");
  expectDecision(
    "hard tuple: the card read from the payment string",
    decide(r, [tuple({ card_last4: null, payment: "Visa ****0000" })]),
    { action: "attach" },
  );
  for (const [why, over] of [
    ["card missing on the candidate", { card_last4: null }],
    ["another card", { card_last4: "1111" }],
    ["another minute", { occurred_at: "2026-06-10T19:31:00.000Z" }],
    ["no time on the candidate", { occurred_at: null }],
    ["another total", { native_total: 1235 }],
    ["other line totals", { item_totals: [1000, 230, 4] }],
    ["no items on the candidate", { item_totals: [] }],
  ] as [string, Partial<ApplyCandidate>][]) {
    expectDecision(`hard tuple fails (${why}) → uncertain`, decide(r, [tuple(over)]), { action: "insert", verdict: "uncertain", flagged: true });
  }
  const noItems = rec((x) => {
    x.identifiers = {};
    x.items = [];
  });
  expectDecision("hard tuple fails (no items on the record) → uncertain", decide(noItems, [tuple()]), { action: "insert", verdict: "uncertain" });
  const noTime = rec((x) => {
    x.identifiers = {};
    x.facts.occurred_at = null;
  });
  expectDecision("hard tuple fails (no time on the record) → uncertain", decide(noTime, [tuple()]), { action: "insert", verdict: "uncertain" });
}

// Several strong; conflicts; residue.
{
  const r = rec();
  const a = sameBrand({ id: "s-1", identifiers: { order_number: "A-000100" }, matched_on: ["identifier"] });
  const b = sameBrand({ id: "s-2", identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"], date_distance: 1 });
  const d = decide(r, [a, b]);
  expectDecision("several strong → insert, uncertain, flagged", d, { action: "insert", verdict: "uncertain", flagged: true });
  check(
    "decide: several strong: reason and both named",
    d.reason === "several candidates match" &&
      d.action === "insert" &&
      json(d.nearDupCheck?.candidate_transaction_ids) === json(["s-1", "s-2"]),
  );

  const c1 = sameBrand({ id: "x-1", identifiers: { order_number: "A-000200" } });
  const c2 = cand({ id: "x-2", identifiers: { order_number: "A-000300" } });
  const dc = decide(r, [c1, c2]);
  expectDecision("every candidate's identifier conflicts → distinct", dc, { action: "insert", verdict: "distinct", flagged: false });
  check(
    "decide: distinct: names every candidate, decided by the applier",
    dc.action === "insert" &&
      json(dc.nearDupCheck?.candidate_transaction_ids) === json(["x-1", "x-2"]) &&
      dc.nearDupCheck?.decided_by === "applier" &&
      dc.nearDupCheck.applier_version === APPLIER_VERSION,
  );

  expectDecision(
    "one conflict and one silent candidate → uncertain",
    decide(r, [c1, sameBrand({ id: "x-3" })]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
  expectDecision(
    "same merchant, same amount, no identifier on either → uncertain (legacy branch 4)",
    decide(rec((x) => (x.identifiers = {})), [sameBrand()]),
    { action: "insert", verdict: "uncertain", flagged: true },
  );
}

// Zero total.
{
  const zero = rec((x) => {
    x.facts.total_minor = 0;
    x.items = [];
  });
  const amountOnly = sameBrand({ total: 0, native_total: 0, matched_on: ["amount"] });
  const d = decide(zero, [amountOnly]);
  expectDecision("total 0: a candidate found only by amount is ignored", d, { action: "insert", verdict: "none" });
  check("decide: total 0: reported as zero_total_amount_only", d.dropped[0]?.why === "zero_total_amount_only");
  expectDecision(
    "total 0: an identifier candidate still counts",
    decide(zero, [sameBrand({ total: 0, native_total: 0, identifiers: { order_number: "A-000100" }, matched_on: ["amount", "identifier"] })]),
    { action: "attach" },
  );
}

// ── project() ──────────────────────────────────────────────────────────

function expectShape(name: string, d: ApplyDraft, want: string[]): void {
  check(`project: ${name}`, shape(d) === [...want].sort().join(" | "), shape(d));
  check(`project: ${name} — balanced per currency`, unbalancedCurrencies(d.postings).length === 0);
  check(
    `project: ${name} — base = native, no fx_rate`,
    d.postings.every((p) => p.amountBaseMinor === p.amountMinor && !("fxRate" in p)),
  );
}

{
  const d = project(rec(), FULL);
  expectShape("purchase by card", d, ["expense:Shopping 1234 USD", "liability:Credit Card -1234 USD"]);
  check("project: purchase mirror recorded", d.mirror.accountName === "Credit Card" && d.mirror.method === "card");
  check("project: header", json(d.header) === json({ payee: "Example Store", occurredOn: "2026-06-10", occurredAt: "2026-06-10T12:30:00-07:00", status: "posted" }));
  check("project: applier version", d.applierVersion === APPLIER_VERSION);
}

// The owner's tender decisions (November 2026): a debit card draws on
// Checking, a gift card or balance on Cash, a mixed tender is Credit Card
// and flagged for review.
for (const [method, account] of [
  ["cash", "asset:Cash"],
  ["gift_card", "asset:Cash"],
  ["debit_card", "asset:Checking"],
  ["check", "asset:Checking"],
  ["bank_transfer", "asset:Checking"],
  ["card", "liability:Credit Card"],
  ["mixed", "liability:Credit Card"],
  ["other", "liability:Credit Card"],
  ["unknown", "liability:Credit Card"],
] as const) {
  const d = project(rec((x) => (x.payment = { method })), FULL);
  expectShape(`mirror for ${method}`, d, ["expense:Shopping 1234 USD", `${account} -1234 USD`]);
  check(`project: mirror table says the same for ${method}`, account.endsWith(MIRROR_BY_METHOD[method]));
  check(`project: ${method} ${method === "mixed" ? "is" : "is not"} flagged for review`, (d.reviewFlag === MIXED_TENDER_REVIEW) === (method === "mixed"), String(d.reviewFlag));
}

{
  const refund = (method: string) =>
    project(
      rec((x) => {
        x.facts.flow = "refund";
        x.facts.total_minor = -1234;
        x.items = x.items.map((i: Rec) => ({ ...i, line_total_minor: -i.line_total_minor }));
        x.payment = { method };
      }),
      FULL,
    );
  expectShape("a debit card refund returns to Checking", refund("debit_card"), ["expense:Shopping -1234 USD", "asset:Checking 1234 USD"]);
  expectShape("a gift card refund returns to Cash", refund("gift_card"), ["expense:Shopping -1234 USD", "asset:Cash 1234 USD"]);
  const mixedRefund = refund("mixed");
  expectShape("a mixed refund returns to Credit Card", mixedRefund, ["expense:Shopping -1234 USD", "liability:Credit Card 1234 USD"]);
  check("project: a mixed refund is flagged too", mixedRefund.reviewFlag === MIXED_TENDER_REVIEW);
  const income = project(rec((x) => {
    x.facts.flow = "income";
    x.payment = { method: "mixed" };
  }), FULL);
  check("project: income's method books nothing, so a mixed one is not flagged", income.reviewFlag === null);
}

{
  const d = project(
    rec((x) => (x.payment = { method: "points" })),
    FULL,
  );
  expectShape("method points on a cash currency falls back to Credit Card", d, ["expense:Shopping 1234 USD", "liability:Credit Card -1234 USD"]);
  check("project: …with account_overridden", d.warnings.some((w) => w.rule === "account_overridden" && w.money === true));
}

{
  const d = project(
    rec((x) => {
      x.facts.flow = "refund";
      x.facts.total_minor = -1234;
      x.items = x.items.map((i: Rec) => ({ ...i, line_total_minor: -i.line_total_minor }));
    }),
    FULL,
  );
  expectShape("refund: the purchase pair with the total negative", d, ["expense:Shopping -1234 USD", "liability:Credit Card 1234 USD"]);
}

{
  const d = project(rec((x) => (x.facts.flow = "income")), FULL);
  expectShape("income with the defaults (Checking, Other)", d, ["asset:Checking 1234 USD", "income:Other -1234 USD"]);
  check("project: income mirror is the deposit", d.mirror.accountName === "Checking");
  const s = project(
    rec((x) => {
      x.facts.flow = "income";
      x.income = { deposit_account: "Savings", income_account: "Salary" };
    }),
    FULL,
  );
  expectShape("income to Savings from Salary", s, ["asset:Savings 1234 USD", "income:Salary -1234 USD"]);
  const c = project(
    rec((x) => {
      x.facts.flow = "income";
      x.income = { deposit_account: "Cash", income_account: "Other" };
      x.sold_item = { product_key: "example-widget", name_as_printed: "WIDGET" };
    }),
    FULL,
  );
  expectShape("income in cash", c, ["asset:Cash 1234 USD", "income:Other -1234 USD"]);
  check("project: the sold item is carried", json(c.soldItem) === json({ productKey: "example-widget", nameAsPrinted: "WIDGET" }));
}

const pointsRecord = (mut: (x: Rec) => void = () => {}) =>
  rec((x) => {
    x.facts.currency = "STAYCO_PT";
    x.facts.total_minor = 40500;
    x.payment = { method: "points" };
    x.points = { programme_name: "Stayco Rewards" };
    x.merchant.category = "Travel";
    x.items = [{ line_no: 1, raw_name: "ROOM NIGHT", line_total_minor: 40500, item_class: "service", confidence: "high" }];
    mut(x);
  });

{
  const d = project(pointsRecord(), FULL);
  expectShape("points with the programme's account", d, ["expense:Travel 40500 STAYCO_PT", "asset:Stayco Rewards points -40500 STAYCO_PT"]);
  check("project: existing points account used, none created", d.pointsAccount?.existingId === POINTS_STAYCO.id && d.pointsAccount.create === null);

  const n = project(
    pointsRecord((x) => {
      x.facts.currency = "NEWCO_PT";
      x.points = { programme_name: "Newco Miles" };
    }),
    FULL,
  );
  expectShape("points with a programme seen for the first time", n, ["expense:Travel 40500 NEWCO_PT", "asset:Newco Miles points -40500 NEWCO_PT"]);
  check(
    "project: the new points account is created under Assets",
    json(n.pointsAccount?.create) === json({ name: "Newco Miles points", currency: "NEWCO_PT", parentId: ROOT_ASSETS.id }) &&
      n.postings.some((p) => p.account.kind === "new_points"),
  );

  const pc = project(
    pointsRecord((x) => {
      x.cash_component = { amount_minor: 3000, currency: "USD" };
      x.items.push({ line_no: 2, raw_name: "RESORT FEE", line_total_minor: 3000, currency: "USD", item_class: "service", confidence: "high" });
    }),
    FULL,
  );
  expectShape("points plus cash: a second pair in the cash currency on Credit Card", pc, [
    "expense:Travel 40500 STAYCO_PT",
    "asset:Stayco Rewards points -40500 STAYCO_PT",
    "expense:Travel 3000 USD",
    "liability:Credit Card -3000 USD",
  ]);

  const pcCash = project(
    pointsRecord((x) => {
      x.payment = { method: "cash" };
      x.cash_component = { amount_minor: 3000, currency: "USD" };
    }),
    FULL,
  );
  expectShape("points plus cash paid in cash: the cash pair on Cash", pcCash, [
    "expense:Travel 40500 STAYCO_PT",
    "asset:Stayco Rewards points -40500 STAYCO_PT",
    "expense:Travel 3000 USD",
    "asset:Cash -3000 USD",
  ]);

  const pcDebit = project(
    pointsRecord((x) => {
      x.payment = { method: "debit_card", card_last4: "0000" };
      x.cash_component = { amount_minor: 3000, currency: "USD" };
    }),
    FULL,
  );
  expectShape("points plus cash on a debit card: the cash pair on Checking", pcDebit, [
    "expense:Travel 40500 STAYCO_PT",
    "asset:Stayco Rewards points -40500 STAYCO_PT",
    "expense:Travel 3000 USD",
    "asset:Checking -3000 USD",
  ]);
  check("project: …and the points still on the points account, not overridden", !pcDebit.warnings.some((w) => w.rule === "account_overridden"));

  const pcMixed = project(
    pointsRecord((x) => {
      x.payment = { method: "mixed" };
      x.cash_component = { amount_minor: 3000, currency: "USD" };
    }),
    FULL,
  );
  check("project: a mixed tender's cash part goes to Credit Card, flagged", pcMixed.reviewFlag === MIXED_TENDER_REVIEW &&
    pcMixed.postings.some((p) => p.role === "cash_mirror" && p.account.name === "Credit Card"));
  check("project: points with a mixed tender but no cash part book nothing to a card, no flag", project(pointsRecord((x) => (x.payment = { method: "mixed" })), FULL).reviewFlag === null);

  const pcRefund = project(
    pointsRecord((x) => {
      x.facts.flow = "refund";
      x.facts.total_minor = -40500;
      x.items[0].line_total_minor = -40500;
      x.cash_component = { amount_minor: 3000, currency: "USD" };
    }),
    FULL,
  );
  expectShape("points plus cash refunded: both pairs reversed", pcRefund, [
    "expense:Travel -40500 STAYCO_PT",
    "asset:Stayco Rewards points 40500 STAYCO_PT",
    "expense:Travel -3000 USD",
    "liability:Credit Card 3000 USD",
  ]);

  const pi = project(
    pointsRecord((x) => {
      x.facts.flow = "income";
    }),
    FULL,
  );
  expectShape("points income is deposited in the points account", pi, ["asset:Stayco Rewards points 40500 STAYCO_PT", "income:Other -40500 STAYCO_PT"]);
  check("project: …with account_overridden", pi.warnings.some((w) => w.rule === "account_overridden"));
}

{
  const jpy = project(
    rec((x) => {
      x.facts.currency = "JPY";
      x.facts.total_minor = 5000;
      x.items = [{ line_no: 1, raw_name: "BENTO", line_total_minor: 5000, item_class: "food_drink", confidence: "high" }];
    }),
    FULL,
  );
  expectShape("JPY: whole yen, untouched", jpy, ["expense:Shopping 5000 JPY", "liability:Credit Card -5000 JPY"]);
  const kwd = project(
    rec((x) => {
      x.facts.currency = "KWD";
      x.facts.total_minor = 1250;
      x.items = [{ line_no: 1, raw_name: "TEA", line_total_minor: 1250, item_class: "food_drink", confidence: "high" }];
    }),
    FULL,
  );
  expectShape("KWD: fils, untouched", kwd, ["expense:Shopping 1250 KWD", "liability:Credit Card -1250 KWD"]);
  const zero = project(rec((x) => ((x.facts.total_minor = 0), (x.items = []))), FULL);
  expectShape("zero total: two zero postings, as the legacy template wrote", zero, ["expense:Shopping 0 USD", "liability:Credit Card 0 USD"]);
}

function expectThrows(name: string, f: () => unknown, code: string, missingHas?: string): void {
  try {
    f();
    check(`project: ${name}`, false, "did not throw");
  } catch (e) {
    check(
      `project: ${name}`,
      e instanceof ProjectionError && e.code === code && (missingHas === undefined || e.missing.some((m) => m.includes(missingHas))),
      e instanceof Error ? e.message : String(e),
    );
  }
}

expectThrows("a missing expense account is account_missing", () => project(rec(), without((a) => a.name === "Shopping")), "account_missing", "expense Shopping");
expectThrows("a missing Credit Card is account_missing", () => project(rec(), without((a) => a.name === "Credit Card")), "account_missing", "Credit Card");
expectThrows(
  "a new points account without an Assets root is account_missing",
  () => project(pointsRecord((x) => ((x.facts.currency = "NEWCO_PT"), (x.points = { programme_name: "Newco" }))), without((a) => a.name === "Assets")),
  "account_missing",
  "Assets",
);
expectThrows(
  "a statement is not projected",
  () =>
    project(
      validateRecordOrThrow({
        contract_version: 1,
        classification: "statement_pdf",
        statement_rows: [{ occurred_on: "2026-06-01", description: "ROW", amount_minor: 100, currency: "USD", kind: "charge" }],
      }),
      FULL,
    ),
  "not_a_receipt",
);

function validateRecordOrThrow(r: Rec): ExtractionV1 {
  const out = validateExtraction(r, CTX);
  if (out.status !== "valid") throw new Error(`fixture refused: ${json(out.report.errors)}`);
  return out.record;
}

{
  // Account lookup is deterministic when a name is duplicated.
  const closedDup = acct("liability", "Credit Card", { closed: true });
  const rootDup = acct("liability", "Credit Card", { parentId: null });
  const d = project(rec(), { accounts: [closedDup, rootDup, ...FULL.accounts] });
  const cc = FULL.accounts.find((a) => a.name === "Credit Card")!;
  check(
    "project: a duplicated name picks the open child account",
    d.postings.some((p) => p.account.kind === "existing" && p.account.id === cc.id),
  );
}

{
  const d = project(rec(), FULL, { existingMerchant: { category: "Food & Drinks" } });
  check(
    "project: category_differs_from_merchant, while the record's category books",
    d.warnings.some((w) => w.rule === "category_differs_from_merchant") && shape(d).includes("expense:Shopping"),
  );
  check("project: no warning when the merchant agrees", project(rec(), FULL, { existingMerchant: { category: "Shopping" } }).warnings.length === 0);
}

{
  const d = project(rec(), FULL);
  check("project: items carry exactly the 27 ITEM_SCHEMA keys", d.items.every((i) => Object.keys(i).length === 27 && !("track_as_owned" in i)));
  check("project: item currency and line_type defaulted", d.items.every((i) => i.currency === "USD" && i.line_type === "product"));
  check("project: items are written as the record prompt's version, run 1", d.itemsWrite.extractionVersion === RECORD_PROMPT_VERSION && d.itemsWrite.run === 1);
  check("project: merchant brand named after the brand, no domain", json(d.merchantBrand) === json({ brandId: "example-store", name: "Example Store", domain: null }));
}

{
  const d = project(
    rec((x) => {
      x.items = [
        { line_no: 1, raw_name: "LAPTOP", line_total_minor: 900, item_class: "durable", confidence: "high", product_key: "example-laptop", quantity: 2, track_as_owned: true },
        { line_no: 2, raw_name: "CABLE", line_total_minor: 100, item_class: "durable", confidence: "high", product_key: "example-cable", track_as_owned: true },
        { line_no: 3, raw_name: "SOAP", line_total_minor: 100, item_class: "consumable", confidence: "high", product_key: "example-soap", track_as_owned: true },
        { line_no: 4, raw_name: "WARRANTY", line_total_minor: 100, line_type: "service_fee", item_class: "durable", confidence: "high", product_key: "example-plan", track_as_owned: true },
        { line_no: 5, raw_name: "HALF", line_total_minor: 34, item_class: "durable", confidence: "high", product_key: "example-half", quantity: 0.4, track_as_owned: true },
      ];
    }),
    FULL,
  );
  check(
    "project: owned items — durable product lines, one instance per unit (2 + 1 + 0)",
    json(d.owned.lineNos) === json([1, 2, 5]) && d.owned.instanceCount === 3 && d.owned.acquiredOn === "2026-06-10",
    json(d.owned),
  );
  check("project: a consumable and a non-product line are skipped with a warning", d.warnings.filter((w) => w.rule === "owned_items_skipped").length === 2);
  const refund = project(
    rec((x) => {
      x.facts.flow = "refund";
      x.facts.total_minor = -900;
      x.items = [{ line_no: 1, raw_name: "LAPTOP", line_total_minor: -900, item_class: "durable", confidence: "high", product_key: "example-laptop", track_as_owned: true }];
    }),
    FULL,
  );
  check("project: a refund adds no owned item", refund.owned.instanceCount === 0 && refund.warnings.some((w) => w.rule === "owned_items_skipped"));

  const durable = (line_no: number, quantity: number) => ({
    line_no,
    raw_name: `THING ${line_no}`,
    line_total_minor: 1,
    item_class: "durable",
    confidence: "high",
    product_key: `example-thing-${line_no}`,
    quantity,
    track_as_owned: true,
  });
  const flood = project(rec((x) => (x.items = [durable(1, 300000), durable(2, 3)])), FULL);
  check(
    "project: a line over the per-line owned cap is not tracked, with a warning",
    json(flood.owned.lineNos) === json([2]) &&
      flood.owned.instanceCount === 3 &&
      flood.warnings.some((w) => w.rule === "owned_items_skipped" && w.path === "items[0].track_as_owned"),
    json(flood.owned),
  );
  const many = project(rec((x) => (x.items = [1, 2, 3, 4, 5, 6].map((n) => durable(n, 100)))), FULL);
  check(
    "project: lines past the per-receipt owned cap are not tracked",
    json(many.owned.lineNos) === json([1, 2, 3, 4, 5]) && many.owned.instanceCount === 500,
    json(many.owned),
  );
}

{
  const d = project(
    rec((x) => {
      x.parties = [
        { role: "seller", display_name: "Example Seller" },
        { role: "maker", display_name: "Example Maker", brand_id: "example-maker", line_no: 1 },
        { role: "maker", display_name: "Example Maker", brand_id: "example-maker", line_no: 1 },
      ];
      x.place = { google_place_id: "ChIJexample000001", resolved_via: "geocode_address", address_printed: "1 Example Way" };
      x.merchant.name_zh_printed = "示例商店";
    }),
    FULL,
  );
  check(
    "project: parties — the channel the validator added, the seller, one maker row",
    json(d.parties.map((p) => [p.role, p.lineNo])) === json([["channel", null], ["seller", null], ["maker", 1]]),
    json(d.parties),
  );
  check(
    "project: place carried with the printed Chinese name",
    d.place?.googlePlaceId === "ChIJexample000001" && d.place.nameZhPrinted === "示例商店" && d.place.resolvedVia === "geocode_address",
  );
  check("project: no place when none was resolved", project(rec((x) => (x.place = { google_place_id: null, resolved_via: "none" })), FULL).place === null);
  check("project: no sold item outside income", d.soldItem === null);
}

check(
  "project: unbalancedCurrencies finds a currency that does not sum to 0",
  json(unbalancedCurrencies([{ amountMinor: 5, currency: "USD" }, { amountMinor: -5, currency: "USD" }, { amountMinor: 1, currency: "EUR" }])) === json(["EUR"]),
);

// ── metadata ───────────────────────────────────────────────────────────

const RUN: MetadataRunContext = {
  ingestId: "i-1",
  runId: "run-1",
  sessionId: "s-1",
  extractionId: "x-1",
  promptGitSha: "0000000000000000000000000000000000000000",
  modelObserved: "model-observed",
  modelRequested: "model-requested",
  ranAt: "2026-06-15T12:00:01.000Z",
};

{
  const r = rec((x) => {
    x.printed_totals = { subtotal_minor: 1100, tax_minor: 134, tip_minor: null };
    x.receipt_facts = { table_number: "7" };
    x.other_references = { store_number: "12" };
    x.merchant.category_hint = "retail";
  });
  const d = project(r, FULL);
  const m = buildTransactionMetadata(r, d, RUN);
  const keys = Object.keys(m);
  check("metadata: every key is in the fixed set", keys.every((k) => (APPLIER_METADATA_KEYS as readonly string[]).includes(k)), keys.join(","));
  check("metadata: no items key", !("items" in m));
  const ex = m.extraction as Record<string, unknown>;
  check("metadata: extraction stamp has exactly its keys", json(Object.keys(ex)) === json(EXTRACTION_STAMP_KEYS), json(Object.keys(ex)));
  check(
    "metadata: extraction stamp values",
    ex.prompt_version === RECORD_PROMPT_VERSION &&
      ex.writer === "server_apply" &&
      ex.applier_version === APPLIER_VERSION &&
      ex.contract_version === 1 &&
      ex.model === "model-observed" &&
      ex.model_requested === "model-requested" &&
      ex.run_id === "run-1" &&
      ex.extraction_id === "x-1" &&
      ex.source === "ingest",
    json(ex),
  );
  check(
    "metadata: header keys",
    m.source === "ingest" && m.source_ingest_id === "i-1" && m.classification === "receipt_image" && m.flow === "purchase" && m.category_hint === "retail",
  );
  check("metadata: merchant block", json(m.merchant) === json({ canonical_name: "Example Store", brand_id: "example-store", category: "Shopping" }));
  check("metadata: identifiers at the top level", m.order_number === "A-000100" && !("confirmation_number" in m));
  check(
    "metadata: card and payment strings, mirror account",
    m.card_last4 === "0000" && m.payment === "Visa ****0000" && m.payment_method === "Visa ****0000" && m.mirror_account === "Credit Card",
    json([m.card_last4, m.payment, m.payment_method, m.mirror_account]),
  );
  check(
    "metadata: tax_minor and printed totals without nulls",
    m.tax_minor === 134 && json(m.printed_totals) === json({ subtotal_minor: 1100, tax_minor: 134 }),
  );
  check("metadata: the two bags", json(m.receipt_facts) === json({ table_number: "7" }) && json(m.other_references) === json({ store_number: "12" }));
  const oa = m.ocr_audit as Record<string, unknown>;
  check("metadata: ocr_audit with the printed payee and its source", oa.payee_as_printed === "EXAMPLE STORE #12" && oa.payee_source === "printed" && oa.year_sanity_ok === true);
  check("metadata: no allocation_audit when the lines meet the total", !("allocation_audit" in m));
  check("metadata: no dedup keys without a decision", !("near_dup_check" in m) && !("refund_of" in m));
  check(
    "metadata: the keys this change introduces are server-owned",
    (["mirror_account", "printed_totals", "extraction", "allocation_audit", "ocr_audit", "near_dup_check"] as const).every((k) =>
      (SERVER_OWNED_TX_METADATA_KEYS as readonly string[]).includes(k),
    ),
  );
}

{
  const r = rec((x) => {
    x.items[0].line_total_minor = 990;
    x.payment = { method: "cash" };
  });
  const m = buildTransactionMetadata(r, project(r, FULL), { ...RUN, modelObserved: "cli-default" });
  check(
    "metadata: allocation_audit when the lines miss the total",
    json(m.allocation_audit) === json({ currency: "USD", items_effective_sum_minor: 1224, total_minor: 1234, residual_minor: -10 }),
    json(m.allocation_audit),
  );
  check("metadata: a cash payment's cell and mirror", m.payment_method === "Cash" && m.mirror_account === "Cash" && !("payment" in m));
  check("metadata: cli-default is never the model", (m.extraction as Record<string, unknown>).model === "model-requested");
  const u = rec((x) => (x.payment = { method: "unknown" }));
  check("metadata: an unknown method with nothing printed leaves the cell empty", !("payment_method" in buildTransactionMetadata(u, project(u, FULL), RUN)));
  const tipped = rec((x) => (x.printed_totals = { subtotal_minor: 1000, tip_minor: 234 }));
  const mt = buildTransactionMetadata(tipped, project(tipped, FULL), RUN);
  check("metadata: tip_minor at the top level (the UI's Tip cell), no tax_minor without a tax", mt.tip_minor === 234 && !("tax_minor" in mt));
}

{
  const r = rec();
  const d = decide(r, [sameBrand({ identifiers: { order_number: "A-000200" } })]);
  const nd = d.action === "insert" ? d.nearDupCheck : null;
  const m = buildTransactionMetadata(r, project(r, FULL), RUN, { refundOf: "p-1", nearDupCheck: nd });
  check("metadata: near_dup_check and refund_of from the decision", json(m.near_dup_check) === json(nd) && m.refund_of === "p-1");
}

// The tenders' cells, and a mixed tender's review flag in near_dup_check:
// the review queue lists `flagged_for_review`, reconcile reads only the
// verdict about the candidates the check names.
{
  const debit = rec((x) => (x.payment = { method: "debit_card" }));
  const md = buildTransactionMetadata(debit, project(debit, FULL), RUN);
  check("metadata: a debit card's cell and mirror", md.payment_method === "Debit card" && md.mirror_account === "Checking", json([md.payment_method, md.mirror_account]));
  const gift = rec((x) => (x.payment = { method: "gift_card", as_printed: "GIFT CARD" }));
  const mg = buildTransactionMetadata(gift, project(gift, FULL), RUN);
  check("metadata: a gift card's printed tender and mirror", mg.payment_method === "GIFT CARD" && mg.mirror_account === "Cash", json([mg.payment_method, mg.mirror_account]));

  const mixed = rec((x) => (x.payment = { method: "mixed" }));
  const alone = buildTransactionMetadata(mixed, project(mixed, FULL), RUN).near_dup_check as Record<string, unknown>;
  check(
    "metadata: a mixed tender with no candidate is flagged, naming nobody",
    alone?.flagged_for_review === true && alone.verdict === "uncertain" && json(alone.candidate_transaction_ids) === "[]" &&
      !("candidate_transaction_id" in alone) && alone.reason === MIXED_TENDER_REVIEW && alone.decided_by === "applier",
    json(alone),
  );
  const distinct = decide(mixed, [sameBrand({ identifiers: { order_number: "A-000200" } }), sameBrand({ id: "c-2", identifiers: { order_number: "A-000300" } })]);
  const nd = distinct.action === "insert" ? distinct.nearDupCheck : null;
  const both = buildTransactionMetadata(mixed, project(mixed, FULL), RUN, { refundOf: null, nearDupCheck: nd }).near_dup_check as Record<string, unknown>;
  check(
    "metadata: a mixed tender flags a distinct check and keeps its verdict and candidates",
    nd?.verdict === "distinct" && nd.flagged_for_review === false && both.verdict === "distinct" && both.flagged_for_review === true &&
      json(both.candidate_transaction_ids) === json(nd.candidate_transaction_ids) && both.reason === `${MIXED_TENDER_REVIEW}; ${nd.reason}`,
    json(both),
  );
  const card = rec();
  const cardDecision = decide(card, [sameBrand({ identifiers: { order_number: "A-000200" } })]);
  const cardNd = cardDecision.action === "insert" ? cardDecision.nearDupCheck : null;
  check(
    "metadata: a single tender leaves the decision's check as it is",
    json(buildTransactionMetadata(card, project(card, FULL), RUN, { refundOf: null, nearDupCheck: cardNd }).near_dup_check) === json(cardNd),
  );
}

// ── fingerprint ────────────────────────────────────────────────────────

{
  const r = rec();
  const d = project(r, FULL);
  const a = fingerprintFromDraft(r, d, { ocrTextPresent: true });
  const shuffled: ApplyDraft = {
    ...d,
    postings: [...d.postings].reverse(),
    items: [...d.items].reverse(),
    header: { ...d.header, occurredAt: "2026-06-10T19:30:00Z" },
  };
  const b = fingerprintFromDraft(r, shuffled, { ocrTextPresent: true });
  check("fingerprint: independent of list order and of the offset an instant is written in", a.sha256 === b.sha256, json(diffFingerprints(a, b)));
  const c = fingerprint({ ...a.fields, postings: a.fields.postings.map((p) => ({ ...p, amount_minor: p.amount_minor * 2 })) });
  check("fingerprint: an amount change shows, and is named", a.sha256 !== c.sha256 && json(diffFingerprints(a, c)) === json(["postings"]));
  check("fingerprint: the card is read as the ledger reads it", a.fields.card_last4 === "0000");
}

// ── Result ─────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`check-apply-decide: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`check-apply-decide: ${checks} checks passed`);
