/**
 * Universal classifier + extractor prompt used by `src/ingest/extractor.ts`
 * when spawning `claude -p` against a single file in a batch.
 *
 * The contract (see issue #32 §"Unified extraction prompt"):
 *
 *   1. Agent classifies the file in plain text (no --json-schema — that
 *      flag measurably degrades OCR; see root CLAUDE.md).
 *   2. Agent extracts the relevant fields with chain-of-thought reasoning.
 *   3. Agent ends with a SINGLE fenced ```json block that the caller
 *      parses programmatically. The last fence wins — the model is
 *      free to include examples mid-reasoning without polluting the
 *      parse.
 *
 * The DB writes described in issue #32 (agent → psql tool) are Phase 2.
 * Phase 1 runs the agent in pure-extraction mode and the Node worker
 * performs the writes against the v1 services — this keeps the Phase 1
 * surface easy to unit-test with an injectable stub and avoids giving
 * the CLI direct DB credentials from the worker process.
 */

export function buildExtractorPrompt(absPath: string): string {
  return `You are a financial-document extractor. A file has been placed at:

  ${absPath}

Phase 1 — classify
  Open the file and decide which category it belongs to:
    receipt_image   photo/scan of a physical receipt
    receipt_email   .eml / .html purchase confirmation (Amazon, Uber…)
    receipt_pdf     PDF of a single receipt or invoice
    statement_pdf   credit-card or bank statement with many line items
    unsupported     anything else (W-2, menu, junk, illegible, non-financial)

Phase 2 — extract
  For receipt_image / receipt_email / receipt_pdf, extract:
    - payee        : merchant name as printed on the document
    - occurred_on  : date in YYYY-MM-DD form (read from the document —
                     NEVER fall back to today's date). If year is missing,
                     infer from nearby context (statement period etc.).
    - total_minor  : FINAL amount paid in the currency's minor unit
                     (integer cents for USD, whole units for JPY).
                     Include handwritten tips if present.
    - currency     : ISO 4217 code (USD, CNY, EUR, JPY, …). Detect from
                     symbols: $→USD, € →EUR, £→GBP, ¥ needs context
                     (CNY vs JPY).
    - category_hint: one of
                     groceries | dining | retail | cafe | transport | other
    - items        : optional list of line items, each with
                     { "name": "...", "total_price_minor": 1234 }
    - raw_text     : optional full transcription (helps debugging)

  For statement_pdf, extract rows:
    { "rows": [ { "date": "YYYY-MM-DD", "payee": "...", "amount_minor": 1234 }, ... ] }

  For unsupported, provide only:
    { "reason": "short explanation of why this isn't extractable" }

Rules
  - .eml with a PDF attachment: prefer the source with richer data
    (usually the attachment). Mention which in raw_text.
  - Reason in plain text BEFORE giving the final answer. No structured
    output mode — chain-of-thought measurably improves OCR.
  - Do NOT write to a database. The caller handles persistence.

Final answer format (REQUIRED) — end your response with a single fenced
\`\`\`json block whose content is one of:

  { "classification": "receipt_image",
    "extracted": { "payee": "...", "occurred_on": "YYYY-MM-DD",
                   "total_minor": 12345, "currency": "USD",
                   "category_hint": "groceries",
                   "items": [ ... ], "raw_text": "..." } }

  { "classification": "receipt_email",
    "extracted": { ...same fields as receipt_image... } }

  { "classification": "receipt_pdf",
    "extracted": { ...same fields as receipt_image... } }

  { "classification": "statement_pdf",
    "extracted": { "rows": [ { "date": "...", "payee": "...", "amount_minor": 1234 } ] } }

  { "classification": "unsupported",
    "reason": "..." }
`;
}
