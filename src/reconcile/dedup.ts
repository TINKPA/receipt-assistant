/**
 * Dedup detection for the reconcile engine: SQL candidate generation
 * plus a deterministic scoring function. No model calls, no writes.
 *
 * What a batch's reconcile looks for
 * ----------------------------------
 * Two transactions that describe ONE money event. A transaction written
 * by this batch (`source_ingest_id` in the batch) is compared with:
 *
 *   in-batch pass     another row of the same batch with the same total
 *                     that either shares the day and the party (payee
 *                     compared case-insensitively, or the same
 *                     merchant), or shares a printed identifier within
 *                     ±3 days
 *   cross-batch pass  any row outside the batch with the same total and
 *                     an `occurred_on` within ±3 days (settlement drift,
 *                     a receipt filed late against a row already there)
 *
 * The in-batch pass used to demand the exact payee string and the exact
 * day. Two extractions of one receipt that landed in the same batch as
 * `Acme` and `Acme.com`, or a day apart, were then invisible to both
 * passes even with the same order number — while the same two rows in
 * different batches were found.
 *
 * The NEWER row of a pair (by `created_at`) is the duplicate and the
 * older one survives. That is usually the batch row, but a batch row
 * ingested before the row it matches is the survivor instead. One
 * exception: a `reconciled` row has been matched to a bank line and is
 * never the duplicate, so when only the newer row is reconciled the
 * older one is proposed for removal instead. Two reconciled rows are two
 * bank lines, hence two money events, and are not paired at all.
 *
 * What makes a pair safe to act on
 * --------------------------------
 * Every rule below exists because the opposite deleted or would delete
 * a real money event.
 *
 *   Live on both sides. Both sides are read through
 *     `ledger_live_transactions`, so a soft-deleted row is neither a
 *     duplicate nor a survivor. Reading `transactions` with a status
 *     filter is how a re-shot receipt came to be deleted in favour of
 *     the row the user had just removed.
 *
 *   Direction gate. The total is the expense/income leg picked by
 *     ACCOUNT TYPE and compared SIGNED (#221): a refund keys negative and
 *     a purchase positive, so they never share a total. Picking the leg
 *     by sign (`GREATEST(amount, 0)`) made a refund total the same as the
 *     purchase it reverses, and a refund normally reprints the purchase's
 *     order number — together an "exact identifier match" that
 *     auto-deleted the refund.
 *     The sign alone is not the whole direction: money coming back that
 *     was booked through an INCOME account (credit, so it keys positive)
 *     has the same signed total as the purchase it reverses. So each row
 *     also carries the CLASS of its legs — expense, income, both, or
 *     neither (a transfer, keyed on its gross amount) — and only rows of
 *     the same class are paired.
 *     `metadata.flow` and `metadata.refund_of` are checked as well, for
 *     rows whose legs were booked the wrong way round: two different
 *     flows never pair, and neither does a row marked `refund` with a
 *     row that says nothing when the legs on both read as money going
 *     out (see `flowsDisagree`).
 *
 *   The identifier contract. All five keys of the #204 contract are
 *     read. The same key carrying the same value on both sides is an
 *     identifier match; the same key carrying different values is a
 *     conflict, and a pair with conflicts and no match is two purchases.
 *
 *   The agent's verdict. A row whose `metadata.near_dup_check` names the
 *     other row with verdict `distinct` (or `uncertain`, since dismissed
 *     by a person) has already been judged with the document in view.
 *     Reconcile sees less than the agent did and does not re-raise it.
 *
 *   Recurring charges. When the batch row has two or more other live
 *     rows of the same total at the same merchant inside the window, the
 *     ledger itself shows that this merchant charges this amount
 *     repeatedly (scooter rides, transit fares, a daily coffee). An equal
 *     amount is then no evidence at all, and a pair with no identifier
 *     match is dropped instead of being proposed once per neighbour.
 *
 *   One proposal per row. Each batch row keeps its single best partner
 *     (identifier match first, then score, then the oldest), and each
 *     duplicate is named once per run.
 *
 * Score
 * -----
 * 1.0 needs an identifier match with no conflict, the same payee or
 * merchant, no card conflict and no open "uncertain" flag from the
 * agent. Everything else is capped at 0.9, below the default auto-apply
 * threshold, so it waits for a person: equal amount, date and merchant
 * is also what two coffees look like.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";

/** The closed identifier contract of the extraction prompt (#204). */
export const IDENTIFIER_KEYS = [
  "order_number",
  "confirmation_number",
  "invoice_number",
  "payment_id",
  "approval_code",
] as const;
export type IdentifierKey = (typeof IDENTIFIER_KEYS)[number];

export type DedupPass = "in_batch" | "cross_batch";

/** Days either side of `occurred_on` the cross-batch pass looks. */
export const NEAR_WINDOW_DAYS = 3;
/** Candidates kept per batch row before scoring (best first). */
const CANDIDATES_PER_ROW = 25;
/** Other same-merchant, same-total rows in the window that make a
 *  charge "recurring" (see the header). */
const RECURRING_MIN_OTHERS = 2;
/** Score ceiling for a pair without a clean identifier match. */
export const REVIEW_SCORE_CAP = 0.9;

export interface DedupPair {
  pass: DedupPass;
  /** The NEWER transaction, proposed for removal. */
  duplicate_id: string;
  /** The OLDER transaction, kept. */
  canonical_id: string;
  score: number;
  /** True when the pair is an identifier match eligible for auto-apply. */
  strong: boolean;
  reasons: string[];
  /** `occurred_on` / `payee` describe `duplicate_id`; the `canonical_*`
   *  pair describes `canonical_id`. */
  occurred_on: string;
  canonical_occurred_on: string;
  payee: string | null;
  canonical_payee: string | null;
  /** Signed expense/income total shared by both sides (see header). */
  total_base_minor: number;
}

/** One side of a candidate pair, as the SQL below emits it. */
export interface DedupSide {
  id: string;
  occurred_on: string;
  payee: string | null;
  merchant_id: string | null;
  /** `posted` or `reconciled` (both sides are live). */
  status: string;
  payment: string | null;
  flow: string | null;
  refund_of: string | null;
  near_dup_check: unknown;
  identifiers: Partial<Record<IdentifierKey, string | null>>;
}

// ── Pure scoring ──────────────────────────────────────────────────────

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Extract a card last-4 from the agent's metadata.payment string
 *  (e.g. "Visa ****7846 (Contactless)" / "Visa xxxxxxxx7846"). */
function cardLast4(payment: string | null): string | null {
  if (!payment) return null;
  const m = payment.match(/(\d{4})(?!.*\d)/);
  return m ? m[1]! : null;
}

export function compareIdentifiers(
  a: DedupSide,
  b: DedupSide,
): { matches: IdentifierKey[]; conflicts: IdentifierKey[] } {
  const matches: IdentifierKey[] = [];
  const conflicts: IdentifierKey[] = [];
  for (const key of IDENTIFIER_KEYS) {
    const av = clean(a.identifiers?.[key]);
    const bv = clean(b.identifiers?.[key]);
    if (!av || !bv) continue;
    // Compared as text, verbatim as printed — the contract's own rule.
    (av === bv ? matches : conflicts).push(key);
  }
  return { matches, conflicts };
}

/**
 * What `self`'s `metadata.near_dup_check` says about `otherId`, if it
 * names it. `distinct` covers both the agent's own verdict and an
 * `uncertain` flag a person has since dismissed
 * (`dismissNearDupFlag` clears `flagged_for_review` and stamps
 * `reviewed_at`).
 */
export function verdictAbout(
  self: DedupSide,
  otherId: string,
): "distinct" | "uncertain" | null {
  const c = self.near_dup_check;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const check = c as Record<string, unknown>;
  const named = new Set<string>();
  if (typeof check.candidate_transaction_id === "string") {
    named.add(check.candidate_transaction_id);
  }
  if (Array.isArray(check.candidate_transaction_ids)) {
    for (const x of check.candidate_transaction_ids) {
      if (typeof x === "string") named.add(x);
    }
  }
  if (!named.has(otherId)) return null;
  if (check.verdict === "distinct") return "distinct";
  if (check.verdict === "uncertain") {
    const dismissed =
      check.flagged_for_review === false &&
      typeof check.reviewed_at === "string";
    return dismissed ? "distinct" : "uncertain";
  }
  return null;
}

/**
 * Second line of the direction gate: what the rows SAY about themselves
 * in `metadata.flow` / `metadata.refund_of`, for when the legs were
 * booked the wrong way round and the signed total cannot tell. Shared by
 * detection and by the apply step.
 *
 * `legs` is what the postings say: the leg class and signed total the
 * two rows share (detection), or the duplicate's (apply, after class and
 * sign were found equal). See `directionLateral`.
 *
 *   - two different flows                         → disagree
 *   - one row is the other's `refund_of`          → disagree
 *   - one says `refund`, the other says nothing,
 *     and the legs read as money GOING OUT (an
 *     expense leg with a positive total)          → disagree: that
 *     refund is mis-booked, and the silent row is most likely the
 *     purchase it reverses. When the legs read as money coming back (a
 *     negative expense, or an income leg) both rows already are money
 *     back by their own postings, and an older extraction that wrote no
 *     flow is no evidence against that.
 */
export function flowsDisagree(
  a: { id: string; flow: string | null; refund_of: string | null },
  b: { id: string; flow: string | null; refund_of: string | null },
  legs: { plClass: string; total: number },
): boolean {
  const aFlow = clean(a.flow);
  const bFlow = clean(b.flow);
  if (aFlow && bFlow && aFlow !== bFlow) return true;
  const legsSayOutflow = legs.plClass !== "income" && legs.total > 0;
  if (legsSayOutflow && (aFlow === "refund") !== (bFlow === "refund")) return true;
  return clean(a.refund_of) === b.id || clean(b.refund_of) === a.id;
}

export interface PairScore {
  score: number;
  strong: boolean;
  reasons: string[];
}

/**
 * Score one candidate pair, or return null when it must not be proposed.
 * `a` and `b` are interchangeable. `recurringOthers` is the number of
 * OTHER live rows sharing the batch row's total and merchant inside the
 * window; `plClass` and `total` are the leg class and signed total the
 * two rows share. Both sides are assumed live, of the same leg class and
 * equal in signed total — the candidate SQL guarantees that; nothing
 * here re-reads the database.
 */
export function scorePair(
  a: DedupSide,
  b: DedupSide,
  opts: { recurringOthers: number; plClass: string; total: number },
): PairScore | null {
  // Direction gate, second line (the first is the class and the signed
  // total in SQL).
  if (flowsDisagree(a, b, opts)) return null;

  // Each matched to its own bank line: two money events.
  if (a.status === "reconciled" && b.status === "reconciled") return null;

  // Already judged with the document in view.
  const va = verdictAbout(a, b.id);
  const vb = verdictAbout(b, a.id);
  if (va === "distinct" || vb === "distinct") return null;
  const flaggedUncertain = va === "uncertain" || vb === "uncertain";

  const ids = compareIdentifiers(a, b);
  // Same key, different values, nothing agreeing: two purchases.
  if (ids.conflicts.length > 0 && ids.matches.length === 0) return null;

  const reasons: string[] = [
    `amount equal within ±${NEAR_WINDOW_DAYS}-day window`,
  ];
  let score = 0.5;

  if (a.occurred_on === b.occurred_on) {
    score += 0.25;
    reasons.push("same occurred_on");
  }

  const aPayee = clean(a.payee)?.toLowerCase() ?? null;
  const bPayee = clean(b.payee)?.toLowerCase() ?? null;
  const sameParty =
    (aPayee !== null && aPayee === bPayee) ||
    (a.merchant_id !== null && a.merchant_id === b.merchant_id);
  if (sameParty) {
    score += 0.15;
    reasons.push("same payee/merchant");
  }

  const a4 = cardLast4(a.payment);
  const b4 = cardLast4(b.payment);
  const cardConflict = a4 !== null && b4 !== null && a4 !== b4;
  if (a4 !== null && a4 === b4) {
    score += 0.1;
    reasons.push(`same card last-4 ${a4}`);
  }

  if (ids.matches.length === 0) {
    // No identifier agrees. A card conflict settles it (two cards, two
    // charges), and so does a merchant that demonstrably repeats this
    // amount.
    if (cardConflict) return null;
    if (opts.recurringOthers >= RECURRING_MIN_OTHERS) return null;
    return { score: Math.min(score, REVIEW_SCORE_CAP), strong: false, reasons };
  }

  reasons.push(`identifier matches exactly (${ids.matches.join(", ")})`);
  const blockers: string[] = [];
  if (ids.conflicts.length > 0) {
    blockers.push(`identifiers disagree (${ids.conflicts.join(", ")})`);
  }
  if (!sameParty) blockers.push("payee/merchant differs");
  if (cardConflict) blockers.push("card last-4 differs");
  if (flaggedUncertain) blockers.push("agent flagged this pair for review");
  if (blockers.length > 0) {
    reasons.push(...blockers.map((b) => `needs review: ${b}`));
    return { score: Math.min(score, REVIEW_SCORE_CAP), strong: false, reasons };
  }
  return { score: 1.0, strong: true, reasons };
}

// ── Candidate generation ──────────────────────────────────────────────

/**
 * Body of a `CROSS JOIN LATERAL (...)` that reads the money direction of
 * the transaction aliased `txAlias` off its postings. The ONE place the
 * leg selection is written; detection and the apply step both use it.
 *
 *   pl_class  which profit-and-loss legs the row has: `expense`,
 *             `income`, `mixed` (both) or `none` (a transfer)
 *   total     the expense/income leg picked by account type and kept
 *             signed (#221): expense as booked, income negated so that
 *             earnings key positive. A refund booked as a negative
 *             expense therefore keys NEGATIVE. A row of class `none`
 *             falls back to its gross amount.
 *
 * `total` alone is not a direction: +X is both "spent X" (expense) and
 * "earned X" (income). Compare `pl_class` as well.
 */
export const directionLateral = (txAlias: string) =>
  sql.raw(`
             SELECT CASE
                      WHEN bool_or(a.type = 'expense') AND bool_or(a.type = 'income') THEN 'mixed'
                      WHEN bool_or(a.type = 'expense') THEN 'expense'
                      WHEN bool_or(a.type = 'income')  THEN 'income'
                      ELSE 'none'
                    END AS pl_class,
                    CASE WHEN bool_or(a.type IN ('expense', 'income'))
                         THEN COALESCE(SUM(CASE a.type
                                             WHEN 'income'  THEN -p.amount_base_minor
                                             WHEN 'expense' THEN  p.amount_base_minor
                                           END), 0)
                         ELSE COALESCE(SUM(GREATEST(p.amount_base_minor, 0)), 0)
                    END AS total
               FROM postings p
               JOIN accounts a ON a.id = p.account_id
              WHERE p.transaction_id = ${txAlias}.id`);

interface CandidateRow {
  pass: DedupPass;
  b: DedupSide;
  o: DedupSide;
  b_newer: boolean;
  pl_class: string;
  total: string | number;
  recurring_others: string | number;
  rn: string | number;
}

const identifierColumns = sql.raw(
  IDENTIFIER_KEYS.map(
    (k) => `NULLIF(btrim(t.metadata->>'${k}'), '') AS ${k}`,
  ).join(",\n             "),
);
const identifierOverlap = sql.raw(
  IDENTIFIER_KEYS.map((k) => `b.${k} = o.${k}`).join(" OR "),
);
const sideJson = (alias: "b" | "o") =>
  sql.raw(`jsonb_build_object(
             'id', ${alias}.id,
             'occurred_on', ${alias}.occurred_on,
             'payee', ${alias}.payee,
             'merchant_id', ${alias}.merchant_id,
             'status', ${alias}.status,
             'payment', ${alias}.payment,
             'flow', ${alias}.flow,
             'refund_of', ${alias}.refund_of,
             'near_dup_check', ${alias}.near_dup_check,
             'identifiers', jsonb_build_object(${IDENTIFIER_KEYS.map(
               (k) => `'${k}', ${alias}.${k}`,
             ).join(", ")}))`);

/**
 * Detect duplicate pairs for one batch: both passes, scored, reduced to
 * at most one proposal per batch row and per duplicate. Deterministic —
 * the same ledger state yields the same pairs in the same order.
 */
export async function detectDedupPairs(params: {
  workspaceId: string;
  batchId: string;
}): Promise<DedupPair[]> {
  const { workspaceId, batchId } = params;
  const res = await db.execute(sql`
    WITH batch_ingests AS (
      SELECT id FROM ingests WHERE batch_id = ${batchId}::uuid
    ),
    keyed AS (
      SELECT t.id, t.occurred_on, t.payee, t.merchant_id, t.created_at,
             t.status::text AS status,
             lower(btrim(t.payee)) AS payee_norm,
             COALESCE(t.source_ingest_id IN (SELECT id FROM batch_ingests), false) AS in_batch,
             ${identifierColumns},
             t.metadata->>'payment'       AS payment,
             t.metadata->>'flow'          AS flow,
             t.metadata->>'refund_of'     AS refund_of,
             t.metadata->'near_dup_check' AS near_dup_check,
             s.pl_class, s.total
        FROM ${liveTransactions} t
       CROSS JOIN LATERAL (
             -- Money direction: the class of the row's P&L legs and
             -- their signed total. See directionLateral.
             ${directionLateral("t")}
             ) s
       WHERE t.workspace_id = ${workspaceId}::uuid
    ),
    series AS (
      -- How many OTHER live rows share this batch row's total at the
      -- same merchant inside the window. Counted over the whole ledger,
      -- independent of the candidate cap below.
      SELECT b.id, COUNT(k.id) AS recurring_others
        FROM keyed b
        LEFT JOIN keyed k
          ON k.id <> b.id
         AND k.total = b.total
         AND k.pl_class = b.pl_class
         AND k.occurred_on BETWEEN b.occurred_on - ${NEAR_WINDOW_DAYS}::int
                               AND b.occurred_on + ${NEAR_WINDOW_DAYS}::int
         AND (k.merchant_id = b.merchant_id OR k.payee_norm = b.payee_norm)
       WHERE b.in_batch
       GROUP BY b.id
    ),
    ranked AS (
      SELECT CASE WHEN o.in_batch THEN 'in_batch' ELSE 'cross_batch' END AS pass,
             ${sideJson("b")} AS b,
             ${sideJson("o")} AS o,
             (b.created_at, b.id) > (o.created_at, o.id) AS b_newer,
             b.pl_class, b.total,
             b.created_at AS b_created, b.id AS b_id,
             s.recurring_others,
             ROW_NUMBER() OVER (
               PARTITION BY b.id
               ORDER BY ((${identifierOverlap}) IS TRUE) DESC,
                        (o.occurred_on = b.occurred_on) DESC,
                        ((o.merchant_id = b.merchant_id OR o.payee_norm = b.payee_norm) IS TRUE) DESC,
                        o.created_at ASC, o.id ASC
             ) AS rn
        FROM keyed b
        JOIN series s ON s.id = b.id
        JOIN keyed o
          ON o.id <> b.id
         AND o.total = b.total
         AND o.pl_class = b.pl_class
         AND o.occurred_on BETWEEN b.occurred_on - ${NEAR_WINDOW_DAYS}::int
                               AND b.occurred_on + ${NEAR_WINDOW_DAYS}::int
         AND (
               -- cross-batch pass: anything outside the batch
               NOT o.in_batch
               -- in-batch pass: each pair once, with the older row on
               -- the "o" side, and only with some evidence beyond the
               -- amount — the same day and party, or a shared printed
               -- identifier (which may sit a day or a spelling apart)
               OR ((o.created_at, o.id) < (b.created_at, b.id)
                   AND ((o.occurred_on = b.occurred_on
                         AND ((o.payee_norm = b.payee_norm) IS TRUE
                              OR (o.merchant_id = b.merchant_id) IS TRUE))
                        OR (${identifierOverlap}) IS TRUE))
             )
       WHERE b.in_batch
         -- A zero total carries no discriminating power (#205).
         AND b.total <> 0
    )
    SELECT pass, b, o, b_newer, pl_class, total, recurring_others, rn
      FROM ranked
     WHERE rn <= ${CANDIDATES_PER_ROW}::int
     ORDER BY b_created ASC, b_id ASC, rn ASC
  `);

  // Best candidate per batch row. Rows arrive grouped by batch row and
  // already ordered best-first within it, so a later candidate only
  // replaces an earlier one when it is strictly better.
  const bestPerRow = new Map<string, DedupPair>();
  for (const r of res.rows as unknown as CandidateRow[]) {
    const total = Number(r.total);
    const verdict = scorePair(r.b, r.o, {
      recurringOthers: Number(r.recurring_others),
      plClass: r.pl_class,
      total,
    });
    if (!verdict) continue;
    // The newer row is the duplicate — unless it alone is `reconciled`:
    // a row matched to a bank line is never the one removed.
    let bIsDuplicate = r.b_newer;
    if (r.b.status === "reconciled" && r.o.status !== "reconciled") {
      bIsDuplicate = false;
    } else if (r.o.status === "reconciled" && r.b.status !== "reconciled") {
      bIsDuplicate = true;
    }
    if (bIsDuplicate !== r.b_newer) {
      verdict.reasons.push("the newer row is reconciled, so the older one is the duplicate");
    }
    const dup = bIsDuplicate ? r.b : r.o;
    const canon = bIsDuplicate ? r.o : r.b;
    const pair: DedupPair = {
      pass: r.pass,
      duplicate_id: dup.id,
      canonical_id: canon.id,
      score: Math.max(0, Math.min(1, verdict.score)),
      strong: verdict.strong,
      reasons: verdict.reasons,
      occurred_on: dup.occurred_on,
      canonical_occurred_on: canon.occurred_on,
      payee: dup.payee,
      canonical_payee: canon.payee,
      total_base_minor: total,
    };
    const cur = bestPerRow.get(r.b.id);
    if (!cur || isBetter(pair, cur)) bestPerRow.set(r.b.id, pair);
  }

  // One proposal per duplicate, and never the same unordered pair twice
  // (two batch rows can both be older than the outside row they match).
  const byDuplicate = new Map<string, DedupPair>();
  for (const pair of bestPerRow.values()) {
    const cur = byDuplicate.get(pair.duplicate_id);
    if (!cur || isBetter(pair, cur)) byDuplicate.set(pair.duplicate_id, pair);
  }
  return [...byDuplicate.values()];
}

function isBetter(a: DedupPair, b: DedupPair): boolean {
  if (a.strong !== b.strong) return a.strong;
  return a.score > b.score;
}
