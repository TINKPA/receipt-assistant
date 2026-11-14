/**
 * The server applier's version (wave 1; docs/server-writer.md, "Versions").
 *
 * Under `EXTRACTION_WRITER=server_apply` the ledger rows of a receipt are
 * derived in code from its stored extraction record
 * (`document_extractions`): the postings, header, metadata and line-item
 * parameters by `project.ts` and `metadata.ts`, the attach-or-insert
 * decision by `decide.ts`. This constant names the rules those modules
 * apply, and every derived row records it (`metadata.extraction.
 * applier_version`, `near_dup_check.applier_version`).
 *
 * Bump it with ANY change to a projection rule (accounts, signs, the
 * mirror account, metadata keys, item parameters), a dedup rule or a
 * catalog rule. It is independent of the prompt: a bump needs no
 * `RECORD_PROMPT_VERSION` change, and because the records are stored, the
 * effect of a bump can be measured by re-projecting them
 * (`scripts/check-projection-replay.ts --records`) before it is deployed.
 *
 * A flat string, like `PROMPT_VERSION`: "1.0", "1.1" for an additive rule,
 * "2.0" for a clean break.
 *
 * "1.0" took changes without a bump, all made before any record had been
 * applied outside throwaway and sandbox databases: the owner's tender
 * decisions of November 2026 (debit card to Checking, gift card to Cash, a
 * mixed tender flagged), and after the P3 smoke the review flags for a
 * date booked as printed or moved by a repair (`review.ts`) and the
 * misread-key attach (`decide.ts` rule 2 (ii)). From the first P4 A/B
 * trial on, no exceptions (docs/server-writer.md, "Versions").
 */
export const APPLIER_VERSION = "1.0";
