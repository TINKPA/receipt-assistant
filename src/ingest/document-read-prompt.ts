/**
 * Shared "how to actually read the uploaded file" phase for the
 * extraction and re-extraction prompts (#164).
 *
 * Both prompts inline this phase verbatim so the agent — which runs
 * inside a container that doesn't have the source files — gets the
 * full instructions in its prompt window. Don't reference this phase
 * by source-file path from the prompt; the agent will go looking for
 * `src/ingest/prompt.ts` and waste turns when it can't find it.
 *
 * Before #164 the re-extract prompt had NEITHER the PDF rasterization
 * recipe nor the `.eml` MIME-decode one-liner — it just said "read the
 * file", which is why email re-extracts produced empty `ocr_text`.
 *
 * #181 flipped the PDF half from render-first to TEXT-first. The old
 * text told the agent to `pdftoppm -png -r 200` every PDF with no page
 * cap and mentioned `pdftotext` only as a subordinate clause, which
 * meant a 3-page text-layer PDF entered the context as three 200-DPI
 * images and every later turn re-read them from cache — the single
 * biggest term in the 2.7M-token measurement on #181. The escape hatch
 * (rasterize when the text layer is empty / mojibake / a flattened
 * scan / internally inconsistent) is what keeps accuracy; DPI is 150
 * and the page cap is 3 because past that point a receipt PDF is a
 * statement, not a receipt.
 *
 * Plain template literal, never `String.raw` — see `prompt-contract.ts`.
 */
/** Per-run scratch directory of an ingest. The worker writes decoded
 *  attachments under it before the agent starts, so the prompt and the
 *  worker must agree on the path. */
export function ingestScratchDir(ingestId: string): string {
  return `/tmp/${ingestId}`;
}

/** Per-run scratch directory of a re-extract. */
export function reExtractScratchDir(transactionId: string): string {
  return `/tmp/reextract-${transactionId}`;
}

/** A file the server pulled out of an email before the agent started. */
export interface DecodedAttachment {
  /** Container-absolute path the agent can open. */
  path: string;
  /** Filename as the sender named it. Untrusted; shown for context only. */
  filename: string;
  bytes: number;
}

function renderAttachments(attachments: DecodedAttachment[]): string {
  if (attachments.length === 0) return "";
  const list = attachments
    .map((a) => `  ${a.path}   (${a.bytes} bytes, sent as ${JSON.stringify(a.filename)})`)
    .join("\n");
  return `
The email also carries PDF attachment(s), already saved for you:

${list}

An attached invoice or receipt PDF usually has the itemization the
body only summarizes. Read each with the PDF recipe above (text layer
first), then use whichever source is more complete and say which in
metadata.raw_text. Do NOT decode attachments out of the .eml yourself.
`;
}

/**
 * The decoded-source block (#167 for re-extract, #261 for ingest).
 *
 * The server MIME-decodes an email and linearizes HTML before the agent
 * starts, because the agent doing it costs 40 KB–1 MB of markup in
 * context per email and it cannot reach attachments at all.
 *
 * Inlined into the prompt rather than pre-written to `documents.ocr_text`:
 * the agent has no `SELECT ocr_text` instruction, and its own psql block
 * overwrites that column at the end of the run anyway.
 *
 * Renders nothing for images and PDFs, which the agent reads itself.
 */
export function renderDecodedSource(
  sourceText: string | null | undefined,
  attachments: DecodedAttachment[] = [],
): string {
  const text = sourceText?.trim() ?? "";
  if (text.length === 0 && attachments.length === 0) return "";
  const body =
    text.length === 0
      ? ""
      : `
This document is an email / HTML file, so its body has ALREADY been
MIME-decoded and linearized for you. Read it here; you do NOT need to
decode the file yourself. Item tables are linearized one row per line,
so a name and its price sit on the SAME line.

Treat this as the receipt text. Open the original file only if this
text is obviously truncated or contradicts itself — and if you do,
follow the document-reading rules above.

The \`Date (envelope)\` header, when present, is when the EMAIL was sent.
It is NOT automatically \`occurred_on\`: use the transaction date printed
in the body, and fall back to the envelope date only when the body
prints none.

<<<DECODED_SOURCE
${text}
DECODED_SOURCE
`;
  return `
── Decoded source text (already extracted for you) ────────────────────
${body}${renderAttachments(attachments)}`;
}

export function phase0DocumentRead(opts: {
  /** Container-absolute path of the file under extraction. */
  filePath: string;
  /** Per-run scratch directory, e.g. `/tmp/<ingestId>`. */
  scratchDir: string;
}): string {
  return `── Reading the document ───────────────────────────────────────────────

PDFs — TEXT FIRST. Always try the text layer before rasterizing.
Rasterized pages cost ~1500x more context than the same page as text,
and every later turn re-reads them from cache.

  mkdir -p ${opts.scratchDir}
  pdftotext -layout "${opts.filePath}" ${opts.scratchDir}/text.txt
  wc -c ${opts.scratchDir}/text.txt

  Then Read ${opts.scratchDir}/text.txt.

  If that file is >= 200 bytes AND contains a recognizable merchant
  name, a date, and a total, you are DONE reading. Do NOT rasterize.
  Do NOT "double-check against the image". The text layer IS the
  source of truth for a text-based PDF.

  Rasterize ONLY when the text layer genuinely fails: the file is
  empty / under 200 bytes, or it is mojibake, or it is a flattened
  scanned form with no extractable text, or the totals it shows do
  not tie to each other:

    pdftoppm -png -r 150 -f 1 -l 3 "${opts.filePath}" ${opts.scratchDir}/page
    # -> page-1.png … page-3.png. Read those, first page first, and
    #    STOP as soon as you have merchant + date + total + items.
    #    Do not Read pages you do not need.

  Never hand-parse the PDF byte structure (decompressing streams,
  mapping Form XObjects, sorting content-stream placements) — poppler
  (\`pdftotext\`, \`pdftoppm\`) and ghostscript (\`gs\`) are installed;
  only fall back to manual decoding if those tools are truly missing.

Images (.jpg/.png/.heic) — Read the file directly. One Read.

Email (.eml) and saved web pages (.html) — when a "Decoded source
text" block appears below, the server has already decoded the file:
read that block and skip the rest of this paragraph. Without one,
NEVER Read the raw \`.eml\` blindly and never Read it as
a PDF. The body is MIME-encoded (quoted-printable or base64, sometimes
with non-UTF-8 bytes), so a raw Read gives you a base64 blob. Do NOT
improvise your own decoder. Run exactly this tested one-liner (stdlib
only — handles QP, base64, and charset quirks; note
\`message_from_binary_file\` + \`policy=email.policy.default\`, both
required):

  python3 -c "import email,email.policy,sys; m=email.message_from_binary_file(open(sys.argv[1],'rb'),policy=email.policy.default); p=m.get_body(preferencelist=('html','plain')); print(p.get_content() if p else '(no text body found)')" "${opts.filePath}" > ${opts.scratchDir}/email-body.txt

then Read \`${opts.scratchDir}/email-body.txt\`. If (and only if) that
command fails, fall back to reading the raw \`.eml\` directly —
quoted-printable parts are human-readable as-is (ignore \`=3D\` and soft
\`=\\n\` line-breaks). Try ONE approach at a time; never fire multiple
decode attempts in parallel (see Tool discipline above).`;
}
