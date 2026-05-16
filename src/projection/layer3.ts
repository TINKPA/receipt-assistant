/**
 * Layer-3 contracts for `transactions` (Phase 4b of #80 / #91).
 *
 * "Layer 3" in the 3-layer data model (#80) means **user-truth**:
 * fields whose value reflects an explicit user decision, never an
 * extraction output. Re-derive (#89) and re-extract (#91 Phase 4c)
 * MUST NOT overwrite these — doing so destroys work and silently
 * loses information the user expected to be preserved.
 *
 * `places.custom_name_zh` is the canonical Layer-3 example for the
 * `places` table; this module establishes the equivalent for
 * `transactions`. The contract has two flavors:
 *
 * 1. HARD Layer 3 — fields the ingest agent never writes from
 *    extraction. Any non-default value is by definition user-set
 *    (or system state, like the FK chain identity columns). Re-extract
 *    omits these from its UPDATE column list entirely. See
 *    `HARD_LAYER3_TX_FIELDS` below.
 *
 * 2. SOFT Layer 3 — fields the ingest agent DOES write but
 *    `PATCH /v1/transactions/:id` (via `UpdateTransactionRequest`)
 *    lets the user override. These need per-field tracking because
 *    we can't distinguish "agent-written → user-accepted" from
 *    "agent-written → user-overrode" without an explicit flag.
 *    Convention: `transactions.metadata.user_edited.<field> = true`
 *    is set by `updateTransaction` when the user PATCHes that field;
 *    re-extract reads this allowlist via `isFieldUserEdited` and
 *    skips the field on the UPDATE.
 *
 * The wire-up for the SOFT path lives in Phase 4c. This module
 * exports the contract so both `updateTransaction` and the future
 * `reExtractDocument` service read from one source of truth.
 */

/**
 * Transaction columns that re-extract NEVER writes. Mirrors the
 * `places.custom_name_zh` shielding in `src/routes/places.service.ts
 * ::reDerivePlace` — the field is simply absent from the UPDATE
 * column list, not COALESCE-protected. Omission is unconditional.
 *
 * Column names use snake_case (DB names), not camelCase (Drizzle
 * field names). Re-extract's UPDATE is built from these names, so
 * matching the SQL column is the useful contract.
 */
export const HARD_LAYER3_TX_FIELDS = [
  // User state changes via explicit endpoints (POST /void, POST
  // /reconcile, the future un-reconcile path). Never written by
  // extraction.
  "status",
  "voided_by_id",
  // User-assigned grouping. No ingest path writes this.
  "trip_id",
  // User-supplied note. Ingest leaves NULL; any value is user input.
  "narration",
  // Immutable identity / provenance. Re-extract is by definition a
  // re-run against the same ingest, so these never change.
  "id",
  "workspace_id",
  "source_ingest_id",
  "created_by",
  "created_at",
  // Optimistic concurrency. Re-extract must bump `version` (it's a
  // write) but never overwrite to an arbitrary value.
  // `version` is included here so it appears in the contract, but
  // re-extract's UPDATE will set it to `version + 1` rather than
  // omitting it entirely.
  "version",
] as const;

/**
 * Convention key under `transactions.metadata` that tracks which
 * extraction-domain fields the user has explicitly overridden. The
 * shape is:
 *
 *   metadata.user_edited = {
 *     payee: true,
 *     occurred_on: true
 *   }
 *
 * Set by `updateTransaction` whenever the PATCH body specifies a
 * value for a SOFT-Layer-3 field. Read by re-extract via
 * `isFieldUserEdited`. Phase 4c wires both sides; 91b only
 * publishes the convention.
 *
 * Why a flag set rather than per-field timestamps: the only thing
 * re-extract needs to know is "has the user touched this." Time
 * of edit is recoverable from `transaction_events` if anyone asks.
 */
export const USER_EDITED_METADATA_PATH = "user_edited" as const;

/**
 * Soft-Layer-3 fields — extraction writes them, but user can override
 * via `PATCH /v1/transactions/:id`. Re-extract checks the user_edited
 * flag for each before overwriting; if the flag is set, the field
 * stays.
 *
 * Mirrors `UpdateTransactionRequest` in `src/schemas/v1/transaction.ts`
 * minus `trip_id` (which is HARD Layer 3 — extraction never writes
 * it) and `metadata` (handled holistically — see Phase 4c).
 */
export const SOFT_LAYER3_TX_FIELDS = [
  "occurred_on",
  "occurred_at",
  "payee",
] as const;

export type HardLayer3TxField = (typeof HARD_LAYER3_TX_FIELDS)[number];
export type SoftLayer3TxField = (typeof SOFT_LAYER3_TX_FIELDS)[number];

/**
 * Returns true when the user has explicitly overridden `field` on
 * this transaction. Re-extract skips overwriting any field that
 * returns true. Safe on missing / malformed metadata — defaults to
 * false (re-extract is allowed to write).
 */
export function isFieldUserEdited(
  metadata: unknown,
  field: SoftLayer3TxField,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const userEdited = (metadata as Record<string, unknown>)[
    USER_EDITED_METADATA_PATH
  ];
  if (!userEdited || typeof userEdited !== "object") return false;
  return (userEdited as Record<string, unknown>)[field] === true;
}
