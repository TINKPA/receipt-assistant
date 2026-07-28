/**
 * Shared extraction-contract constants and agent-hygiene phases for the
 * extraction and re-extraction prompts (#164).
 *
 * Both prompts inline these phases verbatim so the agent — which runs
 * inside a container that doesn't have the source files — gets the
 * full instructions in its prompt window. Don't reference these phases
 * by source-file path from the prompt; the agent will go looking for
 * `src/ingest/prompt.ts` and waste turns when it can't find it.
 *
 * Prompt strings here are PLAIN template literals, never `String.raw`.
 * Inside `String.raw` a `` \` `` / `\$` survives into the agent's window
 * as a literal backslash, which corrupts every shell snippet that
 * mentions `$DATABASE_URL` or a markdown code span.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The ONE prompt-version stamp, written into
 * `transactions.metadata.extraction.prompt_version` and
 * `transaction_items.extraction_version` by BOTH the ingest and the
 * re-extract path. Bump on meaningful prompt changes only — typo fixes
 * and whitespace edits do not warrant a new version. The string becomes
 * the gate for `POST /v1/documents/:id/re-extract` (#91): rows whose
 * `extraction.prompt_version` ≠ `PROMPT_VERSION` are eligible to be
 * re-derived. See #80 / #88 for the 3-layer data model rationale.
 *
 * There is deliberately NO separate re-extract version constant (#164):
 * two number lines in one column (`1.8` sorting "newer" than `2.19`) is
 * pure liability, and nothing reads or compares either value. The path
 * is distinguished by `metadata.extraction.source ∈ {'ingest','re-extract'}`.
 */
export const PROMPT_VERSION = "3.1";

/**
 * The model identifier stamped into `transactions.metadata.extraction.model`
 * and `documents.ocr_model_version`.
 *
 * `claude -p` is spawned WITHOUT a `--model` flag unless `CLAUDE_MODEL`
 * is set (see `extractor.ts::runClaude`), in which case the CLI picks its
 * own default — so `"cli-default"` is the truthful stamp for an unset
 * env var. The old `"sonnet"` fallback was a lie: the container CLI has
 * been running opus while the column read `sonnet`.
 */
export const EXTRACTION_MODEL = process.env.CLAUDE_MODEL ?? "cli-default";

/** Reason-in-plain-text rule. Structured-output coercion measurably
 *  degrades OCR (4/10 dates wrong on an early A/B set) because it skips
 *  chain-of-thought. Never add `--json-schema` / `--output-format json`. */
export const NO_JSON_SCHEMA_RULE = `Reason in plain text first. Chain-of-thought measurably improves OCR.
Do NOT use \`--json-schema\`-style structured output.`;

/**
 * The psql connection + heredoc form + the BATCHING rule (#181).
 *
 * The batching rule is the turn-count half of #181. Nothing in either
 * prompt ever forbade multiple *statements* per invocation, but nothing
 * asked for it either, and the per-section structure produced ~8 core
 * write turns. Each extra round trip re-sends the whole conversation,
 * so turns multiply input tokens super-linearly.
 */
export const PSQL_DISCIPLINE = `DB connection: \`psql "\$DATABASE_URL"\` — the env var is set. Use it for
every SQL call.

- One psql INVOCATION per Bash tool call, and BATCH your statements
  into that one invocation with a heredoc. Do NOT issue one psql call
  per statement — each round trip re-sends the whole conversation.
    psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
      BEGIN;
      ...
      COMMIT;
    SQL
  Always use the QUOTED heredoc marker <<'SQL' so the shell does not
  mangle \$items\$ dollar-quoting. Always pass -v ON_ERROR_STOP=1 —
  without it, a failed statement inside BEGIN turns COMMIT into a
  silent ROLLBACK and psql still exits 0.
- Still SEQUENTIAL: one Bash tool call at a time, never a parallel
  tool-call block.`;

/**
 * Scratch-file discipline (#143) + sequential tool discipline (#126) +
 * the priority / effort-budget preamble.
 *
 * Parameterized rather than a bare const because the scratch directory
 * and the source file path differ per run; the text is otherwise moved
 * verbatim from `prompt.ts`.
 *
 * `brand-icon-prompt.ts` cross-references "the extractor's Priority &
 * effort-budget preamble" — that reference resolves from BOTH prompts
 * only because this block is inlined by both.
 */
export function agentHygiene(opts: {
  /** Per-run scratch directory, e.g. `/tmp/<ingestId>`. */
  scratchDir: string;
  /** Container-absolute path of the file under extraction. */
  filePath: string;
  /** Which path is rendering this. The effort-budget prose names the run's
   *  own phases, and the two paths do not share them — re-extract has no
   *  Phase 5 to close an ingest in, and its Phase 3 is a brand refresh, not
   *  a Google place resolve. Telling a re-extract agent to "close the ingest
   *  in Phase 5" points it at a step that does not exist in its own prompt. */
  path: "ingest" | "re-extract";
}): string {
  const core =
    opts.path === "ingest"
      ? `classify → extract fields → write the balanced double-entry transaction
  (+ postings + line items + document link) → close the ingest in Phase 5.
  A run that commits a correct, balanced transaction and closes the ingest
  is a SUCCESS even if it did zero enrichment.`
      : `re-read the source → UPDATE the existing transaction's fields in place
  → replace its line items (retiring the previous run) → stamp
  metadata.extraction. A run that commits a correct in-place update is a
  SUCCESS even if it did zero enrichment.`;
  const enrichment =
    opts.path === "ingest"
      ? `Phase 3 (Google place resolve / multilingual fetch / storefront photos)
  and the brand-icon resolution pipeline.`
      : `the brand refresh and the brand-icon resolution pipeline.`;
  return `Scratch files — PER-INGEST DIRECTORY ONLY. Several extractions run
concurrently in this container and /tmp is shared: a generic name like
/tmp/receipt_rot.jpg WILL be overwritten by a sibling agent mid-run,
and you will silently read someone else's receipt (#143 — this
happened: an agent extracted the neighbor's Trader Joe's receipt under
a Kelly's Coffee ingest and rationalized the mismatch as a stale EXIF
preview). Rules:
  - First command before any image work:
      mkdir -p ${opts.scratchDir}
    and create EVERY scratch file inside that directory.
  - If a crop/rotation ever shows a DIFFERENT merchant than your first
    read of the original upload, do NOT rationalize it (no "stale
    preview" theories). Re-read the ORIGINAL file at
    ${opts.filePath} and trust only what it shows.

Tool discipline — SEQUENTIAL Bash calls only. Issue Bash tool calls one
at a time and wait for each result before deciding the next command.
NEVER batch multiple Bash invocations into one parallel tool-call block:
if any one errors, every sibling call is cancelled mid-flight, and the
cascade of cancellations is disorienting enough to corrupt your own
extraction state (#126). One command, one result, then the next.

── Priority & effort budget — READ FIRST, governs everything below ────

This job has ONE required deliverable plus a best-effort tail. Keep them
straight, or you will burn minutes on polish while the core sits unfinished.
Trace evidence: routine receipts finish in ~7 tool calls, but some balloon
to 40+ turns — and the extra 30 turns are almost always merchant enrichment
(Google fetches, storefront photos, brand icons), NOT harder extraction.

CORE — required. Do this and commit it no matter what:
  ${core}

ENRICHMENT — best-effort, SECONDARY. You may abbreviate or SKIP any of it:
  ${enrichment} These are polish and a cache.
  You have full authority to skip them. They must NEVER:
    • block, delay, or fail the core write;
    • trigger a self-correction loop — if a step errors or a column/table
      surprises you, do NOT grind on it; record it briefly and move on;
    • keep you working once the core is committed and marginal value is low.

Spend effort PROPORTIONAL to difficulty and value. A routine receipt from
an obvious merchant should finish in a handful of tool calls. If you notice
you are many turns deep and the core is already committed, STOP enriching
and go close the ingest.

Skip heuristics — YOUR judgment, examples not an exhaustive rulebook:
  • Place already cached (Phase 3b hit) → make zero outbound Google calls.
  • Globally English-first brand with no CJK anywhere on the receipt →
    skip storefront-photo OCR AND skip downloading photos; there is nothing
    Chinese to find, so the fetch is pure waste.
  • Storefront photos are only worth downloading when you actually need
    them for CJK OCR (Phase 3d). Otherwise skip the download entirely —
    they are a nice-to-have cache, not part of a complete extraction.
  • Brand-icon resolution is optional visual polish. Do it when it is quick
    and the asset is readily found; skip it when the core is done and it is
    not. Never chase an icon across many fallback providers.
  • The FREE checks stay ON: receipt-OCR CJK (Phase 3e) and the date
    self-check (Phase 3.5 Checks A/B) cost no extra calls — always do them.
    (Phase 3.5 Check C reuses an existing geocode, so it is naturally
    skipped whenever you skipped Phase 3 — it never forces a new call.)

When you deliberately skip an enrichment step, record it so the trace shows
a decision, not a failure:
  metadata.enrichment_skipped = ['photos','brand_icon', ...]   -- reasons ok`;
}

/** Today, in the agent's own terms. Computed per render, never baked in —
 *  see `dateSelfCheck()`. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function currentYear(): number {
  return new Date().getUTCFullYear();
}

/**
 * Phase 3.5 Checks A + B — the two evidence-proven date self-checks.
 *
 * A FUNCTION, not a const, and that is load-bearing. This block tells the
 * agent what "today" is so it can sanity-check an extracted year, and a
 * hardcoded date here is worse than none: it silently teaches the agent the
 * wrong present. A `const` would freeze the date at module load, which on a
 * container that runs for weeks drifts just as badly. Date accuracy is the
 * known weak spot (#27) and this check is the mechanism meant to catch it,
 * so it evaluates on every render.
 *
 * Check C (payee cross-check via Google) is NOT here: it depends on a
 * Phase 3 geocode that only the ingest path performs, so it stays in
 * `prompt.ts`.
 */
export function dateSelfCheck(): string {
  return `── Phase 3.5 — Targeted OCR self-check (date + payee only) ────────────

Round 1 + Round 2 (40 receipts total) showed that **failures cluster
on two axes**: (a) date OCR errors (wrong year, day/month digit swaps)
and (b) payee OCR errors when a merchant name is ambiguous. Generic
"re-read the receipt" verification is net-zero — it adds prompt length
without improving digit accuracy. So this phase is **narrow and
evidence-driven**: only the two checks that provably help.

### Check A — Year sanity (30-second check, catches #27 regression)

Before committing your YYYY-MM-DD:

  1. What year did you extract? Say it out loud: "I extracted year YYYY."
  2. Today's date is ${todayISO()}, and the current year is ${currentYear()}.
  3. Is your extracted year more than 12 months before today? Receipts
     are almost always from the current or previous calendar year.
  4. If your extracted year is ${currentYear() - 2} or earlier: **LOOK AGAIN**
     at the year digit on the receipt. It is statistically extremely
     unlikely that a receipt processed today is 2+ years old.
     Common misread: "${currentYear()}" rendered as "${currentYear() - 2}" on
     faint thermal paper; the middle digit is usually '2' and it is the last
     digit that is misread.
     This is a PROMPT, not a veto — genuine old receipts exist (a backfill of
     a 2021 purchase is legitimate). Look again, then keep what the paper
     actually says.

### Check B — Multi-candidate date enumeration (catches day-digit swaps)

Receipts often have multiple date-like strings: header print date,
transaction date, auth code timestamp, rewards expiry. They're NOT
all the same date.

Before picking ONE \`occurred_on\`:

  1. List every date-like string you can see on the receipt. Examples:
       - "09/30/2025 14:22:07" (top, likely transaction time)
       - "Valid through 12/31/2025" (bottom coupon)
       - "Auth code 092525" (middle, could be date-embedded)
  2. Identify which is the transaction date. It's usually:
       - Near the top (header), OR
       - Adjacent to total/payment line, OR
       - Labeled "Date:" / "Trans Date:" / "Sale Date:"
  3. If only ONE date appears, use it. If multiple, pick by label
     proximity to total/tender.
  4. For the chosen date, verify DAY digits specifically — in US
     MM/DD/YYYY format, day digits can be transposed (30↔03, 28↔82).
     Day must be 1–31; month must be 1–12. If either violates, the
     digits are swapped.

Emit your date-candidate list in metadata:

  "date_candidates": ["09/30/2025", "12/31/2025"],
  "chosen_date_reason": "top of receipt adjacent to transaction time"`;
}

/** The mandatory `metadata.ocr_audit` provenance key. */
export const OCR_AUDIT_REQUIREMENT = `### REQUIRED metadata.ocr_audit shape

You MUST populate this key on every receipt ingest (not optional):

  "ocr_audit": {
    "ocr_raw_payee": "<what you read from the receipt header>",
    "google_name": "<what Google returned, or null if no geocode>",
    "correction_applied": true | false,
    "date_candidates": [ "...", "..." ],
    "chosen_date_reason": "...",
    "year_sanity_ok": true | false,
    "note": "optional freeform observation (e.g., thermal-paper faded, bilingual name, etc.)"
  }

An ingest without this key is considered incomplete. Emit it even
when no corrections were needed (correction_applied=false,
note="clean extraction").`;

/**
 * Curated self-evolution loop (#prompt-lessons).
 *
 * Two files, two homes, by design:
 *   • `lessons.md` — the curated, human-reviewed lesson set. VERSION-
 *     CONTROLLED: it lives next to this module (`src/ingest/lessons.md`,
 *     baked into the image at `dist/ingest/lessons.md`) and ships with the
 *     prompt. It is small, non-sensitive, non-PII, and hand-curated —
 *     irreplaceable knowledge that belongs in git with a review trail, so
 *     the data-tiering "keep out of git" rule (which guards sensitive /
 *     PII / regenerable state) does not apply. Read fresh per call; lines
 *     starting with `#` are comments and are NOT injected.
 *   • `lessons.proposed.md` — the agent's raw per-run PROPOSALS (Phase 6).
 *     RUNTIME-ONLY on the mini (`/data/prompt-lessons/`, a bind-mount):
 *     ephemeral, unvetted agent output, appended to and never read back.
 *     Its path lives in `prompt.ts` (only the ingest prompt runs Phase 6).
 *
 * Flow: the agent appends a proposal → a human (via the agent-evolver
 * skill) promotes good ones into `lessons.md` as a normal repo change +
 * deploy. "agent proposes → human gatekeeps", so the prompt improves only
 * via vetted lessons, never self-poisons. Missing/empty/unreadable →
 * inject nothing (local dev without the file is fine).
 */
const ACTIVE_LESSONS_PATH =
  process.env.PROMPT_LESSONS_FILE ??
  fileURLToPath(new URL("./lessons.md", import.meta.url));

export function renderActiveLessons(): string {
  let raw = "";
  try {
    raw = readFileSync(ACTIVE_LESSONS_PATH, "utf8");
  } catch {
    return "";
  }
  // Drop comment lines (start with '#') and blanks; keep only lesson lines.
  const body = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
  if (!body) return "";
  return `
── Learned lessons (curated, human-reviewed — apply these) ────────────

Short lessons distilled from past extractions and approved by a human.
They encode real mistakes and wins from earlier runs; treat them as
high-priority guidance that overrides your default habits where they
conflict. (These are vetted rules, NOT your own proposals.)

${body}
`;
}
