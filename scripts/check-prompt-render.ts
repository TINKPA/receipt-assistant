/**
 * check-prompt-render.ts — proves the legacy extraction prompts still render
 * byte for byte as they did before wave 1 started changing the files they
 * are built from.
 *
 * WHY THIS EXISTS
 *
 * Wave 1 gives the extraction prompt a second rendering (the record
 * rendering, `writer: 'server_apply'`) built from the same template, and makes
 * `src/ingest/items-sql.ts` serve the server as well as the agent. Until the
 * legacy writer is retired, production keeps running the legacy rendering
 * (`EXTRACTION_WRITER=agent_sql`), and the A/B compares arm B against it. Both
 * only mean something if that rendering has not moved. A one-word slip in a
 * shared block changes what production does, and nothing else would notice:
 * the budget check (`check-prompt-budget.ts`) measures size, and a reworded
 * rule can keep its size.
 *
 * HOW IT WORKS
 *
 * Renders `buildExtractorPrompt` and `buildReExtractPrompt` for a fixed set of
 * contexts that together reach every branch the templates take on their
 * context (no pHash neighbour / some; decoded email or HTML text / none;
 * attachments / none; the image, PDF, `.eml` and `.html` paths), hashes each
 * rendering and compares it with `scripts/prompt-render.golden.json`.
 *
 * Every ingest context sets `writer: 'agent_sql'`. Before wave 1 the template
 * has no such field and ignores it; once it has one, these contexts select
 * the legacy rendering, and the golden — taken from the tree before any
 * prompt file changed — is what proves that rendering is still today's text.
 *
 * Four inputs vary with the machine or the day rather than with the source,
 * and are pinned or normalised before hashing:
 *
 *   build info        `buildInfo.gitSha`, `gitShortSha`, `gitBranch` and
 *                     `builtAt` become placeholders before rendering (the
 *                     templates stamp the full sha and the short one)
 *   EXTRACTION_MODEL  `CLAUDE_MODEL` is set to a sentinel before the prompt
 *                     modules load, and the rendered value becomes
 *                     `<EXTRACTION_MODEL>`
 *   lessons body      the curated lessons between the lessons preamble and
 *                     the next section header become `<LESSONS_BODY>`: the
 *                     lessons are curated data, not template text
 *   clock             `Date` is pinned to FIXED_NOW, because the date
 *                     self-check prints today's date and year
 *
 * The path variables the templates read (`PROMPT_LESSONS_FILE`,
 * `PROMPT_LESSONS_PROPOSED`, `PROMPT_ICON_PIPELINE_FILE`) are cleared so the
 * defaults render whatever the caller's environment says.
 *
 * The golden is never edited by hand and never updated to make this pass.
 * A failure means a legacy rendering changed: find the change and take it
 * out, or move it inside the record rendering. `--dump` writes the normalised
 * renderings so two trees can be diffed:
 *
 *   npx tsx scripts/check-prompt-render.ts --dump=/tmp/render-new
 *   git stash; npx tsx scripts/check-prompt-render.ts --dump=/tmp/render-old; git stash pop
 *   diff -r /tmp/render-old /tmp/render-new
 *
 * Runs in `prebuild`, after `generate-build-info.mjs` (the prompts import
 * `src/generated/build-info.ts`).
 *
 * Usage:
 *   npx tsx scripts/check-prompt-render.ts                   check (exit 1 on any difference)
 *   npx tsx scripts/check-prompt-render.ts --dump=<dir>      also write the normalised renderings
 *   npx tsx scripts/check-prompt-render.ts --update-golden   rewrite the golden (never to make a failure pass)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, "prompt-render.golden.json");

// ── Pin the inputs that are not source ────────────────────────────────

const MODEL_SENTINEL = "golden-render-model-sentinel";
process.env.CLAUDE_MODEL = MODEL_SENTINEL;
delete process.env.PROMPT_LESSONS_FILE;
delete process.env.PROMPT_LESSONS_PROPOSED;
delete process.env.PROMPT_ICON_PIPELINE_FILE;

/** The instant every rendering sees as "now". */
const FIXED_NOW = Date.parse("2026-01-15T12:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as [string | number | Date]));
  }
  static now(): number {
    return FIXED_NOW;
  }
}

// The prompt modules read `process.env` when they load, so they are imported
// only after the environment above is set.
const { buildInfo } = await import("../src/generated/build-info.js");
const { buildExtractorPrompt } = await import("../src/ingest/prompt.js");
const { buildReExtractPrompt } = await import("../src/ingest/reextract-prompt.js");
const { EXTRACTION_MODEL } = await import("../src/ingest/prompt-contract.js");

// What generate-build-info.mjs derives from the checkout and the clock.
Object.assign(buildInfo as Record<string, unknown>, {
  gitSha: "<GIT_SHA>",
  gitShortSha: "<GIT_SHORT_SHA>",
  gitBranch: "<GIT_BRANCH>",
  builtAt: "<BUILT_AT>",
});

type IngestCtx = Parameters<typeof buildExtractorPrompt>[0];
type ReExtractCtx = Parameters<typeof buildReExtractPrompt>[0];

/** The writer whose rendering this check pins. Set on every ingest context;
 *  see the header. */
type LegacyIngestCtx = IngestCtx & { writer: "agent_sql" };

// ── Fixed contexts (synthetic ids, paths and text only) ───────────────

const WS = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000a2";
const DOC = "00000000-0000-4000-8000-0000000000a3";
const INGEST = "00000000-0000-4000-8000-0000000000a4";
const TX = "00000000-0000-4000-8000-0000000000a5";
const upload = (ext: string) => `/data/uploads/${"0f".repeat(32)}.${ext}`;

const EMAIL_TEXT = `From: Example Shop <orders@example.com>
Subject: Your receipt from Example Shop
Date (envelope): 2026-01-10T18:04:05.000Z

Example Shop
Order #EX-1001
Message-ID: <synthetic-0001@example.com>
Widget  1  $10.00
Gadget (blue)  2  $4.50
Subtotal  $19.00
Tax  $1.52
Total  $20.52
Paid with Visa ending in 0000`;

const HTML_TEXT = `Example Portal
Invoice INV-0042
Service fee  $30.00
Total due  $30.00
Paid 2026-01-09`;

const ATTACHMENTS = [
  {
    path: `/tmp/${INGEST}/attachments/attachment-1.pdf`,
    filename: 'invoice "final".pdf',
    bytes: 48213,
  },
  {
    path: `/tmp/${INGEST}/attachments/attachment-2.pdf`,
    filename: "Rechnung-ü.pdf",
    bytes: 2048,
  },
];

const ingestBase = {
  writer: "agent_sql" as const,
  ingestId: INGEST,
  workspaceId: WS,
  documentId: DOC,
  userId: USER,
};

/**
 * One context per branch the ingest template takes on its context. The
 * template has no branch keyed on the file type itself; the image, PDF and
 * statement cases are separate so that a later branch keyed on it is pinned
 * from the start.
 */
const INGEST_CASES: Record<string, LegacyIngestCtx> = {
  "image": { ...ingestBase, filePath: upload("jpg"), phashNeighbors: [] },
  "image-neighbours-absent": { ...ingestBase, filePath: upload("png") },
  "image-one-neighbour": {
    ...ingestBase,
    filePath: upload("jpg"),
    phashNeighbors: [
      { documentId: "00000000-0000-4000-8000-0000000000b1", transactionId: "00000000-0000-4000-8000-0000000000c1", distance: 1 },
    ],
  },
  "image-three-neighbours": {
    ...ingestBase,
    filePath: upload("heic"),
    phashNeighbors: [
      { documentId: "00000000-0000-4000-8000-0000000000b1", transactionId: "00000000-0000-4000-8000-0000000000c1", distance: 0 },
      { documentId: "00000000-0000-4000-8000-0000000000b2", transactionId: "00000000-0000-4000-8000-0000000000c2", distance: 1 },
      { documentId: "00000000-0000-4000-8000-0000000000b3", transactionId: "00000000-0000-4000-8000-0000000000c3", distance: 2 },
    ],
  },
  "pdf-text": { ...ingestBase, filePath: upload("pdf"), phashNeighbors: [], sourceText: null, attachments: [] },
  "pdf-scanned": { ...ingestBase, filePath: upload("pdf"), phashNeighbors: [] },
  "pdf-statement": { ...ingestBase, filePath: upload("pdf"), phashNeighbors: [], sourceText: null },
  "eml-decoded": { ...ingestBase, filePath: upload("eml"), phashNeighbors: [], sourceText: EMAIL_TEXT, attachments: [] },
  "eml-decoded-attachments": {
    ...ingestBase,
    filePath: upload("eml"),
    phashNeighbors: [],
    sourceText: EMAIL_TEXT,
    attachments: ATTACHMENTS,
  },
  "eml-attachments-only": {
    ...ingestBase,
    filePath: upload("eml"),
    phashNeighbors: [],
    sourceText: null,
    attachments: ATTACHMENTS.slice(0, 1),
  },
  "eml-undecoded": { ...ingestBase, filePath: upload("eml"), phashNeighbors: [], sourceText: null },
  "eml-blank-text": { ...ingestBase, filePath: upload("eml"), phashNeighbors: [], sourceText: "  \n\t " },
  "html-decoded": { ...ingestBase, filePath: upload("html"), phashNeighbors: [], sourceText: HTML_TEXT },
  "html-decoded-neighbour": {
    ...ingestBase,
    filePath: upload("html"),
    sourceText: HTML_TEXT,
    phashNeighbors: [
      { documentId: "00000000-0000-4000-8000-0000000000b4", transactionId: "00000000-0000-4000-8000-0000000000c4", distance: 2 },
    ],
  },
};

const reExtractBase = { workspaceId: WS, documentId: DOC, transactionId: TX, userId: USER };

const REEXTRACT_CASES: Record<string, ReExtractCtx> = {
  "image": { ...reExtractBase, filePath: upload("jpg"), ocrText: null },
  "pdf": { ...reExtractBase, filePath: upload("pdf") },
  "eml-decoded": { ...reExtractBase, filePath: upload("eml"), ocrText: EMAIL_TEXT, attachments: [] },
  "eml-decoded-attachments": {
    ...reExtractBase,
    filePath: upload("eml"),
    ocrText: EMAIL_TEXT,
    attachments: ATTACHMENTS,
  },
  "eml-attachments-only": {
    ...reExtractBase,
    filePath: upload("eml"),
    ocrText: null,
    attachments: ATTACHMENTS.slice(1),
  },
  "html-decoded": { ...reExtractBase, filePath: upload("html"), ocrText: HTML_TEXT },
};

// ── Render and normalise ──────────────────────────────────────────────

const LESSONS_PREAMBLE_END = "(These are vetted rules, NOT your own proposals.)\n\n";

function normalise(rendered: string, label: string): string {
  let out = rendered;
  if (EXTRACTION_MODEL.length > 0) {
    out = out.split(EXTRACTION_MODEL).join("<EXTRACTION_MODEL>");
  }
  const start = out.indexOf(LESSONS_PREAMBLE_END);
  if (start < 0) {
    throw new Error(
      `${label}: the curated-lessons block was not found, so its body cannot be ` +
        `normalised. The check expects src/ingest/lessons.md to hold at least one lesson.`,
    );
  }
  const bodyStart = start + LESSONS_PREAMBLE_END.length;
  const bodyEnd = out.indexOf("\n── ", bodyStart);
  if (bodyEnd < 0) throw new Error(`${label}: no section header follows the lessons block`);
  return out.slice(0, bodyStart) + "<LESSONS_BODY>\n" + out.slice(bodyEnd);
}

interface Rendering {
  sha256: string;
  bytes: number;
}

function renderAll(): { ingest: Record<string, Rendering>; reextract: Record<string, Rendering>; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const ingest: Record<string, Rendering> = {};
  const reextract: Record<string, Rendering> = {};
  const record = (group: "ingest" | "reextract", name: string, text: string) => {
    texts.set(`${group}/${name}`, text);
    const r = { sha256: createHash("sha256").update(text, "utf8").digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
    (group === "ingest" ? ingest : reextract)[name] = r;
  };

  globalThis.Date = FixedDate as DateConstructor;
  try {
    for (const [name, ctx] of Object.entries(INGEST_CASES)) {
      record("ingest", name, normalise(buildExtractorPrompt(ctx), `ingest/${name}`));
    }
    for (const [name, ctx] of Object.entries(REEXTRACT_CASES)) {
      record("reextract", name, normalise(buildReExtractPrompt(ctx), `reextract/${name}`));
    }
  } finally {
    globalThis.Date = RealDate;
  }
  return { ingest, reextract, texts };
}

// ── Main ───────────────────────────────────────────────────────────────

interface Golden {
  _comment: string;
  writer: "agent_sql";
  pinned: string[];
  ingest: Record<string, Rendering>;
  reextract: Record<string, Rendering>;
}

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-golden");
  const dumpArg = argv.find((a) => a.startsWith("--dump="));

  const { ingest, reextract, texts } = renderAll();

  if (dumpArg) {
    const dir = path.resolve(dumpArg.slice("--dump=".length));
    for (const [key, text] of texts) {
      const file = path.join(dir, `${key}.txt`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    console.log(`prompt render — normalised renderings written to ${dir}`);
  }

  if (update) {
    const golden: Golden = {
      _comment:
        "SHA-256 of the legacy (agent_sql) extraction and re-extract prompt renderings for fixed " +
        "contexts, taken before wave 1 touched any prompt file. Checked in prebuild by " +
        "scripts/check-prompt-render.ts. Never edit by hand, and never update it to make the " +
        "check pass: a difference means the rendering production runs has changed.",
      writer: "agent_sql",
      pinned: [
        "buildInfo.gitSha, gitShortSha, gitBranch, builtAt -> <GIT_SHA>, <GIT_SHORT_SHA>, <GIT_BRANCH>, <BUILT_AT>",
        "EXTRACTION_MODEL -> <EXTRACTION_MODEL>",
        "curated lessons body -> <LESSONS_BODY>",
        `clock -> ${new RealDate(FIXED_NOW).toISOString()}`,
        "PROMPT_LESSONS_FILE, PROMPT_LESSONS_PROPOSED, PROMPT_ICON_PIPELINE_FILE unset",
      ],
      ingest,
      reextract,
    };
    writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n");
    console.log(
      `prompt render — golden written: ${Object.keys(ingest).length} ingest and ` +
        `${Object.keys(reextract).length} re-extract renderings`,
    );
    return;
  }

  let golden: Golden;
  try {
    golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
  } catch (err) {
    console.error(`FAIL: cannot read ${GOLDEN_PATH}: ${(err as Error).message}`);
    process.exit(1);
  }

  const problems: string[] = [];
  const compare = (group: "ingest" | "reextract", now: Record<string, Rendering>) => {
    const want = golden[group] ?? {};
    for (const name of new Set([...Object.keys(want), ...Object.keys(now)])) {
      const w = want[name];
      const n = now[name];
      if (!w) problems.push(`${group}/${name}: not in the golden (cases are never added after the golden is taken)`);
      else if (!n) problems.push(`${group}/${name}: in the golden but no longer rendered`);
      else if (w.sha256 !== n.sha256) {
        const d = n.bytes - w.bytes;
        problems.push(`${group}/${name}: rendering changed (${w.bytes} -> ${n.bytes} B, ${d >= 0 ? "+" : ""}${d})`);
      }
    }
  };
  compare("ingest", ingest);
  compare("reextract", reextract);

  const count = Object.keys(ingest).length + Object.keys(reextract).length;
  if (problems.length > 0) {
    console.error(`prompt render — ${problems.length} of ${count} legacy renderings differ from the golden:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `\nFAIL: the legacy (agent_sql) prompt is what production runs, and it must not change ` +
        `while wave 1 is in flight. Take the change out of the legacy rendering (put it ` +
        `inside the record rendering instead). Do not update the golden to make this pass. ` +
        `To see the difference, --dump=<dir> on this tree and on the base commit, then diff -r.`,
    );
    process.exit(1);
  }
  console.log(`prompt render — ${count} legacy renderings match the golden`);
}

main();
