/**
 * Validating an extraction record (wave 1; docs/server-writer.md,
 * "Validation").
 *
 * Three kinds of finding, each with a stable `rule` id:
 *
 *   NORMALISATIONS are applied deterministically and listed on the
 *     record (`validation.normalizations`), never bounced: trimmed
 *     strings, "" to null on nullable fields, empty identifiers dropped,
 *     defaults filled in from other fields. Two only change case:
 *     currency codes are upper-cased and `domain_hint` lower-cased. An
 *     empty `other_references` value is dropped like an empty identifier.
 *
 *   ERRORS cover structure, the contract and impossible values
 *     only. They bounce the record to the repair round
 *     (`renderRepairRequest`), and a record still in error after it is
 *     stored as evidence with `status = 'invalid'`. Every error is found
 *     in one pass, including the cross-field rules on a record whose
 *     shape is partly wrong, so the one repair round sees all of them.
 *
 *   WARNINGS are stored and never bounced. The ones decidable from
 *     the record alone are computed here. The others are found while the
 *     record is applied (`APPLY_WARNING_RULES`); by then the record row is
 *     written and immutable, so those go on the run's `apply_report` via
 *     `appendWarnings`, never back into `document_extractions.validation`.
 *
 * The upload time is an input (`future_date`, `date_far_past`), never the
 * wall clock, so a record re-validated later reaches the same verdict.
 * Money scale comes from `src/ledger/money.ts` (`printed_total_mismatch`).
 */
import { z } from "zod";
import { currencyExponent, isIsoCurrencyCode } from "../../ledger/money.js";
import { isPointsCurrency } from "../../points/codes.js";
import type { ArtefactResult } from "./artefact.js";
import { ARTEFACT_MAX_BYTES, hasPgUnsafe, pgSafeText, utf8Head } from "./artefact.js";
import {
  CONTRACT_IDENTIFIER_KEYS,
  DATE_RE,
  ExtractionV1Schema,
  FORBIDDEN_PAYLOAD_KEYS,
  OFFSET_DATETIME_RE,
  REVIEW_FLAGS,
  formatLabel,
  isReceiptClassification,
  peelSchema,
  type ExtractionV1,
} from "./v1.js";

// ── Rule ids ───────────────────────────────────────────────────────────

export const ERROR_RULES = [
  "json_parse",
  "schema",
  "required_for_classification",
  "calendar_date",
  "future_date",
  "ancient_date",
  "currency_unknown",
  "sign_flow_mismatch",
  "points_contract",
  "flow_fields",
  "line_no_duplicate",
  "parent_line_missing",
  "item_currency_foreign",
  "size_cap",
] as const;
export type ErrorRule = (typeof ERROR_RULES)[number];

/** Warnings decided from the record alone, here. */
export const RECORD_WARNING_RULES = [
  "items_total_residual",
  "printed_total_mismatch",
  "date_far_past",
  "occurred_at_date_mismatch",
  "email_without_time",
  "raw_text_missing",
  "no_items",
  "income_defaults_applied",
  "party_line_dropped",
  "mixed_tender",
  ...REVIEW_FLAGS.map((f) => `review_flag_${f}` as const),
  "repair_changed_unnamed",
] as const;

/** Warnings only the applier can decide; they go on `apply_report`.
 *  The last two are the projection's own (`src/ingest/apply/project.ts`):
 *  a record that names an account its currency cannot use, and an owned
 *  item the record asked for that cannot be tracked (the writer,
 *  `catalog.ts`, also raises it for a sold item it cannot retire). */
export const APPLY_WARNING_RULES = [
  "refund_of_dropped",
  "category_differs_from_merchant",
  "place_fetch_failed",
  "place_not_projectable",
  "account_overridden",
  "owned_items_skipped",
] as const;

export type WarningRule =
  | (typeof RECORD_WARNING_RULES)[number]
  | (typeof APPLY_WARNING_RULES)[number];

export const NORMALIZATION_RULES = [
  "trim",
  "empty_to_null",
  "null_to_default",
  "identifier_empty_dropped",
  "reference_empty_dropped",
  "currency_uppercased",
  "domain_hint_lowercased",
  "item_currency_defaulted",
  "item_line_type_defaulted",
  "brand_name_defaulted",
  "party_line_dropped",
  "channel_party_added",
  "income_defaulted",
  "unsafe_character_removed",
] as const;
export type NormalizationRule = (typeof NORMALIZATION_RULES)[number];

export interface ValidationError {
  rule: ErrorRule;
  /** Where in the record: `facts.occurred_on`, `items[3].parent_line_no`;
   *  `""` for the record as a whole. */
  path: string;
  /** What is wrong, never what the value should be. */
  message: string;
}

export interface ValidationWarning {
  rule: WarningRule;
  path: string;
  message: string;
  /** True when the warning is about an amount, a currency or the money's
   *  direction (gate G2 counts those). */
  money?: boolean;
}

/** One normalisation rule, with how often it fired and where (first 10). */
export interface Normalization {
  rule: NormalizationRule;
  count: number;
  paths: string[];
}

export interface RepairRoundNote {
  round: number;
  /** The errors the round was asked to fix. */
  errors: ValidationError[];
}

/** What `document_extractions.validation` holds. */
export interface ValidationReport {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  normalizations: Normalization[];
  /** Present when the record went through the repair round. */
  repairs?: RepairRoundNote[];
}

export interface ValidationContext {
  /** When the document was uploaded; dates are judged against this. */
  uploadedAt: Date;
  /** The ```receipt-text block that came with the record, if any. */
  receiptText?: string | null;
}

export type ValidationOutcome =
  | {
      status: "valid";
      /** The record as validated: normalised, defaults applied. */
      record: ExtractionV1;
      /** What the agent handed back, before any normalisation. */
      parsed: unknown;
      report: ValidationReport;
    }
  | {
      status: "invalid";
      record: null;
      /** What the agent handed back (for a block that would not parse,
       *  `{ unparsed_text, bytes }`), stored as the record's `result`. */
      parsed: unknown;
      report: ValidationReport;
    };

// ── Paths and small readers ────────────────────────────────────────────

type Seg = string | number;

/** A key printed bare in a path; anything else is quoted. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Characters of a quoted key kept; the rest is cut. */
const QUOTED_KEY_MAX = 40;

/**
 * A record path as the error lists, the repair request and the ingest's
 * error print it: `facts.occurred_on`, `items[3].parent_line_no`. A key the
 * model invented is model text, and the path carries it into the repair
 * request on stdin, `ingests.error` and the logs, so a key that is not a
 * plain name is printed quoted and cut, `["<first 40 chars>…"]`, with
 * everything outside printable ASCII escaped: a newline in it cannot start
 * a line that reads as the server's own.
 */
export function formatPath(segs: readonly Seg[]): string {
  let out = "";
  for (const s of segs) {
    if (typeof s === "number") out += `[${s}]`;
    else if (PLAIN_KEY.test(s)) out += out === "" ? s : `.${s}`;
    else {
      const chars = [...s];
      const cut = chars.length > QUOTED_KEY_MAX ? `${chars.slice(0, QUOTED_KEY_MAX).join("")}…` : s;
      const quoted = JSON.stringify(cut).replace(
        /[^\x20-\x7e]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      out += `[${quoted}]`;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const asObj = (v: unknown): Record<string, unknown> | null => (isPlainObject(v) ? v : null);
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `o[k] = v` that always makes an own property: a `"__proto__"` key from
 *  JSON.parse must stay a key for `.strict()` to refuse, not become the
 *  copy's prototype. */
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

class NormalizationLog {
  private readonly byRule = new Map<NormalizationRule, Normalization>();
  add(rule: NormalizationRule, path: string): void {
    let n = this.byRule.get(rule);
    if (!n) {
      n = { rule, count: 0, paths: [] };
      this.byRule.set(rule, n);
    }
    n.count += 1;
    if (n.paths.length < 10) n.paths.push(path);
  }
  list(): Normalization[] {
    return [...this.byRule.values()];
  }
}

// ── Dates ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Days since the epoch of a real `YYYY-MM-DD`, or null when it is not one. */
export function dayNumber(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(t / DAY_MS);
}

/** Whether an `OFFSET_DATETIME_RE` string names a real instant. */
function isRealDateTime(s: string): boolean {
  if (!OFFSET_DATETIME_RE.test(s)) return false;
  if (dayNumber(s.slice(0, 10)) === null) return false;
  const hh = Number(s.slice(11, 13));
  const mi = Number(s.slice(14, 16));
  const ss = s[16] === ":" ? Number(s.slice(17, 19)) : 0;
  if (hh > 23 || mi > 59 || ss > 59) return false;
  const off = /([+-])(\d{2}):?(\d{2})?$/.exec(s);
  if (off) {
    const oh = Number(off[2]);
    const om = off[3] ? Number(off[3]) : 0;
    if (oh > 14 || om > 59) return false;
  }
  return true;
}

const ANCIENT_DAY = dayNumber("2000-01-01")!;
const FUTURE_SLACK_DAYS = 2;
const FAR_PAST_DAYS = 400;

// ── Printed amounts ────────────────────────────────────────────────────

/**
 * The magnitude, in minor units at `exponent`, of an amount as printed
 * ("$1,234.56", "1.234,56 €", "¥5,000", "40,500 points"), or null when it
 * cannot be read as one. The sign is ignored (a refund is often printed
 * without one). The last `.` or `,` is the decimal mark unless it is
 * followed by exactly three digits in a currency without three decimals,
 * in which case it groups thousands.
 */
export function parsePrintedAmount(printed: string, exponent: number): bigint | null {
  const m = /\d(?:[\d.,'’\s  ]*\d)?/.exec(printed);
  if (!m) return null;
  const token = m[0].replace(/['’\s  ]/g, "");
  const lastSep = Math.max(token.lastIndexOf("."), token.lastIndexOf(","));
  let whole = token;
  let frac = "";
  if (lastSep >= 0) {
    const after = token.slice(lastSep + 1);
    if (!(after.length === 3 && exponent !== 3)) {
      whole = token.slice(0, lastSep);
      frac = after;
    }
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (frac.length > exponent) {
    if (!/^0*$/.test(frac.slice(exponent))) return null;
    frac = frac.slice(0, exponent);
  }
  return BigInt(whole) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, "0") || "0");
}

// ── Items residual ─────────────────────────────────────────────────────

/** Line types whose amount the per-line shares redistribute. */
const AGGREGATE_LINE_TYPES = new Set(["tax", "tip", "discount"]);

export interface ItemsResidual {
  currency: string;
  items_effective_sum_minor: number;
  total_minor: number;
  residual_minor: number;
}

/**
 * How far the lines are from the total, per currency the record charges
 * in (the main one, and the cash part of a points-and-cash record).
 *
 * A line's effective amount is `line_total + tax + tip − discount share`,
 * as `transaction_items.effective_total_minor` computes it. The printed
 * tax, tip and discount rows are left out of the sum: their money is
 * already spread over the product lines as shares. Lines with no
 * currency count in the main one. A currency with no counted line is
 * not reported. (Measured on production in November 2026, this
 * definition puts about 15% of ingest transactions with items over the
 * warning threshold.)
 */
export function itemsResidual(record: ExtractionV1): ItemsResidual[] {
  const facts = record.facts;
  if (!facts) return [];
  const totals = new Map<string, number>([[facts.currency, facts.total_minor]]);
  if (record.cash_component) totals.set(record.cash_component.currency, record.cash_component.amount_minor);
  const sums = new Map<string, number>();
  for (const it of record.items) {
    if (AGGREGATE_LINE_TYPES.has(it.line_type ?? "product")) continue;
    const cur = it.currency ?? facts.currency;
    if (!totals.has(cur)) continue;
    const eff =
      it.line_total_minor + (it.tax_minor ?? 0) + (it.tip_share_minor ?? 0) - (it.discount_share_minor ?? 0);
    sums.set(cur, (sums.get(cur) ?? 0) + eff);
  }
  return [...sums.entries()].map(([currency, sum]) => ({
    currency,
    items_effective_sum_minor: sum,
    total_minor: totals.get(currency)!,
    residual_minor: sum - totals.get(currency)!,
  }));
}

/** Over this, `items_total_residual` fires: max(5 minor units, 1% of the total). */
export function residualThreshold(totalMinor: number): number {
  return Math.max(5, Math.abs(totalMinor) / 100);
}

// ── Characters Postgres cannot store ───────────────────────────────────

/**
 * A copy of the parsed record with every string and key made storable
 * (`pgSafeText`: U+0000 removed, a lone surrogate replaced). This runs
 * before anything else, so the record, and what is stored as `parsed`
 * when it is invalid, can always be written: one such character used to
 * fail T1 whole, losing the evidence. A key that changes stays a key the
 * schema does not know, so `.strict()` still refuses it.
 */
function storable(v: unknown, path: Seg[], log: NormalizationLog | null): unknown {
  if (typeof v === "string") {
    if (!hasPgUnsafe(v)) return v;
    log?.add("unsafe_character_removed", formatPath(path));
    return pgSafeText(v);
  }
  if (Array.isArray(v)) return v.map((el, i) => storable(el, [...path, i], log));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, el] of Object.entries(v)) {
      const key = hasPgUnsafe(k) ? pgSafeText(k) : k;
      if (key !== k) log?.add("unsafe_character_removed", formatPath([...path, k]));
      setOwn(out, key, storable(el, [...path, key], log));
    }
    return out;
  }
  return v;
}

// ── Pre-parse normalisation, guided by the schema ──────────────────────

/**
 * Trim every string, turn "" into null where the schema allows null, and
 * drop a null where the schema has a default for it. Returns a copy;
 * keys the schema does not know are copied untouched for `.strict()` to
 * refuse.
 */
function normaliseAgainst(schema: z.ZodTypeAny, value: unknown, path: Seg[], log: NormalizationLog | null): unknown {
  const f = peelSchema(schema);
  if (typeof value === "string") {
    let v = value;
    const t = v.trim();
    if (t !== v) {
      log?.add("trim", formatPath(path));
      v = t;
    }
    if (v === "" && f.nullable) {
      log?.add("empty_to_null", formatPath(path));
      return null;
    }
    return v;
  }
  if (value === null && f.hasDefault && !f.nullable) {
    log?.add("null_to_default", formatPath(path));
    return undefined;
  }
  const core = f.core;
  if (core instanceof z.ZodObject && isPlainObject(value)) {
    const shape = core.shape as z.ZodRawShape;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const child = shape[k];
      const nv = child && Object.hasOwn(shape, k) ? normaliseAgainst(child, v, [...path, k], log) : v;
      if (nv !== undefined) setOwn(out, k, nv);
    }
    return out;
  }
  if (core instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((el, i) => normaliseAgainst(core.element, el, [...path, i], log));
  }
  if (core instanceof z.ZodRecord && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) setOwn(out, k, normaliseAgainst(core.valueSchema, v, [...path, k], log));
    return out;
  }
  return value;
}

/** Field-specific normalisations that need no other field. Mutates `rec`. */
function normaliseFields(rec: Record<string, unknown>, log: NormalizationLog | null): void {
  const dropEmpty = (key: "identifiers" | "other_references", rule: NormalizationRule) => {
    const o = asObj(rec[key]);
    if (!o) return;
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === "") {
        delete o[k];
        log?.add(rule, `${key}.${k}`);
      }
    }
  };
  dropEmpty("identifiers", "identifier_empty_dropped");
  dropEmpty("other_references", "reference_empty_dropped");

  const upper = (o: Record<string, unknown> | null, key: string, path: string) => {
    const v = o ? asStr(o[key]) : null;
    if (o && v !== null && v !== v.toUpperCase()) {
      o[key] = v.toUpperCase();
      log?.add("currency_uppercased", path);
    }
  };
  upper(asObj(rec.facts), "currency", "facts.currency");
  upper(asObj(rec.cash_component), "currency", "cash_component.currency");
  asArr(rec.items).forEach((it, i) => upper(asObj(it), "currency", `items[${i}].currency`));
  asArr(rec.statement_rows).forEach((r, i) => upper(asObj(r), "currency", `statement_rows[${i}].currency`));

  const merchant = asObj(rec.merchant);
  const domain = merchant ? asStr(merchant.domain_hint) : null;
  if (merchant && domain !== null && domain !== domain.toLowerCase()) {
    merchant.domain_hint = domain.toLowerCase();
    log?.add("domain_hint_lowercased", "merchant.domain_hint");
  }
}

/** The pre-parse half of the normalisations: what zod sees. */
function preNormalise(input: unknown, log: NormalizationLog | null): unknown {
  const out = normaliseAgainst(ExtractionV1Schema, input, [], log);
  if (isPlainObject(out)) normaliseFields(out, log);
  return out;
}

// ── zod issues to errors ───────────────────────────────────────────────

const FORBIDDEN = new Set<string>(FORBIDDEN_PAYLOAD_KEYS);

/** The schema at a record path, for wording an issue. */
function schemaAt(path: readonly Seg[]): z.ZodTypeAny | null {
  let s: z.ZodTypeAny = ExtractionV1Schema;
  for (const seg of path) {
    const core = peelSchema(s).core;
    if (core instanceof z.ZodObject && typeof seg === "string") {
      const next = (core.shape as z.ZodRawShape)[seg];
      if (!next) return null;
      s = next;
    } else if (core instanceof z.ZodArray && typeof seg === "number") {
      s = core.element;
    } else if (core instanceof z.ZodRecord) {
      s = core.valueSchema;
    } else {
      return null;
    }
  }
  return s;
}

function issueMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === "undefined"
        ? "is required and missing"
        : `must be ${issue.expected === "integer" ? "an integer" : issue.expected}, not ${issue.received}`;
    case z.ZodIssueCode.invalid_literal:
      return `must be ${JSON.stringify(issue.expected)}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `must be one of ${issue.options.map(String).join(" | ")}`;
    case z.ZodIssueCode.invalid_string: {
      if (issue.validation === "regex") {
        const core = peelSchema(schemaAt(issue.path) ?? z.string()).core;
        const re =
          core instanceof z.ZodString
            ? core._def.checks.find((c): c is { kind: "regex"; regex: RegExp } => c.kind === "regex")
            : undefined;
        const label = re ? formatLabel(re.regex) : undefined;
        return label ? `must be ${label}` : "does not have the required format";
      }
      return "does not have the required format";
    }
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return Number(issue.minimum) <= 1 ? "must not be empty" : `must be at least ${issue.minimum} characters`;
      if (issue.type === "number") return `must be ${issue.inclusive ? "at least" : "more than"} ${issue.minimum}`;
      return issue.message;
    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return `is longer than ${issue.maximum} characters`;
      if (issue.type === "number") return `must be ${issue.inclusive ? "at most" : "less than"} ${issue.maximum}`;
      if (issue.type === "array") return `has more than ${issue.maximum} elements`;
      return issue.message;
    case z.ZodIssueCode.invalid_union:
      return "must be text of at most 200 characters, a number, or true/false";
    case z.ZodIssueCode.not_finite:
      return "must be a finite number";
    default:
      return issue.message;
  }
}

function issueToErrors(issue: z.ZodIssue): ValidationError[] {
  const path = formatPath(issue.path);
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((k) => ({
      rule: "schema" as const,
      path: formatPath([...issue.path, k]),
      message: FORBIDDEN.has(k)
        ? "is supplied by the server and must not be in the record; leave it out"
        : "is not a field of the contract; leave it out",
    }));
  }
  if (issue.code === z.ZodIssueCode.too_big && issue.type === "array") {
    return [{ rule: "size_cap", path, message: issueMessage(issue) }];
  }
  if (issue.code === z.ZodIssueCode.custom && (issue.params as { rule?: string } | undefined)?.rule === "size_cap") {
    return [{ rule: "size_cap", path, message: issue.message }];
  }
  return [{ rule: "schema", path, message: issueMessage(issue) }];
}

// ── Cross-field error rules, on the normalised input ───────────────────

/**
 * Every error rule that spans fields. Runs on the pre-parse normalised
 * input even when zod refused part of it, reading each field defensively,
 * so a record with one malformed field still has its other problems
 * reported in the same round.
 */
function crossFieldErrors(rec: Record<string, unknown>, ctx: ValidationContext): ValidationError[] {
  const errors: ValidationError[] = [];
  const err = (rule: ErrorRule, path: string, message: string) => errors.push({ rule, path, message });

  const classification = asStr(rec.classification);
  const receipt = isReceiptClassification(classification);
  const facts = asObj(rec.facts);
  const present = (k: string) => rec[k] !== undefined && rec[k] !== null;

  // required_for_classification: both directions, required for the
  // classification and refused on any other.
  if (classification !== null && (receipt || classification === "statement_pdf" || classification === "unsupported")) {
    for (const k of ["facts", "merchant", "audit"]) {
      if (receipt && !present(k)) {
        err("required_for_classification", k, `is required when classification is ${classification}`);
      }
    }
    for (const k of ["facts", "merchant"]) {
      if (!receipt && present(k)) {
        err(
          "required_for_classification",
          k,
          `is only for receipt_image, receipt_email and receipt_pdf, not ${classification}; leave it out or re-check the classification`,
        );
      }
    }
    if (classification === "unsupported" && !present("unsupported")) {
      err("required_for_classification", "unsupported", "is required when classification is unsupported");
    }
    if (classification !== "unsupported" && present("unsupported")) {
      err(
        "required_for_classification",
        "unsupported",
        `is only for classification unsupported, not ${classification}; leave it out or re-check the classification`,
      );
    }
    if (classification === "statement_pdf" && !present("statement_rows")) {
      err("required_for_classification", "statement_rows", "is required when classification is statement_pdf");
    }
    if (classification !== "statement_pdf" && present("statement_rows")) {
      err(
        "required_for_classification",
        "statement_rows",
        `is only for classification statement_pdf, not ${classification}; leave it out or re-check the classification`,
      );
    }
  }

  // Dates.
  const uploadDay = Math.floor(ctx.uploadedAt.getTime() / DAY_MS);
  const occurredOn = facts ? asStr(facts.occurred_on) : null;
  if (occurredOn !== null && DATE_RE.test(occurredOn)) {
    const day = dayNumber(occurredOn);
    if (day === null) {
      err("calendar_date", "facts.occurred_on", "this date does not exist on the calendar");
    } else if (day > uploadDay + FUTURE_SLACK_DAYS) {
      err("future_date", "facts.occurred_on", `this date is more than ${FUTURE_SLACK_DAYS} days after the document was uploaded`);
    } else if (day < ANCIENT_DAY) {
      err("ancient_date", "facts.occurred_on", "this date is before 2000-01-01");
    }
  }
  const occurredAt = facts ? asStr(facts.occurred_at) : null;
  if (occurredAt !== null && OFFSET_DATETIME_RE.test(occurredAt) && !isRealDateTime(occurredAt)) {
    err("calendar_date", "facts.occurred_at", "this date or time does not exist");
  }
  asArr(rec.statement_rows).forEach((r, i) => {
    const d = asStr(asObj(r)?.occurred_on);
    if (d !== null && DATE_RE.test(d) && dayNumber(d) === null) {
      err("calendar_date", `statement_rows[${i}].occurred_on`, "this date does not exist on the calendar");
    }
  });

  // Currencies.
  const known = (c: string) => isIsoCurrencyCode(c) || isPointsCurrency(c);
  const currency = facts ? asStr(facts.currency) : null;
  if (currency !== null && currency !== "" && !known(currency)) {
    err("currency_unknown", "facts.currency", "is neither an ISO 4217 code nor a points code (ISSUER_PT)");
  }
  const cash = asObj(rec.cash_component);
  const cashCurrency = cash ? asStr(cash.currency) : null;
  if (cashCurrency !== null && cashCurrency !== "" && !known(cashCurrency)) {
    err("currency_unknown", "cash_component.currency", "is neither an ISO 4217 code nor a points code (ISSUER_PT)");
  }
  asArr(rec.statement_rows).forEach((r, i) => {
    const c = asStr(asObj(r)?.currency);
    if (c !== null && c !== "" && !known(c)) {
      err("currency_unknown", `statement_rows[${i}].currency`, "is neither an ISO 4217 code nor a points code (ISSUER_PT)");
    }
  });

  // Sign against flow.
  const flow = facts ? asStr(facts.flow) : null;
  const total = facts ? asInt(facts.total_minor) : null;
  if (total !== null && (flow === "purchase" || flow === "income") && total < 0) {
    err("sign_flow_mismatch", "facts.total_minor", `a ${flow} total cannot be negative`);
  }
  if (total !== null && flow === "refund" && total > 0) {
    err("sign_flow_mismatch", "facts.total_minor", "a refund total cannot be positive");
  }

  // Points.
  const pointsCurrency = currency !== null && isPointsCurrency(currency);
  if (pointsCurrency && !present("points")) {
    err("points_contract", "points", "is required when the currency is a points code");
  }
  if (present("points") && currency !== null && !pointsCurrency) {
    err("points_contract", "points", "is only for a record whose currency is a points code");
  }
  if (present("points") && facts === null) {
    err("points_contract", "points", "is only for a receipt whose currency is a points code");
  }
  if (cash) {
    if (!present("points")) {
      err("points_contract", "cash_component", "is only for a points redemption that also charged cash");
    }
    if (cashCurrency !== null && (isPointsCurrency(cashCurrency) || cashCurrency === currency)) {
      err("points_contract", "cash_component.currency", "must be a cash currency different from facts.currency");
    }
  }

  // Fields that belong to one flow.
  if (present("sold_item") && flow !== "income") {
    err("flow_fields", "sold_item", "is only for a record whose flow is income");
  }
  if (present("income") && flow !== "income") {
    err("flow_fields", "income", "is only for a record whose flow is income");
  }

  // Items.
  const items = asArr(rec.items);
  const lineNos = new Set<number>();
  const seen = new Set<number>();
  items.forEach((it) => {
    const n = asInt(asObj(it)?.line_no);
    if (n !== null) lineNos.add(n);
  });
  items.forEach((raw, i) => {
    const it = asObj(raw);
    if (!it) return;
    const n = asInt(it.line_no);
    if (n !== null) {
      if (seen.has(n)) err("line_no_duplicate", `items[${i}].line_no`, "another item already has this line_no");
      seen.add(n);
    }
    const parent = asInt(it.parent_line_no);
    if (parent !== null) {
      if (parent === n) err("parent_line_missing", `items[${i}].parent_line_no`, "an item cannot be its own parent");
      else if (!lineNos.has(parent)) err("parent_line_missing", `items[${i}].parent_line_no`, "no item has that line_no");
    }
    const c = asStr(it.currency);
    if (c !== null && c !== "" && currency !== null && c !== currency && c !== cashCurrency) {
      err(
        "item_currency_foreign",
        `items[${i}].currency`,
        "is neither the record's currency nor the currency of its cash part",
      );
    }
  });

  return errors;
}

// ── Post-parse normalisation and record warnings ───────────────────────

function postNormalise(rec: ExtractionV1, log: NormalizationLog, warnings: ValidationWarning[]): ExtractionV1 {
  const receipt = isReceiptClassification(rec.classification);
  if (receipt && rec.facts) {
    const facts = rec.facts;
    rec.items.forEach((it, i) => {
      if (it.currency == null) {
        it.currency = facts.currency;
        log.add("item_currency_defaulted", `items[${i}].currency`);
      }
      if (it.line_type == null) {
        it.line_type = "product";
        log.add("item_line_type_defaulted", `items[${i}].line_type`);
      }
    });
  }
  if (rec.merchant && rec.merchant.brand_name == null) {
    rec.merchant.brand_name = rec.merchant.canonical_name;
    log.add("brand_name_defaulted", "merchant.brand_name");
  }

  const lineNos = new Set(rec.items.map((it) => it.line_no));
  const kept: ExtractionV1["parties"] = [];
  rec.parties.forEach((p, i) => {
    if (p.line_no != null && !lineNos.has(p.line_no)) {
      log.add("party_line_dropped", `parties[${i}]`);
      warnings.push({
        rule: "party_line_dropped",
        path: `parties[${i}].line_no`,
        message: "matches no item's line_no; the party was dropped",
      });
    } else {
      kept.push(p);
    }
  });
  rec.parties = kept;
  if (receipt && rec.merchant && !rec.parties.some((p) => p.role === "channel")) {
    rec.parties.unshift({
      role: "channel",
      display_name: rec.merchant.canonical_name,
      brand_id: rec.merchant.brand_id,
      line_no: null,
    });
    log.add("channel_party_added", "parties[0]");
  }

  if (rec.facts?.flow === "income" && rec.income == null) {
    rec.income = { deposit_account: "Checking", income_account: "Other" };
    log.add("income_defaulted", "income");
    warnings.push({
      rule: "income_defaults_applied",
      path: "income",
      message: "income record without an income block; Checking and Other were used",
      money: true,
    });
  }
  return rec;
}

function recordWarnings(rec: ExtractionV1, ctx: ValidationContext): ValidationWarning[] {
  const out: ValidationWarning[] = [];
  const warn = (rule: WarningRule, path: string, message: string, money?: boolean) =>
    out.push(money ? { rule, path, message, money } : { rule, path, message });
  const receipt = isReceiptClassification(rec.classification);
  const facts = rec.facts;

  if (receipt && rec.items.length === 0) warn("no_items", "items", "a receipt with no line items");

  if (receipt && facts) {
    for (const r of itemsResidual(rec)) {
      if (Math.abs(r.residual_minor) > residualThreshold(r.total_minor)) {
        warn(
          "items_total_residual",
          "items",
          `the lines in ${r.currency} add up to ${r.items_effective_sum_minor}, the total is ${r.total_minor} (residual ${r.residual_minor})`,
          true,
        );
      }
    }

    if (facts.total_printed != null) {
      const parsed = parsePrintedAmount(facts.total_printed, currencyExponent(facts.currency));
      const total = BigInt(Math.abs(facts.total_minor));
      if (parsed === null) {
        warn("printed_total_mismatch", "facts.total_printed", "could not be read as an amount", true);
      } else if (parsed !== total) {
        warn(
          "printed_total_mismatch",
          "facts.total_printed",
          `reads as ${parsed} minor units of ${facts.currency}; total_minor is ${facts.total_minor}`,
          true,
        );
      }
    }

    const day = dayNumber(facts.occurred_on);
    const uploadDay = Math.floor(ctx.uploadedAt.getTime() / DAY_MS);
    if (day !== null && day < uploadDay - FAR_PAST_DAYS) {
      warn("date_far_past", "facts.occurred_on", `more than ${FAR_PAST_DAYS} days before the upload`);
    }
    if (facts.occurred_at != null && facts.occurred_at.slice(0, 10) !== facts.occurred_on) {
      warn("occurred_at_date_mismatch", "facts.occurred_at", "its date part differs from occurred_on");
    }
    if (rec.classification === "receipt_email" && facts.occurred_at == null) {
      warn("email_without_time", "facts.occurred_at", "an email with no transaction time");
    }
    // A record names one tender, so the applier books a mixed one whole to
    // Credit Card and flags the transaction for review (`project.ts`).
    // Only a cash pair is paid by the method: income is deposited where
    // `income` says, and points with no cash part pay from the points
    // account whatever the method.
    const cashPair = !isPointsCurrency(facts.currency) || rec.cash_component != null;
    if (facts.flow !== "income" && cashPair && rec.payment.method === "mixed") {
      warn("mixed_tender", "payment.method", "paid with two or more tenders; the split between them is not booked", true);
    }
  }

  // The server decodes email and HTML itself; a photo or a PDF, text
  // layer included, has no transcription but the agent's receipt-text
  // block, and without one `documents.ocr_text` stays empty.
  const serverText = rec.source_used === "email_body" || rec.source_used === "email_attachment" || rec.source_used === "html";
  const agentText =
    rec.source_used === "image" ||
    rec.source_used === "pdf_text" ||
    rec.source_used === "pdf_raster" ||
    (!serverText &&
      (rec.classification === "receipt_image" || rec.classification === "receipt_pdf" || rec.classification === "statement_pdf"));
  const hasText = typeof ctx.receiptText === "string" && ctx.receiptText.trim() !== "";
  if (agentText && rec.classification !== "unsupported" && !hasText) {
    warn("raw_text_missing", "receipt-text", "a photo or PDF handed back without a receipt-text block");
  }

  for (const f of rec.audit?.review_flags ?? []) {
    warn(`review_flag_${f}`, "audit.review_flags", `the agent flagged ${f}`);
  }
  return out;
}

// ── Entry points ───────────────────────────────────────────────────────

function emptyReport(): ValidationReport {
  return { errors: [], warnings: [], normalizations: [] };
}

/**
 * Validate a parsed record. Never throws. `parsed` is the JSON object the
 * agent handed back; on success `record` is the normalised, typed record.
 */
export function validateExtraction(handedBack: unknown, ctx: ValidationContext): ValidationOutcome {
  const report = emptyReport();
  const log = new NormalizationLog();
  const parsed = storable(handedBack, [], log);
  if (!isPlainObject(parsed)) {
    report.errors.push({ rule: "schema", path: "", message: "the record must be one JSON object" });
    return { status: "invalid", record: null, parsed, report };
  }
  const pre = preNormalise(parsed, log) as Record<string, unknown>;
  const zres = ExtractionV1Schema.safeParse(pre);
  if (!zres.success) report.errors.push(...zres.error.issues.flatMap(issueToErrors));
  report.errors.push(...crossFieldErrors(pre, ctx));
  if (report.errors.length > 0 || !zres.success) {
    report.normalizations = log.list();
    return { status: "invalid", record: null, parsed, report };
  }
  const warnings: ValidationWarning[] = [];
  const record = postNormalise(zres.data, log, warnings);
  report.warnings = [...warnings, ...recordWarnings(record, ctx)];
  report.normalizations = log.list();
  return { status: "valid", record, parsed, report };
}

const UNPARSED_KEEP_BYTES = 16 * 1024;

/**
 * Validate what `parseArtefact` found. Null for `artefact_missing`: there
 * is no record to validate, bounce or store. A block that would not parse
 * or is over a cap becomes an invalid outcome with that error (both
 * bounce to the repair round), its text kept as the evidence.
 */
export function validateArtefact(artefact: ArtefactResult, ctx: Omit<ValidationContext, "receiptText">): ValidationOutcome | null {
  if (artefact.ok) return validateExtraction(artefact.record, { ...ctx, receiptText: artefact.receiptText });
  if (artefact.reason === "artefact_missing") return null;
  const text = artefact.jsonText ?? "";
  const capError: ValidationError = {
    rule: artefact.reason,
    path: artefact.block === "receipt-text" ? "receipt-text" : "",
    message: artefact.message,
  };
  if (artefact.block === "receipt-text") {
    // Only the receipt text is over its cap: validate the record too, so
    // the one repair round hears about everything at once.
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    if (isPlainObject(parsed)) {
      const inner = validateExtraction(parsed, { ...ctx, receiptText: null });
      inner.report.errors.unshift(capError);
      inner.report.warnings = [];
      return { status: "invalid", record: null, parsed: inner.parsed, report: inner.report };
    }
    if (parseError !== null) {
      const report = emptyReport();
      report.errors.push(capError, { rule: "json_parse", path: "", message: pgSafeText(`the json block is not valid JSON: ${parseError}`) });
      return { status: "invalid", record: null, parsed: { unparsed_text: pgSafeText(text), bytes: Buffer.byteLength(text, "utf8") }, report };
    }
  }
  const report = emptyReport();
  report.errors.push(capError);
  const keep = artefact.reason === "size_cap" && artefact.block === "json" ? UNPARSED_KEEP_BYTES : ARTEFACT_MAX_BYTES;
  return {
    status: "invalid",
    record: null,
    parsed: { unparsed_text: pgSafeText(utf8Head(text, keep)), bytes: Buffer.byteLength(text, "utf8") },
    report,
  };
}

/** Add warnings found later (apply time, repair diff) to a report. */
export function appendWarnings(report: ValidationReport, warnings: readonly ValidationWarning[]): ValidationReport {
  report.warnings.push(...warnings);
  return report;
}

/** Note on a report that a repair round was asked to fix `errors`. */
export function noteRepairRound(report: ValidationReport, round: number, errors: readonly ValidationError[]): ValidationReport {
  (report.repairs ??= []).push({ round, errors: [...errors] });
  return report;
}

// ── The text sent back: the repair request ─────────────────────────────

/** What to look at again, per rule. Never a value. */
const REREAD: Partial<Record<ErrorRule, string>> = {
  calendar_date: "Re-read the date on the document.",
  future_date: "Re-read the date on the document.",
  ancient_date: "Re-read the date on the document, the year especially.",
  currency_unknown: "Re-read the currency on the document.",
  sign_flow_mismatch: "Re-read the total, and whether money left the user or came back.",
  points_contract: "Re-read how this was paid.",
  flow_fields: "Re-read whether money left the user, came back, or came in.",
  line_no_duplicate: "Re-read the order of the lines.",
  parent_line_missing: "Re-read which line this one belongs to.",
  item_currency_foreign: "Re-read that line's currency.",
  required_for_classification: "Re-read what kind of document this is.",
  json_parse: "Write the whole record again as one valid JSON object.",
};

const REPAIR_LINES_MAX = 40;

/**
 * The repair request (docs/server-writer.md, "The repair round"): one line
 * per error naming its path and rule, never proposing a value, asking for
 * a re-read of the region where the rule is about the reading. Sent on
 * stdin of the `--resume` spawn.
 */
export function renderRepairRequest(errors: readonly ValidationError[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of errors) {
    const key = `${e.path}\u0000${e.rule}\u0000${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = e.path === "" ? "the record" : e.path === "receipt-text" ? "the receipt-text block" : e.path;
    const hint = REREAD[e.rule];
    lines.push(`- ${where} — ${e.rule}: ${e.message}.${hint ? ` ${hint}` : ""}`);
  }
  const shown = lines.slice(0, REPAIR_LINES_MAX);
  if (lines.length > shown.length) shown.push(`- … and ${lines.length - shown.length} more of the kinds above.`);
  return `Your extraction record was not accepted. Fix only the fields listed, re-reading the document
where told, then end your reply with the full corrected record in one \`\`\`json block
(and the \`\`\`receipt-text block again if you gave one). Do not change fields that are not listed.
${shown.join("\n")}
`;
}

// ── The repair diff ────────────────────────────────────────────────────

export interface ChangedField {
  path: string;
  /** An amount, a currency, or what decides direction or accounts. */
  money: boolean;
}

const MONEY_PATHS = new Set([
  "classification",
  "facts.flow",
  "merchant.category",
  "payment.method",
  "points.programme_name",
  "income.deposit_account",
  "income.income_account",
]);

/** Whether a changed leaf is a money field (gate G2 counts these). */
export function isMoneyPath(path: string): boolean {
  const leaf = path.replace(/\[\d+\]/g, "").split(".").at(-1) ?? "";
  return leaf.endsWith("_minor") || leaf === "currency" || MONEY_PATHS.has(path);
}

function leaves(v: unknown, path: Seg[], out: Map<string, unknown>): void {
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) out.set(formatPath(path), "{}");
    for (const k of keys) leaves(v[k], [...path, k], out);
  } else if (Array.isArray(v)) {
    if (v.length === 0) out.set(formatPath(path), "[]");
    v.forEach((el, i) => leaves(el, [...path, i], out));
  } else if (v !== undefined && v !== null) {
    out.set(formatPath(path), v);
  }
}

function covers(errorPath: string, changed: string): boolean {
  if (errorPath === "") return true;
  const under = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`);
  return under(changed, errorPath) || under(errorPath, changed);
}

/**
 * What a repair round changed that its errors did not name. Both records
 * are compared after the same trimming the validator applies, leaf by
 * leaf; a null and a missing key are the same. A change is named when
 * its path is an error's path, inside it, or contains it. When the first
 * record could not be read at all (`json_parse`, an oversize block), or
 * an error was about the record as a whole, everything is named.
 * Returns the unnamed changes and one `repair_changed_unnamed` warning
 * per change, `money` set on amounts, currencies, flow, classification,
 * category and payment method.
 */
export function diffRepair(
  original: unknown,
  repaired: unknown,
  errors: readonly ValidationError[],
): { changed: ChangedField[]; unnamed: ChangedField[]; warnings: ValidationWarning[] } {
  if (!isPlainObject(original) || !isPlainObject(repaired)) return { changed: [], unnamed: [], warnings: [] };
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  leaves(preNormalise(original, null), [], a);
  leaves(preNormalise(repaired, null), [], b);
  const changed: ChangedField[] = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(p) !== b.get(p)) changed.push({ path: p, money: isMoneyPath(p) });
  }
  changed.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const unnamed = changed.filter((c) => !errors.some((e) => covers(e.path, c.path)));
  const warnings: ValidationWarning[] = unnamed.map((c) => ({
    rule: "repair_changed_unnamed" as const,
    path: c.path,
    message: "changed by the repair round although no error named it",
    ...(c.money ? { money: true } : {}),
  }));
  return { changed, unnamed, warnings };
}

/** The identifier values of a record, as stored on `document_extractions.identifiers`. */
export function identifiersOf(record: Pick<ExtractionV1, "identifiers">): Partial<Record<(typeof CONTRACT_IDENTIFIER_KEYS)[number], string>> {
  const out: Partial<Record<(typeof CONTRACT_IDENTIFIER_KEYS)[number], string>> = {};
  for (const k of CONTRACT_IDENTIFIER_KEYS) {
    const v = record.identifiers[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}
