/**
 * The server applier's version (wave 1, plan §9.3).
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
 * "1.0" took one change without a bump: the owner's tender decisions of
 * November 2026 (debit card to Checking, gift card to Cash, a mixed tender
 * flagged), made before any record had been applied outside throwaway and
 * sandbox databases. From the first production record on, no exceptions.
 */
export const APPLIER_VERSION = "1.0";
