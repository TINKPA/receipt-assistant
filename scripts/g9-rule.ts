/** G9's second run. Re-extract's agent always rewrites
 *  `metadata.extraction.ran_at`, and vision OCR is not deterministic, so a
 *  second run under the same prompt reports `written` with exactly those
 *  two keys; `no_change` only happens when its SQL never ran. What the
 *  gate is about is that nothing else moves. */
export function secondReExtractIsQuiet(r: { outcome: string; changed_keys?: string[] | null }): boolean {
  if (r.outcome === "no_change") return true;
  if (r.outcome !== "written" || !Array.isArray(r.changed_keys)) return false;
  return r.changed_keys.every((k) => k === "metadata_extraction" || k === "ocr_text");
}
