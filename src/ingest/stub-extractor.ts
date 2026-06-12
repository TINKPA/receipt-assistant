/**
 * Test-only extractor (#134/#135 hardening): executes a JSON
 * instruction file instead of spawning `claude -p`, so sandbox tests
 * can (a) place the pipeline into agent-misbehavior terminal states
 * deterministically — the worker guards' negative paths are otherwise
 * untestable because a real agent can't be made to lie on demand —
 * and (b) seed ledger rows in milliseconds for the L3b reconcile
 * matrix instead of paying a 2-minute extraction per seed.
 *
 * SAFETY GATE — two conditions, both required, before the worker
 * routes an upload here (see `pickExtractor` in worker.ts):
 *   1. env `EXTRACTOR_STUB_ALLOWED=1` — set ONLY in
 *      docker-compose.test.yml. Production compose never sets it.
 *   2. the uploaded file parses as JSON whose top-level key
 *      `__stub__` is true.
 * On production a stray stub file therefore goes to the real agent,
 * which classifies it `unsupported`. No data path exists from prod
 * uploads into this module.
 *
 * Instruction shape (the uploaded file's content):
 * {
 *   "__stub__": true,
 *   "write_transaction": {            // optional ledger seed
 *     "payee": "...", "occurred_on": "YYYY-MM-DD",
 *     "total_minor": 1234, "currency": "USD",
 *     "metadata": { ... },            // merged over {source:'stub'}
 *     "link_document": true           // document_links row to $DOC
 *   },
 *   "terminal": {                     // required — what the "agent" reports
 *     "status": "done"|"near_dup"|"unsupported"|"error",
 *     "classification": "receipt_image",
 *     "transaction_ids": ["$TX"],     // "$TX" → seeded txn id
 *     "document_ids": ["$DOC"],       // "$DOC" → the upload's document id
 *     "error": null
 *   }
 * }
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { newId } from "../http/uuid.js";
import type { Extractor } from "./extractor.js";

interface StubInstructions {
  __stub__: true;
  write_transaction?: {
    payee: string;
    occurred_on: string;
    total_minor: number;
    currency?: string;
    metadata?: Record<string, unknown>;
    link_document?: boolean;
  };
  terminal: {
    status: "done" | "near_dup" | "unsupported" | "error";
    classification?: string;
    transaction_ids?: string[];
    document_ids?: string[];
    error?: string | null;
  };
}

/** True when the file at absPath is a stub instruction file. Cheap:
 *  refuses anything over 16 KB before reading. */
export async function isStubFile(absPath: string): Promise<boolean> {
  try {
    const buf = await readFile(absPath);
    if (buf.length > 16_384) return false;
    const parsed = JSON.parse(buf.toString("utf8")) as { __stub__?: unknown };
    return parsed.__stub__ === true;
  } catch {
    return false;
  }
}

export const stubFileExtractor: Extractor = async (input) => {
  const raw = await readFile(input.filePath, "utf8");
  const ins = JSON.parse(raw) as StubInstructions;
  if (ins.__stub__ !== true || !ins.terminal) {
    throw new Error("stub-extractor: file is not a valid stub instruction");
  }

  let seededTxId: string | null = null;
  if (ins.write_transaction) {
    const w = ins.write_transaction;
    const currency = w.currency ?? "USD";
    // Resolve one expense + one liability account; the sandbox seed
    // workspace always has both.
    const acct = await db.execute(
      sql`SELECT
            (SELECT id FROM accounts WHERE workspace_id = ${input.workspaceId}::uuid AND type = 'expense'  ORDER BY name LIMIT 1) AS expense,
            (SELECT id FROM accounts WHERE workspace_id = ${input.workspaceId}::uuid AND type = 'liability' ORDER BY name LIMIT 1) AS liability`,
    );
    const { expense, liability } = acct.rows[0] as {
      expense: string | null;
      liability: string | null;
    };
    if (!expense || !liability) {
      throw new Error("stub-extractor: workspace has no expense/liability accounts");
    }
    seededTxId = newId();
    const metadata = { source: "stub", ...(w.metadata ?? {}) };
    await db.execute(sql`
      WITH tx AS (
        INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, source_ingest_id, metadata, created_by)
        VALUES (${seededTxId}::uuid, ${input.workspaceId}::uuid, ${w.occurred_on}::date, ${w.payee}, 'posted',
                ${input.ingestId}::uuid, ${JSON.stringify(metadata)}::jsonb, ${input.userId}::uuid)
        RETURNING id
      ),
      p1 AS (
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        SELECT gen_random_uuid(), tx.id, ${input.workspaceId}::uuid, ${expense}::uuid, ${w.total_minor}, ${currency}, ${w.total_minor} FROM tx
      ),
      p2 AS (
        INSERT INTO postings (id, transaction_id, workspace_id, account_id, amount_minor, currency, amount_base_minor)
        SELECT gen_random_uuid(), tx.id, ${input.workspaceId}::uuid, ${liability}::uuid, ${-w.total_minor}, ${currency}, ${-w.total_minor} FROM tx
      )
      SELECT 1`);
    if (w.link_document) {
      await db.execute(sql`
        INSERT INTO document_links (document_id, transaction_id)
        VALUES (${input.documentId}::uuid, ${seededTxId}::uuid)
        ON CONFLICT DO NOTHING`);
    }
  }

  const resolveIds = (ids: string[] | undefined): string[] =>
    (ids ?? []).map((x) =>
      x === "$TX" ? (seededTxId ?? x) : x === "$DOC" ? input.documentId : x,
    );
  const t = ins.terminal;
  const produced = {
    transaction_ids: resolveIds(t.transaction_ids),
    document_ids: resolveIds(t.document_ids ?? ["$DOC"]),
    receipt_ids: [] as string[],
  };
  await db.execute(sql`
    UPDATE ingests
       SET status = ${t.status}::ingest_status,
           classification = ${t.classification ?? "receipt_image"},
           produced = ${JSON.stringify(produced)}::jsonb,
           error = ${t.error ?? null},
           completed_at = NOW()
     WHERE id = ${input.ingestId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid`);

  return {
    sessionId: randomUUID(),
    stdout: `STUB ingest=${input.ingestId} terminal=${t.status} tx=${seededTxId ?? "-"}`,
  };
};
