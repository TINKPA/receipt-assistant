/**
 * Extraction records: the only writer of `document_extractions`
 * (migration 0043, wave 1 P2).
 *
 * A record is what one agent run (or a stub, a ledger backfill, a person)
 * read off one document, as validated by `contract/validate.ts`, stored
 * before anything is derived from it. See
 * `src/schema/document_extractions.ts` for why it exists and what the
 * columns hold.
 *
 * `insertExtractionRecord` runs inside the caller's transaction (T1;
 * docs/server-writer.md, "The evidence store") and in it:
 *
 *   1. serialises with any other record write for the same document (a
 *      transaction-scoped advisory lock on the document id; no row lock,
 *      so it stays out of the lock order the ledger writes follow);
 *   2. for a VALID record, marks the document's current valid record
 *      superseded and names it in the new row's `supersedes_id`. An
 *      invalid record supersedes nothing: it is evidence of what the
 *      agent handed back, not a reading the ledger can use;
 *   3. inserts the row, with the promoted copies (classification, flow,
 *      date, total, currency, payee, identifiers, card last-4) taken from
 *      the record, or for an invalid one only the values that are well
 *      formed;
 *   4. points the run at it (`agent_runs.extraction_id`), and fails if
 *      the run is not there.
 *
 * Rows are immutable after insert (a trigger allows only `superseded_at`
 * to change), so warnings found later, while the record is applied, go on
 * the run's `apply_report`, not here.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "../db/client.js";
import { agentRuns, documentExtractions, documents } from "../schema/index.js";
import { newId } from "../http/uuid.js";
import {
  CARD_LAST4_RE,
  CLASSIFICATIONS,
  CONTRACT_IDENTIFIER_KEYS,
  EXTRACTION_CONTRACT_VERSION,
  FLOWS,
} from "./contract/v1.js";
import { dayNumber, identifiersOf, type ValidationOutcome } from "./contract/validate.js";
import { pgSafeText } from "./contract/artefact.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ExtractionOrigin = (typeof documentExtractions.$inferInsert)["origin"];

export interface ExtractionRecordInput {
  workspaceId: string;
  documentId: string;
  ingestId?: string | null;
  /** The run that handed the record back; its `extraction_id` is set. */
  agentRunId?: string | null;
  origin: ExtractionOrigin;
  promptVersion?: string | null;
  promptGitSha?: string | null;
  /** The model the transcript says answered. `cli-default` is stored as NULL. */
  model?: string | null;
  /** sha256 of the decoded source text the agent was shown, if any. */
  sourceTextSha256?: string | null;
  /** `{phash_neighbors, attachments:[{bytes,sha256}], prompt_bytes}`. */
  inputMeta?: Record<string, unknown>;
  /** What `validateExtraction` / `validateArtefact` returned. */
  outcome: ValidationOutcome;
  /** The ```receipt-text block, if one came with the record. */
  rawText?: string | null;
}

export interface StoredExtractionRecord {
  id: string;
  status: "valid" | "invalid";
  /** The record this one replaced as the document's current valid one. */
  supersedesId: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;

interface Promoted {
  classification: string | null;
  flow: string | null;
  occurredOn: string | null;
  totalMinor: number | null;
  currency: string | null;
  payee: string | null;
  identifiers: Record<string, string>;
  cardLast4: string | null;
}

/** The promoted columns of a record: all of them for a valid one, and
 *  for an invalid one only the values that are well formed, so the row
 *  can be found by them without the insert failing on a bad date. */
export function promotedCopies(outcome: ValidationOutcome): Promoted {
  if (outcome.status === "valid") {
    const r = outcome.record;
    return {
      classification: r.classification,
      flow: r.facts?.flow ?? null,
      occurredOn: r.facts?.occurred_on ?? null,
      totalMinor: r.facts?.total_minor ?? null,
      currency: r.facts?.currency ?? null,
      payee: r.facts?.payee ?? null,
      identifiers: identifiersOf(r),
      cardLast4: r.payment.card_last4 ?? null,
    };
  }
  const p = isPlainObject(outcome.parsed) ? outcome.parsed : {};
  const facts = isPlainObject(p.facts) ? p.facts : {};
  const payment = isPlainObject(p.payment) ? p.payment : {};
  const idents = isPlainObject(p.identifiers) ? p.identifiers : {};
  const str = (v: unknown, max: number) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t !== "" && t.length <= max ? t : null;
  };
  const identifiers: Record<string, string> = {};
  for (const k of CONTRACT_IDENTIFIER_KEYS) {
    const v = str(idents[k], 80);
    if (v !== null) identifiers[k] = v;
  }
  const occurredOn = str(facts.occurred_on, 10);
  const total = facts.total_minor;
  const currency = str(facts.currency, 16);
  const last4 = str(payment.card_last4, 4);
  return {
    classification: oneOf(CLASSIFICATIONS, p.classification),
    flow: oneOf(FLOWS, facts.flow),
    occurredOn: occurredOn !== null && dayNumber(occurredOn) !== null ? occurredOn : null,
    totalMinor: typeof total === "number" && Number.isSafeInteger(total) ? total : null,
    currency: currency !== null && /^[A-Za-z0-9_]+$/.test(currency) ? currency.toUpperCase() : null,
    payee: str(facts.payee, 200),
    identifiers,
    cardLast4: last4 !== null && CARD_LAST4_RE.test(last4) ? last4 : null,
  };
}

/**
 * Store a record (valid or invalid) in the caller's transaction, superseding
 * the document's current valid record when this one is valid, and point the
 * run at it. Throws when the document is not in the workspace or the run
 * does not exist; the caller's transaction then rolls back whole.
 */
export async function insertExtractionRecord(
  tx: DbTx,
  input: ExtractionRecordInput,
): Promise<StoredExtractionRecord> {
  const { outcome } = input;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document-extractions:${input.documentId}`}, 0))`,
  );

  const doc = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, input.workspaceId)));
  if (doc.length !== 1) {
    throw new Error(`extraction record: document ${input.documentId} is not in workspace ${input.workspaceId}`);
  }

  let supersedesId: string | null = null;
  if (outcome.status === "valid") {
    const prev = await tx
      .update(documentExtractions)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(documentExtractions.documentId, input.documentId),
          eq(documentExtractions.status, "valid"),
          isNull(documentExtractions.supersededAt),
        ),
      )
      .returning({ id: documentExtractions.id });
    supersedesId = prev[0]?.id ?? null;
  }

  const id = newId();
  const promoted = promotedCopies(outcome);
  const result =
    outcome.status === "valid" ? outcome.record : isPlainObject(outcome.parsed) ? outcome.parsed : { parsed: outcome.parsed ?? null };
  await tx.insert(documentExtractions).values({
    id,
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    ingestId: input.ingestId ?? null,
    agentRunId: input.agentRunId ?? null,
    origin: input.origin,
    status: outcome.status,
    contractVersion: EXTRACTION_CONTRACT_VERSION,
    promptVersion: input.promptVersion ?? null,
    promptGitSha: input.promptGitSha ?? null,
    model: input.model && input.model !== "cli-default" ? input.model : null,
    sourceTextSha256: input.sourceTextSha256 ?? null,
    inputMeta: input.inputMeta ?? {},
    supersedesId,
    ...promoted,
    result,
    // The parser already made it storable; a caller that did not parse
    // (a backfill, a person) gets the same treatment here.
    rawText: input.rawText == null ? null : pgSafeText(input.rawText),
    validation: outcome.report,
  });

  if (input.agentRunId) {
    const run = await tx
      .update(agentRuns)
      .set({ extractionId: id })
      .where(and(eq(agentRuns.id, input.agentRunId), eq(agentRuns.workspaceId, input.workspaceId)))
      .returning({ id: agentRuns.id });
    if (run.length !== 1) {
      throw new Error(`extraction record: run ${input.agentRunId} does not exist in workspace ${input.workspaceId}`);
    }
  }

  return { id, status: outcome.status, supersedesId };
}

/** The document's current valid record, or null. */
export async function currentExtractionRecord(
  executor: Pick<typeof db, "select">,
  documentId: string,
): Promise<typeof documentExtractions.$inferSelect | null> {
  const rows = await executor
    .select()
    .from(documentExtractions)
    .where(
      and(
        eq(documentExtractions.documentId, documentId),
        eq(documentExtractions.status, "valid"),
        isNull(documentExtractions.supersededAt),
      ),
    );
  return rows[0] ?? null;
}
