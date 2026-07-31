#!/usr/bin/env tsx
/**
 * Classification table for `categorizeIngest` / `isIngestRetryable` (#199).
 *
 * There is no test runner in this repo and the classifier is a pure function,
 * so this is how it gets exercised: real error strings in, `(category,
 * retryable)` out, printed as a table and asserted against an expectation.
 * Run it after touching anything in the `categoryOf` / `RETRYABLE_CATEGORIES`
 * region of `src/routes/ingest.service.ts`.
 *
 *   npx tsx scripts/check-ingest-classification.ts
 *
 * Exits non-zero on the first mismatch. No DB, no network — importing the
 * service pulls in the drizzle client module but never opens a connection.
 */
import {
  categorizeIngest,
  isIngestRetryable,
  type IngestCategory,
  type IngestStatus,
} from "../src/routes/ingest.service.js";

interface Case {
  /** What this row is a specimen of, for the table's first column. */
  label: string;
  status: IngestStatus;
  error: string | null;
  expect: IngestCategory;
  expectRetryable: boolean;
}

const CASES: Case[] = [
  // ── The #199 regression itself ──────────────────────────────────────
  {
    // Verbatim from ingest 019fa959-87dd-73d4-8ca5-0eed8c8bd9e6, the row
    // still in production and the live example cited by FE#151. Was
    // input_problem / not retryable; the user was told their Subway .eml
    // "could not be processed" during a total backend outage (#194).
    label: "#194 kernel argv fault (live prod row)",
    status: "error",
    error: "spawn E2BIG",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    // #195's replacement for the opaque kernel error. More informative to a
    // human and, before #199, classified identically wrongly — the proof
    // that widening the regex would only have delayed the next miss.
    label: "#195 assertArgvSafe guard",
    status: "error",
    error:
      "claude CLI argv[1] is 134635 bytes, over the 131072-byte per-argument " +
      "kernel limit (would fail as \"spawn E2BIG\"). Large payloads must be " +
      "passed on stdin, not argv. Offending arg starts: You are an expert…",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },

  // ── Transient subset: still recognized, still labelled precisely ─────
  {
    label: "expired OAuth (the #158 case)",
    status: "error",
    error: "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
    expect: "transient_actionable",
    expectRetryable: true,
  },
  {
    label: "extraction timeout",
    status: "error",
    error: "claude -p timed out after 600000ms",
    expect: "transient_actionable",
    expectRetryable: true,
  },

  // ── A genuine input problem ─────────────────────────────────────────
  {
    // The only structural way to say "the document was the problem": the
    // extractor's close-out contract reserves `unsupported` for exactly this.
    label: "not a receipt (marketing email)",
    status: "unsupported",
    error: "Promotional email with no purchase — no line items, no total.",
    expect: "input_problem",
    expectRetryable: false,
  },

  // ── Our own guards, all of them ours to fix ─────────────────────────
  {
    label: "agent never closed out the row",
    status: "error",
    error:
      "agent did not close out ingest row (status still processing). stdout: ",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    label: "#125 guard: receipt with no transaction",
    status: "error",
    error:
      "receipt classified but no transaction written — forcing error " +
      "(agent self-reported done; see #125)",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    label: "ledger constraint rejected the write",
    status: "error",
    error:
      'ERROR: postings for transaction do not balance (violates "postings_balance_ck")',
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    label: "container restarted mid-batch",
    status: "error",
    error: "worker restart: batch abandoned",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    // The default itself. Nothing in the codebase emits this; it stands in
    // for the *next* unforeseen fault, which is the one #199 is really about.
    label: "an error string nobody has seen yet",
    status: "error",
    error: "EMFILE: too many open files, open '/app/data/uploads/x.heic'",
    expect: "infrastructure_fault",
    expectRetryable: true,
  },
  {
    label: "error with no message at all",
    status: "error",
    error: null,
    expect: "infrastructure_fault",
    expectRetryable: true,
  },

  // ── Non-failure states, unchanged by #199 ───────────────────────────
  { label: "succeeded", status: "done", error: null, expect: "ok", expectRetryable: false },
  { label: "waiting on the worker", status: "queued", error: null, expect: "in_progress", expectRetryable: false },
  { label: "extracting now", status: "processing", error: null, expect: "in_progress", expectRetryable: false },
  { label: "byte-identical duplicate", status: "dedup", error: null, expect: "informational", expectRetryable: false },
  { label: "perceptual near-duplicate", status: "near_dup", error: null, expect: "informational", expectRetryable: false },
];

const pad = (s: string, n: number) => s.padEnd(n);
const cols = {
  label: Math.max(...CASES.map((c) => c.label.length), "case".length),
  status: Math.max(...CASES.map((c) => c.status.length), "status".length),
  error: 46,
  category: Math.max(...CASES.map((c) => c.expect.length), "category".length),
};

const rule = [
  "─".repeat(cols.label),
  "─".repeat(cols.status),
  "─".repeat(cols.error),
  "─".repeat(cols.category),
  "─".repeat(9),
].join("──");

console.log(
  [
    pad("case", cols.label),
    pad("status", cols.status),
    pad("error (truncated)", cols.error),
    pad("category", cols.category),
    "retryable",
  ].join("  "),
);
console.log(rule);

let failures = 0;
for (const c of CASES) {
  const { category, retryable } = categorizeIngest(c.status, c.error, null);
  const predicate = isIngestRetryable(c.status, c.error);

  const errCell =
    c.error === null
      ? "(null)"
      : c.error.length > cols.error
        ? c.error.slice(0, cols.error - 1) + "…"
        : c.error;

  const ok =
    category === c.expect &&
    retryable === c.expectRetryable &&
    // The whole point of #199's second half: the field the API reports and
    // the predicate `retryIngest` guards on are the same value, always.
    predicate === retryable;

  console.log(
    [
      pad(c.label, cols.label),
      pad(c.status, cols.status),
      pad(errCell, cols.error),
      pad(category, cols.category),
      pad(String(retryable), 9),
      ok ? "" : `  ✗ expected ${c.expect}/${c.expectRetryable}, predicate=${predicate}`,
    ].join("  ").trimEnd(),
  );
  if (!ok) failures += 1;
}

console.log(rule);
if (failures > 0) {
  console.error(`\n✗ ${failures} of ${CASES.length} cases mismatched.`);
  process.exit(1);
}
console.log(
  `\n✓ ${CASES.length}/${CASES.length} cases classified as expected; ` +
    "`retryable` and `isIngestRetryable` agree on every one.",
);
