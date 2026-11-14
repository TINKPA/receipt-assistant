/**
 * The workspace's chart of accounts as the applier sees it (wave 1,
 * plan §6.3 c–d).
 *
 * `project()` is a pure function, so the accounts it books to are handed
 * to it as data: every account row of the workspace, read once inside the
 * apply transaction by `readAccountCatalog`. The lookups by name and type
 * the legacy prompt wrote as inline CTEs
 * (`SELECT id FROM accounts WHERE type = 'expense' AND name = '<category>'
 * LIMIT 1`) are `findAccount` and `findPointsAccount` here.
 *
 * `LIMIT 1` without an order picked an arbitrary row when a name was
 * duplicated. These pick deterministically: an open account before a
 * closed one, a child before a top-level row (the five roots, `Assets`
 * and the rest, are never posted to), then the oldest id.
 */
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface CatalogAccount {
  id: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  currency: string;
  parentId: string | null;
  closed: boolean;
}

export interface AccountCatalog {
  accounts: readonly CatalogAccount[];
}

function preferred(a: CatalogAccount, b: CatalogAccount): number {
  if (a.closed !== b.closed) return a.closed ? 1 : -1;
  if ((a.parentId === null) !== (b.parentId === null)) return a.parentId === null ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The account of this type and name (exact, case-sensitive, as the
 *  legacy SQL compared), or null. */
export function findAccount(catalog: AccountCatalog, type: AccountType, name: string): CatalogAccount | null {
  const hits = catalog.accounts.filter((a) => a.type === type && a.name === name);
  return hits.sort(preferred)[0] ?? null;
}

/** The per-programme points asset account for a `_PT` currency (#206),
 *  the row `accounts_points_uq` keeps unique, or null. */
export function findPointsAccount(catalog: AccountCatalog, currency: string): CatalogAccount | null {
  const hits = catalog.accounts.filter((a) => a.subtype === "points" && a.currency === currency);
  return hits.sort(preferred)[0] ?? null;
}

/** The `Assets` root, the parent a new points account is created under
 *  (hole 7: the legacy upsert left it without one). */
export function findAssetsRoot(catalog: AccountCatalog): CatalogAccount | null {
  const hits = catalog.accounts.filter((a) => a.type === "asset" && a.parentId === null && a.name === "Assets");
  return hits.sort(preferred)[0] ?? null;
}

/** Every account of the workspace. Runs on any executor, the apply
 *  transaction included. */
export async function readAccountCatalog(
  executor: Pick<typeof db, "execute">,
  workspaceId: string,
): Promise<AccountCatalog> {
  const res = await executor.execute(sql`
    SELECT id, name, type::text AS type, subtype, currency, parent_id, closed_at IS NOT NULL AS closed
      FROM accounts
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY id`);
  const rows = res.rows as {
    id: string;
    name: string;
    type: AccountType;
    subtype: string | null;
    currency: string;
    parent_id: string | null;
    closed: boolean;
  }[];
  return {
    accounts: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      currency: r.currency,
      parentId: r.parent_id,
      closed: r.closed,
    })),
  };
}
