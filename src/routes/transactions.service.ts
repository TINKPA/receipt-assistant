/**
 * Transactions service — the business logic behind the HTTP router
 * (`/v1/transactions*`).
 *
 * Everything that mutates the ledger runs inside a single
 * `db.transaction(...)` block so that the deferred `postings_balance_ck`
 * constraint trigger fires at commit on exactly the set of rows written
 * together (parent transaction + postings + document_links).
 *
 * PG `check_violation` (ERRCODE 23514) raised by those triggers is
 * translated to `PostingsImbalanceProblem` (422) so clients see a
 * structured 7807 error rather than an opaque 500.
 */
import { sql, eq, and, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  transactions,
  transactionItems,
  postings,
  products,
  accounts,
  documents,
  documentLinks,
  transactionEvents,
  workspaces,
  merchants,
} from "../schema/index.js";
import { loadPlacesByIds, type PlaceRow } from "./places.service.js";
import { isPointsCurrency } from "../points/codes.js";
import {
  USER_EDITED_METADATA_PATH,
  type SoftLayer3TxField,
} from "../projection/layer3.js";
import {
  applyClientTxMetadataPatch,
  metadataDelta,
  metadataDeltaSql,
  type JsonObject,
} from "../projection/metadata-patch.js";
import { resolvePointsValuation } from "../points/valuation.js";
import { toBaseMinor } from "../ledger/money.js";

import { newId } from "../http/uuid.js";
import {
  HttpProblem,
  NotFoundProblem,
  PostingsImbalanceProblem,
  ValidationProblem,
  VersionMismatchProblem,
} from "../http/problem.js";
import type {
  CreateTransactionRequest,
  UpdateTransactionRequest,
  NewPosting,
  NewTransactionItem,
  UpdatePostingRequest,
  ListTransactionsQuery,
  ListPostingsQuery,
} from "../schemas/v1/transaction.js";
import type { z } from "zod";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
} from "../http/pagination.js";

/** Compact merchant ref joined into transaction responses; carries
 *  `custom_name` so the frontend can apply brand-level Layer-3 renames
 *  (#79 Phase C) to Ledger rows without an N+1 fetch. */
export interface MerchantRefRow {
  id: string;
  brand_id: string;
  canonical_name: string;
  custom_name: string | null;
}

async function loadMerchantRefsByIds(
  runner: typeof db,
  ids: string[],
): Promise<Map<string, MerchantRefRow>> {
  const map = new Map<string, MerchantRefRow>();
  if (ids.length === 0) return map;
  const rows = await runner
    .select({
      id: merchants.id,
      brandId: merchants.brandId,
      canonicalName: merchants.canonicalName,
      customName: merchants.customName,
    })
    .from(merchants)
    .where(inArray(merchants.id, ids));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      brand_id: r.brandId,
      canonical_name: r.canonicalName,
      custom_name: r.customName ?? null,
    });
  }
  return map;
}

type CreateReq = z.infer<typeof CreateTransactionRequest>;
type UpdateReq = z.infer<typeof UpdateTransactionRequest>;
type NewPostingT = z.infer<typeof NewPosting>;
type NewTransactionItemInput = z.infer<typeof NewTransactionItem>;
type UpdatePostingReq = z.infer<typeof UpdatePostingRequest>;
type ListTxQuery = z.infer<typeof ListTransactionsQuery>;
type ListPostingQuery = z.infer<typeof ListPostingsQuery>;

// ── Shared output shapes ───────────────────────────────────────────────

export interface PostingRow {
  id: string;
  transaction_id: string;
  account_id: string;
  /** The posting's account's `type`, denormalized (#221). Selecting the
   *  spend leg by type is the only correct way; by sign is wrong on
   *  refunds. See `mapPostingRow`. */
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  amount_minor: number;
  currency: string;
  fx_rate: string | null;
  amount_base_minor: number | null;
  memo: string | null;
  created_at: string;
}

/**
 * Per-line item DTO. Mirrors `TransactionItem` in
 * `src/schemas/v1/transaction.ts` exactly. Source priority:
 *   1. `transaction_items` rows (post-#81 Phase 2 — relational SSOT)
 *   2. `metadata.items` JSONB array (pre-#81 Phase 2 fallback)
 */
export interface TransactionItemRow {
  line_no: number;
  /** #162 — parent item's line_no when this row is a paid modifier;
   *  NULL for top-level items and audit rows. */
  parent_line_no: number | null;
  raw_name: string;
  normalized_name: string | null;
  /** #162 — zero-cost customizations folded into one string; NULL when
   *  the item has no free customizations. */
  product_variant: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price_minor: number | null;
  line_total_minor: number;
  currency: string;
  item_class: "durable" | "consumable" | "food_drink" | "service" | "other";
  durability_tier: "luxury" | "standard" | null;
  food_kind: "restaurant_dish" | "grocery_food" | "beverage" | null;
  tags: string[] | null;
  confidence: "high" | "medium" | "low";
  /** #84 — recommended labels: product / tax / tip / discount / shipping. */
  line_type: string;
  /** #84 — catalog linkage; NULL on non-product rows. */
  product_id: string | null;
  /** #84 — per-line tax allocated from the printed aggregate. */
  tax_minor: number | null;
  tip_share_minor: number | null;
  discount_share_minor: number | null;
  /** #84 — generated column: line_total + tax + tip - discount. */
  effective_total_minor: number;
  /** #183 — creation pathway: 'extraction' (ingest agent, and every
   *  pre-#183 / `metadata.items` fallback row) vs 'manual'. */
  source: string;
}

export interface TransactionRow {
  id: string;
  workspace_id: string;
  occurred_on: string;
  occurred_at: string | null;
  payee: string | null;
  narration: string | null;
  status: "draft" | "posted" | "reconciled" | "error";
  deleted_at: string | null;
  source_ingest_id: string | null;
  trip_id: string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  postings: PostingRow[];
  documents: Array<{
    id: string;
    kind: string;
    /** Raw content type; drives the viewer's render path (text/html →
     *  sanitized /rendered). Present on the detail read, null on the
     *  list view. #137. */
    mime_type?: string | null;
    /** Channel provenance (email sender/subject/received_at). Present on
     *  the single-tx detail read; omitted on the list view. #122. */
    source_meta?: Record<string, unknown> | null;
    /** `documents.deleted_at` tombstone. Non-null when the document was
     *  soft-deleted. Emitted on BOTH the detail read and the list view —
     *  the Ledger list tombstones rows without a detail fetch. */
    deleted_at: string | null;
  }>;
  /**
   * Optional Google Places entry for this transaction's merchant
   * location. Null when the extraction agent declined to geocode (no
   * address / no locality hint), when the workspace/ingest predates
   * the places feature, or when the row has been unlinked.
   */
  place: PlaceRow | null;
  /**
   * Merchant aggregation root (#64) joined from `transactions.merchant_id`.
   * Carries `custom_name` so the frontend `displayName()` cascade can
   * pick up brand-level Layer-3 renames (#79 Phase C) without an N+1
   * fetch per row.
   */
  merchant: MerchantRefRow | null;
  /**
   * Receipt line items (#81). Phase 2 reads `transaction_items`;
   * empty array means the receipt has no items section (e.g. the
   * agent emitted no rows, or this is a `statement_pdf` parent),
   * NOT "items missing from this response".
   */
  items: TransactionItemRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  // Drizzle wraps driver errors; check err + err.cause chain.
  const root = err as { code?: string; cause?: unknown };
  if (typeof root.code === "string") return root.code;
  let cur: any = root.cause;
  while (cur) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

/**
 * The message of the Postgres error itself — the first error in the
 * `cause` chain that carries a SQLSTATE. Drizzle wraps it in an error
 * whose own message is the failed statement and its parameters
 * ("Failed query: commit\nparams: "); that wrapper is not for a client.
 */
function pgMessage(err: unknown): string {
  let cur: any = err;
  while (cur) {
    if (typeof cur.code === "string" && typeof cur.message === "string") {
      return cur.message;
    }
    cur = cur.cause;
  }
  return "";
}

/**
 * Wrap a mutation so PG `check_violation` → PostingsImbalanceProblem.
 * Other errors bubble untouched.
 */
export async function mapBalanceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    if (pgCode(err) === "23514") {
      const detail = pgMessage(err);
      throw new PostingsImbalanceProblem(detail, [
        { path: "postings", code: "imbalance", message: detail },
      ]);
    }
    throw err;
  }
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    // node-postgres may return 'YYYY-MM-DD' for date columns.
    return v;
  }
  return String(v);
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  return String(v);
}

function bigintToNumber(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function bigintToNumberNullable(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return bigintToNumber(v);
}

/**
 * Coerce a posting row to the `Posting` DTO.
 *
 * `account_type` (#221) is denormalized from the posting's account on
 * every fetch path, which is why each of those queries joins `accounts`.
 * Without it a posting is not interpretable on its own: a client holding
 * `{amount_minor: 7117}` cannot tell a $71.17 purchase (expense leg,
 * positive) from the credit side of a $71.17 REFUND (liability leg,
 * also positive). Clients used to guess with `amount_minor > 0`, which
 * is right for purchases and backwards for refunds — the frontend's
 * `totalMinorFromPostings` showed returns as same-size purchases for
 * exactly that reason. Select the leg by type, then read the sign.
 */
function mapPostingRow(row: any): PostingRow {
  return {
    id: row.id,
    transaction_id: row.transactionId ?? row.transaction_id,
    account_id: row.accountId ?? row.account_id,
    account_type: row.accountType ?? row.account_type,
    amount_minor: bigintToNumber(row.amountMinor ?? row.amount_minor),
    currency: row.currency,
    fx_rate: row.fxRate ?? row.fx_rate ?? null,
    amount_base_minor: bigintToNumberNullable(
      row.amountBaseMinor ?? row.amount_base_minor,
    ),
    memo: row.memo ?? null,
    created_at: toIsoString(row.createdAt ?? row.created_at),
  };
}

/** Column map for every drizzle posting fetch: the posting's own columns
 *  plus `accountType` from the joined `accounts` row (#221). */
const POSTING_COLUMNS = {
  id: postings.id,
  transactionId: postings.transactionId,
  accountId: postings.accountId,
  accountType: accounts.type,
  amountMinor: postings.amountMinor,
  currency: postings.currency,
  fxRate: postings.fxRate,
  amountBaseMinor: postings.amountBaseMinor,
  memo: postings.memo,
  createdAt: postings.createdAt,
} as const;

/**
 * Coerce a single row from `transaction_items` or a JSONB object to the
 * `TransactionItemRow` DTO. The two sources are intentionally aligned
 * field-for-field so this can swallow either shape.
 */
function mapTransactionItem(row: any): TransactionItemRow {
  const unitPrice = row.unitPriceMinor ?? row.unit_price_minor;
  const taxMinor = row.taxMinor ?? row.tax_minor;
  const tipShare = row.tipShareMinor ?? row.tip_share_minor;
  const discShare = row.discountShareMinor ?? row.discount_share_minor;
  const lineTotal = Number(row.lineTotalMinor ?? row.line_total_minor);
  const effective =
    row.effectiveTotalMinor ?? row.effective_total_minor ?? null;
  const parentLineNo = row.parentLineNo ?? row.parent_line_no ?? null;
  return {
    line_no: Number(row.lineNo ?? row.line_no),
    parent_line_no:
      parentLineNo === null || parentLineNo === undefined
        ? null
        : Number(parentLineNo),
    raw_name: row.rawName ?? row.raw_name,
    normalized_name: row.normalizedName ?? row.normalized_name ?? null,
    product_variant: row.productVariant ?? row.product_variant ?? null,
    quantity:
      row.quantity === null || row.quantity === undefined
        ? null
        : Number(row.quantity),
    unit: row.unit ?? null,
    unit_price_minor:
      unitPrice === null || unitPrice === undefined ? null : Number(unitPrice),
    line_total_minor: lineTotal,
    currency: row.currency,
    item_class: row.itemClass ?? row.item_class,
    durability_tier: row.durabilityTier ?? row.durability_tier ?? null,
    food_kind: row.foodKind ?? row.food_kind ?? null,
    tags: Array.isArray(row.tags) ? row.tags : null,
    confidence: row.confidence,
    line_type: row.lineType ?? row.line_type ?? "product",
    product_id: row.productId ?? row.product_id ?? null,
    tax_minor: taxMinor === null || taxMinor === undefined ? null : Number(taxMinor),
    tip_share_minor:
      tipShare === null || tipShare === undefined ? null : Number(tipShare),
    discount_share_minor:
      discShare === null || discShare === undefined ? null : Number(discShare),
    // For fallback rows (pre-#84) the generated column doesn't exist;
    // synthesize it from the components so clients always get a number.
    effective_total_minor:
      effective === null
        ? lineTotal +
          (Number(taxMinor) || 0) +
          (Number(tipShare) || 0) -
          (Number(discShare) || 0)
        : Number(effective),
    // #183 — absent on `metadata.items` fallback rows, which predate
    // the manual path entirely and are therefore extraction-derived.
    source: row.source ?? "extraction",
  };
}

/**
 * Read items for a transaction, preferring the relational table; fall
 * back to `metadata.items` for rows ingested before #81 Phase 2.
 */
function itemsFromMetadataFallback(metadata: unknown): TransactionItemRow[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(mapTransactionItem);
}

function mapTransactionRow(
  row: any,
  posts: any[],
  // Both spellings of `deleted_at` are accepted for the same reason the
  // transaction row below accepts both: the detail loader feeds drizzle
  // selects (camelCase) and the list loader feeds raw `db.execute` rows
  // (snake_case).
  docs: Array<{
    id: string;
    kind: string;
    mimeType?: unknown;
    sourceMeta?: unknown;
    deletedAt?: unknown;
    deleted_at?: unknown;
  }>,
  place: PlaceRow | null = null,
  itemRows: any[] = [],
  merchant: MerchantRefRow | null = null,
): TransactionRow {
  const metadata = row.metadata ?? {};
  const items =
    itemRows.length > 0
      ? itemRows.map(mapTransactionItem)
      : itemsFromMetadataFallback(metadata);
  // Both spellings of each column are accepted because this mapper is fed
  // by drizzle selects (camelCase) and raw `db.execute` rows (snake_case).
  const occurredAt = row.occurredAt ?? row.occurred_at;
  const deletedAt = row.deletedAt ?? row.deleted_at;
  return {
    id: row.id,
    workspace_id: row.workspaceId ?? row.workspace_id,
    occurred_on: toIsoDate(row.occurredOn ?? row.occurred_on),
    occurred_at: occurredAt ? toIsoString(occurredAt) : null,
    payee: row.payee ?? null,
    narration: row.narration ?? null,
    status: row.status,
    deleted_at: deletedAt ? toIsoString(deletedAt) : null,
    source_ingest_id: row.sourceIngestId ?? row.source_ingest_id ?? null,
    trip_id: row.tripId ?? row.trip_id ?? null,
    metadata,
    version: Number(row.version),
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
    postings: posts.map(mapPostingRow),
    documents: docs.map((d) => {
      const docDeletedAt = d.deletedAt ?? d.deleted_at;
      return {
        id: d.id,
        kind: d.kind,
        mime_type: (d.mimeType ?? null) as string | null,
        source_meta: (d.sourceMeta ?? null) as Record<string, unknown> | null,
        deleted_at: docDeletedAt ? toIsoString(docDeletedAt) : null,
      };
    }),
    place,
    merchant,
    items,
  };
}

// ── Load utilities ─────────────────────────────────────────────────────

async function loadTransactionFull(
  runner: typeof db,
  workspaceId: string,
  id: string,
): Promise<TransactionRow | null> {
  const rows = await runner
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
    );
  if (rows.length === 0) return null;
  const t = rows[0]!;
  const posts = await runner
    .select(POSTING_COLUMNS)
    .from(postings)
    .innerJoin(accounts, eq(accounts.id, postings.accountId))
    .where(eq(postings.transactionId, id))
    .orderBy(postings.createdAt);
  const docLinks = await runner
    .select({
      id: documents.id,
      kind: documents.kind,
      mimeType: documents.mimeType,
      sourceMeta: documents.sourceMeta,
      deletedAt: documents.deletedAt,
    })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(eq(documentLinks.transactionId, id));
  const placeMap = t.placeId ? await loadPlacesByIds([t.placeId]) : null;
  const place = placeMap?.get(t.placeId!) ?? null;
  const merchantMap = t.merchantId
    ? await loadMerchantRefsByIds(runner, [t.merchantId])
    : null;
  const merchant = merchantMap?.get(t.merchantId!) ?? null;
  // #84: only show LIVE items (retired_at IS NULL). Re-extract soft-
  // deletes the prior run; old rows are kept for history but must not
  // surface in the response.
  const itemRows = await runner
    .select()
    .from(transactionItems)
    .where(
      and(
        eq(transactionItems.transactionId, id),
        isNull(transactionItems.retiredAt),
      ),
    )
    .orderBy(transactionItems.lineNo);
  return mapTransactionRow(t, posts, docLinks, place, itemRows, merchant);
}

async function loadWorkspaceBaseCurrency(
  runner: typeof db,
  workspaceId: string,
): Promise<string> {
  const rows = await runner
    .select({ baseCurrency: workspaces.baseCurrency })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (rows.length === 0) throw new NotFoundProblem("Workspace", workspaceId);
  return rows[0]!.baseCurrency;
}

// ── Mutation guards ────────────────────────────────────────────────────

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Load a transaction head row AND take its row lock for the rest of the
 * surrounding DB transaction. Every If-Match-guarded mutation in this
 * file starts here.
 *
 * The lock is what makes the If-Match check mean something. Without it
 * the read and the write are two statements at READ COMMITTED: two
 * PATCHes carrying the same If-Match both read version N, both pass the
 * check and both write. It also covers the writers that never send an
 * If-Match — the FX and points passes `jsonb_set` their provenance into
 * `metadata` — because `updateTransaction` read-modify-writes that
 * column: with the lock held, such a pass either lands first (and the
 * `bump_version` trigger turns the PATCH into a 412) or waits and
 * applies on top of the committed row. Neither side's write is lost.
 *
 * LOCK ORDER: postings before the head row. A mutation that writes or
 * deletes EXISTING posting rows takes their locks first (`lockPostingRow`
 * for one posting, `lockPostingRowsOf` for whole transactions), then
 * this one. See `lockPostingRow` for why.
 */
async function lockTransactionRow(tx: DbTx, workspaceId: string, id: string) {
  const rows = await tx
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
    )
    .for("update");
  if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
  return rows[0]!;
}

/**
 * Load one posting of a transaction and take its row lock. Call it
 * BEFORE `lockTransactionRow` — the order is the point.
 *
 * The FX and points passes (`src/fx/normalize.ts`,
 * `src/points/valuation.ts`) write a transaction's postings first, in id
 * order, and its `metadata` second, in one DB transaction. A posting
 * PATCH or DELETE that held the head row and then reached for the
 * posting would meet such a pass head-on: each holds the row the other
 * needs, and Postgres ends it by aborting one of them after
 * `deadlock_timeout` — a 500 for the API call, or a silently unconverted
 * foreign leg when the pass is the one aborted (`normalizeFxSafely`
 * swallows the error). Taking the posting first puts both writers in the
 * same order, so one simply waits: the pass lands, its metadata write
 * bumps the version, and the PATCH answers 412 against the row it can
 * now see.
 *
 * The whole file follows the one rule so no pair of writers can cross:
 * postings (in id order) before the head row. A hard delete removes the
 * postings through the FK cascade, which would take them AFTER the head
 * row, so the delete paths lock them explicitly first
 * (`lockPostingRowsOf`). Adding a posting takes only the head row: the
 * new row is nobody else's to wait for.
 *
 * Returns null when the transaction has no such posting; the caller
 * reports that after the head-row checks, so a missing transaction or a
 * stale If-Match is still what the client hears first.
 */
async function lockPostingRow(
  tx: DbTx,
  workspaceId: string,
  txId: string,
  postingId: string,
) {
  const rows = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.id, postingId),
        eq(postings.transactionId, txId),
        eq(postings.workspaceId, workspaceId),
      ),
    )
    .for("update");
  return rows[0] ?? null;
}

/**
 * Lock every posting of the given transactions, in id order. For the
 * paths that delete whole transactions (`deleteTransaction` here, the
 * cascade in documents.service.ts): call it BEFORE locking the head
 * rows. See `lockPostingRow` for the rule this keeps.
 */
export async function lockPostingRowsOf(
  tx: DbTx,
  transactionIds: string[],
): Promise<void> {
  if (transactionIds.length === 0) return;
  await tx
    .select({ id: postings.id })
    .from(postings)
    .where(inArray(postings.transactionId, transactionIds))
    .orderBy(postings.id)
    .for("update");
}

/**
 * Posting mutations change what a transaction is worth, so they are
 * refused in the two states where that must not move:
 *
 *   - soft-deleted — the row is out of every money query; editing it is
 *     editing a tombstone. Restore first.
 *   - reconciled — the amounts were matched to a bank line. The delete
 *     paths already refuse this state; changing the amounts in place
 *     breaks the match just as surely. Unreconcile first.
 */
function assertPostingsMutable(row: {
  id: string;
  status: string;
  deletedAt: Date | null;
}): void {
  if (row.deletedAt !== null) {
    throw new HttpProblem(
      409,
      "transaction-deleted",
      "Transaction is soft-deleted",
      `Transaction ${row.id} has deleted_at set; restore it before changing its postings.`,
      { transaction_id: row.id },
    );
  }
  if (row.status === "reconciled") {
    throw new HttpProblem(
      409,
      "transaction-reconciled",
      "Transaction is reconciled",
      `Transaction ${row.id} is reconciled. Unreconcile it first, then change its postings.`,
      // `transaction_status`, not `status`: problem extras are spread
      // over the body, and a `status` key there replaces the RFC 7807
      // HTTP status code with the string "reconciled".
      { transaction_id: row.id, transaction_status: row.status },
    );
  }
}

/** What the caller said about one posting's money, after the currency
 *  and native amount have been defaulted from the account / the stored
 *  row. `fxRate` and `amountBaseMinor` are exactly what was supplied. */
interface PostingMoneyInput {
  currency: string;
  amountMinor: number;
  fxRate: string | undefined;
  amountBaseMinor: number | undefined;
}

const FX_RATE_SHAPE = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;
/** `postings.fx_rate` is numeric(20,10): ten integer digits, ten
 *  decimals. A larger value overflows the column; a smaller positive one
 *  is stored as zero. */
const FX_RATE_LIMIT = 1e10;
const FX_RATE_DECIMALS = 10;

/**
 * The one place a posting's base-currency side is decided, shared by
 * create, add and update so the three cannot drift.
 *
 * `amount_minor` is what the document says; `amount_base_minor` is the
 * same money in the workspace base currency, and it is the column the
 * balance trigger and every report sum. The rules keep the pair from
 * disagreeing silently:
 *
 *   - Base currency: the two are the same number by definition. The
 *     server sets `amount_base_minor = amount_minor` and `fx_rate = NULL`;
 *     a client-supplied base amount that differs is refused rather than
 *     stored (it used to be stored, and the trigger — which only sums the
 *     base column — could not see the disagreement).
 *   - Foreign cash: `fx_rate` and `amount_base_minor` must arrive
 *     together. There is no rate source on the request path, so the
 *     server cannot restate one from the other.
 *   - Points: an explicit pair wins (a correction, or an import of
 *     already-valued history); with neither, the server applies the
 *     programme valuation (#206). `pointsRate` is that valuation in base
 *     minor units per point, 0 when the programme has none.
 *
 * The base amount may round to zero but never points the other way from
 * the native amount. Whether `amount_base_minor` is numerically
 * `amount_minor × fx_rate` is NOT checked here: the FX pass settles
 * rounding residue onto one leg, so the product is only approximate.
 */
function resolvePostingMoney(
  input: PostingMoneyInput,
  baseCurrency: string,
  pointsRate: number | undefined,
  pathPrefix = "",
): { fxRate: string | null; amountBaseMinor: bigint } {
  const { currency, amountMinor, fxRate, amountBaseMinor } = input;
  const at = (field: string): string => `${pathPrefix}${field}`;

  if (currency === baseCurrency) {
    if (fxRate !== undefined && Number(fxRate) !== 1) {
      throw new ValidationProblem([
        {
          path: at("fx_rate"),
          code: "unexpected",
          message:
            "fx_rate must be omitted when currency equals the workspace base currency",
        },
      ]);
    }
    if (amountBaseMinor !== undefined && amountBaseMinor !== amountMinor) {
      throw new ValidationProblem(
        [
          {
            path: at("amount_base_minor"),
            code: "mismatch",
            message: `amount_base_minor (${amountBaseMinor}) must equal amount_minor (${amountMinor}) for a ${baseCurrency} posting; omit it and the server sets it`,
          },
        ],
        "Base-currency postings carry one amount",
      );
    }
    return { fxRate: null, amountBaseMinor: BigInt(amountMinor) };
  }

  const points = isPointsCurrency(currency);
  if ((fxRate === undefined) !== (amountBaseMinor === undefined)) {
    throw new ValidationProblem(
      [
        {
          path: at(fxRate === undefined ? "fx_rate" : "amount_base_minor"),
          code: "required",
          message: points
            ? "fx_rate and amount_base_minor must be supplied together, or both omitted to apply the programme valuation"
            : "fx_rate and amount_base_minor must be supplied together for a non-base-currency posting",
        },
      ],
      "fx_rate and amount_base_minor travel together",
    );
  }
  if (fxRate === undefined || amountBaseMinor === undefined) {
    if (!points) {
      throw new ValidationProblem(
        [
          {
            path: at("fx_rate"),
            code: "required",
            message: `fx_rate + amount_base_minor required for a ${currency} posting (workspace base currency is ${baseCurrency})`,
          },
        ],
        "Non-base-currency postings must supply fx_rate and amount_base_minor",
      );
    }
    const rate = pointsRate ?? 0;
    return {
      fxRate: String(rate),
      amountBaseMinor: toBaseMinor(amountMinor, rate),
    };
  }

  const rate = FX_RATE_SHAPE.test(fxRate) ? Number(fxRate) : NaN;
  // Judge the rate as the column will hold it. A points programme may be
  // unvalued (rate 0); a cash rate may not, and that includes one so
  // small it rounds to zero at the column's ten decimals.
  const inRange = Number.isFinite(rate) && rate < FX_RATE_LIMIT;
  const storedAsZero = inRange && Number(rate.toFixed(FX_RATE_DECIMALS)) === 0;
  if (!inRange || (!points && storedAsZero)) {
    throw new ValidationProblem([
      {
        path: at("fx_rate"),
        code: "invalid",
        message: points
          ? "fx_rate must be a non-negative decimal number below 10^10"
          : "fx_rate must be a positive decimal number below 10^10, and at least 10^-10",
      },
    ]);
  }
  if (
    amountBaseMinor !== 0 &&
    Math.sign(amountBaseMinor) !== Math.sign(amountMinor)
  ) {
    throw new ValidationProblem(
      [
        {
          path: at("amount_base_minor"),
          code: "sign_mismatch",
          message: `amount_base_minor (${amountBaseMinor}) must have the same sign as amount_minor (${amountMinor})`,
        },
      ],
      "A posting's native and base amounts must point the same way",
    );
  }
  return { fxRate, amountBaseMinor: BigInt(amountBaseMinor) };
}

/** Programme valuation for a points currency on a date, in base minor
 *  units per point; 0 when the programme has none (the visible
 *  `unvalued` state, never a guessed number). */
async function pointsRateOn(
  workspaceId: string,
  currency: string,
  baseCurrency: string,
  onDate: string,
): Promise<number> {
  const v = await resolvePointsValuation(
    workspaceId,
    currency,
    baseCurrency,
    onDate,
  );
  return v?.minorPerPoint ?? 0;
}

/** Workspace-scoped account lookup for a posting; 422 when the id is
 *  unknown or belongs to another workspace. */
async function loadPostingAccount(
  runner: typeof db,
  workspaceId: string,
  accountId: string,
): Promise<{ id: string; currency: string }> {
  const rows = await runner
    .select({
      id: accounts.id,
      currency: accounts.currency,
      workspaceId: accounts.workspaceId,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const acct = rows[0];
  if (!acct || acct.workspaceId !== workspaceId) {
    throw new ValidationProblem([
      {
        path: "account_id",
        code: "not_found",
        message: `Account ${accountId} not found in workspace`,
      },
    ]);
  }
  return { id: acct.id, currency: acct.currency };
}

/** The fields of a posting worth keeping in an audit event. */
interface PostingAuditSnapshot {
  account_id: string;
  amount_minor: number;
  currency: string;
  fx_rate: string | null;
  amount_base_minor: number | null;
  memo: string | null;
}

function postingAuditSnapshot(p: {
  accountId: string;
  amountMinor: bigint;
  currency: string;
  fxRate: string | null;
  amountBaseMinor: bigint | null;
  memo: string | null;
}): PostingAuditSnapshot {
  return {
    account_id: p.accountId,
    amount_minor: Number(p.amountMinor),
    currency: p.currency,
    fx_rate: p.fxRate,
    amount_base_minor:
      p.amountBaseMinor === null ? null : Number(p.amountBaseMinor),
    memo: p.memo,
  };
}

// ── Create ─────────────────────────────────────────────────────────────

export async function createTransaction(
  workspaceId: string,
  userId: string,
  body: CreateReq,
): Promise<TransactionRow> {
  const status = body.status ?? "posted";
  const baseCurrency = await loadWorkspaceBaseCurrency(db, workspaceId);

  // Pre-load all referenced accounts so we can validate currency and
  // workspace ownership in one round trip.
  const acctIds = Array.from(new Set(body.postings.map((p) => p.account_id)));
  const acctRows = await db
    .select({ id: accounts.id, currency: accounts.currency, workspaceId: accounts.workspaceId })
    .from(accounts)
    .where(inArray(accounts.id, acctIds));
  const acctMap = new Map(acctRows.map((r) => [r.id, r]));
  for (const aid of acctIds) {
    const a = acctMap.get(aid);
    if (!a || a.workspaceId !== workspaceId) {
      throw new ValidationProblem(
        [{ path: "postings.account_id", code: "not_found", message: `Account ${aid} not found in workspace` }],
        "One or more postings reference unknown accounts",
      );
    }
  }

  // Validate documents up-front if provided.
  if (body.document_ids && body.document_ids.length > 0) {
    const docRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          inArray(documents.id, body.document_ids),
          eq(documents.workspaceId, workspaceId),
        ),
      );
    if (docRows.length !== body.document_ids.length) {
      const found = new Set(docRows.map((d) => d.id));
      const missing = body.document_ids.filter((d) => !found.has(d));
      throw new ValidationProblem(
        missing.map((m) => ({ path: "document_ids", code: "not_found", message: `Document ${m} not in workspace` })),
        "One or more documents not found",
      );
    }
  }

  // Build posting inserts with computed currency/fx fields.
  type PostingInsert = {
    id: string;
    workspaceId: string;
    transactionId: string;
    accountId: string;
    amountMinor: bigint;
    currency: string;
    fxRate: string | null;
    amountBaseMinor: bigint | null;
    memo: string | null;
  };

  // #206 — a points posting has no published rate for the client to
  // supply, so the server resolves the programme valuation instead of
  // demanding fx_rate + amount_base_minor from the caller. Resolved up
  // front, once per programme, because the posting map below is sync.
  // A programme with no valuation resolves to 0, which is the same
  // visible `unvalued` state the ingest path produces — never a silent
  // rejection and never a guessed number.
  const pointsRates = new Map<string, number>();
  for (const p of body.postings) {
    const currency = p.currency ?? acctMap.get(p.account_id)!.currency;
    if (!isPointsCurrency(currency) || pointsRates.has(currency)) continue;
    pointsRates.set(
      currency,
      await pointsRateOn(workspaceId, currency, baseCurrency, body.occurred_on),
    );
  }

  const txId = newId();
  const postingInserts: PostingInsert[] = body.postings.map((p, idx) => {
    const acct = acctMap.get(p.account_id)!;
    const currency = p.currency ?? acct.currency;
    const money = resolvePostingMoney(
      {
        currency,
        amountMinor: p.amount_minor,
        fxRate: p.fx_rate,
        amountBaseMinor: p.amount_base_minor,
      },
      baseCurrency,
      pointsRates.get(currency),
      `postings.${idx}.`,
    );
    return {
      id: newId(),
      workspaceId,
      transactionId: txId,
      accountId: p.account_id,
      amountMinor: BigInt(p.amount_minor),
      currency,
      fxRate: money.fxRate,
      amountBaseMinor: money.amountBaseMinor,
      memo: p.memo ?? null,
    };
  });

  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      await tx.insert(transactions).values({
        id: txId,
        workspaceId,
        occurredOn: body.occurred_on,
        occurredAt: body.occurred_at ? new Date(body.occurred_at) : null,
        payee: body.payee ?? null,
        narration: body.narration ?? null,
        status,
        tripId: body.trip_id ?? null,
        metadata: body.metadata ?? {},
        createdBy: userId,
      });

      await tx.insert(postings).values(postingInserts);

      if (body.document_ids && body.document_ids.length > 0) {
        await tx.insert(documentLinks).values(
          body.document_ids.map((docId) => ({
            documentId: docId,
            transactionId: txId,
          })),
        );
      }

      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: txId,
        eventType: "created",
        actorId: userId,
        payload: {
          occurred_on: body.occurred_on,
          payee: body.payee ?? null,
          narration: body.narration ?? null,
          status,
          posting_count: postingInserts.length,
          document_ids: body.document_ids ?? [],
        },
      });

      const full = await loadTransactionFull(
        tx as unknown as typeof db,
        workspaceId,
        txId,
      );
      if (!full) throw new Error("Failed to read back newly-created transaction");
      return full;
    });
  });
}

// ── Line items (manual backfill, #183 Phase 2) ─────────────────────────

/**
 * Append manually-entered line items to an existing transaction.
 *
 * Exists because ingest was the only writer of `transaction_items`, so
 * a purchase with no receipt to OCR could reach the ledger but never
 * the product catalog or Things (#183). A sibling endpoint rather than
 * an `items[]` field on `POST /v1/transactions` keeps `createTransaction`
 * single-purpose.
 *
 * Ledger-neutral by construction: it writes no postings and does not
 * touch the head row, so the deferred balance triggers see nothing and
 * `transactions.version` is unchanged (hence no If-Match — there is no
 * payload to clobber). Callers who want the postings to agree with the
 * lines they just typed reconcile that themselves.
 *
 * Provenance, all three orthogonal:
 *   - `source = 'manual'`      — the pathway (#183 Phase 3)
 *   - `extraction_version`     — left NULL, "no prompt produced this"
 *   - `extraction_run`         — joins the transaction's current LIVE
 *     run so the new lines read back next to the existing ones (every
 *     read path filters `retired_at IS NULL`, not on the run number).
 */
export async function addTransactionItems(
  workspaceId: string,
  userId: string,
  txId: string,
  items: NewTransactionItemInput[],
): Promise<{
  transaction_id: string;
  extraction_run: number;
  items: TransactionItemRow[];
}> {
  const txRows = await db
    .select({ id: transactions.id, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(
      and(eq(transactions.id, txId), eq(transactions.workspaceId, workspaceId)),
    );
  if (txRows.length === 0) throw new NotFoundProblem("Transaction", txId);
  if (txRows[0]!.deletedAt !== null) {
    throw new HttpProblem(
      409,
      "transaction-deleted",
      "Transaction is soft-deleted",
      `Transaction ${txId} has deleted_at set; restore it before adding line items.`,
    );
  }

  // `transaction_items.currency` is NOT NULL and the head row carries no
  // currency — the postings do. One distinct posting currency is the
  // unambiguous answer; a mixed-currency transaction must say which.
  const currencyRows = await db
    .select({ currency: postings.currency })
    .from(postings)
    .where(eq(postings.transactionId, txId));
  const txCurrencies = Array.from(new Set(currencyRows.map((r) => r.currency)));
  const defaultCurrency = txCurrencies.length === 1 ? txCurrencies[0]! : null;

  // Current live run + highest live line_no, in one round trip. Both
  // default for a transaction that has no items yet.
  const stateRes = await db.execute(sql`
    SELECT COALESCE(MAX(extraction_run), 1) AS run,
           COALESCE(MAX(line_no), 0)        AS max_line_no
      FROM transaction_items
     WHERE transaction_id = ${txId}::uuid
       AND workspace_id = ${workspaceId}::uuid
       AND retired_at IS NULL`);
  const run = Number((stateRes.rows[0] as any)?.run ?? 1);
  let nextLineNo = Number((stateRes.rows[0] as any)?.max_line_no ?? 0) + 1;

  // Validate catalog links up front — one round trip, precise 422.
  const productIds = Array.from(
    new Set(
      items
        .map((i) => i.product_id)
        .filter((p): p is string => typeof p === "string"),
    ),
  );
  if (productIds.length > 0) {
    const found = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          inArray(products.id, productIds),
          eq(products.workspaceId, workspaceId),
        ),
      );
    const known = new Set(found.map((p) => p.id));
    const missing = productIds.filter((p) => !known.has(p));
    if (missing.length > 0) {
      throw new ValidationProblem(
        missing.map((m) => ({
          path: "items.product_id",
          code: "not_found",
          message: `Product ${m} not in workspace`,
        })),
        "One or more items reference unknown products",
      );
    }
  }

  const inserts = items.map((item, idx) => {
    const currency = item.currency ?? defaultCurrency;
    if (!currency) {
      throw new ValidationProblem(
        [
          {
            path: `items.${idx}.currency`,
            code: "required",
            message:
              txCurrencies.length === 0
                ? "Transaction has no postings to inherit a currency from; supply currency explicitly."
                : `Transaction postings span ${txCurrencies.join(", ")}; supply currency explicitly.`,
          },
        ],
        "Cannot infer the line item's currency",
      );
    }
    const lineNo = item.line_no ?? nextLineNo++;
    return {
      id: newId(),
      workspaceId,
      transactionId: txId,
      lineNo,
      parentLineNo: item.parent_line_no ?? null,
      rawName: item.raw_name,
      normalizedName: item.normalized_name ?? null,
      productVariant: item.product_variant ?? null,
      quantity: item.quantity === undefined || item.quantity === null
        ? null
        : String(item.quantity),
      unit: item.unit ?? null,
      unitPriceMinor: item.unit_price_minor ?? null,
      lineTotalMinor: item.line_total_minor,
      currency,
      itemClass: item.item_class,
      durabilityTier: item.durability_tier ?? null,
      foodKind: item.food_kind ?? null,
      tags: item.tags ?? null,
      confidence: item.confidence ?? "high",
      lineType: item.line_type ?? "product",
      productId: item.product_id ?? null,
      taxMinor: item.tax_minor ?? null,
      tipShareMinor: item.tip_share_minor ?? null,
      discountShareMinor: item.discount_share_minor ?? null,
      extractionRun: run,
      // NOT the string 'manual' — see the column comment. NULL means
      // "no prompt produced this row"; the pathway is `source`.
      extractionVersion: null,
      source: "manual",
      metadata: item.metadata ?? {},
    };
  });

  // Reject a collision inside the request itself before the DB sees it —
  // the unique index would report only the first offender.
  const seen = new Set<number>();
  for (const ins of inserts) {
    if (seen.has(ins.lineNo)) {
      throw new ValidationProblem(
        [
          {
            path: "items.line_no",
            code: "duplicate",
            message: `line_no ${ins.lineNo} appears twice in this request`,
          },
        ],
        "Duplicate line_no in request",
      );
    }
    seen.add(ins.lineNo);
  }

  // The rows and their audit event commit together: a crash between two
  // autocommitted statements used to leave line items with no
  // `items_added` event explaining where they came from.
  let inserted;
  try {
    inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(transactionItems)
        .values(inserts)
        .returning();
      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: txId,
        eventType: "items_added",
        actorId: userId,
        payload: {
          source: "manual",
          extraction_run: run,
          line_nos: inserts.map((i) => i.lineNo),
          count: inserts.length,
        },
      });
      return rows;
    });
  } catch (err) {
    // 23505 on transaction_items_line_no_run_uq — an explicit line_no
    // already exists in the live run. This makes an explicit line_no a
    // safe retry key: the second attempt 409s instead of duplicating.
    if (pgCode(err) === "23505") {
      throw new HttpProblem(
        409,
        "line-no-conflict",
        "Line number already used",
        `One or more line_no values already exist on transaction ${txId} in extraction_run ${run}. Omit line_no to append, or pick unused numbers.`,
      );
    }
    throw err;
  }

  const byLine = new Map(inserted.map((r: any) => [Number(r.lineNo), r]));
  return {
    transaction_id: txId,
    extraction_run: run,
    items: inserts
      .map((i) => byLine.get(i.lineNo))
      .filter((r): r is any => r !== undefined)
      .map(mapTransactionItem),
  };
}

// ── Get ────────────────────────────────────────────────────────────────

export async function getTransaction(
  workspaceId: string,
  id: string,
): Promise<TransactionRow> {
  const row = await loadTransactionFull(db, workspaceId, id);
  if (!row) throw new NotFoundProblem("Transaction", id);
  return row;
}

// ── List ───────────────────────────────────────────────────────────────

type SortColumn = "occurred_on" | "created_at" | "amount";

/** Keyset cursor on (<sort column value>, id). The `sort` field is
 *  stored on the cursor so paginating a result set keeps using the
 *  same ORDER BY column that was used to compute it. Legacy cursors
 *  written before sort=created_at was honored use the un-tagged
 *  `{ occurred_on, id }` shape and are coerced at decode time.
 *  For sort=amount the `value` is a stringified bigint of
 *  MAX(ABS(p.amount_base_minor)) — the largest leg in minor units. */
interface ListCursor {
  sort: SortColumn;
  value: string;
  /** sort=occurred_on only: the within-day key, the row's `occurred_at`
   *  as ISO-8601 or `-infinity` when the row has no time. Absent on
   *  cursors issued before the within-day key existed. */
  at?: string;
  id: string;
}

interface LegacyListCursor {
  occurred_on: string;
  id: string;
}

function normalizeCursor(raw: ListCursor | LegacyListCursor | null): ListCursor | null {
  if (!raw) return null;
  if ("sort" in raw) return raw;
  return { sort: "occurred_on", value: raw.occurred_on, id: raw.id };
}

export interface ListTransactionsResult {
  items: TransactionRow[];
  next_cursor: string | null;
}

export async function listTransactions(
  workspaceId: string,
  query: ListTxQuery,
): Promise<ListTransactionsResult> {
  const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
  const order = query.order ?? "desc";
  const wantDesc = order === "desc";

  // Default to created_at so freshly-uploaded receipts surface at the
  // top regardless of their occurred_on date — the user mental model
  // after upload is "I just added this; it should be at the top."
  //
  // sort=amount sorts by MAX(ABS(p.amount_base_minor)) per transaction
  // — the largest leg, in base-currency minor units. Mirrors the
  // axis already used by amount_min_minor / amount_max_minor filters
  // below so a transaction's "amount" means the same thing for both.
  let sortCol: SortColumn;
  switch (query.sort) {
    case "occurred_on":
      sortCol = "occurred_on";
      break;
    case "amount":
      sortCol = "amount";
      break;
    default:
      sortCol = "created_at";
      break;
  }

  const amountSubquery = sql`(SELECT COALESCE(MAX(ABS(p.amount_base_minor)), 0) FROM postings p WHERE p.transaction_id = t.id)`;

  // The ORDER BY expression and the cast applied to the keyset cursor
  // value have to describe the same column; pairing them in one switch
  // makes it impossible to edit one and forget the other.
  let sortColSql: ReturnType<typeof sql>;
  let cursorCast: ReturnType<typeof sql>;
  switch (sortCol) {
    case "occurred_on":
      sortColSql = sql`t.occurred_on`;
      cursorCast = sql`::date`;
      break;
    case "amount":
      sortColSql = amountSubquery;
      cursorCast = sql`::bigint`;
      break;
    default:
      sortColSql = sql`t.created_at`;
      cursorCast = sql`::timestamptz`;
      break;
  }

  const conditions: ReturnType<typeof sql>[] = [];
  conditions.push(sql`t.workspace_id = ${workspaceId}::uuid`);
  // Hide soft-deleted (e.g. deduped) rows unless explicitly requested. #171
  if (!query.include_deleted) conditions.push(sql`t.deleted_at IS NULL`);
  if (query.occurred_from) conditions.push(sql`t.occurred_on >= ${query.occurred_from}::date`);
  if (query.occurred_to) conditions.push(sql`t.occurred_on <= ${query.occurred_to}::date`);
  if (query.status) conditions.push(sql`t.status = ${query.status}`);
  if (query.trip_id) conditions.push(sql`t.trip_id = ${query.trip_id}::uuid`);
  if (query.source_ingest_id) conditions.push(sql`t.source_ingest_id = ${query.source_ingest_id}::uuid`);
  if (query.payee_contains) conditions.push(sql`t.payee ILIKE ${"%" + query.payee_contains + "%"}`);
  // `q` spans the header AND the line items. Header-only search was a
  // payee-only search in practice — `narration` is populated on 0.4% of rows,
  // while 98% carry line items — so typing a product name found nothing (#217).
  // Both name columns are matched: `normalized_name` is the cleaned name,
  // `raw_name` the original listing title. An accessory bought *for* an iPad
  // often says so only in `raw_name`, and recall matters more here than tidy
  // results — a spurious hit is skipped at a glance, a missing one is never
  // known about.
  if (query.q) {
    const needle = `%${query.q}%`;
    conditions.push(sql`(
      (COALESCE(t.payee, '') || ' ' || COALESCE(t.narration, '')) ILIKE ${needle}
      OR EXISTS (
        SELECT 1 FROM transaction_items ti
        WHERE ti.transaction_id = t.id
          AND (ti.raw_name ILIKE ${needle} OR COALESCE(ti.normalized_name, '') ILIKE ${needle})
      )
    )`);
  }
  if (query.account_id) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ${query.account_id}::uuid)`);
  }
  if (query.amount_min_minor !== undefined) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND ABS(p.amount_base_minor) >= ${query.amount_min_minor})`);
  }
  if (query.amount_max_minor !== undefined) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND ABS(p.amount_base_minor) <= ${query.amount_max_minor})`);
  }
  if (query.flagged === "near_dup") {
    conditions.push(
      sql`(t.metadata->'near_dup_check'->>'flagged_for_review')::boolean IS TRUE`,
    );
  }
  if (query.has_document === true) {
    conditions.push(sql`EXISTS (SELECT 1 FROM document_links dl WHERE dl.transaction_id = t.id)`);
  } else if (query.has_document === false) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM document_links dl WHERE dl.transaction_id = t.id)`);
  }

  // Keyset cursor on (<sort column>, id). If the cursor was issued
  // under a different sort, results would be wrong — callers must
  // not mix sorts within a pagination session. The cursor carries
  // its sort so we can at least detect and refuse the mix.
  // sort=occurred_on orders by date, then by time of day within the date.
  // Without this second key, same-day rows came back in uuid order, i.e.
  // at random: lunch under dinner, this morning's upload under last
  // night's. Rows with no occurred_at sink to the bottom of their day
  // (desc) — their position within the day is genuinely unknown.
  const tieSql =
    sortCol === "occurred_on"
      ? sql`COALESCE(t.occurred_at, '-infinity'::timestamptz)`
      : null;

  const cursor = normalizeCursor(decodeCursor<ListCursor | LegacyListCursor>(query.cursor ?? undefined));
  if (cursor) {
    if (cursor.sort !== sortCol) {
      throw new HttpProblem(
        400,
        "cursor-sort-mismatch",
        "Cursor was issued under a different sort",
        `Cursor was issued for sort=${cursor.sort} but request asked for sort=${sortCol}. ` +
          "Either keep the original sort or omit the cursor to start fresh.",
      );
    }
    if (tieSql) {
      // A cursor issued before the within-day key existed has no `at`.
      // Resume from the edge of that day that re-shows rows rather than
      // skipping them: a duplicate on one page is harmless, a gap is not.
      const at = cursor.at ?? (wantDesc ? "infinity" : "-infinity");
      conditions.push(
        wantDesc
          ? sql`(${sortColSql}, ${tieSql}, t.id) < (${cursor.value}${cursorCast}, ${at}::timestamptz, ${cursor.id}::uuid)`
          : sql`(${sortColSql}, ${tieSql}, t.id) > (${cursor.value}${cursorCast}, ${at}::timestamptz, ${cursor.id}::uuid)`,
      );
    } else if (wantDesc) {
      conditions.push(sql`(${sortColSql}, t.id) < (${cursor.value}${cursorCast}, ${cursor.id}::uuid)`);
    } else {
      conditions.push(sql`(${sortColSql}, t.id) > (${cursor.value}${cursorCast}, ${cursor.id}::uuid)`);
    }
  }

  const where = sql.join(conditions, sql` AND `);
  const dir = wantDesc ? sql`DESC` : sql`ASC`;
  const orderSql = tieSql
    ? sql`${sortColSql} ${dir}, ${tieSql} ${dir}, t.id ${dir}`
    : sql`${sortColSql} ${dir}, t.id ${dir}`;

  // When sorting by amount, expose the computed value as `sort_amount`
  // so we can recover it for the next_cursor below without re-querying.
  const selectClause =
    sortCol === "amount"
      ? sql`SELECT t.*, ${amountSubquery} AS sort_amount`
      : sql`SELECT t.*`;
  const rowsRes = await db.execute(
    sql`${selectClause} FROM transactions t WHERE ${where} ORDER BY ${orderSql} LIMIT ${limit + 1}`,
  );
  const rows = rowsRes.rows as any[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  if (page.length === 0) {
    return { items: [], next_cursor: null };
  }

  const ids = page.map((r) => r.id);
  // Inlined rather than bound because it is spliced into three different
  // ANY(...) clauses below. Safe to interpolate: `ids` are uuids read
  // straight back out of the page rows this function just selected.
  const idArrayLiteral = `ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`;
  const postRes = await db.execute(
    sql`SELECT p.*, a.type AS account_type
          FROM postings p
          JOIN accounts a ON a.id = p.account_id
         WHERE p.transaction_id = ANY(${sql.raw(idArrayLiteral)})
         ORDER BY p.created_at ASC`,
  );
  const postByTx = new Map<string, any[]>();
  for (const p of postRes.rows as any[]) {
    const arr = postByTx.get(p.transaction_id) ?? [];
    arr.push(p);
    postByTx.set(p.transaction_id, arr);
  }

  // `deleted_at` rides along even though `mime_type` / `source_meta` are
  // deliberately detail-only: the Ledger list tombstones soft-deleted
  // rows inline, so it cannot afford a per-row detail fetch to learn it.
  const docRes = await db.execute(
    sql`SELECT dl.transaction_id, d.id, d.kind, d.deleted_at
        FROM document_links dl JOIN documents d ON d.id = dl.document_id
        WHERE dl.transaction_id = ANY(${sql.raw(idArrayLiteral)})`,
  );
  const docByTx = new Map<
    string,
    Array<{ id: string; kind: string; deleted_at: unknown }>
  >();
  for (const d of docRes.rows as any[]) {
    const arr = docByTx.get(d.transaction_id) ?? [];
    arr.push({ id: d.id, kind: d.kind, deleted_at: d.deleted_at });
    docByTx.set(d.transaction_id, arr);
  }

  const placeIds = page
    .map((r) => r.place_id as string | null)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const placeMap = placeIds.length > 0 ? await loadPlacesByIds(placeIds) : null;

  const merchantIds = page
    .map((r) => r.merchant_id as string | null)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const merchantMap = merchantIds.length > 0
    ? await loadMerchantRefsByIds(db, merchantIds)
    : null;

  // Bulk-load relational line-items for this page. Empty → fallback
  // path in mapTransactionRow reads metadata.items for pre-#81 rows.
  // #84: filter retired_at IS NULL — re-extract soft-deletes the
  // prior run; only the current run is live.
  const itemRes = await db.execute(
    sql`SELECT * FROM transaction_items WHERE transaction_id = ANY(${sql.raw(idArrayLiteral)}) AND retired_at IS NULL ORDER BY transaction_id, line_no ASC`,
  );
  const itemsByTx = new Map<string, any[]>();
  for (const it of itemRes.rows as any[]) {
    const arr = itemsByTx.get(it.transaction_id) ?? [];
    arr.push(it);
    itemsByTx.set(it.transaction_id, arr);
  }

  const items = page.map((r) =>
    mapTransactionRow(
      r,
      postByTx.get(r.id) ?? [],
      docByTx.get(r.id) ?? [],
      r.place_id && placeMap ? (placeMap.get(r.place_id) ?? null) : null,
      itemsByTx.get(r.id) ?? [],
      r.merchant_id && merchantMap
        ? (merchantMap.get(r.merchant_id) ?? null)
        : null,
    ),
  );

  const last = page[page.length - 1]!;
  let cursorValue: string;
  let cursorAt: string | undefined;
  switch (sortCol) {
    case "occurred_on":
      cursorValue = toIsoDate(last.occurred_on);
      cursorAt = last.occurred_at ? toIsoString(last.occurred_at) : "-infinity";
      break;
    case "amount":
      // sort_amount comes back as a string from node-postgres for bigint;
      // coerce defensively in case the driver decides otherwise.
      cursorValue = String(last.sort_amount ?? 0);
      break;
    default:
      cursorValue = toIsoString(last.created_at);
      break;
  }
  const nextCursor = hasMore
    ? encodeCursor({ sort: sortCol, value: cursorValue, at: cursorAt, id: last.id })
    : null;

  return { items, next_cursor: nextCursor };
}

// ── Update (head fields) ───────────────────────────────────────────────

export async function updateTransaction(
  workspaceId: string,
  userId: string,
  id: string,
  expectedVersion: number,
  patch: UpdateReq,
): Promise<TransactionRow> {
  return await db.transaction(async (tx) => {
    const current = await lockTransactionRow(tx, workspaceId, id);
    if (Number(current.version) !== expectedVersion) {
      // The route pre-checks with requireIfMatch on an unlocked read;
      // this is the check that counts, made under the row lock.
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }

    const updates: Record<string, unknown> = {};
    // The audit event records both sides of every field that moved.
    const oldSnap: Record<string, unknown> = {};
    const newSnap: Record<string, unknown> = {};
    // SOFT Layer-3 fields (see `src/projection/layer3.ts`) — when the
    // user PATCHes one of these, we flag `metadata.user_edited.<field>`
    // so re-extract (#91 Phase 4c) preserves the user value across
    // a re-OCR. Builds up alongside the column updates and is merged
    // into the final `metadata` update below.
    const userEditedAdditions: Partial<Record<SoftLayer3TxField, true>> = {};
    if (patch.occurred_on !== undefined) {
      updates.occurredOn = patch.occurred_on;
      oldSnap.occurred_on = current.occurredOn;
      newSnap.occurred_on = patch.occurred_on;
      userEditedAdditions.occurred_on = true;
    }
    if (patch.occurred_at !== undefined) {
      updates.occurredAt = patch.occurred_at === null ? null : new Date(patch.occurred_at);
      oldSnap.occurred_at = current.occurredAt;
      newSnap.occurred_at = patch.occurred_at;
      userEditedAdditions.occurred_at = true;
    }
    if (patch.payee !== undefined) {
      updates.payee = patch.payee;
      oldSnap.payee = current.payee;
      newSnap.payee = patch.payee;
      userEditedAdditions.payee = true;
    }
    if (patch.narration !== undefined) {
      updates.narration = patch.narration;
      oldSnap.narration = current.narration;
      newSnap.narration = patch.narration;
    }
    if (patch.trip_id !== undefined) {
      updates.tripId = patch.trip_id;
      oldSnap.trip_id = current.tripId;
      newSnap.trip_id = patch.trip_id;
    }

    // `metadata` is a JSON Merge Patch (RFC 7396) over the stored object,
    // never a replacement: the web client sends `metadata: {}` on every
    // save, and that must change nothing. See
    // `src/projection/metadata-patch.ts` for the rules and for which
    // keys a client may not change.
    const currentMetadata: JsonObject =
      current.metadata !== null &&
      typeof current.metadata === "object" &&
      !Array.isArray(current.metadata)
        ? (current.metadata as JsonObject)
        : {};
    let nextMetadata = currentMetadata;
    if (patch.metadata !== undefined) {
      const applied = applyClientTxMetadataPatch(currentMetadata, patch.metadata);
      if (applied.refusedKeys.length > 0) {
        throw new ValidationProblem(
          applied.refusedKeys.map((k) => ({
            path: `metadata.${k}`,
            code: "server_owned",
            message: `metadata.${k} is maintained by the server and cannot be changed or removed through PATCH`,
          })),
          "Patch would change server-owned metadata",
        );
      }
      nextMetadata = applied.next;
    }

    // The server's own write to `metadata`: flag the soft fields this
    // PATCH named. Layered on after the client patch, and `user_edited`
    // is server-owned, so a client can neither forge nor clear a flag.
    if (Object.keys(userEditedAdditions).length > 0) {
      const existing = nextMetadata[USER_EDITED_METADATA_PATH];
      nextMetadata = {
        ...nextMetadata,
        [USER_EDITED_METADATA_PATH]: {
          ...(existing !== null &&
          typeof existing === "object" &&
          !Array.isArray(existing)
            ? (existing as JsonObject)
            : {}),
          ...userEditedAdditions,
        },
      };
    }

    // Write the column only when a key actually moved, and log only
    // those keys: the full object runs to tens of kilobytes (items,
    // raw_text) and would otherwise be copied into every `updated` event.
    // In the two picks a key missing from `new` was removed and a key
    // missing from `old` was added.
    const delta = metadataDelta(currentMetadata, nextMetadata);
    if (delta) {
      // Only the keys that moved are written (`metadataDeltaSql`), over
      // the stored value — the row is locked, so that is the value read
      // above. Untouched keys never round-trip through JavaScript.
      updates.metadata =
        current.metadata === currentMetadata
          ? metadataDeltaSql(transactions.metadata, delta)
          : nextMetadata; // stored value was not an object; replace it
      oldSnap.metadata = delta.oldValues;
      newSnap.metadata = delta.newValues;
    }

    if (Object.keys(updates).length === 0) {
      // Nothing to write (empty patch, or `metadata: {}` alone): no
      // version bump and no event.
      const full = await loadTransactionFull(tx as unknown as typeof db, workspaceId, id);
      return full!;
    }

    await tx
      .update(transactions)
      .set(updates)
      .where(eq(transactions.id, id));

    await tx.insert(transactionEvents).values({
      id: newId(),
      workspaceId,
      transactionId: id,
      eventType: "updated",
      actorId: userId,
      payload: { old: oldSnap, new: newSnap },
    });

    const full = await loadTransactionFull(tx as unknown as typeof db, workspaceId, id);
    return full!;
  });
}

// ── Delete ─────────────────────────────────────────────────────────────

export async function deleteTransaction(
  workspaceId: string,
  id: string,
  expectedVersion: number,
  opts: { userId?: string } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    // The DELETE below takes the postings through the FK cascade; lock
    // them first so the order is postings, then head row (`lockPostingRow`).
    await lockPostingRowsOf(tx, [id]);
    const current = await lockTransactionRow(tx, workspaceId, id);
    if (Number(current.version) !== expectedVersion) {
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }
    // Reconciled rows must be unreconciled first — a deliberate gate so
    // bank-matched entries aren't destroyed by accident.
    if (current.status === "reconciled") {
      throw new HttpProblem(
        409,
        "cannot-delete-reconciled",
        "Cannot delete reconciled transaction",
        `Transaction ${id} is reconciled. Unreconcile it first, then DELETE.`,
        { transaction_id: id, transaction_status: current.status },
      );
    }
    await tx.insert(transactionEvents).values({
      id: newId(),
      workspaceId,
      transactionId: id,
      eventType: "hard_deleted",
      actorId: opts.userId ?? null,
      // `transaction_id` is duplicated into the payload on purpose: the
      // DELETE below nulls the `transaction_events.transaction_id`
      // column (FK is `ON DELETE SET NULL`, see src/schema/audit.ts), so
      // the payload copy is the only surviving pointer back to the row
      // this event — and every earlier event for the same id — describes.
      payload: {
        reason: "hard_delete",
        prior_status: current.status,
        // Since when the row had been soft-deleted, if it was: the row's
        // last word on whether it was live at an earlier moment.
        prior_deleted_at: current.deletedAt ? current.deletedAt.toISOString() : null,
        transaction_id: id,
      },
    });
    // Hard-delete: postings + document_links cascade via FK. Irreversible
    // — the default DELETE path is the reversible soft delete below.
    // `transaction_events` does NOT cascade; the audit trail outlives the
    // row with a null `transaction_id`.
    await tx.delete(transactions).where(eq(transactions.id, id));
  });
}

/**
 * Soft delete: set `deleted_at = NOW()`. The row survives (audit trail
 * intact, restorable) but drops out of every money query. This is the
 * default delete path and what dedup uses to remove a duplicate — the
 * reversible replacement for the removed `void` machinery (#171).
 */
export async function softDeleteTransaction(
  workspaceId: string,
  id: string,
  expectedVersion: number,
  opts: { userId?: string; reason?: string } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockTransactionRow(tx, workspaceId, id);
    if (Number(current.version) !== expectedVersion) {
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }
    if (current.deletedAt) throw new NotFoundProblem("Transaction", id);
    if (current.status === "reconciled") {
      throw new HttpProblem(
        409,
        "cannot-delete-reconciled",
        "Cannot delete reconciled transaction",
        `Transaction ${id} is reconciled. Unreconcile it first, then delete.`,
        { transaction_id: id, transaction_status: current.status },
      );
    }
    await tx
      .update(transactions)
      .set({ deletedAt: new Date() })
      .where(eq(transactions.id, id));
    await tx.insert(transactionEvents).values({
      id: newId(),
      workspaceId,
      transactionId: id,
      eventType: "deleted",
      actorId: opts.userId ?? null,
      payload: {
        reason: opts.reason ?? "soft_delete",
        prior_status: current.status,
      },
    });
  });
}

/**
 * Restore a soft-deleted transaction: clear `deleted_at`. Returns the
 * refreshed row. 404 if the row isn't found or wasn't deleted.
 */
export async function restoreTransaction(
  workspaceId: string,
  id: string,
  expectedVersion: number,
  opts: { userId?: string } = {},
): Promise<TransactionRow> {
  return await db.transaction(async (tx) => {
    const current = await lockTransactionRow(tx, workspaceId, id);
    if (Number(current.version) !== expectedVersion) {
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }
    if (!current.deletedAt) throw new NotFoundProblem("Transaction", id);
    await tx
      .update(transactions)
      .set({ deletedAt: null })
      .where(eq(transactions.id, id));
    await tx.insert(transactionEvents).values({
      id: newId(),
      workspaceId,
      transactionId: id,
      eventType: "restored",
      actorId: opts.userId ?? null,
      payload: {},
    });
    const full = await loadTransactionFull(
      tx as unknown as typeof db,
      workspaceId,
      id,
    );
    return full!;
  });
}

// ── Reconcile ──────────────────────────────────────────────────────────

export async function reconcileTransaction(
  workspaceId: string,
  userId: string,
  id: string,
  expectedVersion: number,
): Promise<TransactionRow> {
  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const current = await lockTransactionRow(tx, workspaceId, id);
      if (Number(current.version) !== expectedVersion) {
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      if (current.status !== "posted") {
        throw new HttpProblem(
          409,
          "invalid-state",
          "Cannot reconcile",
          `Transaction ${id} is in status=${current.status}; only 'posted' may be reconciled.`,
          { transaction_id: id, transaction_status: current.status },
        );
      }

      await tx
        .update(transactions)
        .set({ status: "reconciled" })
        .where(eq(transactions.id, id));

      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: id,
        eventType: "reconciled",
        actorId: userId,
        payload: {},
      });

      const full = await loadTransactionFull(
        tx as unknown as typeof db,
        workspaceId,
        id,
      );
      return full!;
    });
  });
}

// ── Unreconcile ────────────────────────────────────────────────────────
//
// Pure state flip `reconciled → posted` with an audit event. Match-side
// state (e.g. reconcile_proposals or a future bank-line match table) is
// intentionally untouched — callers compose the unreconcile + their own
// match cleanup as needed.

export async function unreconcileTransaction(
  workspaceId: string,
  userId: string,
  id: string,
  expectedVersion: number,
  reason?: string,
): Promise<TransactionRow> {
  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const current = await lockTransactionRow(tx, workspaceId, id);
      if (Number(current.version) !== expectedVersion) {
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      if (current.status !== "reconciled") {
        throw new HttpProblem(
          409,
          "invalid-state",
          "Cannot unreconcile",
          `Transaction ${id} is in status=${current.status}; only 'reconciled' may be unreconciled.`,
          { transaction_id: id, transaction_status: current.status },
        );
      }

      await tx
        .update(transactions)
        .set({ status: "posted" })
        .where(eq(transactions.id, id));

      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: id,
        eventType: "unreconciled",
        actorId: userId,
        payload: reason ? { reason } : {},
      });

      const full = await loadTransactionFull(
        tx as unknown as typeof db,
        workspaceId,
        id,
      );
      return full!;
    });
  });
}

// ── Posting-level mutations ────────────────────────────────────────────
//
// All three take the head row's lock, check If-Match under it, refuse a
// reconciled or soft-deleted transaction (`assertPostingsMutable`), and
// decide the base-currency side in `resolvePostingMoney`. Update and
// delete take the posting's own lock before the head row's
// (`lockPostingRow`) so they queue behind the FX and points passes
// instead of deadlocking with them. Their audit events carry the values
// that changed, old and new — a removed posting's amount used to
// survive nowhere.

export async function addPosting(
  workspaceId: string,
  userId: string,
  txId: string,
  expectedVersion: number,
  body: NewPostingT,
): Promise<PostingRow> {
  const baseCurrency = await loadWorkspaceBaseCurrency(db, workspaceId);
  const acct = await loadPostingAccount(db, workspaceId, body.account_id);
  const currency = body.currency ?? acct.currency;

  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const current = await lockTransactionRow(tx, workspaceId, txId);
      if (Number(current.version) !== expectedVersion) {
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      assertPostingsMutable(current);

      // Same rule as createTransaction: for a points leg with no explicit
      // pair the server resolves the programme valuation (#206), as of
      // the transaction's own date.
      const pointsRate =
        isPointsCurrency(currency) && body.fx_rate === undefined
          ? await pointsRateOn(workspaceId, currency, baseCurrency, current.occurredOn)
          : undefined;
      const money = resolvePostingMoney(
        {
          currency,
          amountMinor: body.amount_minor,
          fxRate: body.fx_rate,
          amountBaseMinor: body.amount_base_minor,
        },
        baseCurrency,
        pointsRate,
      );

      const newPostingId = newId();
      const inserted = {
        accountId: body.account_id,
        amountMinor: BigInt(body.amount_minor),
        currency,
        fxRate: money.fxRate,
        amountBaseMinor: money.amountBaseMinor,
        memo: body.memo ?? null,
      };
      await tx.insert(postings).values({
        id: newPostingId,
        workspaceId,
        transactionId: txId,
        ...inserted,
      });

      // Bump parent version via a dummy UPDATE to fire the version trigger.
      await tx
        .update(transactions)
        .set({ updatedAt: new Date() })
        .where(eq(transactions.id, txId));

      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: txId,
        eventType: "posting_added",
        actorId: userId,
        payload: {
          posting_id: newPostingId,
          new: postingAuditSnapshot(inserted),
        },
      });

      const postRows = await tx
        .select(POSTING_COLUMNS)
        .from(postings)
        .innerJoin(accounts, eq(accounts.id, postings.accountId))
        .where(eq(postings.id, newPostingId));
      return mapPostingRow(postRows[0]!);
    });
  });
}

export async function updatePosting(
  workspaceId: string,
  userId: string,
  txId: string,
  postingId: string,
  expectedVersion: number,
  patch: UpdatePostingReq,
): Promise<PostingRow> {
  const baseCurrency = await loadWorkspaceBaseCurrency(db, workspaceId);

  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      // Posting first, head row second: see `lockPostingRow`.
      const existing = await lockPostingRow(tx, workspaceId, txId, postingId);
      const current = await lockTransactionRow(tx, workspaceId, txId);
      if (Number(current.version) !== expectedVersion) {
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      assertPostingsMutable(current);
      if (!existing) throw new NotFoundProblem("Posting", postingId);

      const next = {
        accountId: existing.accountId,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        fxRate: existing.fxRate,
        amountBaseMinor: existing.amountBaseMinor,
        memo: existing.memo,
      };

      if (patch.account_id !== undefined && patch.account_id !== existing.accountId) {
        // The FK only proves the account exists somewhere; this proves it
        // is one of this workspace's. The posting keeps its own currency:
        // re-categorising a leg does not re-denominate it.
        await loadPostingAccount(
          tx as unknown as typeof db,
          workspaceId,
          patch.account_id,
        );
        next.accountId = patch.account_id;
      }
      if (patch.memo !== undefined) next.memo = patch.memo;

      // Any patch that names a money field restates the whole pair, so
      // `amount_minor` can never move while `amount_base_minor` stays
      // behind (the balance trigger sums only the base column and would
      // not notice). A memo- or account-only patch leaves both alone.
      const touchesMoney =
        patch.amount_minor !== undefined ||
        patch.currency !== undefined ||
        patch.fx_rate !== undefined ||
        patch.amount_base_minor !== undefined;
      if (touchesMoney) {
        const currency = patch.currency ?? existing.currency;
        const amountMinor = patch.amount_minor ?? Number(existing.amountMinor);
        const pointsRate =
          isPointsCurrency(currency) && patch.fx_rate === undefined
            ? await pointsRateOn(workspaceId, currency, baseCurrency, current.occurredOn)
            : undefined;
        const money = resolvePostingMoney(
          {
            currency,
            amountMinor,
            fxRate: patch.fx_rate,
            amountBaseMinor: patch.amount_base_minor,
          },
          baseCurrency,
          pointsRate,
        );
        next.currency = currency;
        next.amountMinor = BigInt(amountMinor);
        next.fxRate = money.fxRate;
        next.amountBaseMinor = money.amountBaseMinor;
      }

      // Diff on the audit shape so the event and the write agree on what
      // moved. `fx_rate` is compared as a number: the column hands back
      // "0.1389000000" for a patched "0.1389".
      const before = postingAuditSnapshot(existing);
      const after = postingAuditSnapshot(next);
      const sameRate =
        before.fx_rate === after.fx_rate ||
        (before.fx_rate !== null &&
          after.fx_rate !== null &&
          Number(before.fx_rate) === Number(after.fx_rate));
      const changed = (
        Object.keys(before) as Array<keyof PostingAuditSnapshot>
      ).filter((k) => (k === "fx_rate" ? !sameRate : before[k] !== after[k]));

      if (changed.length > 0) {
        await tx.update(postings).set(next).where(eq(postings.id, postingId));

        // Bump parent version.
        await tx
          .update(transactions)
          .set({ updatedAt: new Date() })
          .where(eq(transactions.id, txId));

        await tx.insert(transactionEvents).values({
          id: newId(),
          workspaceId,
          transactionId: txId,
          eventType: "posting_updated",
          actorId: userId,
          payload: {
            posting_id: postingId,
            old: Object.fromEntries(changed.map((k) => [k, before[k]])),
            new: Object.fromEntries(changed.map((k) => [k, after[k]])),
          },
        });
      }

      const postRows = await tx
        .select(POSTING_COLUMNS)
        .from(postings)
        .innerJoin(accounts, eq(accounts.id, postings.accountId))
        .where(eq(postings.id, postingId));
      return mapPostingRow(postRows[0]!);
    });
  });
}

export async function deletePosting(
  workspaceId: string,
  userId: string,
  txId: string,
  postingId: string,
  expectedVersion: number,
): Promise<void> {
  await mapBalanceErrors(async () => {
    await db.transaction(async (tx) => {
      // Posting first, head row second: see `lockPostingRow`.
      await lockPostingRow(tx, workspaceId, txId, postingId);
      const current = await lockTransactionRow(tx, workspaceId, txId);
      if (Number(current.version) !== expectedVersion) {
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      assertPostingsMutable(current);

      const allPostings = await tx
        .select()
        .from(postings)
        .where(eq(postings.transactionId, txId));
      const target = allPostings.find((p) => p.id === postingId);
      if (!target) throw new NotFoundProblem("Posting", postingId);

      // Check resulting count upfront to produce a clear 422.
      if (current.status !== "draft" && current.status !== "error" && allPostings.length - 1 < 2) {
        throw new ValidationProblem(
          [{ path: "postings", code: "min_items", message: "A posted transaction must retain at least 2 postings" }],
          "Deleting this posting would leave the transaction with fewer than 2 postings",
        );
      }

      await tx.delete(postings).where(eq(postings.id, postingId));

      await tx
        .update(transactions)
        .set({ updatedAt: new Date() })
        .where(eq(transactions.id, txId));

      await tx.insert(transactionEvents).values({
        id: newId(),
        workspaceId,
        transactionId: txId,
        eventType: "posting_removed",
        actorId: userId,
        // The row is gone after this; the event is the only record of
        // what it was.
        payload: { posting_id: postingId, old: postingAuditSnapshot(target) },
      });
    });
  });
}

// ── Posting queries (for /v1/postings) ─────────────────────────────────

export interface ListPostingsResult {
  items: PostingRow[];
  next_cursor: string | null;
}

interface PostingCursor {
  created_at: string;
  id: string;
}

export async function listPostings(
  workspaceId: string,
  query: ListPostingQuery,
): Promise<ListPostingsResult> {
  const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);

  const conditions: ReturnType<typeof sql>[] = [];
  conditions.push(sql`p.workspace_id = ${workspaceId}::uuid`);
  // Never leak postings of soft-deleted transactions (e.g. deduped rows). #171
  conditions.push(
    sql`EXISTS (SELECT 1 FROM transactions t WHERE t.id = p.transaction_id AND t.deleted_at IS NULL)`,
  );
  if (query.transaction_id) conditions.push(sql`p.transaction_id = ${query.transaction_id}::uuid`);
  if (query.account_id) conditions.push(sql`p.account_id = ${query.account_id}::uuid`);
  if (query.from || query.to) {
    // Join via EXISTS to transactions.occurred_on
    if (query.from) conditions.push(sql`EXISTS (SELECT 1 FROM transactions t WHERE t.id = p.transaction_id AND t.occurred_on >= ${query.from}::date)`);
    if (query.to) conditions.push(sql`EXISTS (SELECT 1 FROM transactions t WHERE t.id = p.transaction_id AND t.occurred_on <= ${query.to}::date)`);
  }

  const cursor = decodeCursor<PostingCursor>(query.cursor ?? undefined);
  if (cursor) {
    conditions.push(
      sql`(p.created_at, p.id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const where = sql.join(conditions, sql` AND `);
  const res = await db.execute(
    sql`SELECT p.*, a.type AS account_type
          FROM postings p
          JOIN accounts a ON a.id = p.account_id
         WHERE ${where}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ${limit + 1}`,
  );
  const rows = res.rows as any[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items = page.map(mapPostingRow);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({
        created_at: toIsoString(last.created_at),
        id: last.id,
      })
    : null;

  return { items, next_cursor: nextCursor };
}

export async function getPosting(
  workspaceId: string,
  id: string,
): Promise<PostingRow> {
  const rows = await db
    .select(POSTING_COLUMNS)
    .from(postings)
    .innerJoin(accounts, eq(accounts.id, postings.accountId))
    .where(
      and(eq(postings.id, id), eq(postings.workspaceId, workspaceId)),
    );
  if (rows.length === 0) throw new NotFoundProblem("Posting", id);
  return mapPostingRow(rows[0]!);
}

/**
 * Resolve a #134 branch-4 near-dup flag (v1: dismiss only). Clears
 * `metadata.near_dup_check.flagged_for_review`, stamps `reviewed_at`,
 * and appends a transaction_events row so the review is auditable.
 * Returns null when the transaction doesn't exist or isn't flagged
 * (idempotent dismiss of an unflagged row is a 404 — the queue is the
 * only caller and it only shows flagged rows).
 */
export async function dismissNearDupFlag(
  workspaceId: string,
  userId: string,
  txId: string,
): Promise<{ id: string; flagged_for_review: boolean; reviewed_at: string } | null> {
  const reviewedAt = new Date().toISOString();
  // One DB transaction: the flag flip and the event that explains it
  // commit together or not at all.
  return await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      UPDATE transactions
         SET metadata = jsonb_set(
               jsonb_set(metadata, '{near_dup_check,flagged_for_review}', 'false'::jsonb),
               '{near_dup_check,reviewed_at}', to_jsonb(${reviewedAt}::text)
             ),
             updated_at = NOW()
       WHERE id = ${txId}::uuid
         AND workspace_id = ${workspaceId}::uuid
         AND (metadata->'near_dup_check'->>'flagged_for_review')::boolean IS TRUE
       RETURNING id`);
    if (res.rows.length === 0) return null;
    await tx.insert(transactionEvents).values({
      id: newId(),
      workspaceId,
      transactionId: txId,
      eventType: "near_dup_reviewed",
      actorId: userId,
      payload: { action: "dismiss", reviewed_at: reviewedAt },
    });
    return { id: txId, flagged_for_review: false, reviewed_at: reviewedAt };
  });
}
