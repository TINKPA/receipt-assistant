/**
 * Seed a fresh database with a default workspace, owner user, and
 * 5-branch chart of accounts (Assets / Liabilities / Equity / Income /
 * Expenses).
 *
 * Idempotent: no-op if the default workspace already exists, so this is
 * safe to call on every container boot.
 *
 * Callers:
 *   - `src/server.ts` at startup (unless SEED_ON_BOOT=false).
 *   - `scripts/seed.ts` as a standalone CLI.
 */
import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  users,
  workspaces,
  workspaceMembers,
  accounts,
} from "../schema/index.js";

/**
 * Stable IDs so re-runs of the seeder land on the same rows.
 * UUIDv7-shaped (version nibble = 7, variant bits = 10).
 */
export const SEED_USER_ID = "00000000-0000-7000-8000-000000000001";
export const SEED_WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";

type AccountSeed = {
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  subtype?: string;
  children?: AccountSeed[];
};

const DEFAULT_CHART: AccountSeed[] = [
  {
    name: "Assets",
    type: "asset",
    children: [
      { name: "Cash", type: "asset", subtype: "cash" },
      { name: "Checking", type: "asset", subtype: "checking" },
      { name: "Savings", type: "asset", subtype: "savings" },
    ],
  },
  {
    name: "Liabilities",
    type: "liability",
    children: [
      { name: "Credit Card", type: "liability", subtype: "credit_card" },
    ],
  },
  {
    name: "Equity",
    type: "equity",
    children: [
      { name: "Opening Balance", type: "equity", subtype: "opening_balance" },
    ],
  },
  {
    name: "Income",
    type: "income",
    children: [
      { name: "Salary", type: "income" },
      { name: "Other", type: "income" },
    ],
  },
  {
    name: "Expenses",
    type: "expense",
    // Seven canonical spending categories — must stay aligned with the
    // frontend's `CATEGORIES` tuple (`receipt-assistant-frontend/src/types.ts`)
    // and the extractor prompt's account-picker (`src/ingest/prompt.ts`
    // Phase 4a). Adding/removing a child here without updating those two
    // breaks the Dashboard summary buckets — see migration 0007 + #68.
    children: [
      { name: "Food & Drinks", type: "expense" },
      { name: "Transportation", type: "expense" },
      { name: "Shopping", type: "expense" },
      { name: "Travel", type: "expense" },
      { name: "Entertainment", type: "expense" },
      { name: "Health", type: "expense" },
      { name: "Services", type: "expense" },
    ],
  },
];

async function insertTree(
  workspaceId: string,
  currency: string,
  nodes: AccountSeed[],
  parentId: string | null = null,
): Promise<void> {
  for (const node of nodes) {
    const id = uuidv7();
    await db.insert(accounts).values({
      id,
      workspaceId,
      parentId,
      name: node.name,
      type: node.type,
      subtype: node.subtype ?? null,
      currency,
    });
    if (node.children?.length) {
      await insertTree(workspaceId, currency, node.children, id);
    }
  }
}

export interface SeedResult {
  userId: string;
  workspaceId: string;
  created: boolean;
}

export async function seed(): Promise<SeedResult> {
  const existing = await db.execute(
    sql`SELECT id FROM workspaces WHERE id = ${SEED_WORKSPACE_ID}::uuid`,
  );
  if (existing.rows.length > 0) {
    return { userId: SEED_USER_ID, workspaceId: SEED_WORKSPACE_ID, created: false };
  }

  await db.insert(users).values({
    id: SEED_USER_ID,
    email: "owner@receipts.local",
    name: "Default Owner",
  });

  await db.insert(workspaces).values({
    id: SEED_WORKSPACE_ID,
    ownerId: SEED_USER_ID,
    name: "Default Workspace",
    baseCurrency: "USD",
  });

  await db.insert(workspaceMembers).values({
    workspaceId: SEED_WORKSPACE_ID,
    userId: SEED_USER_ID,
    role: "owner",
  });

  await insertTree(SEED_WORKSPACE_ID, "USD", DEFAULT_CHART);

  return { userId: SEED_USER_ID, workspaceId: SEED_WORKSPACE_ID, created: true };
}
