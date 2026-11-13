/**
 * JSON Merge Patch (RFC 7396) for `metadata` columns, plus the list of
 * `transactions.metadata` keys a client PATCH may not change.
 *
 * ## Why this exists
 *
 * `PATCH /v1/transactions/:id` has always been advertised as
 * `application/merge-patch+json`, but `updateTransaction` assigned
 * `patch.metadata` to the column wholesale. The OpenAPI schema gave the
 * field `default: {}`, openapi-typescript renders a defaulted property as
 * required, and so the web client's Edit modal sends `metadata: {}` on
 * every save. One save would have replaced the whole object — extraction
 * provenance, dedup identifiers, FX and points provenance, the legacy
 * `items` array 79 rows still read from — with `{}` (or with just
 * `{user_edited: …}` when a soft field was edited in the same request).
 *
 * The contract now matches the content type:
 *
 *   - objects merge recursively; a key the patch does not name is kept
 *   - `null` removes a key
 *   - anything else (scalar, array) replaces the value at that key
 *   - `metadata: {}` changes nothing
 *   - a value sent back exactly as stored is left as stored (see
 *     `mergePatch` for why this is spelled out)
 *
 * ## Server-owned keys
 *
 * Most of `transactions.metadata` is free-form: the extraction agent adds
 * whatever the receipt prints (`order_number`, `payment`, `tax_minor`,
 * ~780 distinct keys in production), and those are Layer-2 projection
 * values a user may legitimately correct. A small set of keys is
 * different: the server (or the extraction contract acting for it)
 * writes them as provenance or bookkeeping, and other code reads them
 * back to make decisions. A client that overwrote one would falsify the
 * audit trail or change server behaviour without changing the ledger.
 * `SERVER_OWNED_TX_METADATA_KEYS` is that set, each entry cited to the
 * code that writes it. A patch that would CHANGE one of them is refused
 * (422); a patch that merely echoes the current value back — the shape a
 * read-modify-write client produces — is a no-op and is accepted.
 *
 * Deliberately NOT in the list: `merchant`, `category_hint`, `flow`,
 * `refund_of` and every receipt-fact key. They are projections of what
 * the receipt says, not records of what the server did, and correcting a
 * mis-booked category or direction through the API needs them writable.
 *
 * When you add a server-side writer of `transactions.metadata`, add its
 * key here in the same PR.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { USER_EDITED_METADATA_PATH } from "./layer3.js";

export type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Own-property write that cannot be hijacked by a key named
 *  `__proto__` (plain assignment would set the prototype instead of
 *  creating the property, silently dropping the value on serialize). */
function setOwn(o: JsonObject, k: string, v: unknown): void {
  Object.defineProperty(o, k, {
    value: v,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneObject(o: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of Object.keys(o)) setOwn(out, k, o[k]);
  return out;
}

/**
 * RFC 7396 `MergePatch(Target, Patch)`, with one deliberate refinement.
 * Pure: neither argument is mutated, and untouched subtrees are shared
 * with `target`.
 *
 * The refinement: a patch value that is exactly the stored value leaves
 * it as stored, nested nulls included. Strict RFC 7396 cannot echo a
 * null — inside a patch object it always means "remove" — so sending an
 * object back unchanged would strip every null-valued member inside it.
 * That turns the ordinary read-modify-write pattern (GET the object, add
 * a key, PATCH it all back; scripts have backfilled keys exactly this
 * way) into a quiet rewrite of data the caller never meant to touch:
 * most production transactions carry nulls inside `items` and
 * `ocr_audit`. An exact echo is a no-op here instead, at every depth.
 *
 * Inside an object that is NOT an exact echo, a `null` member removes
 * its key as the RFC says, whatever is stored there — a stored null too.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (target !== undefined && jsonEqual(target, patch)) return target; // exact echo
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(target) ? cloneObject(target) : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) {
      delete out[k];
    } else {
      setOwn(out, k, mergePatch(hasOwn(out, k) ? out[k] : undefined, v));
    }
  }
  return out;
}

/** Structural equality over JSON values (what jsonb round-trips). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Top-level `transactions.metadata` keys owned by the server. See the
 * module comment for what qualifies. Each entry names its writer.
 */
export const SERVER_OWNED_TX_METADATA_KEYS = [
  // Layer-3 edit flags. Writer: `updateTransaction`
  // (src/routes/transactions.service.ts). Reader: the re-extract UPDATE's
  // CASE expressions (src/ingest/reextract-prompt.ts). A client clearing
  // a flag would let the next re-extract overwrite a user's own edit.
  USER_EDITED_METADATA_PATH,

  // Extraction provenance. Writers: the ingest INSERT template
  // (src/ingest/prompt.ts, "REQUIRED metadata.extraction shape") and the
  // re-extract UPDATE (src/ingest/reextract-prompt.ts), which also pushes
  // the previous stamp onto `extraction_history` and sets
  // `re_extracted_at`. `extraction.prompt_version` is the re-extract
  // eligibility filter.
  "extraction",
  "extraction_history",
  "re_extracted_at",
  // Where the row came from. Writer: the ingest INSERT template
  // (`'source', 'ingest'`, `'source_ingest_id'`, `'classification'`);
  // `source` is also set once by a client at create time.
  "source",
  "source_ingest_id",
  "classification",
  // Extraction self-audit. Writers: OCR_AUDIT_REQUIREMENT in
  // src/ingest/prompt-contract.ts (ingest and re-extract both stamp it),
  // the allocation check in src/ingest/line-item-prompt.ts, the
  // enrichment-skip contract in src/ingest/prompt-contract.ts, and the
  // CJK-name provenance blocks in src/ingest/prompt.ts.
  "ocr_audit",
  "allocation_audit",
  "enrichment_skipped",
  "photo_ocr",
  "receipt_ocr_zh",
  // Legacy line-item store (pre-#81). Writers: ingest INSERT template and
  // re-extract UPDATE. Reader: `itemsFromMetadataFallback`, which serves
  // it as the transaction's `items` when no `transaction_items` rows
  // exist. Line items change through `POST /:id/items` or re-extract.
  "items",

  // Dedup / reconcile bookkeeping. Writers: the attach branch of the
  // ingest prompt's Phase 4a.0 (`merge_audit`), its distinct / uncertain
  // branches (`near_dup_check`), and `dismissNearDupFlag`, which is the
  // supported way to clear `near_dup_check.flagged_for_review`
  // (`POST /:id/near-dup-review`).
  "merge_audit",
  "near_dup_check",

  // Valuation provenance. Writers: src/fx/normalize.ts (`fx`) and
  // src/points/valuation.ts (`points`), each alongside the posting
  // amounts it explains.
  "fx",
  "points",
] as const;

const SERVER_OWNED = new Set<string>(SERVER_OWNED_TX_METADATA_KEYS);

export function isServerOwnedTxMetadataKey(key: string): boolean {
  return SERVER_OWNED.has(key);
}

/** Top-level keys whose value differs between two metadata objects
 *  (added, removed or changed), in a stable order. */
export function changedTopLevelKeys(
  before: JsonObject,
  after: JsonObject,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter(
      (k) =>
        hasOwn(before, k) !== hasOwn(after, k) ||
        !jsonEqual(before[k], after[k]),
    )
    .sort();
}

/** The sub-object of `metadata` restricted to `keys`; absent keys are
 *  omitted, so a key present in the "old" pick and missing from the
 *  "new" pick reads as removed (and the reverse as added). */
export function pickKeys(metadata: JsonObject, keys: string[]): JsonObject {
  const out: JsonObject = {};
  for (const k of keys) if (hasOwn(metadata, k)) setOwn(out, k, metadata[k]);
  return out;
}

/** What changed between two metadata objects, at top-level-key grain. */
export interface MetadataDelta {
  /** Changed keys with their previous values; a key that did not exist
   *  before is absent. This is the `old` half of an audit event. */
  oldValues: JsonObject;
  /** Changed keys with their new values; a removed key is absent. The
   *  `new` half of an audit event, and the keys the write sets. */
  newValues: JsonObject;
  /** Changed keys that no longer exist. */
  removedKeys: string[];
}

/** `null` when the two objects are equal. */
export function metadataDelta(
  before: JsonObject,
  after: JsonObject,
): MetadataDelta | null {
  const changed = changedTopLevelKeys(before, after);
  if (changed.length === 0) return null;
  return {
    oldValues: pickKeys(before, changed),
    newValues: pickKeys(after, changed),
    removedKeys: changed.filter((k) => !hasOwn(after, k)),
  };
}

/**
 * The jsonb expression that applies a `MetadataDelta` to a stored
 * column: drop the removed keys, overlay the changed ones, leave every
 * other key exactly as stored.
 *
 * This is deliberately not "write the merged object back". node-postgres
 * hands jsonb to JavaScript through `JSON.parse`, so a whole-object
 * rewrite re-serialises every key the request never mentioned: `8.50`
 * comes back as `8.5` and an integer past 2^53 loses its low digits.
 * Touching only the keys that moved keeps the rest byte-identical.
 *
 * The caller must hold the row (a `FOR UPDATE` lock, or a version
 * predicate on the UPDATE) so the stored value is the one the delta was
 * computed against.
 */
export function metadataDeltaSql(column: AnyColumn, delta: MetadataDelta): SQL {
  return sql`(${column} - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(delta.removedKeys)}::jsonb))) || ${JSON.stringify(delta.newValues)}::jsonb`;
}

export interface TxMetadataPatchResult {
  /** `current` with the patch merged in. */
  next: JsonObject;
  /** Server-owned keys the patch would have changed. Non-empty means the
   *  caller must refuse the request; `next` is then not to be written. */
  refusedKeys: string[];
}

/**
 * Apply a client-supplied merge patch to a transaction's metadata and
 * report which server-owned keys it tried to change.
 *
 * A server-owned member of the patch is either a no-op or a refusal; it
 * is never applied. It is a no-op when merging it leaves the stored
 * value as it is (an exact or partial echo), or when it is a `null`
 * aimed at a key that is absent or holds a bare JSON null — there is
 * nothing there to remove, and a whole-object echo of such a row sends
 * exactly that.
 */
export function applyClientTxMetadataPatch(
  current: JsonObject,
  patch: JsonObject,
): TxMetadataPatchResult {
  const clientPatch: JsonObject = {};
  const refusedKeys: string[] = [];
  for (const k of Object.keys(patch)) {
    if (!SERVER_OWNED.has(k)) {
      setOwn(clientPatch, k, patch[k]);
      continue;
    }
    const stored = hasOwn(current, k) ? current[k] : undefined;
    const noop =
      patch[k] === null
        ? stored === undefined || stored === null
        : stored !== undefined && jsonEqual(mergePatch(stored, patch[k]), stored);
    if (!noop) refusedKeys.push(k);
  }
  return {
    next: mergePatch(current, clientPatch) as JsonObject,
    refusedKeys: refusedKeys.sort(),
  };
}
