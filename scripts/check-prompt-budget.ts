/**
 * check-prompt-budget.ts — a ratchet against silent extraction-prompt growth (#197).
 *
 * WHY THIS EXISTS
 *
 * The rendered extractor prompt grew 46x in three months — 2,860 B on
 * 2026-04-19 to 132,441 B on 2026-07-28 — and crossed the 131,071 B argv
 * ceiling, taking the backend down with `spawn E2BIG` (#194). Exactly one
 * commit in that entire history ever made it smaller.
 *
 * Nobody was careless. The crossing commit (PR #187) was *titled* as a
 * token-burn reduction, and it genuinely did cut runtime tokens by ~10x — it
 * just also added 24,273 B of prompt text, and no number anywhere moved to
 * say so. Worse, the deploy that actually broke production (`d815b31`) touched
 * no prompt file at all: it was a docker-compose fix whose rebuild shipped
 * growth accumulated across three earlier merges. Cause and symptom were
 * different commits, which is why this has to be a per-change gate and not
 * deploy-time vigilance.
 *
 * #195 moved the prompt to stdin, so the argv ceiling is gone. The condition
 * that produced the outage — unbounded, unmeasured, monotonic growth — is not.
 * The next ceiling is the context window and the token bill, and it will be
 * reached the same way: silently.
 *
 * HOW IT WORKS
 *
 * Renders both prompts with an EMPTY context so the number is a pure function
 * of committed source: reproducible, input-independent, and diffable. Compares
 * against a committed baseline and fails when the total grows past a small
 * allowance without that baseline being updated in the same commit.
 *
 * The point is not the ceiling. The point is the ratchet: growth stays
 * possible, but it can no longer be invisible. The intended workflow is
 *
 *     grow the prompt -> build fails -> npm run check:prompt-budget -- --update-baseline
 *
 * which turns an unreviewable +24 KB into a one-line `132731 -> 141002` in the
 * diff, sitting in front of a human.
 *
 * Usage:
 *   npm run check:prompt-budget                     check (exit 1 on violation)
 *   npm run check:prompt-budget -- --update-baseline rewrite the baseline
 *   npm run check:prompt-budget -- --json            machine-readable
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildExtractorPrompt } from "../src/ingest/prompt.js";
import { buildReExtractPrompt } from "../src/ingest/reextract-prompt.js";

import * as contract from "../src/ingest/prompt-contract.js";
import * as docRead from "../src/ingest/document-read-prompt.js";
import * as lineItem from "../src/ingest/line-item-prompt.js";
import * as itemsSql from "../src/ingest/items-sql.js";
import * as brandIcon from "../src/ingest/brand-icon-prompt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(HERE, "prompt-budget.baseline.json");

/**
 * Hard ceiling, ~50K tokens. Not the argv limit — that one is gone (#195).
 * This is the "no single prompt should ever be a sixth of a 200K context
 * window" line, and crossing it means something has gone structurally wrong,
 * not that a rule got longer.
 */
const PROMPT_HARD_CEILING_BYTES = 200_000;

/**
 * How much the total may grow before the baseline must be updated. Deliberately
 * small: 4 KiB is roughly one substantial new rule or worked example, which is
 * exactly the granularity at which a human should be asked "is this worth it?".
 * PR #187 added six times this in one merge.
 */
const PROMPT_GROWTH_ALLOWANCE = 4_096;

interface Baseline {
  _comment: string;
  generatedAt: string;
  totals: { ingest: number; reextract: number };
  modules: Record<string, number>;
}

/** Empty context — every field blank so the measurement is input-independent. */
const EMPTY_INGEST_CTX = {
  filePath: "",
  ingestId: "",
  workspaceId: "",
  documentId: "",
  userId: "",
  phashNeighbors: [],
} as Parameters<typeof buildExtractorPrompt>[0];

const EMPTY_REEXTRACT_CTX = {
  filePath: "",
  workspaceId: "",
  documentId: "",
  transactionId: "",
  userId: "",
  ocrText: null,
} as Parameters<typeof buildReExtractPrompt>[0];

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Size of every exported prompt fragment, by module.
 *
 * Functions are called with an empty context for the same reason the prompts
 * are. `brand-icon-prompt.ts` is enumerated explicitly because it is the
 * third-largest contributor and was missing from the original #194
 * investigation scope — the block that is not on the list is the block that
 * grows unwatched.
 */
function measureModules(): { module: string; symbol: string; bytes: number }[] {
  const out: { module: string; symbol: string; bytes: number }[] = [];
  const modules: Record<string, Record<string, unknown>> = {
    "prompt-contract.ts": contract as unknown as Record<string, unknown>,
    "document-read-prompt.ts": docRead as unknown as Record<string, unknown>,
    "line-item-prompt.ts": lineItem as unknown as Record<string, unknown>,
    "items-sql.ts": itemsSql as unknown as Record<string, unknown>,
    "brand-icon-prompt.ts": brandIcon as unknown as Record<string, unknown>,
  };

  for (const [modName, mod] of Object.entries(modules)) {
    for (const [symbol, value] of Object.entries(mod)) {
      let rendered: string | null = null;
      if (typeof value === "string") {
        rendered = value;
      } else if (typeof value === "function") {
        // Prompt fragments that need context are functions; anything that
        // throws on an empty context is not a renderable fragment, so skip it
        // rather than guess at arguments.
        try {
          const r = (value as (...a: unknown[]) => unknown)({
            scratchDir: "",
            filePath: "",
            path: modName === "document-read-prompt.ts" ? undefined : "ingest",
            ingestId: "",
            workspaceId: "",
            transactionId: "",
            txIdExpr: "",
            runExpr: "",
            merchantIdExpr: "",
            touchedPredicate: "",
          });
          if (typeof r === "string") rendered = r;
        } catch {
          continue;
        }
      }
      if (rendered !== null && rendered.length > 0) {
        out.push({ module: modName, symbol, bytes: bytes(rendered) });
      }
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-baseline");
  const asJson = argv.includes("--json");

  const ingest = buildExtractorPrompt(EMPTY_INGEST_CTX);
  const reextract = buildReExtractPrompt(EMPTY_REEXTRACT_CTX);
  const ingestBytes = bytes(ingest);
  const reextractBytes = bytes(reextract);
  const total = ingestBytes + reextractBytes;

  const blocks = measureModules();
  const byModule: Record<string, number> = {};
  for (const b of blocks) byModule[b.module] = (byModule[b.module] ?? 0) + b.bytes;
  // prompt.ts's own inline template is whatever the ingest render is not
  // accounted for by imported fragments.
  const imported = Object.values(byModule).reduce((a, b) => a + b, 0);
  byModule["prompt.ts (inline)"] = Math.max(0, ingestBytes - imported);

  if (update) {
    const next: Baseline = {
      _comment:
        "Rendered size of the extraction prompts with an EMPTY context, in bytes. " +
        "Regenerate deliberately with `npm run check:prompt-budget -- --update-baseline` " +
        "in the same commit as the prompt change, so growth arrives as a reviewable diff. " +
        "See scripts/check-prompt-budget.ts and issue #197.",
      generatedAt: new Date().toISOString(),
      totals: { ingest: ingestBytes, reextract: reextractBytes },
      modules: byModule,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
    const prev = readBaseline();
    console.log(
      `baseline updated: ingest ${prev?.totals.ingest ?? "-"} -> ${ingestBytes}, ` +
        `reextract ${prev?.totals.reextract ?? "-"} -> ${reextractBytes}`,
    );
    return;
  }

  const baseline = readBaseline();
  const baseTotal = baseline
    ? baseline.totals.ingest + baseline.totals.reextract
    : null;
  const delta = baseTotal === null ? 0 : total - baseTotal;

  if (asJson) {
    console.log(
      JSON.stringify(
        { ingestBytes, reextractBytes, total, baseTotal, delta, modules: byModule, blocks },
        null,
        2,
      ),
    );
  }

  const overCeiling = ingestBytes > PROMPT_HARD_CEILING_BYTES || reextractBytes > PROMPT_HARD_CEILING_BYTES;
  const overAllowance = baseTotal !== null && delta > PROMPT_GROWTH_ALLOWANCE;
  const failing = overCeiling || overAllowance;

  if (!asJson) {
    const pct = ((ingestBytes / PROMPT_HARD_CEILING_BYTES) * 100).toFixed(0);
    console.log(`prompt budget — ingest ${ingestBytes.toLocaleString()} B (${pct}% of ceiling), ` +
      `re-extract ${reextractBytes.toLocaleString()} B`);
    if (baseTotal !== null) {
      const sign = delta >= 0 ? "+" : "";
      console.log(`  vs baseline: ${sign}${delta.toLocaleString()} B (allowance ${PROMPT_GROWTH_ALLOWANCE.toLocaleString()} B)`);
    } else {
      console.log("  no baseline committed yet — run with --update-baseline");
    }
  }

  // Only print the attribution table when it is actionable. On a clean run it
  // is noise in the build log; on a failure it is the first thing the author
  // needs, because "the prompt grew" is useless without "this block grew".
  if (failing && !asJson) {
    console.log("\n  per module:");
    for (const [m, b] of Object.entries(byModule).sort((a, b) => b[1] - a[1])) {
      const baseB = baseline?.modules[m];
      const d = baseB === undefined ? "" : `  (${b - baseB >= 0 ? "+" : ""}${b - baseB})`;
      console.log(`    ${m.padEnd(28)} ${String(b).padStart(8)} B${d}`);
    }
    console.log("\n  largest blocks:");
    for (const b of blocks.slice(0, 10)) {
      console.log(`    ${b.symbol.padEnd(30)} ${String(b.bytes).padStart(8)} B  ${b.module}`);
    }
  }

  if (overCeiling) {
    console.error(
      `\nFAIL: a rendered prompt exceeds the hard ceiling of ` +
        `${PROMPT_HARD_CEILING_BYTES.toLocaleString()} B. This is not "a rule got longer" — ` +
        `something is structurally wrong. Do not raise the ceiling to make this pass.`,
    );
    process.exit(1);
  }
  if (overAllowance) {
    console.error(
      `\nFAIL: the prompts grew ${delta.toLocaleString()} B past the committed baseline, ` +
        `over the ${PROMPT_GROWTH_ALLOWANCE.toLocaleString()} B allowance.\n` +
        `If the growth is intended, record it:\n` +
        `    npm run check:prompt-budget -- --update-baseline\n` +
        `and commit the baseline alongside the prompt change, so the size moves in the diff ` +
        `where a reviewer can see it. That is the whole point — see #197.`,
    );
    process.exit(1);
  }
  if (!asJson) console.log("  OK");
}

main();
