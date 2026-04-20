/**
 * Transactions service — the business logic shared between the HTTP
 * router (`/v1/transactions*`) and the FastMCP tools.
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
import { sql, eq, and, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  transactions,
  postings,
  accounts,
  documents,
  documentLinks,
  transactionEvents,
  workspaces,
} from "../schema/index.js";
import { loadPlacesByIds, type PlaceRow } from "./places.service.js";
import { newId } from "../http/uuid.js";
import {
  HttpProblem,
  NotFoundProblem,
  PostingsImbalanceProblem,
  ValidationProblem,
  MustVoidInsteadProblem,
} from "../http/problem.js";
import type {
  CreateTransactionRequest,
  UpdateTransactionRequest,
  NewPosting,
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

type CreateReq = z.infer<typeof CreateTransactionRequest>;
type UpdateReq = z.infer<typeof UpdateTransactionRequest>;
type NewPostingT = z.infer<typeof NewPosting>;
type UpdatePostingReq = z.infer<typeof UpdatePostingRequest>;
type ListTxQuery = z.infer<typeof ListTransactionsQuery>;
type ListPostingQuery = z.infer<typeof ListPostingsQuery>;

// ── Shared output shapes ───────────────────────────────────────────────

export interface PostingRow {
  id: string;
  transaction_id: string;
  account_id: string;
  amount_minor: number;
  currency: string;
  fx_rate: string | null;
  amount_base_minor: number | null;
  memo: string | null;
  created_at: string;
}

export interface TransactionRow {
  id: string;
  workspace_id: string;
  occurred_on: string;
  occurred_at: string | null;
  payee: string | null;
  narration: string | null;
  status: "draft" | "posted" | "voided" | "reconciled" | "error";
  voided_by_id: string | null;
  source_ingest_id: string | null;
  trip_id: string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  postings: PostingRow[];
  documents: Array<{ id: string; kind: string }>;
  /**
   * Optional Google Places entry for this transaction's merchant
   * location. Null when the extraction agent declined to geocode (no
   * address / no locality hint), when the workspace/ingest predates
   * the places feature, or when the row has been unlinked.
   */
  place: PlaceRow | null;
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

function pgMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: any = err;
  while (cur) {
    if (typeof cur.message === "string") parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
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

function mapPostingRow(row: any): PostingRow {
  return {
    id: row.id,
    transaction_id: row.transactionId ?? row.transaction_id,
    account_id: row.accountId ?? row.account_id,
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

function mapTransactionRow(
  row: any,
  posts: any[],
  docs: Array<{ id: string; kind: string }>,
  place: PlaceRow | null = null,
): TransactionRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId ?? row.workspace_id,
    occurred_on: toIsoDate(row.occurredOn ?? row.occurred_on),
    occurred_at: row.occurredAt ?? row.occurred_at
      ? toIsoString(row.occurredAt ?? row.occurred_at)
      : null,
    payee: row.payee ?? null,
    narration: row.narration ?? null,
    status: row.status,
    voided_by_id: row.voidedById ?? row.voided_by_id ?? null,
    source_ingest_id: row.sourceIngestId ?? row.source_ingest_id ?? null,
    trip_id: row.tripId ?? row.trip_id ?? null,
    metadata: row.metadata ?? {},
    version: Number(row.version),
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
    postings: posts.map(mapPostingRow),
    documents: docs,
    place,
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
    .select()
    .from(postings)
    .where(eq(postings.transactionId, id))
    .orderBy(postings.createdAt);
  const docLinks = await runner
    .select({ id: documents.id, kind: documents.kind })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .where(eq(documentLinks.transactionId, id));
  const placeMap = t.placeId ? await loadPlacesByIds([t.placeId]) : null;
  const place = placeMap?.get(t.placeId!) ?? null;
  return mapTransactionRow(t, posts, docLinks, place);
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

  const txId = newId();
  const postingInserts: PostingInsert[] = body.postings.map((p, idx) => {
    const acct = acctMap.get(p.account_id)!;
    const currency = p.currency ?? acct.currency;
    let fxRate: string | null = null;
    let amountBaseMinor: bigint;
    if (currency === baseCurrency) {
      if (p.fx_rate !== undefined && p.fx_rate !== "1" && p.fx_rate !== "1.0") {
        // Allow redundant "1" but otherwise reject.
        const n = Number(p.fx_rate);
        if (!Number.isFinite(n) || n !== 1) {
          throw new ValidationProblem(
            [{ path: `postings.${idx}.fx_rate`, code: "unexpected", message: "fx_rate must be null when currency equals workspace base currency" }],
          );
        }
      }
      amountBaseMinor = BigInt(p.amount_base_minor ?? p.amount_minor);
    } else {
      if (p.fx_rate === undefined || p.amount_base_minor === undefined) {
        throw new ValidationProblem(
          [
            { path: `postings.${idx}.fx_rate`, code: "required", message: "fx_rate + amount_base_minor required for non-base currency postings" },
          ],
          "Non-base-currency postings must supply fx_rate and amount_base_minor",
        );
      }
      fxRate = p.fx_rate;
      amountBaseMinor = BigInt(p.amount_base_minor);
    }
    return {
      id: newId(),
      workspaceId,
      transactionId: txId,
      accountId: p.account_id,
      amountMinor: BigInt(p.amount_minor),
      currency,
      fxRate,
      amountBaseMinor,
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

interface ListCursor {
  occurred_on: string;
  id: string;
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

  const conditions: ReturnType<typeof sql>[] = [];
  conditions.push(sql`t.workspace_id = ${workspaceId}::uuid`);
  if (query.occurred_from) conditions.push(sql`t.occurred_on >= ${query.occurred_from}::date`);
  if (query.occurred_to) conditions.push(sql`t.occurred_on <= ${query.occurred_to}::date`);
  if (query.status) conditions.push(sql`t.status = ${query.status}`);
  if (query.trip_id) conditions.push(sql`t.trip_id = ${query.trip_id}::uuid`);
  if (query.source_ingest_id) conditions.push(sql`t.source_ingest_id = ${query.source_ingest_id}::uuid`);
  if (query.payee_contains) conditions.push(sql`t.payee ILIKE ${"%" + query.payee_contains + "%"}`);
  if (query.q) conditions.push(sql`(COALESCE(t.payee, '') || ' ' || COALESCE(t.narration, '')) ILIKE ${"%" + query.q + "%"}`);
  if (query.account_id) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ${query.account_id}::uuid)`);
  }
  if (query.amount_min_minor !== undefined) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND ABS(p.amount_base_minor) >= ${query.amount_min_minor})`);
  }
  if (query.amount_max_minor !== undefined) {
    conditions.push(sql`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND ABS(p.amount_base_minor) <= ${query.amount_max_minor})`);
  }
  if (query.has_document === true) {
    conditions.push(sql`EXISTS (SELECT 1 FROM document_links dl WHERE dl.transaction_id = t.id)`);
  } else if (query.has_document === false) {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM document_links dl WHERE dl.transaction_id = t.id)`);
  }

  // Keyset cursor on (occurred_on, id)
  const cursor = decodeCursor<ListCursor>(query.cursor ?? undefined);
  if (cursor) {
    if (wantDesc) {
      conditions.push(sql`(t.occurred_on, t.id) < (${cursor.occurred_on}::date, ${cursor.id}::uuid)`);
    } else {
      conditions.push(sql`(t.occurred_on, t.id) > (${cursor.occurred_on}::date, ${cursor.id}::uuid)`);
    }
  }

  const where = sql.join(conditions, sql` AND `);
  const orderSql = wantDesc
    ? sql`t.occurred_on DESC, t.id DESC`
    : sql`t.occurred_on ASC, t.id ASC`;

  const rowsRes = await db.execute(
    sql`SELECT t.* FROM transactions t WHERE ${where} ORDER BY ${orderSql} LIMIT ${limit + 1}`,
  );
  const rows = rowsRes.rows as any[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  if (page.length === 0) {
    return { items: [], next_cursor: null };
  }

  const ids = page.map((r) => r.id);
  const postRes = await db.execute(
    sql`SELECT * FROM postings WHERE transaction_id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`)}) ORDER BY created_at ASC`,
  );
  const postByTx = new Map<string, any[]>();
  for (const p of postRes.rows as any[]) {
    const arr = postByTx.get(p.transaction_id) ?? [];
    arr.push(p);
    postByTx.set(p.transaction_id, arr);
  }

  const docRes = await db.execute(
    sql`SELECT dl.transaction_id, d.id, d.kind
        FROM document_links dl JOIN documents d ON d.id = dl.document_id
        WHERE dl.transaction_id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`)})`,
  );
  const docByTx = new Map<string, Array<{ id: string; kind: string }>>();
  for (const d of docRes.rows as any[]) {
    const arr = docByTx.get(d.transaction_id) ?? [];
    arr.push({ id: d.id, kind: d.kind });
    docByTx.set(d.transaction_id, arr);
  }

  const placeIds = page
    .map((r) => r.place_id as string | null)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const placeMap = placeIds.length > 0 ? await loadPlacesByIds(placeIds) : null;

  const items = page.map((r) =>
    mapTransactionRow(
      r,
      postByTx.get(r.id) ?? [],
      docByTx.get(r.id) ?? [],
      r.place_id && placeMap ? (placeMap.get(r.place_id) ?? null) : null,
    ),
  );

  const last = page[page.length - 1]!;
  const nextCursor = hasMore
    ? encodeCursor({ occurred_on: toIsoDate(last.occurred_on), id: last.id })
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
    const rows = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, id),
          eq(transactions.workspaceId, workspaceId),
        ),
      );
    if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
    const current = rows[0]!;
    if (Number(current.version) !== expectedVersion) {
      // Caller is expected to have pre-checked with requireIfMatch, but
      // defence-in-depth: race between fetch and update.
      const { VersionMismatchProblem } = await import("../http/problem.js");
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }

    const updates: Record<string, unknown> = {};
    const oldSnap: Record<string, unknown> = {};
    if (patch.occurred_on !== undefined) {
      updates.occurredOn = patch.occurred_on;
      oldSnap.occurred_on = current.occurredOn;
    }
    if (patch.occurred_at !== undefined) {
      updates.occurredAt = patch.occurred_at === null ? null : new Date(patch.occurred_at);
      oldSnap.occurred_at = current.occurredAt;
    }
    if (patch.payee !== undefined) {
      updates.payee = patch.payee;
      oldSnap.payee = current.payee;
    }
    if (patch.narration !== undefined) {
      updates.narration = patch.narration;
      oldSnap.narration = current.narration;
    }
    if (patch.trip_id !== undefined) {
      updates.tripId = patch.trip_id;
      oldSnap.trip_id = current.tripId;
    }
    if (patch.metadata !== undefined) {
      updates.metadata = patch.metadata;
      oldSnap.metadata = current.metadata;
    }

    if (Object.keys(updates).length === 0) {
      // No-op patch: still bump the audit trail? No — idempotent no-op.
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
      payload: { old: oldSnap, new: patch },
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
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
      );
    if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
    const current = rows[0]!;
    if (Number(current.version) !== expectedVersion) {
      const { VersionMismatchProblem } = await import("../http/problem.js");
      throw new VersionMismatchProblem(Number(current.version), expectedVersion);
    }
    if (current.status !== "draft" && current.status !== "error") {
      throw new MustVoidInsteadProblem(id, current.status);
    }
    // Hard-delete: postings + document_links cascade via FK.
    await tx.delete(transactions).where(eq(transactions.id, id));
  });
}

// ── Void ───────────────────────────────────────────────────────────────

export async function voidTransaction(
  workspaceId: string,
  userId: string,
  id: string,
  expectedVersion: number,
  reason?: string,
): Promise<TransactionRow> {
  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
      const current = rows[0]!;
      if (Number(current.version) !== expectedVersion) {
        const { VersionMismatchProblem } = await import("../http/problem.js");
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      if (current.status === "voided" || current.status === "draft" || current.status === "error") {
        throw new HttpProblem(
          409,
          "invalid-state",
          "Cannot void transaction",
          `Transaction ${id} is in status=${current.status}; only posted/reconciled may be voided.`,
          { transaction_id: id, status: current.status },
        );
      }

      const originalPostings = await tx
        .select()
        .from(postings)
        .where(eq(postings.transactionId, id));

      const mirrorId = newId();
      const existingMeta = (current.metadata ?? {}) as Record<string, unknown>;
      const mirrorMeta: Record<string, unknown> = {
        ...existingMeta,
        voided: id,
        ...(reason ? { void_reason: reason } : {}),
      };

      await tx.insert(transactions).values({
        id: mirrorId,
        workspaceId,
        occurredOn: toIsoDate(current.occurredOn),
        occurredAt: current.occurredAt,
        payee: `VOID: ${current.payee ?? ""}`.trim(),
        narration: current.narration,
        status: "posted",
        tripId: current.tripId,
        metadata: mirrorMeta,
        createdBy: userId,
      });

      await tx.insert(postings).values(
        originalPostings.map((p) => ({
          id: newId(),
          workspaceId,
          transactionId: mirrorId,
          accountId: p.accountId,
          amountMinor: -BigInt(p.amountMinor),
          currency: p.currency,
          fxRate: p.fxRate,
          amountBaseMinor:
            p.amountBaseMinor === null ? null : -BigInt(p.amountBaseMinor),
          memo: p.memo,
        })),
      );

      await tx
        .update(transactions)
        .set({ status: "voided", voidedById: mirrorId })
        .where(eq(transactions.id, id));

      await tx.insert(transactionEvents).values([
        {
          id: newId(),
          workspaceId,
          transactionId: id,
          eventType: "voided",
          actorId: userId,
          payload: { voided_by: mirrorId, reason: reason ?? null },
        },
        {
          id: newId(),
          workspaceId,
          transactionId: mirrorId,
          eventType: "created",
          actorId: userId,
          payload: { voids: id, reason: reason ?? null },
        },
      ]);

      const full = await loadTransactionFull(
        tx as unknown as typeof db,
        workspaceId,
        mirrorId,
      );
      return full!;
    });
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
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("Transaction", id);
      const current = rows[0]!;
      if (Number(current.version) !== expectedVersion) {
        const { VersionMismatchProblem } = await import("../http/problem.js");
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }
      if (current.status !== "posted") {
        throw new HttpProblem(
          409,
          "invalid-state",
          "Cannot reconcile",
          `Transaction ${id} is in status=${current.status}; only 'posted' may be reconciled.`,
          { transaction_id: id, status: current.status },
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

// ── Posting-level mutations ────────────────────────────────────────────

export async function addPosting(
  workspaceId: string,
  userId: string,
  txId: string,
  expectedVersion: number,
  body: NewPostingT,
): Promise<PostingRow> {
  const baseCurrency = await loadWorkspaceBaseCurrency(db, workspaceId);

  const acctRows = await db
    .select({ id: accounts.id, currency: accounts.currency, workspaceId: accounts.workspaceId })
    .from(accounts)
    .where(eq(accounts.id, body.account_id));
  const acct = acctRows[0];
  if (!acct || acct.workspaceId !== workspaceId) {
    throw new ValidationProblem(
      [{ path: "account_id", code: "not_found", message: `Account ${body.account_id} not found in workspace` }],
    );
  }

  const currency = body.currency ?? acct.currency;
  let fxRate: string | null = null;
  let amountBaseMinor: bigint;
  if (currency === baseCurrency) {
    amountBaseMinor = BigInt(body.amount_base_minor ?? body.amount_minor);
  } else {
    if (body.fx_rate === undefined || body.amount_base_minor === undefined) {
      throw new ValidationProblem([
        { path: "fx_rate", code: "required", message: "fx_rate + amount_base_minor required for non-base currency postings" },
      ]);
    }
    fxRate = body.fx_rate;
    amountBaseMinor = BigInt(body.amount_base_minor);
  }

  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, txId), eq(transactions.workspaceId, workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("Transaction", txId);
      const current = rows[0]!;
      if (Number(current.version) !== expectedVersion) {
        const { VersionMismatchProblem } = await import("../http/problem.js");
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }

      const newPostingId = newId();
      await tx.insert(postings).values({
        id: newPostingId,
        workspaceId,
        transactionId: txId,
        accountId: body.account_id,
        amountMinor: BigInt(body.amount_minor),
        currency,
        fxRate,
        amountBaseMinor,
        memo: body.memo ?? null,
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
        payload: { posting_id: newPostingId, account_id: body.account_id, amount_minor: body.amount_minor },
      });

      const postRows = await tx
        .select()
        .from(postings)
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
  return await mapBalanceErrors(async () => {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, txId), eq(transactions.workspaceId, workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("Transaction", txId);
      const current = rows[0]!;
      if (Number(current.version) !== expectedVersion) {
        const { VersionMismatchProblem } = await import("../http/problem.js");
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }

      const existingRows = await tx
        .select()
        .from(postings)
        .where(eq(postings.id, postingId));
      if (existingRows.length === 0 || existingRows[0]!.transactionId !== txId) {
        throw new NotFoundProblem("Posting", postingId);
      }

      const updates: Record<string, unknown> = {};
      if (patch.account_id !== undefined) updates.accountId = patch.account_id;
      if (patch.amount_minor !== undefined) updates.amountMinor = BigInt(patch.amount_minor);
      if (patch.currency !== undefined) updates.currency = patch.currency;
      if (patch.fx_rate !== undefined) updates.fxRate = patch.fx_rate;
      if (patch.amount_base_minor !== undefined) updates.amountBaseMinor = BigInt(patch.amount_base_minor);
      if (patch.memo !== undefined) updates.memo = patch.memo;

      if (Object.keys(updates).length > 0) {
        await tx.update(postings).set(updates).where(eq(postings.id, postingId));
      }

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
        payload: { posting_id: postingId, patch },
      });

      const postRows = await tx
        .select()
        .from(postings)
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
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, txId), eq(transactions.workspaceId, workspaceId)),
        );
      if (rows.length === 0) throw new NotFoundProblem("Transaction", txId);
      const current = rows[0]!;
      if (Number(current.version) !== expectedVersion) {
        const { VersionMismatchProblem } = await import("../http/problem.js");
        throw new VersionMismatchProblem(Number(current.version), expectedVersion);
      }

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
        payload: { posting_id: postingId },
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
    sql`SELECT * FROM postings p WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit + 1}`,
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
    .select()
    .from(postings)
    .where(
      and(eq(postings.id, id), eq(postings.workspaceId, workspaceId)),
    );
  if (rows.length === 0) throw new NotFoundProblem("Posting", id);
  return mapPostingRow(rows[0]!);
}
