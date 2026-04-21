/**
 * Test-only fake for the Phase 2 agent-direct-DB-writes pipeline.
 *
 * In production, `claude -p` reads the receipt image and issues the
 * ledger writes itself via psql (see src/ingest/prompt.ts). CI cannot
 * invoke the CLI, so integration tests inject this fake — it honors
 * the same contract (spawn-less; writes the full ingest terminal
 * state directly) while dispatching off the uploaded filename so
 * tests stay deterministic.
 *
 * Each test file composes a `buildFakeExtractor({...dispatch})` with
 * its own filename → fake-extraction map.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Extractor, ExtractorResult } from "../../src/ingest/extractor.js";

// NOTE: db + schema are dynamically imported inside the extractor
// function — NOT at module top. Test files set DATABASE_URL inside
// beforeAll() via `withTestDb()`; a static import of `src/db/client.js`
// here would bind the pool to localhost:5432 at import-time, before
// the test container is even started (same pattern the worker.ts
// import uses — see the comment at the top of ingest.test.ts).
type DbModule = typeof import("../../src/db/client.js");
type SchemaModule = typeof import("../../src/schema/index.js");

let cached: { db: DbModule["db"]; schema: SchemaModule } | null = null;
async function getDb(): Promise<{ db: DbModule["db"]; schema: SchemaModule }> {
  if (cached) return cached;
  const [{ db }, schema] = await Promise.all([
    import("../../src/db/client.js"),
    import("../../src/schema/index.js"),
  ]);
  cached = { db, schema };
  return cached;
}

export interface FakeReceiptFields {
  payee: string;
  occurred_on: string;
  total_minor: number;
  currency?: string;
  category_hint?: "groceries" | "dining" | "cafe" | "retail" | "transport" | "other";
}

export type FakeDispatch =
  | { kind: "throw"; reason?: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "statement_pdf" } // closed as unsupported in tests; fake does not produce rows
  | { kind: "receipt_image" | "receipt_email" | "receipt_pdf"; fields: FakeReceiptFields };

export interface FakeExtractorOptions {
  /** Map from filename's leading token (before first `-` or `_`) → dispatch. */
  byPrefix?: Record<string, FakeDispatch>;
  /** Fallback dispatch when no prefix matches. */
  fallback?: FakeDispatch;
}

const EXPENSE_BY_CATEGORY: Record<string, string> = {
  groceries: "Groceries",
  dining: "Dining",
  cafe: "Dining",
  retail: "Other",
  transport: "Transport",
  other: "Other",
};

async function lookupAccount(
  workspaceId: string,
  predicate: (a: { name: string; type: string; subtype: string | null }) => boolean,
): Promise<string> {
  const { db, schema } = await getDb();
  const rows = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
      subtype: schema.accounts.subtype,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.workspaceId, workspaceId));
  const hit = rows.find((r) =>
    predicate({
      name: r.name,
      type: r.type as string,
      subtype: r.subtype as string | null,
    }),
  );
  if (!hit) throw new Error(`fake-extractor: no matching account under workspace ${workspaceId}`);
  return hit.id;
}

async function writeReceiptTerminal(args: {
  ingestId: string;
  workspaceId: string;
  documentId: string;
  userId: string;
  classification: "receipt_image" | "receipt_email" | "receipt_pdf";
  fields: FakeReceiptFields;
}): Promise<string> {
  const { ingestId, workspaceId, documentId, userId, classification, fields } = args;
  const expenseName = EXPENSE_BY_CATEGORY[fields.category_hint ?? "other"] ?? "Other";
  const expenseId = await lookupAccount(workspaceId, (a) => a.type === "expense" && a.name === expenseName);
  const creditId = await lookupAccount(workspaceId, (a) => a.type === "liability" && a.subtype === "credit_card");

  const { db, schema } = await getDb();
  const currency = (fields.currency ?? "USD").toUpperCase();
  const amount = fields.total_minor;
  const txId = randomUUID();

  await db.transaction(async (txn) => {
    await txn.insert(schema.transactions).values({
      id: txId,
      workspaceId,
      occurredOn: fields.occurred_on,
      payee: fields.payee,
      status: "posted",
      sourceIngestId: ingestId,
      createdBy: userId,
      metadata: {
        source: "ingest",
        classification,
        category_hint: fields.category_hint ?? "other",
        source_ingest_id: ingestId,
        // In production the agent also stashes its ocr_audit etc. here.
        // Tests don't exercise Phase 2.5's Google cross-check path.
        fake_extractor: true,
      },
    });
    await txn.insert(schema.postings).values([
      {
        id: randomUUID(),
        transactionId: txId,
        workspaceId,
        accountId: expenseId,
        amountMinor: amount,
        currency,
        amountBaseMinor: amount,
      },
      {
        id: randomUUID(),
        transactionId: txId,
        workspaceId,
        accountId: creditId,
        amountMinor: -amount,
        currency,
        amountBaseMinor: -amount,
      },
    ]);
    await txn
      .insert(schema.documentLinks)
      .values({ transactionId: txId, documentId })
      .onConflictDoNothing();
    await txn
      .update(schema.documents)
      .set({ sourceIngestId: ingestId })
      .where(
        and(
          eq(schema.documents.id, documentId),
          eq(schema.documents.workspaceId, workspaceId),
        ),
      );
  });

  await db
    .update(schema.ingests)
    .set({
      status: "done",
      classification,
      produced: {
        transaction_ids: [txId],
        document_ids: [documentId],
        receipt_ids: [],
      },
      completedAt: new Date(),
    })
    .where(and(eq(schema.ingests.id, ingestId), eq(schema.ingests.workspaceId, workspaceId)));

  return txId;
}

async function writeUnsupportedTerminal(args: {
  ingestId: string;
  workspaceId: string;
  documentId: string;
  classification: string;
  reason: string;
}): Promise<void> {
  const { db, schema } = await getDb();
  await db
    .update(schema.ingests)
    .set({
      status: "unsupported",
      classification: args.classification,
      produced: {
        transaction_ids: [],
        document_ids: [args.documentId],
        receipt_ids: [],
      },
      error: args.reason,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(schema.ingests.id, args.ingestId),
        eq(schema.ingests.workspaceId, args.workspaceId),
      ),
    );
}

/**
 * Build a Phase-2-shaped fake extractor. Returns a function whose
 * contract matches `src/ingest/extractor.ts::Extractor`:
 *   - returns `{sessionId, stdout}` after writing DB terminal state, OR
 *   - throws (same behavior the real agent exhibits on catastrophic
 *     failure — worker catches and marks ingest error).
 */
export function buildFakeExtractor(options: FakeExtractorOptions = {}): Extractor {
  const byPrefix = options.byPrefix ?? {};
  const fallback: FakeDispatch = options.fallback ?? {
    kind: "receipt_image",
    fields: {
      payee: "FakeMart",
      occurred_on: "2026-04-19",
      total_minor: 1234,
      currency: "USD",
      category_hint: "groceries",
    },
  };

  return async (input): Promise<ExtractorResult> => {
    const stem = input.filename.toLowerCase();
    const head = stem.split(/[-_]/)[0] ?? "";
    const dispatch = byPrefix[head] ?? fallback;

    const sessionId = `stub-${head || "default"}`;
    let stdout = "";

    if (dispatch.kind === "throw") {
      throw new Error(dispatch.reason ?? "stub extractor blew up on purpose");
    }
    if (dispatch.kind === "unsupported") {
      await writeUnsupportedTerminal({
        ingestId: input.ingestId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        classification: "unsupported",
        reason: dispatch.reason,
      });
      stdout = `DONE ingest=${input.ingestId} classification=unsupported tx_ids=[]`;
    } else if (dispatch.kind === "statement_pdf") {
      // The real Phase 2 prompt knows how to walk a statement row-by-row,
      // but the fake collapses it to 'unsupported' for deterministic tests.
      // Real statement behavior is exercised via manual runs (see the
      // Round 1-3 eval notes).
      await writeUnsupportedTerminal({
        ingestId: input.ingestId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        classification: "statement_pdf",
        reason: "fake-extractor does not simulate statement rows",
      });
      stdout = `DONE ingest=${input.ingestId} classification=statement_pdf tx_ids=[]`;
    } else {
      const txId = await writeReceiptTerminal({
        ingestId: input.ingestId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        userId: input.userId,
        classification: dispatch.kind,
        fields: dispatch.fields,
      });
      stdout = `DONE ingest=${input.ingestId} classification=${dispatch.kind} tx_ids=[${txId}]`;
    }

    return { sessionId, stdout };
  };
}
