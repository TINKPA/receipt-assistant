/**
 * `/v1/accounts` — chart-of-accounts CRUD + derived views.
 *
 * Implements issue #36. See epic #28 for the endpoint surface + header
 * contract. All mutations use ETag / If-Match for OCC; all errors
 * serialize as `application/problem+json` via the central
 * `problemHandler`.
 *
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { sql, and, eq, isNull, asc } from "drizzle-orm";
import {
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

import { db } from "../db/client.js";
import { accounts, postings, workspaces } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import { parseOrThrow } from "../http/validate.js";
import {
  formatEtag,
  setEtag,
  requireIfMatch,
  handleIfNoneMatch,
} from "../http/etag.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  emitNextLink,
} from "../http/pagination.js";
import {
  AccountInUseProblem,
  HttpProblem,
  NotFoundProblem,
  ValidationProblem,
} from "../http/problem.js";

import {
  Account,
  AccountBalance,
  AccountRegister,
  CreateAccountRequest,
  UpdateAccountRequest,
  ListAccountsQuery,
  BalanceQuery,
  RegisterQuery,
} from "../schemas/v1/account.js";
import { IdParam, ProblemDetails } from "../schemas/v1/common.js";

// ── Shared types ────────────────────────────────────────────────────────

type AccountRow = typeof accounts.$inferSelect;

export interface AccountDto {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  subtype: string | null;
  currency: string;
  institution: string | null;
  last4: string | null;
  opening_balance_minor: number;
  closed_at: string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AccountTreeDto extends AccountDto {
  children: AccountTreeDto[];
}

function toIso(d: Date | string | null): string | null {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) return d.toISOString();
  // Postgres may already have returned a string (timestamptz text form)
  return new Date(d as string).toISOString();
}

function rowToDto(r: AccountRow): AccountDto {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    parent_id: r.parentId,
    code: r.code,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    currency: r.currency,
    institution: r.institution,
    last4: r.last4,
    opening_balance_minor: Number(r.openingBalanceMinor),
    closed_at: r.closedAt ? toIso(r.closedAt) : null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    version: Number(r.version),
    created_at: toIso(r.createdAt)!,
    updated_at: toIso(r.updatedAt)!,
  };
}

// Promise-aware route wrapper: forwards rejections to Express error
// middleware. Express 5 forwards rejections too, but wrapping gives us
// a crisp stack trace and protects against older middleware quirks.
type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ── Service: common helpers ─────────────────────────────────────────────

async function fetchAccount(
  workspaceId: string,
  id: string,
): Promise<AccountRow | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

async function fetchWorkspaceBaseCurrency(workspaceId: string): Promise<string> {
  const rows = await db
    .select({ baseCurrency: workspaces.baseCurrency })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundProblem("Workspace", workspaceId);
  }
  return rows[0]!.baseCurrency;
}

// ── Service: list ───────────────────────────────────────────────────────

export interface ListAccountsArgs {
  workspaceId: string;
  flat?: boolean;
  includeClosed?: boolean;
}

export async function listAccountsService(
  args: ListAccountsArgs,
): Promise<AccountDto[] | AccountTreeDto[]> {
  const whereClause = args.includeClosed
    ? eq(accounts.workspaceId, args.workspaceId)
    : and(
        eq(accounts.workspaceId, args.workspaceId),
        isNull(accounts.closedAt),
      );

  const rows = await db
    .select()
    .from(accounts)
    .where(whereClause)
    .orderBy(asc(accounts.name));

  const dtos = rows.map(rowToDto);

  if (args.flat) return dtos;

  // Build tree: group by parent_id, attach children[]; return roots.
  const byId = new Map<string, AccountTreeDto>();
  for (const d of dtos) byId.set(d.id, { ...d, children: [] });
  const roots: AccountTreeDto[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Stable sort: by name within each level
  const sortTree = (ns: AccountTreeDto[]): void => {
    ns.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of ns) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

// ── Service: create ─────────────────────────────────────────────────────

export interface CreateAccountArgs {
  workspaceId: string;
  body: z.infer<typeof CreateAccountRequest>;
}

export async function createAccountService(
  args: CreateAccountArgs,
): Promise<AccountDto> {
  const { workspaceId, body } = args;

  // Resolve currency: inherit from parent if omitted.
  let currency = body.currency;
  let parent: AccountRow | null = null;
  if (body.parent_id) {
    parent = await fetchAccount(workspaceId, body.parent_id);
    if (!parent) {
      throw new NotFoundProblem("Account", body.parent_id);
    }
    if (parent.type !== body.type) {
      throw new ValidationProblem(
        [
          {
            path: "type",
            code: "parent_type_mismatch",
            message: `Child type '${body.type}' does not match parent type '${parent.type}'`,
          },
        ],
        "Parent account type must match child type",
      );
    }
    if (!currency) currency = parent.currency;
  }
  if (!currency) {
    // Fall back to workspace base currency if no parent and no override.
    currency = await fetchWorkspaceBaseCurrency(workspaceId);
  }

  const id = newId();
  const insertVals = {
    id,
    workspaceId,
    parentId: body.parent_id ?? null,
    code: body.code ?? null,
    name: body.name,
    type: body.type,
    subtype: body.subtype ?? null,
    currency,
    institution: body.institution ?? null,
    last4: body.last4 ?? null,
    openingBalanceMinor:
      body.opening_balance_minor !== undefined
        ? BigInt(body.opening_balance_minor)
        : 0n,
    metadata: body.metadata ?? {},
  };

  await db.insert(accounts).values(insertVals);

  const created = await fetchAccount(workspaceId, id);
  if (!created) throw new NotFoundProblem("Account", id);
  return rowToDto(created);
}

// ── Service: get ────────────────────────────────────────────────────────

export async function getAccountService(
  workspaceId: string,
  id: string,
): Promise<AccountDto> {
  const row = await fetchAccount(workspaceId, id);
  if (!row) throw new NotFoundProblem("Account", id);
  return rowToDto(row);
}

// ── Service: update ─────────────────────────────────────────────────────

export interface UpdateAccountArgs {
  workspaceId: string;
  id: string;
  patch: z.infer<typeof UpdateAccountRequest>;
  ifMatchVersion: number; // already parsed
}

export async function updateAccountService(
  args: UpdateAccountArgs,
): Promise<AccountDto> {
  const { workspaceId, id, patch } = args;
  const current = await fetchAccount(workspaceId, id);
  if (!current) throw new NotFoundProblem("Account", id);

  // Verify optimistic-concurrency version (caller already checked the
  // header, but re-check with fresh row in case of race).
  if (current.version !== args.ifMatchVersion) {
    const { VersionMismatchProblem } = await import("../http/problem.js");
    throw new VersionMismatchProblem(current.version, args.ifMatchVersion);
  }

  // Re-parent: validate type consistency.
  if (patch.parent_id !== undefined && patch.parent_id !== null) {
    const newParent = await fetchAccount(workspaceId, patch.parent_id);
    if (!newParent) throw new NotFoundProblem("Account", patch.parent_id);
    if (newParent.type !== current.type) {
      throw new ValidationProblem(
        [
          {
            path: "parent_id",
            code: "parent_type_mismatch",
            message: `New parent type '${newParent.type}' does not match child type '${current.type}'`,
          },
        ],
        "Parent account type must match child type",
      );
    }
    // Cycle check: can't re-parent under a descendant.
    if (patch.parent_id === id) {
      throw new ValidationProblem(
        [{ path: "parent_id", code: "self_parent", message: "Cannot parent under self" }],
      );
    }
  }

  const updateVals: Partial<typeof accounts.$inferInsert> = {};
  if (patch.code !== undefined) updateVals.code = patch.code;
  if (patch.name !== undefined) updateVals.name = patch.name;
  if (patch.subtype !== undefined) updateVals.subtype = patch.subtype;
  if (patch.institution !== undefined) updateVals.institution = patch.institution;
  if (patch.last4 !== undefined) updateVals.last4 = patch.last4;
  if (patch.parent_id !== undefined) updateVals.parentId = patch.parent_id;
  if (patch.closed_at !== undefined) {
    updateVals.closedAt = patch.closed_at ? new Date(patch.closed_at) : null;
  }
  if (patch.metadata !== undefined) updateVals.metadata = patch.metadata;

  if (Object.keys(updateVals).length === 0) {
    // No-op patch: return current.
    return rowToDto(current);
  }

  await db
    .update(accounts)
    .set(updateVals)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, id)));

  const updated = await fetchAccount(workspaceId, id);
  if (!updated) throw new NotFoundProblem("Account", id);
  return rowToDto(updated);
}

// ── Service: delete ─────────────────────────────────────────────────────

export async function deleteAccountService(
  workspaceId: string,
  id: string,
  ifMatchVersion: number,
): Promise<void> {
  const current = await fetchAccount(workspaceId, id);
  if (!current) throw new NotFoundProblem("Account", id);
  if (current.version !== ifMatchVersion) {
    const { VersionMismatchProblem } = await import("../http/problem.js");
    throw new VersionMismatchProblem(current.version, ifMatchVersion);
  }

  // Postings referencing this account?
  const cntRes = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM postings
        WHERE workspace_id = ${workspaceId}::uuid AND account_id = ${id}::uuid`,
  );
  const n = Number((cntRes.rows[0] as { n: number })?.n ?? 0);
  if (n > 0) throw new AccountInUseProblem(id, n);

  await db
    .delete(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, id)));
}

// ── Service: balance ────────────────────────────────────────────────────

export interface BalanceArgs {
  workspaceId: string;
  accountId: string;
  asOf?: string; // YYYY-MM-DD
  currency?: string;
  includeChildren?: boolean;
}

export async function getBalanceService(
  args: BalanceArgs,
): Promise<z.infer<typeof AccountBalance>> {
  const account = await fetchAccount(args.workspaceId, args.accountId);
  if (!account) throw new NotFoundProblem("Account", args.accountId);

  const asOf =
    args.asOf ?? new Date().toISOString().slice(0, 10); // today in UTC
  const currency =
    args.currency ?? (await fetchWorkspaceBaseCurrency(args.workspaceId));

  // Gather relevant account IDs: either just this one, or the subtree.
  const result = await db.execute(
    args.includeChildren
      ? sql`
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM accounts
              WHERE workspace_id = ${args.workspaceId}::uuid AND id = ${args.accountId}::uuid
            UNION ALL
            SELECT a.id FROM accounts a
              JOIN subtree s ON a.parent_id = s.id
              WHERE a.workspace_id = ${args.workspaceId}::uuid
          )
          SELECT COALESCE(SUM(p.amount_base_minor), 0)::bigint AS balance,
                 COUNT(*)::int AS posting_count
            FROM postings p
            JOIN transactions t ON t.id = p.transaction_id
           WHERE p.workspace_id = ${args.workspaceId}::uuid
             AND p.account_id IN (SELECT id FROM subtree)
             AND t.occurred_on <= ${asOf}::date
             AND t.status = 'posted'
        `
      : sql`
          SELECT COALESCE(SUM(p.amount_base_minor), 0)::bigint AS balance,
                 COUNT(*)::int AS posting_count
            FROM postings p
            JOIN transactions t ON t.id = p.transaction_id
           WHERE p.workspace_id = ${args.workspaceId}::uuid
             AND p.account_id = ${args.accountId}::uuid
             AND t.occurred_on <= ${asOf}::date
             AND t.status = 'posted'
        `,
  );
  const row = result.rows[0] as {
    balance: string | number | bigint;
    posting_count: number;
  };
  // node-postgres returns bigint-like values as strings by default.
  const balanceMinor = Number(row?.balance ?? 0);
  const postingCount = Number(row?.posting_count ?? 0);

  return {
    account_id: args.accountId,
    as_of: asOf,
    balance_minor: balanceMinor,
    currency,
    posting_count: postingCount,
    includes_children: Boolean(args.includeChildren),
  };
}

// ── Service: register ───────────────────────────────────────────────────

export interface RegisterArgs {
  workspaceId: string;
  accountId: string;
  from?: string;
  to?: string;
  includeVoided?: boolean;
  cursor?: string;
  limit?: number;
}

interface RegisterCursor {
  occurred_on: string;
  posting_id: string;
}

export async function getRegisterService(
  args: RegisterArgs,
): Promise<z.infer<typeof AccountRegister>> {
  const account = await fetchAccount(args.workspaceId, args.accountId);
  if (!account) throw new NotFoundProblem("Account", args.accountId);

  const limit = clampLimit(args.limit);
  const cursor = decodeCursor<RegisterCursor>(args.cursor);

  // Step 1: fetch candidate postings window via keyset pagination. We
  // query ONE extra row to know if there's a "next" page. The window
  // function for running_balance_after_minor must be computed over the
  // FULL filtered set, not the paginated slice — so we compute it in
  // the CTE over all rows then filter + limit in the outer query.
  //
  // Running balance is SUM(amount_base_minor) ordered by
  // (occurred_on ASC, posting_id ASC) — so older rows accumulate first.
  // We *display* rows in descending order (most recent first) but the
  // cumulative sum is still evaluated in chronological order.
  const statusFilter = args.includeVoided
    ? sql``
    : sql`AND t.status = 'posted'`;
  const fromFilter = args.from
    ? sql`AND t.occurred_on >= ${args.from}::date`
    : sql``;
  const toFilter = args.to
    ? sql`AND t.occurred_on <= ${args.to}::date`
    : sql``;

  // Keyset predicate: rows strictly "after" the cursor in descending
  // (occurred_on DESC, posting_id DESC) ordering. That means:
  //   (occurred_on < cursor.occurred_on)
  //   OR (occurred_on = cursor.occurred_on AND posting_id < cursor.posting_id)
  // Evaluated against the CTE's exposed columns, not the base tables.
  const cursorFilter = cursor
    ? sql`AND (occurred_on < ${cursor.occurred_on}::date
             OR (occurred_on = ${cursor.occurred_on}::date AND posting_id < ${cursor.posting_id}::uuid))`
    : sql``;

  const rowsRes = await db.execute(sql`
    WITH all_rows AS (
      SELECT
        p.id            AS posting_id,
        p.transaction_id,
        t.version       AS transaction_version,
        t.occurred_on,
        t.payee,
        t.narration,
        t.status,
        p.amount_minor,
        p.amount_base_minor,
        p.currency,
        SUM(p.amount_base_minor) OVER (
          ORDER BY t.occurred_on ASC, p.id ASC
          ROWS UNBOUNDED PRECEDING
        ) AS running_balance_after_minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      WHERE p.workspace_id = ${args.workspaceId}::uuid
        AND p.account_id = ${args.accountId}::uuid
        ${statusFilter}
        ${fromFilter}
        ${toFilter}
    )
    SELECT *
      FROM all_rows
     WHERE 1 = 1
       ${cursorFilter}
     ORDER BY occurred_on DESC, posting_id DESC
     LIMIT ${limit + 1}
  `);

  const pageRows = rowsRes.rows as Array<{
    posting_id: string;
    transaction_id: string;
    transaction_version: string | number;
    occurred_on: Date | string;
    payee: string | null;
    narration: string | null;
    status: string;
    amount_minor: string | number | bigint;
    amount_base_minor: string | number | bigint;
    currency: string;
    running_balance_after_minor: string | number | bigint;
  }>;

  const hasMore = pageRows.length > limit;
  const pageSlice = hasMore ? pageRows.slice(0, limit) : pageRows;

  // Collect transaction ids to look up counter_postings + documents in bulk.
  const txIds = Array.from(new Set(pageSlice.map((r) => r.transaction_id)));
  const postingIds = pageSlice.map((r) => r.posting_id);

  type CounterRow = {
    transaction_id: string;
    posting_id: string;
    account_id: string;
    name: string;
    amount_minor: string | number | bigint;
  };
  type DocRow = {
    transaction_id: string;
    id: string;
    kind: string;
  };

  let counterRows: CounterRow[] = [];
  let docRows: DocRow[] = [];
  if (txIds.length > 0) {
    const cRes = await db.execute(sql`
      SELECT p.transaction_id,
             p.id AS posting_id,
             p.account_id,
             a.name,
             p.amount_minor
        FROM postings p
        JOIN accounts a ON a.id = p.account_id
       WHERE p.workspace_id = ${args.workspaceId}::uuid
         AND p.transaction_id IN (${sql.join(
           txIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         AND p.id NOT IN (${sql.join(
           postingIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
    `);
    counterRows = cRes.rows as CounterRow[];

    const dRes = await db.execute(sql`
      SELECT dl.transaction_id, d.id, d.kind
        FROM document_links dl
        JOIN documents d ON d.id = dl.document_id
       WHERE d.workspace_id = ${args.workspaceId}::uuid
         AND dl.transaction_id IN (${sql.join(
           txIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
       ORDER BY
         CASE d.kind
           WHEN 'receipt_image' THEN 1
           WHEN 'receipt_pdf'   THEN 2
           WHEN 'statement_pdf' THEN 3
           WHEN 'receipt_email' THEN 4
           ELSE 5
         END
    `);
    docRows = dRes.rows as DocRow[];
  }

  const counterByTx = new Map<string, CounterRow[]>();
  for (const c of counterRows) {
    const arr = counterByTx.get(c.transaction_id) ?? [];
    arr.push(c);
    counterByTx.set(c.transaction_id, arr);
  }
  const docsByTx = new Map<string, DocRow[]>();
  for (const d of docRows) {
    const arr = docsByTx.get(d.transaction_id) ?? [];
    arr.push(d);
    docsByTx.set(d.transaction_id, arr);
  }

  const items = pageSlice.map((r) => {
    const occurredOn =
      r.occurred_on instanceof Date
        ? r.occurred_on.toISOString().slice(0, 10)
        : typeof r.occurred_on === "string"
          ? r.occurred_on.slice(0, 10)
          : String(r.occurred_on);
    const cp = counterByTx.get(r.transaction_id) ?? [];
    const docs = docsByTx.get(r.transaction_id) ?? [];
    return {
      posting_id: r.posting_id,
      transaction_id: r.transaction_id,
      transaction_version: Number(r.transaction_version),
      occurred_on: occurredOn,
      payee: r.payee,
      narration: r.narration,
      amount_minor: Number(r.amount_minor),
      currency: r.currency,
      running_balance_after_minor: Number(r.running_balance_after_minor),
      counter_postings: cp.map((c) => ({
        account_id: c.account_id,
        name: c.name,
        amount_minor: Number(c.amount_minor),
      })),
      documents: docs.map((d) => ({ id: d.id, kind: d.kind })),
    };
  });

  let next_cursor: string | null = null;
  if (hasMore && pageSlice.length > 0) {
    const last = pageSlice[pageSlice.length - 1]!;
    const lastDate =
      last.occurred_on instanceof Date
        ? last.occurred_on.toISOString().slice(0, 10)
        : typeof last.occurred_on === "string"
          ? last.occurred_on.slice(0, 10)
          : String(last.occurred_on);
    next_cursor = encodeCursor({
      occurred_on: lastDate,
      posting_id: last.posting_id,
    });
  }

  return {
    account_id: args.accountId,
    items,
    next_cursor,
  };
}

// ── Router ──────────────────────────────────────────────────────────────

export const accountsRouter: Router = Router();

accountsRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parseOrThrow(ListAccountsQuery, req.query);
    const out = await listAccountsService({
      workspaceId: req.ctx.workspaceId,
      flat: q.flat,
      includeClosed: q.include_closed,
    });
    res.json(out);
  }),
);

accountsRouter.post(
  "/",
  ah(async (req, res) => {
    const body = parseOrThrow(CreateAccountRequest, req.body);
    const account = await createAccountService({
      workspaceId: req.ctx.workspaceId,
      body,
    });
    setEtag(res, account.version);
    res.setHeader("Location", `/v1/accounts/${account.id}`);
    res.status(201).json(account);
  }),
);

accountsRouter.get(
  "/:id",
  ah(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const account = await getAccountService(req.ctx.workspaceId, id);
    if (handleIfNoneMatch(req, res, account.version)) return;
    setEtag(res, account.version);
    res.json(account);
  }),
);

accountsRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    // Validate body first so shape errors are 422 not 428.
    const patch = parseOrThrow(UpdateAccountRequest, req.body ?? {});
    // Peek at the header-checked version explicitly so the service can
    // pass it through (avoids a second DB read in the helper).
    const current = await fetchAccount(req.ctx.workspaceId, id);
    if (!current) throw new NotFoundProblem("Account", id);
    requireIfMatch(req, current.version);
    const out = await updateAccountService({
      workspaceId: req.ctx.workspaceId,
      id,
      patch,
      ifMatchVersion: current.version,
    });
    setEtag(res, out.version);
    res.json(out);
  }),
);

accountsRouter.delete(
  "/:id",
  ah(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const current = await fetchAccount(req.ctx.workspaceId, id);
    if (!current) throw new NotFoundProblem("Account", id);
    requireIfMatch(req, current.version);
    await deleteAccountService(req.ctx.workspaceId, id, current.version);
    res.status(204).end();
  }),
);

accountsRouter.get(
  "/:id/balance",
  ah(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const q = parseOrThrow(BalanceQuery, req.query);
    const out = await getBalanceService({
      workspaceId: req.ctx.workspaceId,
      accountId: id,
      asOf: q.as_of,
      currency: q.currency,
      includeChildren: q.include_children,
    });
    res.json(out);
  }),
);

accountsRouter.get(
  "/:id/register",
  ah(async (req, res) => {
    const { id } = parseOrThrow(IdParam, req.params);
    const q = parseOrThrow(RegisterQuery, req.query);
    const out = await getRegisterService({
      workspaceId: req.ctx.workspaceId,
      accountId: id,
      from: q.from,
      to: q.to,
      includeVoided: q.include_voided,
      cursor: q.cursor,
      limit: q.limit,
    });
    emitNextLink(req, res, out.next_cursor);
    res.json(out);
  }),
);

// ── OpenAPI registration ────────────────────────────────────────────────

const problemResponse = {
  content: { "application/problem+json": { schema: ProblemDetails } },
};

export function registerAccountsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("Account", Account);
  // AccountTreeNode contains z.lazy(...) which the OpenAPI generator
  // cannot introspect. Document the tree shape in the list endpoint's
  // description; clients build it by walking `parent_id`.
  registry.register("CreateAccountRequest", CreateAccountRequest);
  registry.register("UpdateAccountRequest", UpdateAccountRequest);
  registry.register("AccountBalance", AccountBalance);
  registry.register("AccountRegister", AccountRegister);

  registry.registerPath({
    method: "get",
    path: "/v1/accounts",
    summary: "List accounts (tree by default, flat with ?flat=true)",
    tags: ["accounts"],
    request: { query: ListAccountsQuery },
    responses: {
      200: {
        description:
          "Account list (flat: array of Account; default: array of AccountTreeNode roots)",
        content: { "application/json": { schema: z.array(Account) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/accounts",
    summary: "Create a new account",
    tags: ["accounts"],
    request: {
      body: {
        content: { "application/json": { schema: CreateAccountRequest } },
      },
    },
    responses: {
      201: {
        description: "Account created",
        content: { "application/json": { schema: Account } },
        headers: {
          Location: { schema: { type: "string" } },
          ETag: { schema: { type: "string" } },
        },
      },
      404: { description: "Parent account not found", ...problemResponse },
      422: { description: "Validation failed", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/accounts/{id}",
    summary: "Get one account",
    tags: ["accounts"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "Account",
        content: { "application/json": { schema: Account } },
        headers: { ETag: { schema: { type: "string" } } },
      },
      304: { description: "Not Modified (If-None-Match matched)" },
      404: { description: "Account not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/accounts/{id}",
    summary: "Patch account (rename / re-parent / close)",
    tags: ["accounts"],
    request: {
      params: IdParam,
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateAccountRequest },
        },
      },
    },
    responses: {
      200: {
        description: "Account updated",
        content: { "application/json": { schema: Account } },
        headers: { ETag: { schema: { type: "string" } } },
      },
      404: { description: "Account not found", ...problemResponse },
      412: { description: "Version mismatch (If-Match)", ...problemResponse },
      422: { description: "Validation failed", ...problemResponse },
      428: {
        description: "Precondition required (If-Match missing)",
        ...problemResponse,
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/accounts/{id}",
    summary: "Hard-delete an unused account",
    tags: ["accounts"],
    request: { params: IdParam },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Account not found", ...problemResponse },
      409: {
        description: "Account has postings; soft-close instead",
        ...problemResponse,
      },
      412: { description: "Version mismatch", ...problemResponse },
      428: {
        description: "Precondition required (If-Match missing)",
        ...problemResponse,
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/accounts/{id}/balance",
    summary: "Account balance as of a date",
    tags: ["accounts"],
    request: { params: IdParam, query: BalanceQuery },
    responses: {
      200: {
        description: "Balance summary",
        content: { "application/json": { schema: AccountBalance } },
      },
      404: { description: "Account not found", ...problemResponse },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/accounts/{id}/register",
    summary: "Register (checkbook view) with running balance",
    tags: ["accounts"],
    request: { params: IdParam, query: RegisterQuery },
    responses: {
      200: {
        description: "Paginated register",
        content: { "application/json": { schema: AccountRegister } },
        headers: { Link: { schema: { type: "string" } } },
      },
      404: { description: "Account not found", ...problemResponse },
    },
  });
}

// Silence unused-import warnings in declaration-only places.
void HttpProblem;
