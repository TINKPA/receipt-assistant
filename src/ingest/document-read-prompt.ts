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
 * PR #181 rewrites the PDF half of this to be text-layer-first; the
 * text below is the pre-#181 render-first behavior, moved verbatim.
 *
 * Plain template literal, never `String.raw` — see `prompt-contract.ts`.
 */
export function phase0DocumentRead(opts: {
  /** Container-absolute path of the file under extraction. */
  filePath: string;
  /** Per-run scratch directory, e.g. `/tmp/<ingestId>`. */
  scratchDir: string;
}): string {
  return `── Reading the document (especially PDFs) ────────────────────────────

For a PDF, do NOT hand-parse the byte structure (decompressing streams,
mapping Form XObjects, sorting content-stream placements) — that path is
slow and error-prone. Rasterize to an image and read the pixels, which is
what you do best:

  pdftoppm -png -r 200 "${opts.filePath}" ${opts.scratchDir}/page
  # → ${opts.scratchDir}/page-1.png, page-2.png, …  then Read those PNGs.

\`pdftoppm\` and \`pdftotext\` (poppler) plus \`gs\` (ghostscript) are
installed. \`pdftotext -layout "${opts.filePath}" -\` gives a fast text
layer for text-based PDFs; when the PDF is a flattened form or its text
layer is empty/garbled, prefer the rasterized PNG. Only fall back to
manual stream decoding if those tools are genuinely unavailable.

**Decoding an \`.eml\` body.** The \`.eml\` body is MIME-encoded (quoted-printable
or base64, sometimes with non-UTF-8 bytes). Do NOT try to read a raw
base64 blob, and do NOT improvise your own decoder. Run exactly this
tested one-liner (stdlib only — handles QP, base64, and charset quirks;
note \`message_from_binary_file\` + \`policy=email.policy.default\`, both
required):

  python3 -c "import email,email.policy,sys; m=email.message_from_binary_file(open(sys.argv[1],'rb'),policy=email.policy.default); p=m.get_body(preferencelist=('html','plain')); print(p.get_content() if p else '(no text body found)')" "${opts.filePath}" > /tmp/email-body.txt

then Read \`/tmp/email-body.txt\`. If (and only if) that command fails,
fall back to reading the raw \`.eml\` directly — quoted-printable parts
are human-readable as-is (ignore \`=3D\` and soft \`=\\n\` line-breaks).
Try ONE approach at a time; never fire multiple decode attempts in
parallel (see Tool discipline above).`;
}
