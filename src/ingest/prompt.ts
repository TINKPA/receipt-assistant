/**
 * The ingest extractor prompt: one template, two renderings (wave 1;
 * docs/server-writer.md, "Two renderings of one prompt"). `ctx.writer`
 * picks one, and every write-specific block is wrapped in
 * `forWriter(writer, legacyText, recordText)` so the reading text the two
 * share has one source and the arms cannot drift.
 *
 *   agent_sql     (legacy, `PROMPT_VERSION`) — the agent writes the v1
 *                 double-entry ledger directly via the `psql` Bash tool;
 *                 Node only spawns it, waits for the ingest row to reach a
 *                 terminal status, and relays SSE events (#49). Production
 *                 runs this, and `scripts/check-prompt-render.ts` pins it
 *                 byte for byte: a change to it fails the build.
 *   server_apply  (record, `RECORD_PROMPT_VERSION`) — the agent reads and
 *                 decides, then ends its final message with one extraction
 *                 record (`src/ingest/contract/v1.ts`); the server
 *                 validates it and writes the ledger in code. No SQL, no
 *                 database, no web search, no place fetch, no icons.
 *
 * Opening words: both renderings start with "You are a v1 double-entry
 * ledger extractor", which is how `src/session-transcript.ts` tells an
 * ingest transcript from a re-extract one.
 */
import { appendFileSync } from "node:fs";
import { buildInfo } from "../generated/build-info.js";
import {
  PHASE_2_6_BRAND_DISCOVERY,
  PHASE_2_6_BRAND_NAME_RECORD,
  PHASE_4B_4C_ICON_GATE,
} from "./brand-icon-prompt.js";
import {
  PROMPT_VERSION,
  EXTRACTION_MODEL,
  NO_JSON_SCHEMA_RULE,
  PSQL_DISCIPLINE,
  dateSelfCheck,
  OCR_AUDIT_REQUIREMENT,
  OCR_AUDIT_REQUIREMENT_RECORD,
  agentHygiene,
  forWriter,
  renderActiveLessons,
  type PromptWriter,
} from "./prompt-contract.js";
import {
  ingestScratchDir,
  phase0DocumentRead,
  randomSourceDelimiter,
  renderDecodedSource,
  type DecodedAttachment,
} from "./document-read-prompt.js";
import {
  ITEM_SCHEMA,
  ITEM_SCHEMA_RECORD,
  LINE_TYPE_VOCAB_AND_NAMES,
  LINE_TYPE_VOCAB_AND_NAMES_RECORD,
  LINE_ITEM_TWO_LEVEL_RULE,
  LINE_ITEM_COVERAGE_AND_BRIDGE,
  LINE_ITEM_COVERAGE_AND_BRIDGE_RECORD,
  ALLOCATION_LOGIC,
  ALLOCATION_LOGIC_RECORD,
  LINE_ITEM_WORKED_EXAMPLES,
} from "./line-item-prompt.js";
import { renderContractForPrompt } from "./contract/v1.js";
import {
  itemsCte,
  brandFkGuard,
  productsUpsert,
  transactionItemsInsert,
  productAggregateRecompute,
} from "./items-sql.js";

export interface ExtractorPromptContext {
  /** Which rendering: `agent_sql` (the agent writes the ledger through
   *  psql) or `server_apply` (the agent hands back an extraction record
   *  and the server writes). See the module header. */
  writer: PromptWriter;
  /** Absolute path inside the container where the file was staged. */
  filePath: string;
  /** The UUID of the `ingests` row this extraction is tied to. */
  ingestId: string;
  /** Workspace scope (required for every INSERT). Not rendered in the
   *  record rendering, whose agent never handles a ledger id. */
  workspaceId: string;
  /** Pre-existing `documents` row for the uploaded file. */
  documentId: string;
  /** User owner of the workspace, used as `created_by` on transactions. */
  userId: string;
  /** Perceptually-near existing documents (#134), pHash d ≤ 2, each
   *  linked to a live transaction. Injected by the worker; candidate-
   *  surfacing evidence for the near-dup decision in Phase 4a.0. The
   *  record rendering ignores them: there the server decides duplicates
   *  and takes the neighbours as candidates itself. */
  phashNeighbors?: {
    documentId: string;
    transactionId: string;
    distance: number;
  }[];
  /** Server-decoded text of an `.eml` / HTML upload (#261). NULL for
   *  images and PDFs, which the agent reads itself. */
  sourceText?: string | null;
  /** PDF attachments of an `.eml`, already written to the scratch dir. */
  attachments?: DecodedAttachment[];
}

/** Render the pHash-neighbor context block for Phase 4a.0. */
function renderPhashNeighbors(
  neighbors: ExtractorPromptContext["phashNeighbors"],
): string {
  if (!neighbors || neighbors.length === 0) {
    return `(none — no perceptually-similar existing image was found for this
upload. The SQL candidate check below still applies.)`;
  }
  return neighbors
    .map(
      (n) =>
        `  - document ${n.documentId} (pHash distance ${n.distance}) → transaction ${n.transactionId}`,
    )
    .join("\n");
}

/**
 * Append-only proposal file the agent writes (Phase 6); never read back.
 * Runtime-only bind-mount on the mini (`/data/prompt-lessons/`):
 * ephemeral, unvetted agent output, appended to and never read back.
 *
 * Its counterpart — the curated, human-reviewed `lessons.md` that gets
 * injected INTO the prompt — lives with `renderActiveLessons()` in
 * `prompt-contract.ts`, because both prompts inject it. Only the ingest
 * prompt runs Phase 6, so the proposal path stays here.
 */
const PROPOSED_LESSONS_PATH =
  process.env.PROMPT_LESSONS_PROPOSED ??
  "/data/prompt-lessons/lessons.proposed.md";

/**
 * Phase 6 for the record rendering: its agent hands a lesson back in the
 * record's `lesson_proposal` instead of appending it itself, and the
 * server appends it here after the record is applied, in the line format
 * the legacy agent writes (`- [<classification>] <lesson>`), so the
 * curator reads one file. Best effort, like the agent's own append: an
 * unwritable file is logged and the run goes on.
 *
 * The text is untrusted and goes to a human, never back into a prompt.
 * It is still kept to one line of at most 600 characters, so one
 * proposal is one line and a document cannot fake a run of them.
 */
export function appendLessonProposal(classification: string, lesson: string): boolean {
  const kind = classification.replace(/[^a-z_]/g, "").slice(0, 40) || "unknown";
  // Control and format characters out (terminal escapes, bidi overrides,
  // lone surrogates): a curator reads this file in a terminal, and none of
  // them belongs in a one-line lesson.
  const text = [
    ...lesson
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 600)
    .join("");
  if (text === "") return false;
  try {
    appendFileSync(PROPOSED_LESSONS_PATH, `- [${kind}] ${text}\n`, "utf8");
    return true;
  } catch (err) {
    console.warn(`[lessons] could not append a lesson proposal: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Record rendering: what Phase 4's write becomes. The legacy Phase 4 is a
 * schema primer, a turn plan and SQL templates; here it is the handful of
 * judgments the server cannot make (category, signs, how it was paid,
 * where income landed), stated as the record fields that carry them.
 */
const RECORD_PHASE_4_INTRO = `── Phase 4 — The money, as fields ─────────────────────────────────────

You write no SQL and no postings. From your record the server derives
the transaction, its balanced postings, the catalog rows, the place link
and the document stamp, in one database transaction. What it needs from
you is the reading below, as fields.

Money is ALWAYS integer minor units, never a float. Never convert it:
record the currency actually printed on the receipt, and amounts in that
currency's own units — a CNY, JPY or EUR receipt, or a points redemption,
keeps its own currency. The server converts to the base currency from the
published rate for the receipt's own date (#184), or from the
programme's valuation for points (#206). A rate you guessed, or a total
you converted yourself, would be booked as if the receipt had printed it.

`;

/** Record rendering: Phase 4a.0's place. The decision tree, the pHash list
 *  and the candidate query are the server's now (docs/server-writer.md,
 *  "Attach or insert"). */
const RECORD_DUPLICATES = `**Duplicates are the server's call (#134).** The same purchase may
already be in the ledger through another copy (a re-shot photo, a
re-scanned PDF) or another evidence channel (the email for a PDF, the
invoice for a receipt). The server decides attach or insert in code,
from the identifiers, card last-4, time, total and items you hand back,
and recognises a re-forwarded email by its Message-ID itself. You do not
look for duplicates and you never say "attach": read those fields
accurately. An identifier left out, or put under the wrong key, is a
duplicate the server cannot see.

`;

/** Record rendering: how the total was paid, which decides the paying
 *  account (docs/server-writer.md, "Tenders"; `project.ts`), and
 *  the printed totals. Legacy has no counterpart: its template always
 *  credited Credit Card. */
const RECORD_PAYMENT = `**payment** — how total_minor was paid, read off the tender line. The
server picks the paying account from \`payment.method\` (the contract
below says which method books where), so the method is a reading of the
document, never a guess:
  - A card is \`card\` unless the document itself says debit: the tender
    line reads DEBIT on its own or names a debit-only network (Interac,
    Maestro, a "US DEBIT" chip label). Then it is \`debit_card\`. A label
    that names both kinds (CREDIT/DEBIT, "Credit/Debit Card") or neither
    ("bank card", "card") is \`card\`. A phone wallet (Apple Pay, Google
    Pay) pays with a card and follows the same rule.
  - \`gift_card\` is a gift card, store credit, or a balance held in an
    app or account (a store app's balance, a PayPal or Venmo balance). A
    card linked through PayPal or an app is that card, not a balance.
  - A gift card or balance is never counted as a second tender:
    total_minor is the residual (Phase 2), and the method is what paid
    the residual.
    When a gift card or balance paid the whole order, total_minor is 0
    (Phase 2) and the method is \`gift_card\`. \`mixed\` is two or more
    tenders that together paid total_minor (cash and a card, two cards);
    the server books it whole to Credit Card and flags the transaction
    for a person.
\`unknown\` when the document does not say. Copy card_last4 (exactly four
digits), card_network and the tender line itself (as_printed) when they
are printed.

**printed_totals** — the document's printed subtotal, tax, tip, discount
and fees (service, delivery and surcharges added together), in minor
units, each only when printed. The tax and the tip rows still go in
items[] as well.`;

/** Record rendering: points and miles (#206), which the legacy template
 *  teaches as a commented-out CTE. */
const RECORD_POINTS = `

**points** — an award redemption (Phase 2): facts.currency is the
programme code, facts.total_minor the points redeemed (never 0), and
\`points.programme_name\` the programme as printed. When the folio ALSO
charges cash (a resort fee, parking), add \`cash_component\`
{amount_minor, currency} for the cash part; a line priced in that cash
currency says so in its own \`currency\`. payment.method is what paid
the cash part, read as above (a card, a debit card, cash, …), or
\`points\` when there is no cash part.`;

/**
 * Record rendering: the hand-back (docs/server-writer.md, "The hand-back").
 * It replaces the legacy Phase 5 close-out, Output and Rules: the ending
 * rule, "omit rather than invent", the one repair round, and the contract
 * itself, rendered from the zod schema the validator enforces so the two
 * cannot drift.
 */
function recordHandBack(): string {
  return `── Rules ──────────────────────────────────────────────────────────────

- \`.eml\` with a PDF attachment: prefer the source with richer data
  (usually the attachment). Say which in source_used.
- Reason in plain text BEFORE writing the record. Show your arithmetic
  (the lines against the printed subtotal, tax, tip and total) so
  mistakes are visible in the session transcript.
- Every run ends with a record, an unsupported document and a statement
  included. If you cannot read the document at all, hand back
  classification \`unsupported\` with reason \`unreadable\` and a one-line
  note.

── Hand back your record ──────────────────────────────────────────────

The record is the ONE required output of this run. The server reads it
from your final message; there is no other channel. Do not write it to
a file, print it with a command, or send it anywhere.

End your FINAL message with, in this order, and nothing after it:

  1. For a photo or a PDF (text layer or page images): one
     \`\`\`receipt-text block with your full transcription of the
     document as you read it, line by line (at most 64 KB). Leave it out
     for an email or an HTML page: the server already has that text. If
     a line of the document starts with three backticks, open and close
     the block with a fence longer than any run of backticks in it
     (\`\`\`\`receipt-text … \`\`\`\`), so that line stays text.
  2. Exactly ONE \`\`\`json block holding the extraction record: one
     JSON object that starts with "contract_version": 1.
  3. Nothing after the json block's closing fence.

The shape of that ending (every value comes from the document):

  ...your reasoning, the arithmetic and the self-checks...

  \`\`\`receipt-text
  <the document's text, as printed>
  \`\`\`

  \`\`\`json
  {"contract_version": 1, "classification": "receipt_image", "source_used": "image", "facts": {...}, ...}
  \`\`\`

Writing the record:

  - Reason first, then write it once, at the very end. It is the
    conclusion of the reading above, written after it: not the
    structured-output mode ruled out after Phase 1b, and not a form to
    fill in instead of reading.
  - Strict JSON: double quotes, no comments, no trailing commas, no
    "..." placeholders. (The worked examples above carry // notes for
    you; the record never does.)
  - OMIT RATHER THAN INVENT. A field the document does not show is left
    out, or null where null is allowed. Never fill one with a guess to
    make the record look complete: an empty field is honest, an invented
    one is a silent lie the ledger keeps.
  - Only the keys listed below, nested as shown. A metadata key named in
    an earlier section or a lesson is not a record key: a printed
    reference goes in other_references, any other printed fact worth
    keeping (operator entity, table number, total basis) in
    receipt_facts, a problem for a person in audit.review_flags
    (date_unresolved, needs_review, …), an observation in audit.note.
  - source_used says what you read: image, pdf_text, pdf_raster,
    email_body, email_attachment or html.
  - Where the earlier sections' names go:
        payee, occurred_on, occurred_at, total_minor, currency  → facts
        the Phase 1b money direction                            → facts.flow
        category_hint, the Phase 2.5/2.6 fields, Phase 3e       → merchant
        Phase 3a's place id                                     → place
        the Phase 3.5 / Check C self-check                      → audit
        order, confirmation, invoice, payment, approval numbers → identifiers
        4a-bis owned items              → items[].track_as_owned, sold_item
        4a-ter parties                                          → parties
        4b statement rows                                       → statement_rows
        raw_text                                                → receipt-text block
        the Phase 6 lesson                                      → lesson_proposal

The server may send ONE list of problems back. It validates the record,
and when something structural is wrong (a key the contract does not
have, a date that does not exist, a sign that contradicts the flow) it
replies in this same session with a list naming each field and rule.
Then re-read the document where it says, fix ONLY the fields it names,
and end that reply with the full corrected record again, the
receipt-text block too if you gave one. It never tells you a value;
never change a field it did not name to make the list go away.

${renderContractForPrompt()}

Remember: your final message ends with the optional \`\`\`receipt-text block
and exactly one \`\`\`json record, with nothing after it.
`;
}

export function buildExtractorPrompt(ctx: ExtractorPromptContext): string {
  const scratchDir = ingestScratchDir(ctx.ingestId);
  /** This block's legacy text, or the record rendering's. */
  const w = (legacy: string, record: string) => forWriter(ctx.writer, legacy, record);
  const record = ctx.writer === "server_apply";
  return `You are a v1 double-entry ledger extractor. You will classify a
financial document, extract its fields, optionally geocode the merchant,
and ${w(
    `**write the result directly into Postgres** via the psql Bash tool.
Node is not doing any DB writes — you are the only writer.`,
    `**hand the result back as one extraction record** at the end of your
final message. You read and decide; the server writes. You have no
database. Never write SQL.`,
  )}

── Context ─────────────────────────────────────────────────────────────

File path (inside this container):
  ${ctx.filePath}

${w(
  `Context variables for SQL:
  INGEST_ID     = '${ctx.ingestId}'
  WORKSPACE_ID  = '${ctx.workspaceId}'
  DOCUMENT_ID   = '${ctx.documentId}'
  USER_ID       = '${ctx.userId}'

${PSQL_DISCIPLINE}

Optional: if you want to discover schema details, \`\\d\` works:
  psql "\$DATABASE_URL" -c "\\d transactions"

Do NOT spend a turn listing \`accounts\`. The names are fixed (Phase 4
primer) and every id is resolved inline as a CTE in the write, so that
query cannot tell you anything the prompt has not already told you.`,
  `The server already knows which upload, document and workspace this is,
and supplies every id itself. You never see a ledger id and never write
one, in the record or anywhere else.`,
)}

${agentHygiene({ scratchDir, filePath: ctx.filePath, path: "ingest", writer: ctx.writer })}
${renderActiveLessons({ writer: ctx.writer })}
${phase0DocumentRead({ filePath: ctx.filePath, scratchDir })}
${renderDecodedSource(
  ctx.sourceText,
  ctx.attachments,
  record ? { writer: ctx.writer, delimiter: randomSourceDelimiter(ctx.sourceText) } : {},
)}
── Phase 1 — Classify ─────────────────────────────────────────────────

Follow the document-reading rules above FIRST — for a PDF that means
the text file, never the PDF itself (the Read tool rasterizes PDFs into
images). Then decide which category:

  receipt_image   photo/scan of a physical receipt
  receipt_email   .eml / .html purchase confirmation (Amazon, Uber, …)
  receipt_pdf     PDF of a single receipt or invoice
  statement_pdf   credit-card or bank statement with many line items
  unsupported     anything else (W-2, menu, junk, illegible, non-financial)

That axis is the document's FORMAT. Now decide the second axis, which
way the money moved. They are independent: a refund confirmation email
is \`receipt_email\` + \`refund\`.

── Phase 1b — Money direction (#221) ──────────────────────────────────

  purchase   money left the user. The overwhelming default.
  refund     money came BACK to the user because a purchase was undone
             or reduced — a return, a cancelled order, a price
             adjustment, a service credit, a warranty reimbursement, a
             chargeback, a duplicate charge reversed.
  income     money came IN and no purchase of the user's is being
             undone — selling or trading in a device (buyback, "we pay
             you $525 for your drone"), a payout, an insurance claim
             settlement, a rebate on something never bought here.
  transfer   money moved between the user's OWN pockets, or to another
             person, with nothing bought or sold — Zelle / Venmo /
             WeChat P2P, a gift-card or stored-value top-up, a bank-to-
             bank move. NOT SUPPORTED YET: classify the document
             \`unsupported\` with reason ${w(
               `"transfer — not spend, not
             income" and stop`,
               `\`transfer\` (note: "transfer — not
             spend, not income") and stop`,
             )}. Do not force it into one of the others.

**A refund is NOT income**, and the test that separates them is: **was
something the user bought being undone?** Returning a drone you bought
→ refund. Selling a drone you already owned → income. The document can
look identical; only that question decides. A refund is the user's own
money coming back, so it nets against the category the purchase used;
calling it income would inflate income and spend at once and leave that
category overstated forever.

Borderline calls, decided:
  - Trade-in credit INSIDE a purchase (phone traded toward a new one,
    one receipt, one net total) → \`purchase\` at the net total. That is
    a discount line, not a separate income event.
  - Insurance / purchase-protection payout → \`income\`. The purchase
    stands; this is new money.
  - Deposit returned (rental, utility) → \`refund\`.
  - A statement's credit rows → per-row in 4b, not here.

${NO_JSON_SCHEMA_RULE}

── Phase 2 — Extract ──────────────────────────────────────────────────

For receipt_image / receipt_email / receipt_pdf, pull out${w(
  "",
  ` (into the
record's \`facts\` block, unless noted)`,
)}:

  payee         : merchant name as printed on the document
  occurred_on   : date in YYYY-MM-DD form (read from the document —
                  NEVER fall back to today's date). If year is missing,
                  infer from nearby context (statement period etc.).
  occurred_at   : ${w(
    `timestamp YYYY-MM-DD HH:MM:SS+TZ if a time is
                  printed; NULL otherwise`,
    `local date-time with its UTC offset, ISO-8601
                  (2026-01-31T14:05:00-08:00), if a time is printed;
                  null otherwise. The offset is the merchant's own on
                  that date, and the date part equals occurred_on.`,
  )}
  total_minor   : the receipt's FINAL "Grand Total" — the amount actually
                  charged — in the currency's minor unit (integer cents for
                  USD, whole units for JPY). Include handwritten tips.
                  ⚠ Read the GRAND TOTAL line, never the item subtotal.
                  Gift card / store credit / prepaid balance: total_minor is
                  the printed residual Grand Total (0 if it covers the whole
                  order) — that money was counted when the card was loaded.
                  ⚠ LOYALTY POINTS AND MILES ARE NOT THAT CASE (#206). An
                  award redemption is real spend in a non-cash currency, so
                  never zero it: total_minor = the number of points/miles
                  redeemed (40500, not 0) and \`currency\` = the programme
                  code. A stay paid with both points and cash gets BOTH: the
                  points as total_minor/currency, the cash charge as ${w(
                    `a second
                  posting pair (see Phase 4a)`,
                    `the
                  record's cash_component (see Phase 4)`,
                  )}.
                  ⚠ SIGN — a \`refund\` (Phase 1b) carries a NEGATIVE
                  total_minor, and so does every items[] line and its
                  tax: a $28.86 refund is -2886, not 2886. The sign is
                  what nets the money back out of its category, and
                  ${w("Phase 4a's template needs", "the server needs")} no other change to book it.
                  \`income\` keeps total_minor POSITIVE — that path
                  changes the posting PAIR, not the sign.
  currency      : ISO 4217 code (USD, CNY, EUR, JPY, …). Detect from
                  symbols: \$→USD, €→EUR, £→GBP, ¥ needs context
                  (CNY vs JPY).
                  For a points/miles redemption use the programme code
                  instead: uppercase issuer + \`_PT\`, ≤16 chars. World of
                  Hyatt → HYATT_PT, Marriott Bonvoy → BONVOY_PT, AA miles →
                  AA_PT. The same programme MUST always get the same code.${w(
                    "",
                    `
  total_printed : the grand total exactly as printed, symbol and
                  separators included ("$1,234.56", "¥5,000"). The server
                  only uses it to check the scale of total_minor.`,
                  )}
  category_hint : ${w("", "(in merchant) ")}one of
                  groceries | dining | retail | cafe | transport | other
                  (vehicle repair / maintenance / parts / fuel / parking →
                  transport — the same "car spending" axis as the
                  "Transportation" merchant category; never "other" for a
                  vehicle expense.)
  items         : REQUIRED structured line-item array (#81). Each
                  item is one object with the exact shape below;
                  the array MUST be non-empty for receipt_image /
                  receipt_email / receipt_pdf. Statement PDFs
                  ${w(
                    `continue to skip items (each statement row IS a
                  transaction, no sub-itemization possible).`,
                    `skip items: their rows go in statement_rows (4b).`,
                  )}
  raw_text      : full transcription (${w(
    "written to \`documents.ocr_text\`",
    "the \`\`\`receipt-text block of the\n                  hand-back, for a photo or a PDF",
  )})

${w(ITEM_SCHEMA, ITEM_SCHEMA_RECORD)}

${w(LINE_TYPE_VOCAB_AND_NAMES, LINE_TYPE_VOCAB_AND_NAMES_RECORD)}

${w(LINE_ITEM_COVERAGE_AND_BRIDGE, LINE_ITEM_COVERAGE_AND_BRIDGE_RECORD)}

${LINE_ITEM_TWO_LEVEL_RULE}

${LINE_ITEM_WORKED_EXAMPLES}

${w(
  `For statement_pdf, pull rows: { date, payee, amount_minor }.

For unsupported, record a short reason.`,
  `For statement_pdf, pull every row into statement_rows (see 4b).

For unsupported, fill \`unsupported\`: a reason and a one-line note.`,
)}

${w(ALLOCATION_LOGIC, ALLOCATION_LOGIC_RECORD)}

── Phase 2.5 — Merchant canonicalization (#64) ────────────────────────

For receipt_image / receipt_email / receipt_pdf only. After extracting
the payee, emit a \`merchant\` block — the aggregation key for the
frontend merchant page (see \`receipt-assistant-frontend#33\`). This is
the most attention-sensitive new ask in the prompt; keep it terse.

  canonical_name : the brand's display name with store ID / location /
                   punctuation suffixes stripped. Single independent
                   merchants keep their full name.
                     "Costco #479"             → "Costco"
                     "STARBUCKS STORE 12345"   → "Starbucks"
                     "Apple Store, Pasadena"   → "Apple Store"
                     "secure8.store.apple.com" → "Apple Store"
                     "Wing Hop Fung Sawtelle"  → "Wing Hop Fung"
                     "Wang Fu 王府饭店"        → "Wang Fu" (drop CJK
                       parenthetical if a Latin name is present; if
                       only CJK, use Hanyu Pinyin without tones)
  brand_id       : kebab-case stable identifier. ${w(
    `ASCII lowercase, digits,
                   hyphens. Regex: ^[a-z0-9-]+$`,
    `ASCII lowercase letters
                   and digits joined by single hyphens (no leading,
                   trailing or doubled hyphen), at most 64 characters.`,
  )}
                   The SAME brand MUST always collapse to the SAME id —
                   "Costco", "Costco #479", "COSTCO WHOLESALE" → all
                   "costco". Strip CJK/accents (Pinyin for Chinese,
                   Romaji for Japanese).
                     "Apple Store"     → "apple-store"
                     "The UPS Store"   → "the-ups-store"
                     "Urth Caffé"      → "urth-caffe"
                     "王府饭店"        → "wang-fu"
  category       : one of "Food & Drinks" | "Transportation" | "Shopping"
                   | "Travel" | "Entertainment" | "Health" | "Services".
                   This is the per-transaction 7-class taxonomy used by
                   the frontend Dashboard — NOT the same axis as
                   \`category_hint\` above (groceries/dining/retail/…).
                   For a genuinely multi-purpose merchant it is OK to
                   land in different categories on different receipts
                   (Costco warehouse → Shopping; Costco gas →
                   Transportation). But a SINGLE-purpose merchant (an auto
                   shop, a pharmacy) must stay in its ONE category on every
                   receipt. If you have resolved this merchant before, keep
                   the category you gave it last time unless the receipt
                   clearly shows a different KIND of spend.
                   Mapping crib:
                     dining/cafe/groceries/bakery   → "Food & Drinks"
                     retail/department/apparel     → "Shopping"
                     gas/transit/parking/rideshare → "Transportation"
                     auto repair/service/parts/tires/smog/oil/towing → "Transportation"
                     pharmacy/medical/dental       → "Health"
                     shipping/subscriptions/utilities/rent/laundry → "Services"
                     concerts/movies/streaming     → "Entertainment"
                     hotel/flight/cruise           → "Travel"

                   ── category is the KIND of spend, NOT the item_class ──
                   This category (= the expense account = the Dashboard
                   icon) answers "what kind of purchase is this whole
                   payment?" It is chosen from the MERCHANT / what was
                   bought, and is INDEPENDENT of the per-line item_class.
                   An auto shop is "Transportation" (money spent on your
                   car) EVEN THOUGH every labor line inside is
                   item_class='service' and the parts are
                   'consumable'/'durable'. Do NOT let "the lines are
                   services" pull the whole transaction into "Services" —
                   that is the #1 mistake on auto-repair receipts.

${w(
  `The merchant block goes into the transaction's \`metadata.merchant\` JSON
key (see the Phase 4 template).`,
  `The merchant block is the record's \`merchant\` object: canonical_name,
brand_id and category always, and category_hint, brand_name, domain_hint
and name_zh_printed when you have them.`,
)}

${w(PHASE_2_6_BRAND_DISCOVERY, PHASE_2_6_BRAND_NAME_RECORD)}

For receipt_image / receipt_email / receipt_pdf only. Skip for
\`statement_pdf\` (handled per-row in Phase 4b) and \`unsupported\`.

${w(
  "── Phase 3 — Resolve place + fetch multilingual record (#74) ──────────",
  "── Phase 3 — Resolve the merchant's place (#74) ──────────────────────",
)}

BUDGET GATE (see the Priority & effort-budget preamble): this ENTIRE
phase is best-effort enrichment. Skip it whenever the core is what
matters — ${w("a cached place, ", "")}an obvious non-CJK global brand, or when you
are already many turns deep. Everything below is "do it if it is cheap
and adds value", never "do it no matter what".

${w(
  `Goal: get a stable \`google_place_id\` for the merchant, fetch its full
multilingual record from Google v1, cache locally. If the place is
Chinese-named and Google text doesn't carry the Chinese, OCR the
storefront photo for the CJK characters. Local-first — every step
checks the DB before paying Google.`,
  `Goal: a stable \`google_place_id\` for the merchant, and nothing more.
The server keeps the place cache: it fetches the full multilingual
Google record for that id itself (or finds it cached), stores it and
links it. You resolve the id; you never fetch the place record.`,
)}

For receipt_image / receipt_email / receipt_pdf only. The API key is
in the GOOGLE_MAPS_API_KEY environment variable.

### Phase 3a — Resolve google_place_id

Decision tree (stop at first match):

  (a) \$GOOGLE_MAPS_API_KEY is empty → skip the rest of Phase 3.
  (b) Receipt shows a full street address → Geocoding API:

        ADDR='1380 Stockton St, San Francisco, CA 94133'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$ADDR")
        curl -sS "https://maps.googleapis.com/maps/api/geocode/json?address=\$QS&language=zh-CN&key=\$GOOGLE_MAPS_API_KEY"

      Use the top result's \`place_id\`. ${w(
        'Source = "google_geocode".',
        'place.resolved_via = "geocode_address".',
      )}
      Note \`language=zh-CN\` — Google returns localized name when it has
      one (e.g. Wing Hop Fung at 725 W Garvey returns
      "Wing Hop Fung(永合丰)Monterey Park Store" instead of plain
      "Wing Hop Fung").

      QUALITY GATE — geocoding resolves an ADDRESS, not a BUSINESS, and a
      street address is not a merchant (#203). If the top result's
      \`types\` contains "premise", "subpremise", "street_address" or
      "route", you have found the BUILDING the merchant sits in. Do NOT
      accept it. Fall through to (c) and re-query by name, then:
        keep the (c) result when it returns a candidate whose
        formatted_address passes the same locality validation below;
        keep the (b) premise ONLY if (c) also fails.
      Symptom this prevents: the transaction links to a place with no
      business name, no rating, no phone, no photos and no hours — which
      is every field the place record exists to hold. Reported 10 times
      independently across hotels, Costco warehouses, restaurants and
      auto shops, with zero counter-examples.

  (c) Address missing, OR (b) hit the quality gate → Find-Place-From-Text.
      With a full address in hand, query "<merchant name> <locality>":

        Q='Wing Hop Fung Monterey Park'
        QS=\$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip()))' <<< "\$Q")
        curl -sS "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=\$QS&inputtype=textquery&fields=place_id,name,formatted_address&language=zh-CN&key=\$GOOGLE_MAPS_API_KEY"

      Use candidates[0].place_id. ${w(
        'Source = "google_places".',
        `place.resolved_via = "find_place_text"
      ("find_place_phone" when you searched by phone number,
      inputtype=phonenumber).`,
      )}

  (d) Only merchant name, no locality anywhere on receipt → skip the
      rest of Phase 3. Bare names like "Costco" resolve to random
      branches.

Validation: top result's formatted_address MUST contain a locality
token from the receipt (city, state abbr, or ZIP). No match → skip.
Any non-OK status / HTTP error → skip. Phase 3 is best-effort.

${w(
  `### Phase 3b — Local-first cache check

Before hitting any v1 endpoint, check whether we already have this
place cached. Do NOT spend a psql call of your own here: this lookup
is result set ② of the ONE consolidated read (**Turn A**, Phase 4.0
below). Run Turn A now — you have the \`<PLACE_ID>\` from 3a, which is
all it was waiting for — and read its answer.

If Turn A's ② returned a row (the place is cached):
  - SKIP Phase 3c entirely. No outbound Google calls.
  - You do NOT need the returned id in hand: the \`place\` CTE inside
    Turn B upserts on \`google_place_id\` and feeds \`tx.place_id\`
    inline, so it handles insert-new and increment-existing alike.

Only when Turn A's ② returned no row do you proceed to 3c.

### Phase 3c — Dual-language v1 fetch + photos

For uncached places, run TWO v1 \`places/{id}\` calls in sequence — once
in en, once in zh-CN — using the wildcard FieldMask so we capture every
field for the local cache:

  PID='<google_place_id>'
  for L in en zh-CN; do
    curl -sS "https://places.googleapis.com/v1/places/\$PID?languageCode=\$L" \\
      -H "X-Goog-Api-Key: \$GOOGLE_MAPS_API_KEY" \\
      -H "X-Goog-FieldMask: *" \\
      > /tmp/place_\${L}.json
  done

Extract these fields for the SQL upsert (read both files):

  From the en response:
    display_name_en          ← .displayName.text
    formatted_address_en     ← .formattedAddress
    primary_type             ← .primaryType
    types[]                  ← .types
    business_status          ← .businessStatus
    business_hours           ← .regularOpeningHours (jsonb verbatim)
    time_zone                ← .timeZone.id
    rating                   ← .rating
    user_rating_count        ← .userRatingCount
    national_phone_number    ← .nationalPhoneNumber
    website_uri              ← .websiteUri
    google_maps_uri          ← .googleMapsUri
    postal_code              ← .postalAddress.postalCode
    country_code             ← .postalAddress.regionCode
    lat, lng                 ← .location.{latitude,longitude}
    photos[]                 ← .photos (array of {name, widthPx, heightPx, authorAttributions})

  From the zh-CN response — store ONLY when the response carries
  actual Han characters. The check has two parts:
    (i)  \`.displayName.languageCode\` starts with \`zh\` AND is NOT
         \`zh-Latn\` / \`zh-Latn-pinyin\` (those are romanizations);
    (ii) \`.displayName.text\` contains at least one CJK Unified
         Ideograph (U+4E00–U+9FFF). Without this Google sometimes
         returns the Latin name under a \`zh\` locale tag for places
         that have no native Chinese name (e.g. "Costco" tagged
         \`zh\`). Treat those as no-zh.

  If both checks pass, run these TWO STEPS — do not skip Step A:

    Step A — STRIP \`.displayName.text\` down to the brand-identity
             CJK substring. Google's zh-CN field often returns a
             verbose mixed string; you MUST NOT store it verbatim.
             Discard surrounding Latin, parentheses, brackets, and
             branch / store-locator suffixes; keep only the longest
             contiguous CJK run that reads as the brand name:

      "Wing Hop Fung(永合豐)Monterey Park Store"  →  "永合豐"
      "Jiu Ji Dessert (九记八方甜品）"            →  "九记八方甜品"
      "Starbucks 星巴克"                          →  "星巴克"
      "永合豐"                                    →  "永合豐"   (already clean)

      If no CJK substring remains after stripping (whole input was
      Latin), set display_name_zh = NULL and skip Step B.

    Step B — assign (using the STRIPPED value from Step A, never
             the raw .displayName.text):

      display_name_zh           ← <stripped CJK substring>
      display_name_zh_locale    ← .displayName.languageCode   (e.g. "zh")
      display_name_zh_source    ← "google_text"
      display_name_zh_is_native ← see "is_native heuristic" below

  ── is_native heuristic ──

  display_name_zh_is_native distinguishes the merchant's REAL
  Chinese-market identity from a Google-only translation gloss.
  It governs whether the frontend promotes the Chinese name to
  primary in the list view.

  Default: true. Set false ONLY in the narrow case where ALL of:
    - .displayName.text from the zh-CN response is pure CJK
      (no Latin chars mixed in), AND
    - .displayName.text from the en response is pure Latin
      (no CJK mixed in), AND
    - the en name is a globally-recognized English brand whose
      identity is unambiguously English-first — Costco, Walmart,
      Target, McDonald's, Whole Foods, Trader Joe's, CVS, the
      USPS, Apple, Amazon, etc. The signage at every US store
      shows the English name; the Chinese name only appears on
      Google or in mainland-China stores.

  When unsure (a brand you don't recognize as globally English-
  first), default true. The cost of a false positive (showing a
  Chinese name the user can override) is much lower than a false
  negative (hiding the actual brand identity behind a pinyin name
  like "Dong Ting Xian").

  receipt_ocr and photo_ocr sources are ALWAYS is_native=true —
  if it's printed on the merchant's own surface, it's their own
  name by definition.
    primary_type_display_zh  ← .primaryTypeDisplayName.text
    maps_type_label_zh       ← .googleMapsTypeLabel.text
    formatted_address_zh     ← .formattedAddress

  Build raw_response as:
    { "v1": { "en": <full en body>, "zh-CN": <full zh body> },
      "fetched_at": "<ISO timestamp>" }

### Phase 3d — Storefront-photo OCR fallback (only when needed)

Trigger this ONLY when BOTH:
  - Phase 3c left \`display_name_zh\` NULL (Google text has no Chinese), AND
  - You judge the merchant is likely Chinese-named (receipt OCR text
    contains CJK characters, OR the brand name reads as Cantonese/
    Mandarin transliteration). When unsure, run it — false positives
    just return null.

Procedure: download the top up to 3 photos at \`maxHeightPx=1600\`,
read them, return any CJK characters on storefront signage:

  PID='<google_place_id>'
  python3 - <<'PY' > /tmp/place_photos.txt
import json
photos = json.load(open('/tmp/place_en.json')).get('photos', [])[:3]
for i, p in enumerate(photos):
    print(f"{i}\\t{p['name']}\\t{p.get('widthPx',0)}x{p.get('heightPx',0)}")
PY

  while IFS=\$'\\t' read -r RANK NAME DIM; do
    curl -sSL "https://places.googleapis.com/v1/\$NAME/media?maxHeightPx=1600&key=\$GOOGLE_MAPS_API_KEY" \\
      -o "/tmp/place_photo_\$RANK.jpg"
  done < /tmp/place_photos.txt

Then read each downloaded photo and inspect storefront signage for
CJK. Be conservative:
  - Return the Chinese characters EXACTLY as they appear on the sign.
  - If multiple candidate strings appear (店招 + 商品标签 + 装饰),
    prefer the one that reads as a brand/shop name and is visually
    largest. Goods tags are not the store name.
  - If NO CJK is unambiguously visible on signage, return null. Do
    not transliterate from the English name. Do not guess.

When OCR yields a string:
  display_name_zh          ← that string (e.g. "永安")
  display_name_zh_locale   ← "zh"
  display_name_zh_source   ← "photo_ocr"
  display_name_zh_is_native← true   (signage is the merchant's own surface)

For every photo you DID read, record per-photo OCR provenance in metadata
(even a null result):
  metadata.photo_ocr = [
    {"rank":0,"chinese_chars":"永安","confidence":"high"},
    {"rank":1,"chinese_chars":null,"confidence":"n/a"},
    ...
  ]

Photos are a best-effort cache, NOT part of a complete extraction. Only
download them when Phase 3d actually needs them for CJK OCR (per the
budget preamble) — if there is no Chinese name to hunt for, skip the
download entirely. When you DID download for OCR, Phase 4 inserts a
\`place_photos\` row per photo with the local file_path and the OCR
fallback adds the \`ocr_extracted\` jsonb to the photos it read; if you
skipped the download, skip the \`place_photos\` insert too.

`,
  `Report what you found in the record's \`place\` block:
\`google_place_id\` (null when nothing passed the checks above),
\`resolved_via\` (\`none\` when you skipped Phase 3 or nothing passed),
and \`address_printed\` — the address exactly as the document prints it,
whenever it prints one, even when you skipped the lookup.

### Phase 3b–3d — The place record is the server's

Do NOT fetch the Google place record (the v1 Places API), do not
download place photos, and do not OCR storefronts. With your id the
server checks its cache, fetches the place in English and Chinese,
derives the names and links it. You never see that record: where a
lesson checks one of its fields (websiteUri), use only what Phase 3a's
own responses showed you.

`,
)}${w(
  `### Phase 3e — Receipt-OCR CJK fallback (last-resort, free)

When Phase 3c and 3d both leave \`display_name_zh\` NULL, but the
receipt itself prints the merchant name in CJK, use that.`,
  `### Phase 3e — The merchant's Chinese name, as printed (free)

When the receipt itself prints the merchant name in CJK, report it: the
server uses it whenever Google has no Chinese name for the place.`,
)} This is
the common case for small vendors inside a plaza: the Google place
resolves to the plaza's geocoded street address (no displayName.zh,
no storefront photos), yet the receipt's letterhead shows e.g.
"小玲锅巴土豆 / XIAO LING CRISPY POTATO BITES".

Trigger when ${w(
  `ALL of:
  - \`display_name_zh\` is still NULL after 3c/3d, AND`,
  "BOTH:",
)}
  - The receipt OCR text contains CJK Unified Ideographs
    (U+4E00–U+9FFF, also U+3400–U+4DBF, U+20000+), AND
  - You can identify a contiguous CJK substring that reads as the
    merchant's name (i.e. appears in the letterhead / payee /
    branding area, not in item descriptions or addresses).

Procedure:
  1. Look at the payee region of the receipt — top-of-receipt
     letterhead, store-name banner, or whatever you used to extract
     the Latin \`payee\`. Find the CJK substring that names the
     merchant.
  2. Strip surrounding punctuation, slashes, parens, the Latin
     half, and the romanized form. Keep only the CJK characters
     that name the store. Examples:
       "小玲锅巴土豆 / XIAO LING CRISPY POTATO BITES" → "小玲锅巴土豆"
       "九记八方甜品（Jiu Ji Dessert）"               → "九记八方甜品"
       "王府饭店 WANG FU"                              → "王府饭店"
  3. If the receipt is partly Chinese but the merchant-name region
     is purely Latin (e.g. only item descriptions are in CJK),
     leave ${w("\`display_name_zh\` NULL", "merchant.name_zh_printed out")}. Don't invent a name from item
     text.

${w(
  `When the receipt yields a CJK merchant string:
  display_name_zh          ← that string (e.g. "小玲锅巴土豆")
  display_name_zh_locale   ← "zh"
  display_name_zh_source   ← "receipt_ocr"
  display_name_zh_is_native← true   (the receipt is the merchant's own surface)

Also record provenance in metadata:
  metadata.receipt_ocr_zh = {
    "chinese_chars": "小玲锅巴土豆",
    "extracted_from": "letterhead",
    "confidence": "high"
  }

This phase is FREE — it uses OCR you've already done. Always run
it before giving up on the Chinese name.`,
  `When the receipt yields a CJK merchant string, put it in
\`merchant.name_zh_printed\` (e.g. "小玲锅巴土豆").

This phase is FREE — it uses OCR you've already done. Always run it.`,
)}

${dateSelfCheck({ writer: ctx.writer })}

### Check C — Payee cross-check via Google (KEEP — evidence-proven)

Only if you geocoded successfully in Phase 3. Call Places Details to
get the business's canonical name:

  curl -sS "https://maps.googleapis.com/maps/api/place/details/json?place_id=<PLACE_ID>&fields=name&key=$GOOGLE_MAPS_API_KEY"

Compare Google's \`name\` with your OCR'd payee:

  - If case-insensitive substring OR Levenshtein distance ≤ 2 OR one
    is a longer/shorter form of the other: keep your OCR payee, record
    Google's name in ${w("metadata", "audit.google_name")} for provenance. Don't "correct" things
    that aren't broken (e.g., "Nijiya Market" ↔ "Nijiya Market
    Sawtelle Store" is fine to keep as "Nijiya Market").
  - If they differ substantially AND Google's name is clearly the
    same business (the address matches): PREFER Google's name.
    Example: OCR "King Hop Fung" + Google "Wing Hop Fung" at same
    address → correct to "Wing Hop Fung".${w(
      "",
      ` Then facts.payee is Google's
    name, facts.payee_as_printed what the receipt prints, and
    facts.payee_source "google_check_c".`,
    )}
  - If Google returns a bilingual or abbreviated name (e.g.,
    "老广的味道 Sunrise Noodle House" or "GW Supermarket" for "Great
    Wall Supermarket"): prefer the receipt's printed English/full
    form; record Google's in ${w("metadata.ocr_audit.note", "audit.note")} as context.
${w(
  "",
  `
Without a correction, facts.payee_source is "printed" (or "email_sender"
for an email that names the merchant only as its sender), and
facts.payee_as_printed the name as printed.
`,
)}
${w(OCR_AUDIT_REQUIREMENT, OCR_AUDIT_REQUIREMENT_RECORD)}

${w(
  `### REQUIRED metadata.extraction shape (provenance stamp — #88 / #80)

The transaction SQL template below already includes the
\`extraction\` key under metadata. **Do not change its values** — they
are templated from Node-side build artifacts so they describe the
prompt/model under which extraction actually ran:

  "extraction": {
    "prompt_version": "${PROMPT_VERSION}",     // bumped manually on meaningful prompt edits
    "prompt_git_sha": "${buildInfo.gitSha}",    // build-time git rev
    "model":          "${EXTRACTION_MODEL}",
    "ran_at":         NOW()                                                    // wall-clock at COMMIT
  }

Future re-extract endpoints (#91) gate eligibility on
\`prompt_version != latest\`. Leaving these wrong would mark this
transaction as already-up-to-date and skip it.

── Phase 4 — Write to the ledger ──────────────────────────────────────

v1 schema primer (workspace_id is required on every row):

  accounts        — chart of accounts; type IN (asset|liability|equity|income|expense)
                   You never need to query this table. The expense
                   account name IS the \`merchant.category\` you emit in
                   Phase 2.5 — the seven canonical names are listed once,
                   in 4.1 — and every id you need is resolved inline as a
                   CTE in the write statement itself. The other types are
                   fixed:
                     liability: Credit Card
                     asset:     Cash, Checking, Savings
                     income:    Salary, Other
                     equity:    Opening Balance
                   Each type also has a parent row (Expenses, Assets,
                   Liabilities, Income, Equity) — never post to a parent.
                   Points accounts ("World of Hyatt points", #206/#215)
                   are created on demand by the write, not seeded.
  transactions    — one per receipt (or one per statement row)
                   status IN (draft|posted|reconciled|error)
                   set status='posted' for completed receipts.
  postings        — ≥2 per transaction; SUM(amount_minor) PER currency
                   MUST EQUAL 0. Debit expense = positive; credit
                   liability/asset = negative. Enforced by deferred
                   trigger \`postings_balance_ck\` that fires at COMMIT.
  places          — shared across workspaces, keyed on google_place_id.
                   UPSERT via ON CONFLICT (google_place_id) DO UPDATE.
  document_links  — (document_id, transaction_id) PK, connects the
                   uploaded file to the transaction it produced.

Invariants you MUST honor:
  - Use a single BEGIN/COMMIT around the transaction + postings inserts
    so the deferred balance trigger fires at COMMIT on matched rows.
  - Money is ALWAYS integer minor units. Never insert floats.
  - amount_base_minor: always write it equal to amount_minor, and NEVER
    write fx_rate at all — leave that column out of your INSERT so it
    stays NULL. When the receipt is already in the workspace base
    currency (USD here) that is the final, correct answer. When it is
    NOT (a CNY / JPY / EUR receipt, or a points redemption), your value
    is a placeholder that only exists to satisfy the deferred balance
    trigger: the worker re-derives both columns straight after your run —
    from the published FX rate for the receipt's own date for cash (#184,
    src/fx/normalize.ts), from the configured programme valuation for
    points (#206, src/points/valuation.ts). \`fx_rate IS NULL\` is
    precisely the marker both look for, so a guessed rate from you would
    suppress the real conversion and leave 1 CNY (or 1 point) counted as
    1 USD in every report. Do not guess a rate, do not convert the total
    yourself, and do not "helpfully" write USD into the currency column —
    record the currency actually printed on the receipt.
  - Generate UUIDs via gen_random_uuid() inside the SQL.
  - All rows take workspace_id = WORKSPACE_ID.
  - The items[] JSON is embedded via PostgreSQL dollar-quoting
    (\`$items$<ITEMS_JSON_ARRAY>$items$::jsonb\`): drop your JSON array
    directly between the \`$items$\` markers with NO surrounding single
    quotes and NO escaping — this is what keeps apostrophes in product
    titles ("World's", 12" pan) from breaking the write. Never revert it
    to a single-quoted \`'...'::jsonb\` literal.

### 4.0 The write-phase turn plan — READ THIS BEFORE ANY WRITE

The entire ledger write is **THREE psql invocations**, not eight and
not twenty:

  Turn A — ONE read invocation, four result sets. Everything the write
           branches on.
  Turn B — ONE write invocation. The whole ledger write.
  Turn C — Phase 5, close the ingest row.

Batch statements inside each invocation with a heredoc (see the psql
discipline near the top). Every extra invocation re-sends this whole
conversation, and that round-trip cost — not the extraction itself —
is what makes a run expensive.

**Turn A.** Run it ONCE, after you have (a) your extracted fields,
(b) the Phase 2.5 merchant block, and (c) the Phase 3a geocode result
if you are doing Phase 3 at all. Phase 3a is a \`curl\`, not a psql
call, so doing it before Turn A costs you nothing and lets the place
lookup ride along. Include only the result sets that apply; keep them
in this order so you can read the output positionally:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
  -- (1) brand registry: Phase 2.6 cache check AND the Phase 4b icon
  --     pre-check, in one row per brand.
  SELECT b.brand_id, b.name, b.domain, b.user_chose_at,
         b.preferred_asset_id,
         b.metadata->>'icon_resolution' AS icon_resolution,
         (SELECT count(*) FROM brand_assets a
           WHERE a.brand_id = b.brand_id AND a.retired_at IS NULL) AS live_count
    FROM brands b
   WHERE b.brand_id IN ('<merchant brand-id>' /* , '<product brand-ids>' */);

  -- (2) place cache: Phase 3b. OMIT this query when Phase 3a produced
  --     no place id (or you skipped Phase 3).
  SELECT id FROM places WHERE google_place_id = '<PLACE_ID>';

  -- (3) Message-ID dedup: receipt_email ONLY. OMIT otherwise.
  SELECT id FROM documents
   WHERE workspace_id = '${ctx.workspaceId}'
     AND message_id = '<MESSAGE_ID>'
     AND id <> '${ctx.documentId}'
   LIMIT 1;

  -- (4) near-duplicate candidates: Phase 4a.0. Use YOUR extracted
  --     values; the ±3-day window covers settlement-date drift.
  --
  --     TWO independent candidate paths, UNIONed. Amount alone is not
  --     enough: it has zero discriminating power at $0 (#205), and the
  --     old query's "amount_minor > 0" join meant a zero-total
  --     transaction produced no rows and could never be a candidate at
  --     all — so re-uploading a $0 document wrote a new row every time.
  --     Conversely amount alone over-matches: five distinct $0 Amazon
  --     orders on one day are five real orders, not duplicates, and only
  --     the identifier can say so.
  --
  --     Branch (a) sums the leg that carries the MEANING of the
  --     transaction — expense for spend, income for earnings — picked by
  --     account type and compared SIGNED (#221). Picking it by sign
  --     broke both ways once refunds exist: a refund's positive leg is
  --     the CARD leg, so a $28.86 refund looked exactly like a $28.86
  --     purchase and could attach to the very purchase it reverses,
  --     while a second copy of that refund could never match its own
  --     earlier row. Income is negated so it compares against the
  --     POSITIVE total_minor an income document carries; an income row
  --     has no expense leg at all, so leaving it out of the join made
  --     every income transaction invisible to amount dedup. Signed
  --     comparison also subsumes the $0 case: a zero-total transaction
  --     sums to 0 and matches <TOTAL_MINOR> = 0.
  --
  --     Substitute <IDENTS> with a comma-separated quoted list of every
  --     identifier value YOU extracted, or omit branch (b) if you found
  --     none. Identifier keys are the contract in Phase 4a.0 (#204).
  SELECT * FROM (
    -- (a) same signed amount, near date — the classic re-upload of a
    --     priced receipt, and the re-upload of a refund
    SELECT t.id, t.payee, t.occurred_on, 'amount' AS matched_on,
           t.metadata->>'order_number'        AS order_number,
           t.metadata->>'confirmation_number' AS confirmation_number,
           t.metadata->>'invoice_number'      AS invoice_number,
           t.metadata->>'payment_id'          AS payment_id,
           t.metadata->>'approval_code'       AS approval_code
      FROM transactions t
      JOIN postings p ON p.transaction_id = t.id
      JOIN accounts a ON a.id = p.account_id AND a.type IN ('expense','income')
     WHERE t.workspace_id = '${ctx.workspaceId}'
       AND t.status IN ('posted','reconciled')
       AND t.deleted_at IS NULL
       AND t.occurred_on BETWEEN DATE '<YYYY-MM-DD>' - 3 AND DATE '<YYYY-MM-DD>' + 3
     GROUP BY t.id
    HAVING SUM(CASE WHEN a.type = 'income' THEN -p.amount_minor
                    ELSE p.amount_minor END) = <TOTAL_MINOR>
    UNION
    -- (b) shared identifier, ANY amount, wider window. An order number is
    --     stronger evidence than an amount and survives a re-issued or
    --     partially-refunded document, so it is not date-bounded as tightly.
    SELECT t.id, t.payee, t.occurred_on, 'identifier' AS matched_on,
           t.metadata->>'order_number', t.metadata->>'confirmation_number',
           t.metadata->>'invoice_number', t.metadata->>'payment_id',
           t.metadata->>'approval_code'
      FROM transactions t
     WHERE t.workspace_id = '${ctx.workspaceId}'
       AND t.status IN ('posted','reconciled')
       AND t.deleted_at IS NULL
       AND t.occurred_on BETWEEN DATE '<YYYY-MM-DD>' - 30 AND DATE '<YYYY-MM-DD>' + 30
       AND (t.metadata->>'order_number' IN (<IDENTS>)
         OR t.metadata->>'confirmation_number' IN (<IDENTS>)
         OR t.metadata->>'invoice_number' IN (<IDENTS>)
         OR t.metadata->>'payment_id' IN (<IDENTS>)
         OR t.metadata->>'approval_code' IN (<IDENTS>))
  ) cand
   LIMIT 10;
  SQL

psql prints the result sets in order. Read them once, then branch:
  (3) non-empty → duplicate email; skip the write entirely and go to
      Turn C with status='done' (see 4a step 1).
  (4) → walk the near-dup decision tree in 4a.0.
  (2) → Phase 3b/3c.
  (1) → Phase 2.6 discovery and the Phase 4b/4c icon cases.

Do NOT re-run any of these queries later in the run. If a result
surprises you, re-read the output you already have.

`,
  RECORD_PHASE_4_INTRO,
)}### 4a. receipt_image / receipt_email / receipt_pdf

${w(
  `**Email-only pre/post steps (receipt_email). #122.**
For \`receipt_email\`, first parse the \`.eml\` headers: From, Subject,
Date, Message-ID.

**Canonical Message-ID — read this.** The header is \`Message-ID: <id@host>\`.
Everywhere \`<MESSAGE_ID>\` appears below it means the id **with the
surrounding angle brackets stripped** (\`id@host\`, NOT \`<id@host>\`). Use this
exact bracket-free form in BOTH the dedup pre-check query AND when you store
\`documents.message_id\` / \`source_meta.message_id\`. Storing one form and
querying the other silently breaks dedup → duplicate transactions. One form,
everywhere.

(Decode the body with the tested MIME one-liner from the "Reading the
document" phase above before reading it.)

1. **Dedup pre-check — skip the WHOLE ingest if this email was already
   ingested.** A re-forwarded copy has different bytes (so the sha256
   dedup misses it) but the same Message-ID. This is result set (3) of
   **Turn A** — do not issue a separate psql call for it.

   If Turn A's (3) returned a row, do **NOT** write a transaction — go
   straight to Phase 5 (Turn C) and close the ingest as \`done\` with
   \`produced.transaction_ids = []\` and \`error = 'duplicate Message-ID'\`.
   (The \`(workspace_id, message_id)\` unique index is the hard backstop;
   this pre-check is the graceful path.)

2. **Stamping the document** with \`message_id\` / \`source_meta\` is NOT
   a separate call either — it is folded into Turn B's
   \`UPDATE documents\` statement, which runs after the transaction
   INSERT inside the same transaction. The values to put there:

       message_id  = '<MESSAGE_ID>',
       source_meta = jsonb_build_object(
         'channel', 'eml',
         'sender', '<FROM>',
         'subject', '<SUBJECT>',
         'received_at', '<RFC822 Date as ISO-8601>',
         'message_id', '<MESSAGE_ID>')

**Brand rows are FK parents — they are the first statements of Turn
B.** \`merchants.brand_id\` and \`products.brand_id\` are both FK into
\`brands\`, so both must exist before the \`m\` and \`p_upsert\` CTEs
run. Items may carry a \`product_brand_id\` distinct from the merchant's
(e.g. Apple-branded products at Best Buy → product brand = "apple",
merchant brand = "best-buy").

Each is its OWN statement inside Turn B's heredoc, never a sibling
CTE: \`WITH\` sub-statements cannot see each other's effects on target
tables, and RI checks are AFTER-ROW, so a brands row created in a
sibling CTE is not reliably visible to the FK check.

The product-brand rows are stubs (domain NULL); we don't run Phase 2.6
discovery for product brand_ids in v1. Phase 4b will skip them at the
discovery_failed check, so they cost nothing extra at ingest. They
become eligible for discovery + icon acquisition if a future ingest
sees the same brand as a merchant.

**Phase 4a.0 — Near-duplicate pre-INSERT check (#134). MANDATORY for
receipt_image / receipt_email / receipt_pdf, AFTER extraction and
BEFORE any transaction INSERT.**

The same purchase may already be in the ledger via another copy
(re-shot photo, re-scanned PDF) or another evidence channel (the email
for a PDF you're holding, the invoice for a receipt). Inserting again
double-counts the money. Decide attach-vs-insert as follows.

`,
  RECORD_DUPLICATES,
)}── Identifier keys — a CLOSED contract, not free choice (#204) ────────

A printed reference number is the single strongest dedup signal there
is: it survives a re-shot photo, a different evidence channel, a
partial refund, and a $0 total, none of which an amount survives. It
only works if the writer and the reader agree on the key, so the key
set is fixed. Store every identifier you find ${w("under EXACTLY one of:", "in \`identifiers\`, under\nEXACTLY one of:")}

  order_number         Amazon/Newegg order refs, restaurant order or
                       check numbers, POS transaction numbers
  confirmation_number  hotel and travel confirmations, booking refs
  invoice_number       invoices and folios, "Invoice #", Apple's
                       Invoice Number, contractor bills
  payment_id           processor ids — Square, Stripe, PayPal
  approval_code        card auth / approval codes

Rules that make this a contract rather than a suggestion:
  * NEVER invent a sixth key. A number under a key nobody reads is
    invisible to dedup, which is the exact failure this replaces —
    invoice_number was on 61 transactions and confirmation_number on 17,
    and the query read neither.
  * When a document prints something that fits none of them, put it in
    ${w(
      `metadata under any name you like, but ALSO copy it to the closest
    key above.`,
      `\`other_references\` under any snake_case name you like, but ALSO
    copy it to the closest key above.`,
    )} Findable beats tidy.
  * Never put a SKU, serial number, tracking number, loyalty number or
    store number in these keys. They identify a product, a shipment or a
    place — not this purchase — and dedup comparing them silently
    matches unrelated transactions.
  * Values are compared as text, verbatim as printed. Do not strip
    leading zeros, dashes or prefixes.

${w(
  `Perceptually-similar existing documents (pHash, candidate-surfacing
ONLY — same-app screenshots of DIFFERENT purchases can land here, so
the extracted fields below always decide, never this list by itself):

${renderPhashNeighbors(ctx.phashNeighbors)}

Candidate list — this is result set (4) of **Turn A**, already run with
YOUR extracted values. Do not re-query it here.

Union that result with any pHash-neighbor transactions above, then walk
this tree (tiebreaker strength: order/receipt number > payment auth
code / card last-4 > time-of-day > items list):

0. **DIRECTION GATE — before anything else (#221).** A candidate is a
   duplicate only if the money moved the SAME way. Never attach across
   directions: a refund against the purchase it reverses, income
   against the purchase of the thing sold, or a purchase against a
   refund are all DISTINCT events — INSERT, do not attach. Attaching a
   refund to its own purchase makes the reversal vanish into the row it
   was meant to undo and the money stays double-counted forever.

   Read a candidate's direction off its expense-leg sign (branch (a)
   matched it signed, so a negative-total candidate is a refund), or off
   \`metadata.flow\`. Only same-direction candidates reach steps 1-4.

   **\`refund_of\`.** A refund almost always reprints the original's
   order number, so branch (b) usually has the purchase already. When
   exactly one purchase candidate shares an identifier with this refund,
   add \`'refund_of', '<PURCHASE_TX_ID>',\` to the template's metadata
   object. Otherwise omit it — never guess from amount and date, and the
   refund nets correctly either way. It is provenance, not plumbing.

1. **No candidate** → proceed to the normal INSERT below.
2. **A candidate matches on a STRONG tiebreaker** (same order/receipt
   number, or same auth code, or same card last-4 + same time-of-day +
   same items) AND same merchant → this purchase is already in the
   ledger. Do NOT insert a transaction. Instead ATTACH:

     psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
     BEGIN;
     INSERT INTO document_links (document_id, transaction_id)
     VALUES ('${ctx.documentId}', '<EXISTING_TX_ID>')
     ON CONFLICT DO NOTHING;
     UPDATE transactions
        SET metadata = metadata || jsonb_build_object(
              'merge_audit',
              COALESCE(metadata->'merge_audit', '[]'::jsonb) || jsonb_build_object(
                'attached_document_id', '${ctx.documentId}',
                'source_ingest_id', '${ctx.ingestId}',
                'reason', '<one line: which tiebreakers matched>',
                'at', NOW()::text
              )
            )
      WHERE id = '<EXISTING_TX_ID>';
     -- receipt_email only: Turn B never runs on this branch, so stamp
     -- the document here or dedup breaks for the next forwarded copy.
     UPDATE documents
        SET message_id  = '<MESSAGE_ID>',
            source_meta = jsonb_build_object(
              'channel', 'eml',
              'sender', '<FROM>',
              'subject', '<SUBJECT>',
              'received_at', '<RFC822 Date as ISO-8601>',
              'message_id', '<MESSAGE_ID>'),
            updated_at  = NOW()
      WHERE id = '${ctx.documentId}';
     COMMIT;
     SQL

   That heredoc is the whole write for this branch — one invocation.
   Then close the ingest in Phase 5 (Turn C)
   with **status='near_dup'** and
   \`produced.transaction_ids = ['<EXISTING_TX_ID>']\`. Skip Phases
   2.6/3/4b/4c entirely — the existing transaction already carries
   merchant/place/brand data.
3. **Candidates exist but a strong tiebreaker DISAGREES** (different
   order numbers, different auth codes, or clearly different items /
   time-of-day) → genuinely distinct purchases that coincide on
   amount+date. Proceed to INSERT, and add
   \`'near_dup_check', jsonb_build_object('candidate_transaction_id','<ID>','verdict','distinct','reason','<why>')\`
   to the metadata object in the template.
4. **Candidates exist but NEITHER side has a strong tiebreaker**
   (no order number, no auth code on one or both) → NEVER attach on a
   weak match. Proceed to INSERT, and add
   \`'near_dup_check', jsonb_build_object('candidate_transaction_id','<ID>','verdict','uncertain','flagged_for_review',true,'reason','<why>')\`
   to the metadata object. A flagged duplicate is recoverable; a wrong
   merge silently loses a real purchase (#125's failure class).

Write one balanced transaction. `,
  `A refund almost always reprints the original's order number: keep it.
The server links the refund to the purchase it reverses by that number,
and never attaches one to the other.

`,
)}The expense account name is **exactly
the \`merchant.category\` value you emitted in Phase 2.5** — one of the
seven canonical accounts:

  Food & Drinks · Transportation · Shopping · Travel ·
  Entertainment · Health · Services

This is the KIND of spend (an auto shop → "Transportation"), NOT the
item_class of the lines (which stay 'service'/'consumable'/'durable').
Never let the lines being services push the whole transaction to
"Services".

\`merchant.category\` is REQUIRED — Phase 2.5 is not optional and you
must not skip it. If a merchant genuinely doesn't fit the other six
buckets, use Services as the catch-all. Never invent a new account
and never leave the category blank.

${w(
  `Mirror side is Credit Card (default).`,
  RECORD_PAYMENT,
)}

── ${w("Which posting pair", "The sign")} — by money direction (#221) ${w("─────────────────────", "───────────────────────────────")}

${w(
  `**purchase** — the template below, unchanged. Expense +TOTAL_MINOR,
Credit Card -TOTAL_MINOR.

**refund** — the same template, with TOTAL_MINOR NEGATIVE (Phase 2).
Nothing else differs: -2886 yields expense -2886 / card +2886. Use the
SAME expense account the original purchase used`,
  `**purchase** — facts.total_minor positive (or 0).

**refund** — facts.total_minor NEGATIVE (Phase 2), and so is every
items[] line and its tax: -2886, not 2886. Use the SAME merchant.category
the original purchase used`,
)} — a returned pair of
shoes comes out of Shopping, because "what did Shopping actually cost
me" is the question only netting can answer.

${w(
  `  Do NOT: post to an Income account, invent an \`Expenses:Refunds\`
  account, flip the mirror side, or write ABS() anywhere.

**income** — a DIFFERENT pair. New money has no expense side, so
replace the \`expense\` and \`credit\` CTEs with:

    income  AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'income' AND name = '<Salary|Other>' LIMIT 1),
    deposit AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'asset' AND name = '<Checking|Savings|Cash>' LIMIT 1),

and the two posting inserts become

    p1: deposit.id, <TOTAL_MINOR>     -- asset debit, POSITIVE
    p2: income.id, -<TOTAL_MINOR>     -- income credit, NEGATIVE`,
  `  Do NOT: call it income, or write the total positive.

**income** — facts.total_minor POSITIVE. The server books it to an
asset account and an income account, which you name in the \`income\`
block (deposit_account, income_account).`,
)}

Accounts: \`Other\` unless the document is genuinely payroll;
\`Checking\` unless it names where the money landed (check or ACH →
Checking, cash in hand → Cash). Never create an account for a payout
processor — PayPal / Venmo / Zelle payouts land in Checking.

Still emit the Phase 2.5 merchant block: the counterparty is a real
merchant (Jay Brokers, Assurant) and the brand graph wants it.
${w(
  `\`category\` is simply unused on an income row, since the spend rollups
join \`a.type = 'expense'\`.`,
  `\`merchant.category\` is still required; it is simply unused on an
income row.`,
)}${w("", RECORD_POINTS)}

${w(
  `Template — **this whole heredoc is Turn B: ONE Bash tool call.**
Substitute your extracted values for the placeholders; the subqueries
resolve account ids inline so you do NOT need to SELECT them first.
Statements marked OPTIONAL get deleted when they don't apply to this
receipt. Everything that stays goes in this single invocation — do not
split it back into one psql call per statement.

\`<TX>\` below means the expression

  (SELECT id FROM transactions WHERE source_ingest_id = '${ctx.ingestId}' AND workspace_id = '${ctx.workspaceId}')

— the row the \`tx\` CTE inserts in step (3). Later statements resolve
the new transaction that way, so nothing here needs its uuid echoed
back to you in a separate turn.

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
  BEGIN;

  -- (1) FK parent — the merchant's brand. Its OWN statement: a sibling
  --     CTE cannot reliably satisfy merchants.brand_id's AFTER-ROW RI
  --     check. Use the canonical_name + domain you settled in Phase 2.6
  --     (domain NULL is fine). When Phase 2.6 found no usable domain,
  --     add  metadata = jsonb_build_object('icon_resolution','discovery_failed')
  --     to the DO UPDATE list so Phase 4b skips the brand cheaply.
  INSERT INTO brands (brand_id, name, domain)
  VALUES ('<brand-id>', '<CANONICAL_NAME>', <'<domain>' | NULL>)
  ON CONFLICT (brand_id) DO UPDATE
    SET name       = EXCLUDED.name,
        domain     = COALESCE(brands.domain, EXCLUDED.domain),
        updated_at = NOW();

  -- (2) OPTIONAL FK parents — every distinct product_brand_id in
  --     items[]. Stub rows (domain NULL). Delete when no item carries
  --     a product_brand_id.
${brandFkGuard()}

  -- (3) The ledger write itself: merchant, transaction, both postings,
  --     the document link, the product catalog and the line items —
  --     ONE statement, so the deferred balance trigger sees a matched
  --     set of postings.
  WITH
${itemsCte()},
    expense AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'expense' AND name = '<EXPENSE_NAME>' LIMIT 1),
    credit  AS (SELECT id FROM accounts WHERE workspace_id = '${ctx.workspaceId}' AND type = 'liability' AND name = 'Credit Card' LIMIT 1),
    -- POINTS ONLY (#206): replace the \`credit\` CTE above with this one
    -- when <CURRENCY> is a programme code. Points cannot be credited to
    -- the USD card; they come out of a per-programme asset account, which
    -- this upsert creates on first sight of the programme.
    --   credit AS (
    --     INSERT INTO accounts (id, workspace_id, name, type, subtype, currency)
    --     VALUES (gen_random_uuid(), '${ctx.workspaceId}', '<PROGRAMME NAME> points', 'asset', 'points', '<CURRENCY>')
    --     ON CONFLICT (workspace_id, currency) WHERE subtype = 'points'
    --       DO UPDATE SET updated_at = NOW()
    --     RETURNING id
    --   ),
    -- If the folio ALSO charges cash (resort fee, parking), add a second
    -- posting pair p3/p4 in that cash currency against the real \`credit\`
    -- card account. Each currency balances within itself.
    m AS (
      INSERT INTO merchants (workspace_id, brand_id, canonical_name, category)
      VALUES ('${ctx.workspaceId}', '<brand-id>', '<CANONICAL_NAME>', '<7-class CATEGORY>')
      ON CONFLICT (workspace_id, brand_id) DO UPDATE
        SET updated_at = NOW()
      RETURNING id
    ),
    tx AS (
      INSERT INTO transactions (
        id, workspace_id, occurred_on, occurred_at, payee, status,
        source_ingest_id, merchant_id, metadata, created_by
      ) VALUES (
        gen_random_uuid(), '${ctx.workspaceId}', '<YYYY-MM-DD>',
        <'<YYYY-MM-DD HH:MM:SS+TZ>'::timestamptz | NULL>,
        '<PAYEE>', 'posted',
        '${ctx.ingestId}',
        (SELECT id FROM m),
        jsonb_build_object(
          'source', 'ingest',
          'classification', '<receipt_image|receipt_email|receipt_pdf>',
          -- Phase 1b money direction. REQUIRED on every transaction.
          -- The postings are the truth; this records the decision you
          -- made, so a wrong booking is auditable instead of having to
          -- be reverse-engineered from signs (#221).
          'flow', '<purchase|refund|income>',
          -- refund ONLY, and only when Turn A branch (b) matched a
          -- purchase on a shared identifier. Delete this line otherwise.
          'refund_of', '<PURCHASE_TX_ID>',
          'category_hint', '<CATEGORY_HINT>',
          'source_ingest_id', '${ctx.ingestId}',
          'merchant', jsonb_build_object(
            'canonical_name', '<CANONICAL_NAME>',
            'brand_id',       '<brand-id>',
            'category',       '<7-class CATEGORY>'
          ),
          'extraction', jsonb_build_object(
            'prompt_version', '${PROMPT_VERSION}',
            'prompt_git_sha', '${buildInfo.gitSha}',
            'model',          '${EXTRACTION_MODEL}',
            'ran_at',         NOW(),
            'source',         'ingest'
          ),
          -- items[] is REQUIRED for receipt_image / receipt_email /
          -- receipt_pdf per #81. Statement_pdf omits this key. Each
          -- object follows the schema in Phase 2. This reads the SAME
          -- array you already pasted into the \`raw\` CTE above — copy
          -- it from there, do not retype it differently.
          'items', (SELECT j FROM raw)
          -- add tax/tip/raw_text here if useful, as extra JSONB keys
        ),
        '${ctx.userId}'
      )
      RETURNING id
    ),
    p1 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${ctx.workspaceId}', expense.id, <TOTAL_MINOR>, '<CURRENCY>', <TOTAL_MINOR>
      FROM tx, expense
      RETURNING id
    ),
    p2 AS (
      INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
      SELECT gen_random_uuid(), tx.id, '${ctx.workspaceId}', credit.id, -<TOTAL_MINOR>, '<CURRENCY>', -<TOTAL_MINOR>
      FROM tx, credit
      RETURNING id
    ),
    dl AS (
      INSERT INTO document_links (document_id, transaction_id)
      SELECT '${ctx.documentId}', tx.id FROM tx
      ON CONFLICT DO NOTHING
      RETURNING transaction_id
    ),
${productsUpsert({ workspaceId: ctx.workspaceId, merchantIdExpr: "(SELECT id FROM m)" })},
    -- #81 Phase 2 + #84: relational line-items with product_id link
    -- and per-line allocation columns. Re-extract on the same tx
    -- bumps extraction_run and soft-deletes the prior run; this
    -- ingest path always writes the first run (run=1, retired_at=NULL).
    ti AS (
${transactionItemsInsert({
  workspaceId: ctx.workspaceId,
  txIdExpr: "tx.id",
  runExpr: "1",
  merchantIdExpr: "(SELECT id FROM m)",
  fromPrefix: "tx,",
  returning: "id, product_id",
})}
    )
  SELECT tx.id AS tx_id FROM tx;

  -- (4) Force the DEFERRABLE balance triggers to fire HERE, where psql
  --     can point at a line number, instead of at COMMIT where it
  --     cannot. If postings don't sum to zero you find out now.
  SET CONSTRAINTS ALL IMMEDIATE;

  -- (5) OPTIONAL — owned_items for the durable lines you judged worth
  --     tracking (see 4a-bis for the judgment). ONE set-based
  --     statement: list those line_no values in the ARRAY. Delete this
  --     statement entirely when no line qualifies.
  INSERT INTO owned_items (workspace_id, product_id, transaction_item_id, instance_index, acquired_on)
  SELECT '${ctx.workspaceId}', ti.product_id, ti.id, gs.idx, '<YYYY-MM-DD>'::date
  FROM transaction_items ti
  CROSS JOIN LATERAL generate_series(1, COALESCE(ti.quantity, 1)::int) gs(idx)
  WHERE ti.transaction_id = <TX>
    AND ti.retired_at IS NULL
    AND ti.line_no = ANY(ARRAY[<durable line_nos, comma-separated>]::int[])
    AND ti.item_class = 'durable'
    AND ti.product_id IS NOT NULL
  ON CONFLICT (transaction_item_id, instance_index) DO NOTHING;

  -- (5b) OPTIONAL, \`income\` flow ONLY — retire what was sold. Copy the
  --      guarded UPDATE from 4a-bis verbatim; its "exactly one live
  --      instance" count guard is not optional. Delete this statement
  --      for purchase and refund flows, which is every normal receipt.

  -- (6) Stamp the document: ties the file back to this ingest AND
  --     stores the OCR text, so \`documents.ocr_text\` is populated by
  --     BOTH the ingest and the re-extract path (it used to be
  --     re-extract only, which made every "what did the agent actually
  --     read?" question unanswerable for ingest-only documents).
  --     message_id / source_meta are the receipt_email post-step from
  --     4a step 2 — drop those two assignments for non-email uploads.
  UPDATE documents
     SET source_ingest_id  = '${ctx.ingestId}',
         ocr_text          = '<RAW_TEXT, single-quote-escaped>',
         ocr_model_version = '${EXTRACTION_MODEL}',
         message_id        = '<MESSAGE_ID>',
         source_meta       = jsonb_build_object(
                               'channel', 'eml',
                               'sender', '<FROM>',
                               'subject', '<SUBJECT>',
                               'received_at', '<RFC822 Date as ISO-8601>',
                               'message_id', '<MESSAGE_ID>'),
         updated_at        = NOW()
   WHERE id = '${ctx.documentId}';

  -- (7) products aggregate recomputation, for every product this
  --     ingest touched. Recompute, never increment (#84) — the stats
  --     then reflect the LIVE set of transaction_items immediately.
  --     total_spent_minor uses the workspace base-currency snapshot
  --     already on postings.amount_base_minor.
${productAggregateRecompute({ workspaceId: ctx.workspaceId, touchedPredicate: `t.source_ingest_id = '${ctx.ingestId}'` })}

  COMMIT;

  -- (8) AFTER COMMIT, still inside this one invocation: the party
  --     graph (see 4a-ter for which parties to record). Additive —
  --     it must never be able to roll back the transaction itself,
  --     which is why it sits after COMMIT rather than inside it.
  INSERT INTO transaction_parties
    (workspace_id, transaction_id, transaction_item_id, role, display_name, brand_id)
  VALUES
    ('${ctx.workspaceId}', <TX>, NULL, 'channel', '<as printed>', '<brand_id-or-NULL>')
    -- , line-level example:
    -- ('${ctx.workspaceId}', <TX>,
    --   (SELECT id FROM transaction_items WHERE transaction_id=<TX> AND line_no=<N> AND retired_at IS NULL),
    --   'maker', 'Anker', 'anker')
  ON CONFLICT ON CONSTRAINT transaction_parties_identity_uq DO NOTHING;

  -- (9) OPTIONAL, Phase 3 only — the place cache. Also after COMMIT,
  --     and for the same reason: Phase 3 is best-effort enrichment and
  --     a malformed Google blob must never take the ledger write down
  --     with it. Full multilingual upsert (#74): for uncached places
  --     include every column you extracted in Phase 3c/3d; for cached
  --     places the ON CONFLICT clause keeps existing per-language data
  --     and the \`custom_name\` user override (renamed from
  --     \`custom_name_zh\` in #79) and only bumps \`last_seen_at\` /
  --     \`hit_count\`. COALESCE(EXCLUDED.x, places.x) ensures a NEW
  --     fetch that returned NULL for a field never overwrites a
  --     previously-good value. Delete (9)-(11) when you have no
  --     geocode result.
  INSERT INTO places (
    id, google_place_id, formatted_address, lat, lng, source, raw_response,
    last_seen_at, hit_count,
    display_name_en, display_name_zh, display_name_zh_locale, display_name_zh_source, display_name_zh_is_native,
    primary_type, primary_type_display_zh, maps_type_label_zh, types,
    formatted_address_en, formatted_address_zh, postal_code, country_code,
    business_status, business_hours, time_zone,
    rating, user_rating_count,
    national_phone_number, website_uri, google_maps_uri
  ) VALUES (
    gen_random_uuid(),
    '<PLACE_ID>', '<FORMATTED_ADDRESS>', <LAT>, <LNG>,
    '<google_geocode|google_places>',
    '<RAW_JSON_STRING_WITH_BOTH_LANGS>'::jsonb,
    NOW(), 1,
    <NULLABLE_TEXT 'display_name_en'>,
    <NULLABLE_TEXT 'display_name_zh'>,
    <NULLABLE_TEXT 'display_name_zh_locale'>,
    <NULLABLE_TEXT 'display_name_zh_source'>,           -- 'google_text' | 'photo_ocr' | 'receipt_ocr' | NULL
    <NULLABLE_BOOL 'display_name_zh_is_native'>,        -- true unless brand is a global English-first name w/ Google gloss
    <NULLABLE_TEXT 'primary_type'>,
    <NULLABLE_TEXT 'primary_type_display_zh'>,
    <NULLABLE_TEXT 'maps_type_label_zh'>,
    <NULLABLE_TEXT_ARRAY 'types[]'>,                     -- e.g. ARRAY['store','food']::text[] or NULL
    <NULLABLE_TEXT 'formatted_address_en'>,
    <NULLABLE_TEXT 'formatted_address_zh'>,
    <NULLABLE_TEXT 'postal_code'>,
    <NULLABLE_TEXT 'country_code'>,
    <NULLABLE_TEXT 'business_status'>,
    <NULLABLE_JSONB 'business_hours'>,
    <NULLABLE_TEXT 'time_zone'>,
    <NULLABLE_NUMERIC 'rating'>,
    <NULLABLE_INT 'user_rating_count'>,
    <NULLABLE_TEXT 'national_phone_number'>,
    <NULLABLE_TEXT 'website_uri'>,
    <NULLABLE_TEXT 'google_maps_uri'>
  )
  ON CONFLICT (google_place_id) DO UPDATE
    SET last_seen_at = NOW(),
        hit_count = places.hit_count + 1,
        raw_response = EXCLUDED.raw_response,
        display_name_en          = COALESCE(EXCLUDED.display_name_en,          places.display_name_en),
        display_name_zh          = COALESCE(EXCLUDED.display_name_zh,          places.display_name_zh),
        display_name_zh_locale   = COALESCE(EXCLUDED.display_name_zh_locale,   places.display_name_zh_locale),
        display_name_zh_source   = COALESCE(EXCLUDED.display_name_zh_source,   places.display_name_zh_source),
        display_name_zh_is_native = COALESCE(EXCLUDED.display_name_zh_is_native, places.display_name_zh_is_native),
        primary_type             = COALESCE(EXCLUDED.primary_type,             places.primary_type),
        primary_type_display_zh  = COALESCE(EXCLUDED.primary_type_display_zh,  places.primary_type_display_zh),
        maps_type_label_zh       = COALESCE(EXCLUDED.maps_type_label_zh,       places.maps_type_label_zh),
        types                    = COALESCE(EXCLUDED.types,                    places.types),
        formatted_address_en     = COALESCE(EXCLUDED.formatted_address_en,     places.formatted_address_en),
        formatted_address_zh     = COALESCE(EXCLUDED.formatted_address_zh,     places.formatted_address_zh),
        postal_code              = COALESCE(EXCLUDED.postal_code,              places.postal_code),
        country_code             = COALESCE(EXCLUDED.country_code,             places.country_code),
        business_status          = COALESCE(EXCLUDED.business_status,          places.business_status),
        business_hours           = COALESCE(EXCLUDED.business_hours,           places.business_hours),
        time_zone                = COALESCE(EXCLUDED.time_zone,                places.time_zone),
        rating                   = COALESCE(EXCLUDED.rating,                   places.rating),
        user_rating_count        = COALESCE(EXCLUDED.user_rating_count,        places.user_rating_count),
        national_phone_number    = COALESCE(EXCLUDED.national_phone_number,    places.national_phone_number),
        website_uri              = COALESCE(EXCLUDED.website_uri,              places.website_uri),
        google_maps_uri          = COALESCE(EXCLUDED.google_maps_uri,          places.google_maps_uri);
        -- Note: custom_name is INTENTIONALLY OMITTED — user overrides never get overwritten by re-fetches. (Renamed from custom_name_zh in #79.)

  -- (10) OPTIONAL, Phase 3 only — #90 Phase 3: append-only history of
  --      every Google/Yelp fetch. One row per ingest that touched this
  --      place; \`places.raw_response\` is the latest pointer,
  --      \`place_snapshots\` is the full audit trail that #91 refresh
  --      will diff against. Use the SAME
  --      \`<RAW_JSON_STRING_WITH_BOTH_LANGS>\` body you passed into the
  --      \`places\` upsert above and the SAME
  --      \`<google_geocode|google_places>\` source string.
  INSERT INTO place_snapshots (place_id, source, raw_response, fetched_by_sha)
  SELECT id, '<google_geocode|google_places>', '<RAW_JSON_STRING_WITH_BOTH_LANGS>'::jsonb, '${buildInfo.gitShortSha}'
    FROM places WHERE google_place_id = '<PLACE_ID>';

  -- (11) OPTIONAL, Phase 3 only — attach the place to the transaction.
  UPDATE transactions
     SET place_id = (SELECT id FROM places WHERE google_place_id = '<PLACE_ID>'),
         updated_at = NOW()
   WHERE id = <TX> AND workspace_id = '${ctx.workspaceId}';
  SQL

If you downloaded photos in Phase 3c, insert one \`place_photos\` row
per photo. Move the temp files into the shared uploads dir under
\`/data/uploads/places/<google_place_id>/<rank>__<sha256>.<ext>\` and
record \`file_path\` accordingly:

  PID='<google_place_id>'
  PLACE_DIR="/data/uploads/places/\$PID"
  mkdir -p "\$PLACE_DIR"
  for f in /tmp/place_photo_*.jpg; do
    [ -f "\$f" ] || continue
    RANK=\$(basename "\$f" | sed -E 's/place_photo_([0-9]+)\\.jpg/\\1/')
    SHA=\$(sha256sum "\$f" | awk '{print \$1}')
    DEST="\$PLACE_DIR/\${RANK}__\${SHA}.jpg"
    mv "\$f" "\$DEST"
    SIZE=\$(stat -c%s "\$DEST" 2>/dev/null || stat -f%z "\$DEST")
    PHOTO_NAME=\$(awk -v r="\$RANK" '\$1==r {print \$2}' /tmp/place_photos.txt)
    WH=\$(awk -v r="\$RANK" '\$1==r {print \$3}' /tmp/place_photos.txt)
    W=\${WH%x*}; H=\${WH#*x}
    psql "\$DATABASE_URL" -c "
      INSERT INTO place_photos (place_id, google_photo_name, rank, width_px, height_px, file_path, mime_type, sha256, ocr_extracted)
      VALUES (
        (SELECT id FROM places WHERE google_place_id = '\$PID'),
        '\$PHOTO_NAME',
        \$RANK, \$W, \$H,
        '\$DEST', 'image/jpeg', '\$SHA',
        <jsonb_build_object('chinese_chars', '...', 'model', 'claude-...', 'confidence', '...', 'ran_at', NOW()) or NULL>
      )
      ON CONFLICT (place_id, google_photo_name) DO NOTHING;
    "
  done

`,
  "",
)}### 4a-bis. ${w("owned_items judgment", "Owned items")} (#84 Phase 2)

For each line where you set \`item_class='durable'\` AND ${w(
  `assigned a
\`product_id\``,
  `gave a
\`product_key\``,
)} AND judge the item **worth tracking as a real-world
thing**, ${w(
  "insert N owned_items rows (instance_index 1..quantity).",
  `set \`track_as_owned: true\` on it (the server creates one
owned instance per unit of quantity).`,
)}
Pure judgment, no threshold:

  - Limited-edition / luxury / high-value goods                  → YES
  - Anything with a serial number printed on the receipt          → YES
  - Items the user plausibly tracks warranty / location for       → YES
  - Cheap commodity durables ($5 hammer, basic kitchenware)       → NO
  - One-time-use durables (party plates that *technically* last)  → NO

${w(
  `Leave \`serial_number\`, \`location\`, \`warranty_until\`, \`condition\`,
\`notes\` blank — the user fills those in. \`acquired_on\` defaults to
the transaction's \`occurred_on\`.

The INSERT is statement (5) of Turn B — you do NOT run it here and you
do NOT need to query the transaction_items ids back first. Decide which
durable lines qualify, then put THOSE line_no values into the
\`ARRAY[...]\` in Turn B (5). It is ONE set-based statement for the
whole receipt, not one per line. The ON CONFLICT clause makes it safe
to re-run. Delete Turn B (5) entirely when nothing qualifies — which
is the common case: non-durable items, durables you judge not worth
tracking, and product-less lines all fall out.

`,
  `Serial number, location, warranty and condition are the user's to fill
in later. Most receipts track nothing: non-durable items, durables you
judge not worth tracking, and lines without a product_key stay unset.

`,
)}**Selling it is the other half (#221).** An \`income\` buyback / trade-in
/ resale means the user no longer owns the thing, so leaving it in
inventory is a lie they have to find and undo by hand. When the flow is
\`income\` and the document names a specific item, ${w(
  `RETIRE the matching
row instead of inserting one — statement (5b) of Turn B:

  UPDATE owned_items o
     SET retired_at = NOW(),
         condition  = COALESCE(o.condition, 'sold'),
         notes      = CONCAT_WS(' ', o.notes, 'sold via <PAYEE> <YYYY-MM-DD>'),
         updated_at = NOW()
   WHERE o.workspace_id = '${ctx.workspaceId}'
     AND o.retired_at IS NULL
     AND o.product_id = (
       SELECT p.id FROM products p
        WHERE p.workspace_id = '${ctx.workspaceId}'
          AND p.canonical_name ILIKE '<PRODUCT NAME AS SOLD>'
        LIMIT 1)
     AND (SELECT count(*) FROM owned_items o2
           WHERE o2.workspace_id = o.workspace_id
             AND o2.product_id = o.product_id
             AND o2.retired_at IS NULL) = 1;

The trailing count guard is load-bearing: retire ONLY when exactly one
live instance of that product is owned. Two identical iPhones and one
buyback receipt cannot say which one left, and retiring the wrong
instance destroys its serial / warranty / location. When the guard
suppresses the update, or no product matches, say so in
\`metadata.owned_items_note\` and leave inventory alone — an un-retired
item is a nuisance, a wrongly-retired one is lost data. For a \`refund\`
of a tracked durable, note it there too and move on; its owned_items
row hangs off the ORIGINAL purchase's transaction_item, which the
refund does not touch. Delete (5b) for purchase and refund flows.

`,
  `name it in
\`sold_item\`: \`name_as_printed\`, plus the \`product_key\` it was bought
under when you know it. The server retires the owned instance only when
exactly one live instance of that product is owned: two identical
iPhones and one buyback receipt cannot say which one left, and retiring
the wrong instance destroys its serial / warranty / location. An
un-retired item is a nuisance, a wrongly-retired one is lost data. For a
\`refund\` of a tracked durable, do nothing here: its owned instance
hangs off the ORIGINAL purchase, which the refund does not touch.
\`sold_item\` is for income only.

`,
)}### 4a-ter. ${w("transaction_parties", "parties")} — the party graph (#149 P4)

The card statement sees one merchant; the receipt sees more. Record
every party the receipt TEXT states, ${w("one row", "one \`parties\` entry")} per (role, party):

  - **channel** (${w("tx-level, transaction_item_id NULL", "transaction-level, line_no null")}): the platform /
    statement entity that took the order — what shows up as the line on
    a card statement. ALWAYS ${w("write exactly one channel row", "give exactly one channel entry")}.
    · DEFAULT (a normal in-store / single-merchant receipt): the
      channel IS the merchant you resolved in Phase 2.5 — duplicate it
      with its brand_id.
    · DELIVERY / MARKETPLACE PLATFORM ORDERS (DoorDash, Uber Eats,
      Grubhub, Postmates, Caviar; Amazon when a third-party "Sold by"
      seller is named): the **platform is the channel**, even when
      Phase 2.5 resolved the merchant to the restaurant/seller behind
      it. Detect the platform from the receipt header / email sender
      ("Your order from <restaurant>" emails are DoorDash-style). The
      restaurant/seller then becomes the **seller** row below — NOT the
      channel, and the platform is NEVER an acquirer.
  - **seller** (tx- or line-level): the party that actually sold the
    goods when it differs from the channel.
    · Platform orders: the restaurant / store behind the platform —
      i.e. the merchant Phase 2.5 resolved (tx-level seller row). On a
      bb.q Chicken order via DoorDash: channel=DoorDash,
      seller=bb.q Chicken.
    · Marketplace lines: "Sold by: AnkerDirect" (line-level).
    Same party as the channel → NO seller row.
  - **maker** (line-level): the product's brand, only when the line
    text itself states it ("Anker MagGo 610" → Anker; "KS WATER 40PK"
    → Kirkland Signature). Don't infer makers from world knowledge
    when the text doesn't name them.
  - **acquirer** (tx-level): payment PROCESSOR only — Stripe, Square,
    Adyen, Toast, Block ("Powered by Stripe"). A delivery platform
    (DoorDash etc.) is a channel, NEVER an acquirer. Rare; skip when
    absent.

${w(
  `\`display_name\` = the string as printed. \`brand_id\`: reuse the
channel's resolved brand for the channel row; for sellers/makers, set
it ONLY when a brands row already exists (check with a SELECT) or the
party is unambiguously a known brand — then upsert a brands row first
(brand_id = lowercase-hyphenated name; for a marketplace seller whose
parent brand is obvious, e.g. AnkerDirect → anker, set parent_id).
Otherwise leave brand_id NULL — a text-only row is still useful.

The INSERT is statement (8) of Turn B — you do NOT run it here. Fill in
one VALUES row per (role, party) you decided on above; line-level rows
resolve their \`transaction_item_id\` by line_no from the items Turn B
just wrote, in the same invocation.

Don't fabricate parties; a plain single-merchant receipt legitimately
produces just the one channel row. This step is additive — never let a
parties failure roll back the transaction itself, which is exactly why
Turn B places it after COMMIT rather than inside the block.

`,
  `\`display_name\` = the string as printed. \`brand_id\`: the channel's
resolved brand for the channel entry; for sellers and makers a slug
(same rules as merchant.brand_id) ONLY when the party is unambiguously a
known brand (AnkerDirect → anker). Otherwise leave brand_id null — a
text-only entry is still useful. \`line_no\`: the item's line_no for a
line-level party, null for a transaction-level one.

Don't fabricate parties; a plain single-merchant receipt legitimately
produces just the one channel entry.

`,
)}### 4b. statement_pdf

${w(
  `Loop over each row on the statement. Per row: one BEGIN/COMMIT, same
shape as 4a (expense side determined by payee name, mirror = Credit
Card). If a row's payee is ambiguous or zero-amount, skip it but log a
warning line.

Statement CREDIT rows (printed as a credit, a minus sign, or in a
"Payments and Credits" section) are refunds and take a NEGATIVE
amount_minor, which the 4a template turns into the correct reversal
with no other change (#221). Set \`metadata.flow\` = 'refund' on those
rows. The one exception is the row that PAYS the card bill — that is a
transfer, not a refund; skip it with a warning line, exactly like an
ambiguous payee.

Track every successful tx_id in a shell variable and include them all
in the final ingest close-out (Phase 5).

### 4c. unsupported

Skip every insert above. Go directly to Phase 5.

BUDGET GATE (see the Priority & effort-budget preamble): the brand-icon
resolution below is optional visual polish. Do it when it is quick and
the asset is readily found; skip it when the core is already committed
and an icon is not close at hand. Never chase an icon across many
fallback providers — one or two cheap tries, then move on and close.

${PHASE_4B_4C_ICON_GATE}


── Phase 5 — Close the ingest row (Turn C) ────────────────────────────

Regardless of classification, end with ONE invocation:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = '<done|unsupported|near_dup>',
         classification = '<classification>',
         produced = jsonb_build_object(
           'transaction_ids', ARRAY[<quoted tx_ids, comma-separated>]::text[],
           'document_ids',    ARRAY['${ctx.documentId}']::text[],
           'receipt_ids',     ARRAY[]::text[]
         ),
         error = <NULL or 'reason'>,
         completed_at = NOW()
   WHERE id = '${ctx.ingestId}'
     AND workspace_id = '${ctx.workspaceId}';
  SQL

Use status='unsupported' when classification is unsupported (set
error = <one-line reason>).

Use status='near_dup' ONLY for the Phase 4a.0 attach outcome (branch 2):
\`transaction_ids\` must contain exactly the existing transaction you
attached '${ctx.documentId}' to, and the \`document_links\` row must
already be committed — the worker verifies the link exists and forces
'error' if it doesn't. error = NULL.

If any INSERT above fails (foreign key violation, balance trigger,
constraint error), catch it and instead:

  psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<SQL
  UPDATE ingests
     SET status = 'error',
         error = '<one-line message, escape quotes>',
         produced = jsonb_build_object('transaction_ids', ARRAY[]::text[], 'document_ids', ARRAY[]::text[], 'receipt_ids', ARRAY[]::text[]),
         completed_at = NOW()
   WHERE id = '${ctx.ingestId}';
  SQL

`,
  `A statement is recorded, not booked: the server keeps your rows as
evidence and writes no transaction from them. Give every row on the
statement as one \`statement_rows\` entry: occurred_on, the description
as printed, amount_minor, currency and kind. No facts, merchant, items or
audit on a statement record.

Statement CREDIT rows (printed as a credit, a minus sign, or in a
"Payments and Credits" section) take a NEGATIVE amount_minor and kind
\`credit\`; charges are positive, kind \`charge\` (\`fee\` and
\`interest\` for those rows). The row that PAYS the card bill is kind
\`payment\`. Skip nothing: an ambiguous row is still a row.

### 4c. unsupported

No facts, merchant, items or audit. Fill \`unsupported\` with a reason
(\`not_a_receipt\`, \`transfer\`, \`marketing\`, \`unreadable\` or
\`other\`) and a one-line note on what the document is, then hand back
the record.

`,
)}── Phase 6 — Propose a lesson (optional, best-effort, human-reviewed) ──

${w(
  `After the ingest is closed, if THIS run hit something genuinely worth
remembering — a slowdown you could have avoided, an error you had to
self-correct, a schema surprise, or a skip heuristic that clearly paid
off or misfired — append ONE concise line to the PROPOSAL file:

  echo '- [<classification>] <one specific, evidence-based lesson>' \\
    >> ${PROPOSED_LESSONS_PATH} 2>/dev/null || true

`,
  `If THIS run hit something genuinely worth remembering — a slowdown you
could have avoided, an error you had to self-correct, a surprise in the
document, or a skip heuristic that clearly paid off or misfired — put
ONE concise lesson in the record's \`lesson_proposal\` field (at most
600 characters). The server appends it to the proposal file.

`,
)}This is how the extractor improves itself over time WITHOUT self-poisoning:
  • Proposals are for a HUMAN to review and promote into the curated
    lesson set that gets fed back to future runs. They are NOT active
    rules; never read this file back, never treat your own proposals as
    instructions.
  • One line, max. Be specific and evidence-based ("Costco gas prints the
    date as MM/DD in tiny type at the top-right — check there first"), not
    generic ("be careful with dates").
  • Skip this entirely on an unremarkable run. No lesson beats a noise
    lesson — the reviewer's attention is the bottleneck.${w(
      `
  • Never let this step fail or delay the run. The \`2>/dev/null || true\`
    drops it silently if the file is not writable. Do not retry.`,
      "",
    )}

${w(
  `── Output ─────────────────────────────────────────────────────────────

After all SQL is committed, print ONE summary line to stdout so the
Node worker can log it:

  DONE ingest=${ctx.ingestId} classification=<kind> tx_ids=[<uuid>,...] place_id=<uuid|null>

That's the only structured output required. No JSON fence needed —
the database is your output.

── Rules ──────────────────────────────────────────────────────────────

- Every \`psql\` INVOCATION is a separate Bash tool call, so BATCH your
  statements into as few invocations as possible — the write phase is
  Turn A / Turn B / Turn C and nothing else (Phase 4.0). Don't try to
  pipeline from one invocation to the next via stdin chaining.
- NEVER insert a transaction without exactly matching balanced
  postings in the SAME BEGIN/COMMIT block. The deferred constraint
  trigger will reject at COMMIT and roll back the whole block.
- \`.eml\` with a PDF attachment: prefer the source with richer data
  (usually the attachment). Mention which in metadata.raw_text.
- Reason in plain text BEFORE issuing SQL. Show your arithmetic for
  postings (expense +X, credit -X) so mistakes are visible in the
  session transcript.
- On any failure, leave the ingest row with status='error' and a
  helpful one-line error message. Never leave it stuck in 'processing'.
`,
  recordHandBack(),
)}`;
}
