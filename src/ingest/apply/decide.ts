/**
 * Attach or insert: the duplicate decision for one receipt record, made in
 * code (wave 1, plan §7). Pure: it reads only the record and the
 * candidates `candidates.ts` found under the workspace apply lock.
 *
 * The legacy agent made this call itself (prompt Phase 4a.0) from a Turn
 * A read that gave it payee, date and the five identifiers. Code sees
 * those, plus card last-4, the time and the line items, and reaches the
 * same answer every time. The rules, in order:
 *
 *   0. DIRECTION GATE. A candidate whose money moved the other way is
 *      dropped: its `metadata.flow`, else its legs (an income leg is
 *      income, an expense leg negative is a refund, positive or zero a
 *      purchase), and `flowsDisagree` from `src/reconcile/dedup.ts` as the
 *      second line, as reconcile uses it. A candidate whose direction
 *      cannot be read (legs of both kinds, or neither) is dropped too:
 *      attaching across directions loses a money event. A refund whose
 *      dropped candidates include exactly one purchase sharing an
 *      identifier value names it in `refund_of`; several such purchases
 *      give `refund_of_dropped` instead.
 *      Also dropped: a candidate found only by amount when the total is 0
 *      (#205; `candidates.ts` does not look, this keeps the rule if a
 *      caller passes one anyway).
 *   1. NO CANDIDATE LEFT: insert. `near_dup_check` is still written when
 *      a perceptually similar document existed (verdict `distinct`: it was
 *      dropped by the direction gate).
 *   2. STRONG MATCH. `strong(c)` needs all three of
 *        - the same merchant: equal `brand_id` (through the merchant row),
 *          or equal normalised payee, or equal normalised
 *          `metadata.merchant.canonical_name`;
 *        - no identifier conflict: no shared key carries different values;
 *        - one tiebreaker: an identifier match (the same value under the
 *          same key, or the same value of 6 or more characters under two
 *          different keys) with the same total in the record's currency
 *          and no conflicting card last-4, or the hard tuple (both card
 *          last-4 present and equal, both times present and equal to the
 *          minute, equal total, equal multisets of line totals with items
 *          on both).
 *      Exactly one strong candidate: attach to it. More than one: insert,
 *      `uncertain`, flagged ("several candidates match").
 *
 *      An identifier alone never attaches. The plan let a match outweigh a
 *      conflict and took any total; both lose money. An order number is
 *      shared by every partial refund and split shipment of the order, and
 *      a subscription's id by every month of it, so the second refund, the
 *      second charge or next month's invoice would be filed as evidence for
 *      the first and never booked. A different total, a different card, or
 *      a key that disagrees (a second invoice or approval code on the same
 *      order) is what tells those apart, so each one blocks the attach and
 *      leaves the record to rule 3 or 4: inserted, and flagged when a
 *      person must look. This is reconcile's own line (`scorePair` in
 *      `src/reconcile/dedup.ts` folds only equal totals, and a conflicting
 *      key or card sends a pair to review).
 *   3. EVERY REMAINING CANDIDATE HAS AN IDENTIFIER CONFLICT: insert,
 *      `distinct`, naming them.
 *   4. OTHERWISE: insert, `uncertain`, `flagged_for_review` (the legacy
 *      branch 4). A flagged pair is recoverable; a wrong attach loses a
 *      purchase.
 *
 * Not in applier 1.0, each a measured `APPLIER_VERSION` bump later: a
 * "different time of day means distinct" rule, brand matching by name or
 * domain, category reuse.
 */
import type { ValidationWarning } from "../contract/validate.js";
import type { ExtractionV1, Flow } from "../contract/v1.js";
import {
  IDENTIFIER_KEYS,
  cardLast4,
  compareIdentifiers,
  flowsDisagree,
  type DedupSide,
  type IdentifierKey,
} from "../../reconcile/dedup.js";
import { APPLIER_VERSION } from "./version.js";

/** How a candidate was found (§7 a–c). */
export type CandidateSource = "amount" | "identifier" | "phash";

/** One live transaction near the record, as `candidates.ts` reads it. */
export interface ApplyCandidate extends DedupSide {
  occurred_at: string | null;
  /** `merchants.brand_id` of the candidate's merchant row. */
  merchant_brand_id: string | null;
  /** `metadata.merchant.canonical_name`. */
  merchant_canonical_name: string | null;
  /** `directionLateral`: the class of its P&L legs and their signed total
   *  in base minor units. */
  pl_class: string;
  total: number;
  /** The same signed P&L sum in native minor units of the record's
   *  currency, or null when it has no P&L leg in that currency. */
  native_total: number | null;
  /** `line_total_minor` of its live line items. */
  item_totals: number[];
  matched_on: CandidateSource[];
  /** Days between its `occurred_on` and the record's. */
  date_distance: number;
}

export interface DroppedCandidate {
  id: string;
  why: "direction" | "direction_unknown" | "zero_total_amount_only";
  /** The candidate's direction, when it could be read. */
  flow: Flow | null;
}

export interface CandidateVerdict {
  id: string;
  sameMerchant: "brand_id" | "payee" | "canonical_name" | null;
  identifierMatches: string[];
  identifierConflicts: IdentifierKey[];
  /** Its P&L total in the record's currency equals the record's total. */
  sameTotal: boolean;
  /** Both sides carry a card last-4, and they differ. */
  cardConflict: boolean;
  hardTuple: boolean;
  strong: boolean;
}

/** `metadata.near_dup_check` as the applier writes it (§6.4). Without a
 *  candidate (`flagForReview` on a row nothing resembles) the list is
 *  empty and `candidate_transaction_id` absent. */
export interface NearDupCheck {
  candidate_transaction_id?: string;
  candidate_transaction_ids: string[];
  verdict: "distinct" | "uncertain";
  flagged_for_review: boolean;
  reason: string;
  decided_by: "applier";
  applier_version: string;
}

interface DecisionBase {
  applierVersion: string;
  /** Candidates that passed the gate, nearest first, with what was found. */
  considered: CandidateVerdict[];
  dropped: DroppedCandidate[];
  reason: string;
  warnings: ValidationWarning[];
}

export type ApplyDecision =
  | (DecisionBase & {
      action: "attach";
      targetId: string;
      tiebreaker: "identifier" | "hard_tuple";
    })
  | (DecisionBase & {
      action: "insert";
      /** `none` when no candidate was left to compare. */
      verdict: "none" | "distinct" | "uncertain";
      flaggedForReview: boolean;
      refundOf: string | null;
      /** What goes in `metadata.near_dup_check`, or null. */
      nearDupCheck: NearDupCheck | null;
    });

/**
 * The duplicate check with a review flag added for a reason that is not
 * about duplicates (a mixed tender, `project.ts`). `flagged_for_review` is
 * what the review queue lists (`GET /v1/transactions?flagged=near_dup`)
 * and what its dismiss clears, so a row a person must look at for any
 * reason carries it there. A check that already exists keeps its verdict
 * and candidates (reconcile reads those, and a flag says nothing about
 * them) and gains the reason after its own; with no check, the flag names
 * no candidate, so reconcile finds no verdict about any pair in it.
 */
export function flagForReview(check: NearDupCheck | null, reason: string): NearDupCheck {
  if (check) return { ...check, flagged_for_review: true, reason: `${check.reason}; ${reason}` };
  return {
    candidate_transaction_ids: [],
    verdict: "uncertain",
    flagged_for_review: true,
    reason,
    decided_by: "applier",
    applier_version: APPLIER_VERSION,
  };
}

/** Identifier values shorter than this match only under the same key. */
export const CROSS_KEY_MIN_LENGTH = 6;

/** Case, width and spacing folded: how payees and merchant names compare. */
export function normaliseName(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const n = s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return n === "" ? null : n;
}

/** The direction a candidate's own metadata or legs give it. */
export function candidateFlow(c: Pick<ApplyCandidate, "flow" | "pl_class" | "total">): Flow | null {
  const f = typeof c.flow === "string" ? c.flow.trim() : "";
  if (f === "purchase" || f === "refund" || f === "income") return f;
  if (c.pl_class === "income") return "income";
  if (c.pl_class === "expense") return c.total < 0 ? "refund" : "purchase";
  return null;
}

function recordSide(record: ExtractionV1): DedupSide {
  return {
    id: "",
    occurred_on: record.facts!.occurred_on,
    payee: record.facts!.payee,
    merchant_id: null,
    status: "posted",
    payment: null,
    card_last4: record.payment.card_last4 ?? null,
    flow: record.facts!.flow,
    refund_of: null,
    near_dup_check: null,
    identifiers: record.identifiers,
  };
}

/** Identifier matches between the record and a candidate: `key` for the
 *  same key, `key~other` for the same long value under different keys. */
function identifierMatches(rec: DedupSide, c: DedupSide): { matches: string[]; conflicts: IdentifierKey[] } {
  const { matches, conflicts } = compareIdentifiers(rec, c);
  const out: string[] = [...matches];
  for (const a of IDENTIFIER_KEYS) {
    const av = rec.identifiers[a]?.trim();
    if (!av || av.length < CROSS_KEY_MIN_LENGTH) continue;
    for (const b of IDENTIFIER_KEYS) {
      if (a === b) continue;
      if (c.identifiers[b]?.trim() === av) out.push(`${a}~${b}`);
    }
  }
  return { matches: out, conflicts };
}

/** Whether two instants are the same to the minute. */
function sameMinute(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.floor(ta / 60_000) === Math.floor(tb / 60_000);
}

function sameMultiset(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

function judge(record: ExtractionV1, rec: DedupSide, c: ApplyCandidate): CandidateVerdict {
  const merchant = record.merchant!;
  const facts = record.facts!;
  let sameMerchant: CandidateVerdict["sameMerchant"] = null;
  if (c.merchant_brand_id !== null && c.merchant_brand_id === merchant.brand_id) sameMerchant = "brand_id";
  else if (normaliseName(facts.payee) !== null && normaliseName(facts.payee) === normaliseName(c.payee)) sameMerchant = "payee";
  else if (
    normaliseName(merchant.canonical_name) !== null &&
    normaliseName(merchant.canonical_name) === normaliseName(c.merchant_canonical_name)
  ) {
    sameMerchant = "canonical_name";
  }

  const ids = identifierMatches(rec, c);
  const noConflict = ids.conflicts.length === 0;

  const recCard = cardLast4(rec);
  const candCard = cardLast4(c);
  const cardConflict = recCard !== null && candCard !== null && recCard !== candCard;
  const sameTotal = c.native_total !== null && c.native_total === facts.total_minor;
  const recItems = record.items.map((it) => it.line_total_minor);
  const hardTuple =
    recCard !== null &&
    recCard === candCard &&
    facts.occurred_at != null &&
    c.occurred_at !== null &&
    sameMinute(facts.occurred_at, c.occurred_at) &&
    sameTotal &&
    recItems.length > 0 &&
    c.item_totals.length > 0 &&
    sameMultiset(recItems, c.item_totals);
  const identifierTiebreak = ids.matches.length > 0 && sameTotal && !cardConflict;

  return {
    id: c.id,
    sameMerchant,
    identifierMatches: ids.matches,
    identifierConflicts: ids.conflicts,
    sameTotal,
    cardConflict,
    hardTuple,
    strong: sameMerchant !== null && noConflict && (identifierTiebreak || hardTuple),
  };
}

const hasConflict = (v: CandidateVerdict) => v.identifierConflicts.length > 0 && v.identifierMatches.length === 0;

/**
 * §7 for one valid receipt record. Candidates are expected nearest first
 * (`candidates.ts` orders them); the decision does not depend on their
 * order except for which id `near_dup_check.candidate_transaction_id`
 * names first.
 */
export function decide(record: ExtractionV1, candidates: readonly ApplyCandidate[]): ApplyDecision {
  if (!record.facts || !record.merchant) {
    throw new Error("decide: only a receipt record has a duplicate decision");
  }
  const flow = record.facts.flow;
  const rec = recordSide(record);
  const warnings: ValidationWarning[] = [];
  const base = { applierVersion: APPLIER_VERSION, warnings };

  // 0. Direction gate.
  const kept: ApplyCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  const droppedRows: ApplyCandidate[] = [];
  for (const c of candidates) {
    const cFlow = candidateFlow(c);
    if (record.facts.total_minor === 0 && c.matched_on.every((m) => m === "amount")) {
      dropped.push({ id: c.id, why: "zero_total_amount_only", flow: cFlow });
      continue;
    }
    if (cFlow === null) {
      dropped.push({ id: c.id, why: "direction_unknown", flow: null });
      droppedRows.push(c);
      continue;
    }
    if (cFlow !== flow || flowsDisagree({ id: "", flow, refund_of: null }, c, { plClass: c.pl_class, total: c.total })) {
      dropped.push({ id: c.id, why: "direction", flow: cFlow });
      droppedRows.push(c);
      continue;
    }
    kept.push(c);
  }

  let refundOf: string | null = null;
  if (flow === "refund") {
    const purchases = droppedRows.filter(
      (c) => candidateFlow(c) === "purchase" && identifierMatches(rec, c).matches.length > 0,
    );
    if (purchases.length === 1) refundOf = purchases[0]!.id;
    else if (purchases.length > 1) {
      warnings.push({
        rule: "refund_of_dropped",
        path: "facts.flow",
        message: `${purchases.length} purchases share an identifier with this refund; refund_of was left out`,
      });
    }
  }

  const nearDup = (
    ids: string[],
    verdict: NearDupCheck["verdict"],
    flagged: boolean,
    reason: string,
  ): NearDupCheck => ({
    candidate_transaction_id: ids[0]!,
    candidate_transaction_ids: ids,
    verdict,
    flagged_for_review: flagged,
    reason,
    decided_by: "applier",
    applier_version: APPLIER_VERSION,
  });

  // 1. No candidate left.
  if (kept.length === 0) {
    const phash = droppedRows.filter((c) => c.matched_on.includes("phash")).map((c) => c.id);
    const reason =
      phash.length > 0
        ? "perceptually similar documents belong to transactions that moved money the other way"
        : "no live transaction matches by amount, identifier or image";
    return {
      ...base,
      action: "insert",
      verdict: "none",
      flaggedForReview: false,
      refundOf,
      considered: [],
      dropped,
      reason,
      nearDupCheck: phash.length > 0 ? nearDup(phash, "distinct", false, reason) : null,
    };
  }

  const verdicts = kept.map((c) => judge(record, rec, c));
  const ids = verdicts.map((v) => v.id);
  const strong = verdicts.filter((v) => v.strong);

  // 2. Strong match.
  if (strong.length === 1) {
    const v = strong[0]!;
    const tiebreaker = v.identifierMatches.length > 0 && v.sameTotal && !v.cardConflict ? "identifier" : "hard_tuple";
    const evidence =
      tiebreaker === "identifier"
        ? `identifier match (${v.identifierMatches.join(", ")})`
        : "card last-4, time to the minute, total and line totals all equal";
    return {
      ...base,
      action: "attach",
      targetId: v.id,
      tiebreaker,
      considered: verdicts,
      dropped,
      reason: `same merchant (${v.sameMerchant}) and ${evidence}`,
    };
  }
  if (strong.length > 1) {
    const reason = "several candidates match";
    return {
      ...base,
      action: "insert",
      verdict: "uncertain",
      flaggedForReview: true,
      refundOf,
      considered: verdicts,
      dropped,
      reason,
      // Every candidate compared is named, as in rule 4: reconcile reads
      // an open `uncertain` naming a pair as "a person must look".
      nearDupCheck: nearDup(ids, "uncertain", true, reason),
    };
  }

  // 3. Every remaining candidate has an identifier conflict.
  if (verdicts.every(hasConflict)) {
    const keys = [...new Set(verdicts.flatMap((v) => v.identifierConflicts))];
    const reason = `printed identifiers differ from every candidate (${keys.join(", ")})`;
    return {
      ...base,
      action: "insert",
      verdict: "distinct",
      flaggedForReview: false,
      refundOf,
      considered: verdicts,
      dropped,
      reason,
      nearDupCheck: nearDup(ids, "distinct", false, reason),
    };
  }

  // 4. Otherwise. An identifier that matches where the total, the card or
  // another key does not is said so: it is the partial refund, the split
  // charge or the next invoice of one order, which a person tells apart.
  const blocked = verdicts.find(
    (v) => v.sameMerchant !== null && v.identifierMatches.length > 0 && (!v.sameTotal || v.cardConflict || v.identifierConflicts.length > 0),
  );
  const differing = blocked
    ? [...(!blocked.sameTotal ? ["the total"] : []), ...(blocked.cardConflict ? ["the card"] : []), ...blocked.identifierConflicts]
    : [];
  const reason = blocked
    ? `an identifier matches (${blocked.identifierMatches.join(", ")}) but ${differing.join(", ")} ${differing.length === 1 ? "differs" : "differ"}`
    : "a candidate matches without a strong tiebreaker";
  return {
    ...base,
    action: "insert",
    verdict: "uncertain",
    flaggedForReview: true,
    refundOf,
    considered: verdicts,
    dropped,
    reason,
    nearDupCheck: nearDup(ids, "uncertain", true, reason),
  };
}
