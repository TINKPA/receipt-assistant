/**
 * check-extraction-records.ts — `document_extractions` and its only writer,
 * `src/ingest/records.ts`, against a real Postgres (wave 1, migration 0043).
 *
 * WHAT IT CHECKS
 *
 *   - a valid record is stored with its promoted copies and the run points
 *     at it (`agent_runs.extraction_id`);
 *   - an invalid record is stored as evidence, promotes only well-formed
 *     values, and supersedes nothing;
 *   - a second valid record supersedes the first, and
 *     `currentExtractionRecord` returns the new one;
 *   - the trigger refuses an UPDATE of any column but `superseded_at`, and
 *     a manual clearing of a reference whose row still exists, but lets the
 *     ON DELETE SET NULL foreign keys clear a reference to a deleted run or
 *     ingest;
 *   - the partial unique index refuses a second current valid record for a
 *     document (written around `records.ts`), and the CHECK refuses a valid
 *     record without a classification;
 *   - `records.ts` refuses a document of another workspace and a run that
 *     does not exist;
 *   - deleting the document purges its records;
 *   - two concurrent valid inserts for one document both succeed, one after
 *     the other, the later superseding the earlier;
 *   - deleting a workspace that holds records, runs and ingests succeeds.
 *
 * Every check but the last two runs inside one transaction that is rolled
 * back. The last two commit a fixture workspace of their own and delete it
 * at the end. Never point this at the ledger: `--db` is required and is
 * not read from DATABASE_URL, and `--disposable` confirms the database is
 * a throwaway (`docker run … postgres:17`, migrated with
 * `node dist/db/migrate.js`).
 *
 *   npx tsx scripts/check-extraction-records.ts --disposable \
 *     --db=postgresql://postgres:postgres@127.0.0.1:<port>/receipts
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema/index.js";
import { insertExtractionRecord, currentExtractionRecord } from "../src/ingest/records.js";
import { validateExtraction, type ValidationOutcome } from "../src/ingest/contract/validate.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DB_URL = arg("db");
if (!DB_URL || !process.argv.includes("--disposable")) {
  console.error("usage: check-extraction-records.ts --disposable --db=<url of a throwaway Postgres>");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
const db = drizzle(pool, { schema });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let checks = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

class Rollback extends Error {}

/** Run `fn` in a savepoint; return "<SQLSTATE> <message>" of its failure, or null. */
async function failsWith(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await fn(sp);
    });
    return null;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
    const code = e.cause?.code ?? e.code ?? "-";
    return `${code} ${e.cause?.message ?? e.message ?? String(err)}`;
  }
}

const UPLOAD = new Date("2026-06-15T12:00:00Z");

function validRecord(payee: string, orderNumber: string): ValidationOutcome {
  const o = validateExtraction(
    {
      contract_version: 1,
      classification: "receipt_image",
      source_used: "image",
      facts: {
        flow: "purchase",
        occurred_on: "2026-06-10",
        payee,
        total_minor: 1080,
        currency: "USD",
      },
      payment: { method: "card", card_last4: "0000" },
      identifiers: { order_number: orderNumber },
      merchant: { canonical_name: payee, brand_id: "example-cafe", category: "Food & Drinks" },
      items: [{ line_no: 1, raw_name: "LATTE", line_total_minor: 1080, item_class: "food_drink", confidence: "high" }],
      audit: {
        ocr_raw_payee: payee,
        correction_applied: false,
        date_candidates: ["06/10/2026"],
        chosen_date_reason: "header",
        year_sanity_ok: true,
      },
    },
    { uploadedAt: UPLOAD, receiptText: "EXAMPLE CAFE\nTOTAL 10.80" },
  );
  if (o.status !== "valid") throw new Error(`fixture record invalid: ${JSON.stringify(o.report.errors)}`);
  return o;
}

function invalidRecord(): ValidationOutcome {
  const o = validateExtraction(
    {
      contract_version: 1,
      classification: "receipt_image",
      facts: { flow: "purchase", occurred_on: "2026-02-30", payee: "Example Cafe", total_minor: 1080, currency: "usd" },
      identifiers: { order_number: "A-0002", invoice_number: 7 },
      payment: { method: "card", card_last4: "12345" },
    },
    { uploadedAt: UPLOAD },
  );
  if (o.status !== "invalid") throw new Error("fixture invalid record validated");
  return o;
}

interface Fixture {
  workspaceId: string;
  docA: string;
  docB: string;
  ingestId: string;
  runId: string;
}

async function seed(tx: Tx | typeof db): Promise<Fixture> {
  const f: Fixture = {
    workspaceId: randomUUID(),
    docA: randomUUID(),
    docB: randomUUID(),
    ingestId: randomUUID(),
    runId: randomUUID(),
  };
  const userId = randomUUID();
  await tx.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`check-${userId}@example.invalid`})`);
  await tx.execute(
    sql`INSERT INTO workspaces (id, owner_id, name, base_currency) VALUES (${f.workspaceId}, ${userId}, 'check-extraction-records', 'USD')`,
  );
  for (const d of [f.docA, f.docB]) {
    await tx.execute(
      sql`INSERT INTO documents (id, workspace_id, kind, sha256) VALUES (${d}, ${f.workspaceId}, 'receipt_image', ${`check-${d}`})`,
    );
  }
  await tx.execute(
    sql`INSERT INTO ingests (id, workspace_id, filename, file_path, status, document_id)
        VALUES (${f.ingestId}, ${f.workspaceId}, 'check.jpg', ${`check/${f.ingestId}.jpg`}, 'processing', ${f.docA})`,
  );
  await tx.execute(
    sql`INSERT INTO agent_runs (id, workspace_id, kind, status, ingest_id, document_id, trigger, writer, session_id,
                                prompt_version, prompt_git_sha)
        VALUES (${f.runId}, ${f.workspaceId}, 'ingest', 'running', ${f.ingestId}, ${f.docA}, 'upload', 'server_apply',
                ${randomUUID()}, '4.0', 'check')`,
  );
  return f;
}

async function row(tx: Tx | typeof db, id: string): Promise<Record<string, any> | undefined> {
  const r = await tx.execute(sql`SELECT * FROM document_extractions WHERE id = ${id}`);
  return r.rows[0] as Record<string, any> | undefined;
}

async function inTransaction(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const f = await seed(tx);
      const base = { workspaceId: f.workspaceId, documentId: f.docA, ingestId: f.ingestId, origin: "stub" as const };

      // A valid record.
      const r1 = await insertExtractionRecord(tx, {
        ...base,
        agentRunId: f.runId,
        promptVersion: "4.0",
        model: "cli-default",
        outcome: validRecord("Example Cafe", "A-0001"),
        rawText: "EXAMPLE CAFE\nTOTAL 10.80",
        inputMeta: { prompt_bytes: 1 },
      });
      const s1 = await row(tx, r1.id);
      check("valid record stored", s1?.status === "valid" && r1.supersedesId === null);
      check(
        "promoted copies",
        s1?.classification === "receipt_image" &&
          s1?.flow === "purchase" &&
          s1?.occurred_on === "2026-06-10" &&
          Number(s1?.total_minor) === 1080 &&
          s1?.currency === "USD" &&
          s1?.payee === "Example Cafe" &&
          s1?.card_last4 === "0000" &&
          JSON.stringify(s1?.identifiers) === '{"order_number": "A-0001"}'.replace(": ", ":"),
        JSON.stringify(s1),
      );
      check("cli-default is not stored as a model", s1?.model === null);
      check("result is the normalised record", s1?.result?.items?.[0]?.currency === "USD" && s1?.result?.parties?.[0]?.role === "channel");
      check("validation report stored", Array.isArray(s1?.validation?.normalizations) && s1.validation.errors.length === 0);
      const run = (await tx.execute(sql`SELECT extraction_id FROM agent_runs WHERE id = ${f.runId}`)).rows[0] as any;
      check("run points at the record", run?.extraction_id === r1.id);

      // An invalid record supersedes nothing and promotes only what is well formed.
      const r2 = await insertExtractionRecord(tx, { ...base, outcome: invalidRecord() });
      const s2 = await row(tx, r2.id);
      check("invalid record stored", s2?.status === "invalid" && r2.supersedesId === null);
      check(
        "invalid record promotes only well-formed values",
        s2?.classification === "receipt_image" &&
          s2?.occurred_on === null &&
          s2?.currency === "USD" &&
          s2?.card_last4 === null &&
          JSON.stringify(s2?.identifiers) === JSON.stringify({ order_number: "A-0002" }),
        JSON.stringify(s2),
      );
      check("invalid record keeps the parsed input", s2?.result?.facts?.occurred_on === "2026-02-30");
      check("the valid record is still current", (await row(tx, r1.id))?.superseded_at === null);

      // A second valid record supersedes the first.
      const r3 = await insertExtractionRecord(tx, {
        ...base,
        agentRunId: f.runId,
        outcome: validRecord("Example Cafe Two", "A-0003"),
      });
      const s1b = await row(tx, r1.id);
      check("second valid record supersedes the first", r3.supersedesId === r1.id && s1b?.superseded_at !== null);
      const cur = await currentExtractionRecord(tx, f.docA);
      check("current record is the new one", cur?.id === r3.id);

      // Immutability.
      const upd = await failsWith(tx, (sp) => sp.execute(sql`UPDATE document_extractions SET payee = 'changed' WHERE id = ${r3.id}`));
      check("trigger refuses an update of payee", upd !== null && /^P0001 .*immutable/.test(upd), String(upd));
      const updResult = await failsWith(tx, (sp) =>
        sp.execute(sql`UPDATE document_extractions SET result = '{}'::jsonb WHERE id = ${r3.id}`),
      );
      check("trigger refuses an update of result", updResult !== null && /^P0001 .*immutable/.test(updResult), String(updResult));
      const updRef = await failsWith(tx, (sp) =>
        sp.execute(sql`UPDATE document_extractions SET agent_run_id = NULL WHERE id = ${r3.id}`),
      );
      check("trigger refuses clearing a reference whose row exists", updRef !== null && /^P0001 .*immutable/.test(updRef), String(updRef));
      const sup = await failsWith(tx, (sp) =>
        sp.execute(sql`UPDATE document_extractions SET superseded_at = now() - interval '1 day' WHERE id = ${r1.id}`),
      );
      check("trigger allows superseded_at", sup === null, String(sup));

      // Partial unique index and CHECK, written around records.ts.
      const insertRaw = (sp: Tx, status: string, classification: string | null, doc = f.docA) =>
        sp.execute(sql`INSERT INTO document_extractions (id, workspace_id, document_id, origin, status, contract_version, classification, result)
                       VALUES (${randomUUID()}, ${f.workspaceId}, ${doc}, 'manual', ${status}::extraction_status, 1, ${classification}, '{}'::jsonb)`);
      const dup = await failsWith(tx, (sp) => insertRaw(sp, "valid", "receipt_image"));
      check("unique index refuses a second current valid record", dup !== null && dup.startsWith("23505") && dup.includes("document_extractions_current_uq"), String(dup));
      const otherDoc = await failsWith(tx, (sp) => insertRaw(sp, "valid", "receipt_image", f.docB));
      check("another document may have its own current record", otherDoc === null, String(otherDoc));
      const invalidToo = await failsWith(tx, async (sp) => {
        await insertRaw(sp, "invalid", null);
        await insertRaw(sp, "invalid", null);
      });
      check("invalid records are not limited", invalidToo === null, String(invalidToo));
      const noClass = await failsWith(tx, (sp) => insertRaw(sp, "valid", null, f.docB));
      check("CHECK refuses a valid record without classification", noClass !== null && noClass.startsWith("23514"), String(noClass));

      // records.ts guards.
      const otherWs = await failsWith(tx, (sp) =>
        insertExtractionRecord(sp, { ...base, workspaceId: randomUUID(), outcome: validRecord("X", "A-9") }),
      );
      check("refuses a document of another workspace", otherWs !== null && /not in workspace/.test(otherWs), String(otherWs));
      const noRun = await failsWith(tx, (sp) =>
        insertExtractionRecord(sp, { ...base, documentId: f.docB, agentRunId: randomUUID(), outcome: validRecord("X", "A-9") }),
      );
      // The agent_run_id foreign key refuses it first (23503); the run update
      // in records.ts is the guard for a run of another workspace.
      check("refuses a run that does not exist", noRun !== null && /^23503|does not exist/.test(noRun), String(noRun));

      // Foreign keys clear references through the trigger.
      await tx.execute(sql`UPDATE ingests SET current_run_id = NULL WHERE id = ${f.ingestId}`);
      const delRun = await failsWith(tx, (sp) => sp.execute(sql`DELETE FROM agent_runs WHERE id = ${f.runId}`));
      const s3 = await row(tx, r3.id);
      check("deleting the run nulls agent_run_id", delRun === null && s3?.agent_run_id === null, String(delRun));
      const delIngest = await failsWith(tx, (sp) => sp.execute(sql`DELETE FROM ingests WHERE id = ${f.ingestId}`));
      check("deleting the ingest nulls ingest_id", delIngest === null && (await row(tx, r3.id))?.ingest_id === null, String(delIngest));

      // A hard delete of the document purges its records.
      await tx.execute(sql`DELETE FROM documents WHERE id = ${f.docA}`);
      const left = (await tx.execute(sql`SELECT count(*)::int AS n FROM document_extractions WHERE document_id = ${f.docA}`)).rows[0] as any;
      check("deleting the document purges its records", left?.n === 0);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function concurrency(): Promise<void> {
  const f = await seed(db);
  try {
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        db.transaction(async (tx) => {
          const r = await insertExtractionRecord(tx, {
            workspaceId: f.workspaceId,
            documentId: f.docB,
            origin: "stub",
            outcome: validRecord(`Concurrent ${n}`, `C-${n}`),
          });
          // Hold the transaction open a moment so the two overlap.
          await tx.execute(sql`SELECT pg_sleep(0.3)`);
          return r;
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string; supersedesId: string | null }>[];
    check("two concurrent valid inserts both commit", ok.length === 2, JSON.stringify(results.map((r) => r.status)));
    const rows = (
      await db.execute(sql`SELECT id, supersedes_id, superseded_at FROM document_extractions WHERE document_id = ${f.docB} ORDER BY created_at, id`)
    ).rows as Array<{ id: string; supersedes_id: string | null; superseded_at: string | null }>;
    const current = rows.filter((r) => r.superseded_at === null);
    check("exactly one is current", rows.length === 2 && current.length === 1);
    const older = rows.find((r) => r.superseded_at !== null);
    check("the later supersedes the earlier", !!older && current[0]?.supersedes_id === older.id);
  } finally {
    // A workspace delete cascades through runs, ingests, documents and
    // records, and the trigger must let the foreign keys do it.
    const del = await db
      .execute(sql`DELETE FROM workspaces WHERE id = ${f.workspaceId} RETURNING owner_id`)
      .then((r) => ({ ok: true as const, owner: (r.rows[0] as any)?.owner_id as string }))
      .catch((err) => ({ ok: false as const, err }));
    check("deleting a workspace with records succeeds", del.ok, del.ok ? "" : String((del as any).err?.cause?.message ?? (del as any).err));
    if (del.ok) await db.execute(sql`DELETE FROM users WHERE id = ${del.owner}`);
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM document_extractions WHERE workspace_id = ${f.workspaceId}`)).rows[0] as any;
    check("nothing of the fixture is left", left?.n === 0);
  }
}

async function main(): Promise<void> {
  const migrated = (await db.execute(sql`SELECT to_regclass('public.document_extractions') IS NOT NULL AS ok`)).rows[0] as any;
  if (!migrated?.ok) {
    console.error("document_extractions does not exist: run `node dist/db/migrate.js` against this database first");
    process.exit(2);
  }
  await inTransaction();
  await concurrency();
  await pool.end();
  if (failures.length > 0) {
    console.error(`check-extraction-records: ${failures.length} of ${checks} checks failed`);
    process.exit(1);
  }
  console.log(`check-extraction-records: ${checks} checks passed`);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
