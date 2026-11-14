/**
 * eval-dedup.ts — dedup-system regression matrix (#134/#135 hardening).
 *
 * Runs the full L1/L2/L3 dedup behavior matrix against a THROWAWAY
 * stack (never production): decision-tree branches, worker guard
 * negative paths (via the stub extractor), the reconcile engine's safety
 * rules, the same-batch concurrency race, and the flagged-review API.
 *
 * Prereqs:
 *   - a server started with EXTRACTOR_STUB_ALLOWED=1 against a database
 *     you can throw away: the sandbox (docker-compose.test.yml sets the
 *     env), or `npx tsx src/server.ts` pointed at a scratch Postgres
 *   - for the Claude cases only: a RESET sandbox (scripts/sandbox-reset.sh)
 *     and the corpus images under --uploads-dir
 *
 * Usage (from the repo root):
 *   npx tsx scripts/eval-dedup.ts --base=http://<host>:<port> \
 *       --pg=postgresql://postgres:postgres@<host>:<port>/receipts \
 *       [--only=g1,rf] [--with-claude]
 *
 * Stub cases are deterministic and fast (about a minute in total): every
 * seed carries a per-run nonce, so they can run against a dirty database
 * and repeat without interfering. Claude cases (b*, race) each pay a real
 * extraction (~2-4 min), need macOS `sips`, and are gated behind
 * --with-claude. Run them after any eval-dates batch finishes to avoid
 * auth-pool contention.
 *
 * "Removed" below always means SOFT-DELETED: `deleted_at` set, status
 * still `posted` (#171). Nothing writes `voided` any more, and a count of
 * live rows must filter `deleted_at IS NULL`.
 *
 * Case matrix — worker guards (stub):
 *   g1   near_dup claimed without a committed link  → worker forces error (#134 guard)
 *   g2   done with produced=[] but txn written      → #133 self-heal repairs produced
 *   g3   done with produced=[] and no txn           → worker forces error (#125 guard)
 *   g4   near_dup attach to a SOFT-DELETED txn      → worker forces error (deleted is not live)
 *
 * Reconcile engine (stub):
 *   r1   cross-batch order-number exact match       → 1.0 auto-apply: later row soft-deleted,
 *        evidence re-linked, and the moved links RECORDED on the proposal (#135)
 *   r2   cross-batch card-last4 conflict            → no proposal
 *   r3   reconcile flip+re-run                      → no duplicate proposals (idempotency)
 *   rf   refund vs purchase, same order number      → no proposal, nothing removed
 *        (signed-total gate; flow gate for a refund booked the wrong way round, with a flow
 *        on both sides or on the refund only; leg-class gate for money back booked through
 *        an income account; in-batch too)
 *   sd   soft-deleted survivor                      → no proposal against the deleted row, the
 *        new row stays live; re-uploading the deleted row's exact bytes extracts AGAIN,
 *        and a third upload dedups against the new live row
 *   l1   the same bytes in four requests at once    → extracted once, for a first upload and
 *        for a re-upload after its transaction was deleted
 *   rc   run of equal-price same-merchant charges   → bounded: ≤ 1 proposal across 6 separate
 *        batches, 0 for 5 in one batch, nothing removed
 *   ib   in-batch identifier rules                  → different order numbers: no proposal;
 *        no identifiers: one 0.9 proposal, NOT applied; same order number: 1.0 auto-apply,
 *        also a day apart; same order number under two spellings of the payee: found, for review
 *   nd   pair the agent judged `distinct`           → not re-raised
 *   pp   same pair seen from a second batch         → still one proposal; a rejection sticks
 *   cl   survivor deleted before apply              → apply refused, proposal `stale`,
 *        duplicate untouched; the next reconcile closes other stale proposals
 *   un   undo                                       → auto-applied and user-applied proposals
 *        both restore the row WITH its own document (same link timestamp); second undo is a
 *        no-op; a self-pair on file is refused
 *   rd   reconciled rows                            → the reconciled row survives even when it
 *        is the newer one; two reconciled rows are not paired
 *   ch   applies built on each other                → undo refuses the inner one until the outer
 *        is undone; newest-first restores every row with exactly its own document
 *   cd   cascade delete between apply and undo      → deleting the moved document keeps the
 *        survivor and says so; undo is then refused (`no_live_document`) instead of restoring
 *        a row with no live document; soft: restore the document and undo works; hard: the
 *        refusal stands
 *   cs   cascade delete of the survivor's OWN document → the moved document keeps the survivor;
 *        between apply and undo                     undo is then refused (`survivor_no_live_document`)
 *        instead of leaving the survivor live with no live document; restoring its document
 *        (soft) or deleting the survivor (hard) lets the undo through
 *
 * Agent decision tree (--with-claude):
 *   b2   re-encoded copy of extracted receipt       → branch-2 attach (near_dup, no new txn)
 *   b3   same-app-template different purchase (d≈2) → branch-3 INSERT distinct (pHash never decides)
 *   b4   candidates but no strong tiebreaker        → branch-4 INSERT + flagged_for_review,
 *        then GET ?flagged=near_dup + dismiss endpoint round-trip
 *   race two byte-different copies in ONE batch     → ledger converges to 1 live txn
 *        (L3a attach in-flight, or the in-batch pass repairs after — which needs the two
 *        extractions to agree on an identifier; without one it is a 0.9 proposal for a
 *        person, and this case then fails by design)
 */
import "dotenv/config";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

// ── CLI ────────────────────────────────────────────────────────────────
function argOf(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const BASE = argOf("base") ?? "http://localhost:3001";
const PG_URL =
  argOf("pg") ?? "postgresql://postgres:postgres@localhost:5433/receipts";
const ONLY = argOf("only")?.split(",") ?? null;
const WITH_CLAUDE = process.argv.includes("--with-claude");
const UPLOADS_DIR =
  argOf("uploads-dir") ??
  path.join(
    process.env.HOME ?? "~",
    "Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads",
  );

// Corpus images (verified NOT in eval-dates.fixtures.json):
const STARBUCKS_1 =
  "28b476e69f7c903ca18268a69c20ab49a5b2e7b89457ed9ce9a130cac96db3f3.jpg"; // Cold Brew $4.95, Feb 17, receipt #66143296
const STARBUCKS_2 =
  "c8960015470c53cd1a334df9afa1b722c107cfaff605b93d5c35588d505f6f28.jpg"; // Nitro $5.95, May 12, receipt #65985696 (pHash d≈2 from #1)
const RACE_IMAGE =
  "17ee7d85d17cad886f5c66454987781371e3fabc9765c806ee411ad7e4a13a03.jpg"; // Mitsuwa $75.16, 2026-06-09

const db = new pg.Client({ connectionString: PG_URL });

// Per-run nonce: stub seeds carry it in payees/order-numbers so reruns
// against a dirty database never cross-match a previous run's rows
// (fixed values would near-dup-match across runs and remove each
// other — observed before this existed). Claude cases (b2/b3/race) use
// real corpus images and DO require a reset sandbox.
const NONCE = randomUUID().slice(0, 6);

// Per-run AMOUNTS too. Reconcile pairs rows on an equal total inside a
// ±3-day window whatever their payee, so a fixed amount would pair this
// run's seeds with a previous run's (or with a real row, on a
// production-shaped copy) and the "no proposal" assertions below would
// be measuring that noise. `amt(k)` is unique per (run, k): give every
// sub-case its own k unless it WANTS two rows to share a total.
const NONCE_NUM = parseInt(NONCE, 16);
const amt = (k: number): number => 100_000 + (NONCE_NUM % 1_000_000) * 100 + k;

// ── helpers ────────────────────────────────────────────────────────────
async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows as T[];
}

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${pathname}`, init);
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, body, headers: res.headers };
}

async function postJson(pathname: string, payload: unknown): Promise<any> {
  return api(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

interface UploadFile {
  name: string;
  bytes: Buffer;
  mime: string;
}

async function postBatch(files: UploadFile[]): Promise<{
  batchId: string;
  ingestIds: string[];
}> {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name);
  }
  const res = await fetch(`${BASE}/v1/ingest/batch`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`POST /v1/ingest/batch → ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    batchId: string;
    items: { ingestId: string }[];
  };
  return { batchId: json.batchId, ingestIds: json.items.map((i) => i.ingestId) };
}

const TERMINAL_BATCH = new Set(["extracted", "reconciled", "failed", "error"]);
// Reconcile is fire-and-forget after `extracted`, so a case that asserts
// on proposals must wait for the batch to leave the reconcile pipeline,
// not merely for extraction to finish.
const RECONCILE_DONE = new Set(["reconciled", "reconcile_error", "failed", "error"]);

async function pollBatch(
  batchId: string,
  timeoutMs = 420_000,
  until: Set<string> = TERMINAL_BATCH,
): Promise<any> {
  const start = Date.now();
  for (let n = 0; ; n++) {
    const { json } = await api(`/v1/batches/${batchId}`);
    if (json && until.has(json.status)) return json;
    if (Date.now() - start > timeoutMs)
      throw new Error(`batch ${batchId} not terminal after ${timeoutMs}ms (status=${json?.status})`);
    // Stub extractions finish in milliseconds; real ones take minutes.
    await new Promise((r) => setTimeout(r, n < 20 ? 250 : 4000));
  }
}

const pollReconciled = (batchId: string, timeoutMs = 60_000): Promise<any> =>
  pollBatch(batchId, timeoutMs, RECONCILE_DONE);

function stubFile(ins: Record<string, unknown>): UploadFile {
  return {
    name: `stub-${randomUUID().slice(0, 8)}.json`,
    // __salt__ keeps every stub upload byte-unique — otherwise two
    // identical instruction files trip L1 sha-dedup and the second
    // batch is born `dedup` without ever running the stub (observed:
    // r1's batch B). A correct L1 behavior, wrong test vehicle.
    bytes: Buffer.from(
      JSON.stringify({ __stub__: true, __salt__: randomUUID(), ...ins }, null, 1),
    ),
    mime: "application/json",
  };
}

// ── stub-seed helpers (reconcile matrix) ───────────────────────────────

interface SeedTx {
  payee: string;
  occurred_on: string;
  /** Signed: a NEGATIVE total writes a refund (expense leg negative,
   *  card leg positive), exactly the shape the agent writes. */
  total_minor: number;
  /** Which kind of account carries the `total_minor` leg (default
   *  expense). `income` with a negative total is money coming back
   *  booked as income: income credited, card debited. */
  pl_account_type?: "expense" | "income";
  metadata?: Record<string, unknown>;
}

interface TxState {
  id: string;
  status: string;
  deleted_at: Date | null;
}

interface Seeded {
  batchId: string;
  ingestId: string;
  file: UploadFile;
  tx: TxState;
  docId: string;
}

const seedInstruction = (w: SeedTx): Record<string, unknown> => ({
  write_transaction: { ...w, link_document: true },
  terminal: { status: "done", transaction_ids: ["$TX"] },
});

async function txBySourceIngest(ingestId: string): Promise<TxState> {
  const rows = await q<TxState>(
    `SELECT id, status, deleted_at FROM transactions WHERE source_ingest_id = $1`,
    [ingestId],
  );
  assert(rows.length === 1, `expected 1 txn for ingest ${ingestId}, got ${rows.length}`);
  return rows[0]!;
}

async function txState(id: string): Promise<TxState> {
  const [row] = await q<TxState>(
    `SELECT id, status, deleted_at FROM transactions WHERE id = $1`,
    [id],
  );
  assert(row, `transaction ${id} missing`);
  return row;
}

/** The ledger's one definition of live, spelled out so this harness
 *  checks the view from the outside instead of trusting it. */
const isLive = (t: TxState): boolean =>
  t.deleted_at === null && (t.status === "posted" || t.status === "reconciled");

async function docOfIngest(ingestId: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `SELECT d.id FROM ingests i
       JOIN documents d ON d.workspace_id = i.workspace_id AND d.file_path = i.file_path
      WHERE i.id = $1`,
    [ingestId],
  );
  assert(row, `document for ingest ${ingestId} missing`);
  return row.id;
}

/** Seed several transactions in ONE batch and wait for its reconcile. */
async function seedBatch(ws: SeedTx[]): Promise<Seeded[]> {
  const files = ws.map((w) => stubFile(seedInstruction(w)));
  const { batchId, ingestIds } = await postBatch(files);
  await pollReconciled(batchId);
  const out: Seeded[] = [];
  for (let i = 0; i < ingestIds.length; i++) {
    out.push({
      batchId,
      ingestId: ingestIds[i]!,
      file: files[i]!,
      tx: await txBySourceIngest(ingestIds[i]!),
      docId: await docOfIngest(ingestIds[i]!),
    });
  }
  return out;
}

/** Seed one transaction in its own batch and wait for its reconcile. */
async function seedOne(w: SeedTx): Promise<Seeded> {
  return (await seedBatch([w]))[0]!;
}

interface ProposalState {
  id: string;
  batch_id: string;
  status: string;
  score: number;
  payload: any;
}

/** Every dedup proposal naming BOTH ids, in either orientation. */
async function proposalsBetween(a: string, b: string): Promise<ProposalState[]> {
  return q<ProposalState>(
    `SELECT id, batch_id, status, score::float8 AS score, payload
       FROM reconcile_proposals
      WHERE kind = 'dedup'
        AND ((payload->>'duplicate' = $1 AND payload->>'duplicate_of' = $2)
          OR (payload->>'duplicate' = $2 AND payload->>'duplicate_of' = $1))
      ORDER BY created_at`,
    [a, b],
  );
}

/** Every dedup proposal naming ANY of the ids on either side. */
async function proposalsTouching(ids: string[]): Promise<ProposalState[]> {
  return q<ProposalState>(
    `SELECT id, batch_id, status, score::float8 AS score, payload
       FROM reconcile_proposals
      WHERE kind = 'dedup'
        AND (payload->>'duplicate' = ANY($1) OR payload->>'duplicate_of' = ANY($1))
      ORDER BY created_at`,
    [ids],
  );
}

async function linksOf(txId: string): Promise<string[]> {
  const rows = await q<{ document_id: string }>(
    `SELECT document_id FROM document_links WHERE transaction_id = $1 ORDER BY document_id`,
    [txId],
  );
  return rows.map((r) => r.document_id);
}

/**
 * Put a dedup proposal on file by hand, the way one written before the
 * direction gate existed would sit there, and ask the API to apply it.
 * Returns the reason it was skipped (or the response, if it was not).
 */
async function applyHandMadeProposal(duplicate: Seeded, survivor: Seeded): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO reconcile_proposals (id, batch_id, kind, payload, score, status)
     VALUES ($1, $2, 'dedup', $3::jsonb, 0.9, 'proposed')`,
    [id, duplicate.batchId, JSON.stringify({ duplicate: duplicate.tx.id, duplicate_of: survivor.tx.id })],
  );
  const res = await postJson(`/v1/batches/${duplicate.batchId}/reconcile/apply`, {
    proposal_ids: [id],
  });
  await q(`DELETE FROM reconcile_proposals WHERE id = $1`, [id]);
  return String(res.json?.skipped?.[0]?.reason ?? `NOT skipped: ${res.body}`);
}

/** Soft-delete through the API, the way a person does it. */
async function softDeleteViaApi(txId: string): Promise<void> {
  const got = await api(`/v1/transactions/${txId}`);
  assert(got.status === 200, `GET txn → ${got.status}`);
  const etag = got.headers.get("etag");
  assert(etag, "GET txn returned no ETag");
  const del = await api(`/v1/transactions/${txId}`, {
    method: "DELETE",
    headers: { "If-Match": etag },
  });
  assert(del.status === 204, `DELETE txn → ${del.status}: ${del.body}`);
}

/** Flip a reconciled batch back and run its reconcile again. */
async function rerunReconcile(batchId: string): Promise<void> {
  await q(`UPDATE batches SET status = 'extracted' WHERE id = $1`, [batchId]);
  const res = await postJson(`/v1/batches/${batchId}/reconcile`, {});
  assert(res.status === 200, `reconcile → ${res.status}: ${res.body}`);
  assert(res.json.status === "reconciled", `reconcile left batch ${res.json.status}`);
}

let tmp = "";
async function reencode(srcName: string, quality: number): Promise<Buffer> {
  const src = path.join(UPLOADS_DIR, srcName);
  const out = path.join(tmp, `${quality}-${srcName}`);
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), src, "--out", out], { stdio: "ignore" });
  return readFile(out);
}

function makeEml(opts: {
  merchant: string;
  totalUsd: string;
  dateLine: string;
  item: string;
}): UploadFile {
  const mid = `${randomUUID()}@dedup-eval.test`;
  const eml = [
    `From: receipts@${opts.merchant.toLowerCase().replace(/\s+/g, "")}.test`,
    `To: customer@example.test`,
    `Subject: Your ${opts.merchant} receipt`,
    `Date: ${opts.dateLine}`,
    `Message-ID: <${mid}>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Thanks for your purchase at ${opts.merchant}!`,
    ``,
    `${opts.item}  $${opts.totalUsd}`,
    `Total: $${opts.totalUsd}`,
    ``,
    `Paid in store. No order number for walk-in purchases.`,
    ``,
  ].join("\r\n");
  return {
    name: `${opts.merchant.replace(/\s+/g, "-")}-${mid.slice(0, 8)}.eml`,
    bytes: Buffer.from(eml),
    mime: "message/rfc822",
  };
}

// ── case framework ─────────────────────────────────────────────────────
interface CaseResult {
  name: string;
  pass: boolean;
  notes: string[];
}
const results: CaseResult[] = [];

async function runCase(
  name: string,
  needsClaude: boolean,
  fn: (notes: string[]) => Promise<void>,
): Promise<void> {
  if (ONLY && !ONLY.includes(name)) return;
  if (needsClaude && !WITH_CLAUDE) {
    console.log(`~ ${name}: skipped (needs --with-claude)`);
    return;
  }
  const notes: string[] = [];
  process.stdout.write(`▶ ${name} ... `);
  try {
    await fn(notes);
    console.log("PASS");
    results.push({ name, pass: true, notes });
  } catch (err) {
    console.log(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
    results.push({
      name,
      pass: false,
      notes: [...notes, err instanceof Error ? err.message : String(err)],
    });
  }
  for (const n of notes) console.log(`    · ${n}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── main ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await db.connect();
  tmp = await mkdtemp(path.join(tmpdir(), "eval-dedup-"));
  console.log(`# eval-dedup  base=${BASE}  claude-cases=${WITH_CLAUDE ? "ON" : "off"}\n`);

  // g1 — near_dup claimed, no link → forced error (#134 guard)
  await runCase("g1", false, async (notes) => {
    const phantom = randomUUID();
    const { batchId, ingestIds } = await postBatch([
      stubFile({
        terminal: { status: "near_dup", transaction_ids: [phantom] },
      }),
    ]);
    await pollBatch(batchId);
    const [ing] = await q(`SELECT status, error FROM ingests WHERE id = $1`, [ingestIds[0]]);
    assert(ing!.status === "error", `expected error, got ${ing!.status}`);
    assert(String(ing!.error).includes("#134"), `error msg: ${ing!.error}`);
    notes.push(`forced error: "${String(ing!.error).slice(0, 80)}…"`);
  });

  // g2 — done + produced=[] but txn written → #133 self-heal
  await runCase("g2", false, async (notes) => {
    const { batchId, ingestIds } = await postBatch([
      stubFile({
        write_transaction: {
          payee: `SelfHeal Mart ${NONCE}`,
          occurred_on: "2026-06-01",
          total_minor: amt(1),
          link_document: true,
        },
        terminal: { status: "done", transaction_ids: [] },
      }),
    ]);
    await pollBatch(batchId);
    const [ing] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`,
      [ingestIds[0]],
    );
    assert(ing!.status === "done", `expected done, got ${ing!.status}`);
    const repaired = ing!.produced?.transaction_ids ?? [];
    const [tx] = await q(`SELECT id FROM transactions WHERE source_ingest_id = $1`, [ingestIds[0]]);
    assert(tx, "seed txn missing");
    assert(
      repaired.length === 1 && repaired[0] === tx!.id,
      `produced not repaired: ${JSON.stringify(repaired)} vs ${tx!.id}`,
    );
    notes.push(`produced self-healed to [${String(tx!.id).slice(0, 8)}…]`);
  });

  // g3 — done + produced=[] + no txn → forced error (#125 guard)
  await runCase("g3", false, async (notes) => {
    const { batchId, ingestIds } = await postBatch([
      stubFile({ terminal: { status: "done", transaction_ids: [] } }),
    ]);
    await pollBatch(batchId);
    const [ing] = await q(`SELECT status, error FROM ingests WHERE id = $1`, [ingestIds[0]]);
    assert(ing!.status === "error", `expected error, got ${ing!.status}`);
    assert(String(ing!.error).includes("#125"), `error msg: ${ing!.error}`);
    notes.push(`forced error: "${String(ing!.error).slice(0, 80)}…"`);
  });

  // g4 — near_dup claimed against a SOFT-DELETED transaction, with a
  // committed link → forced error. A deleted row keeps status `posted`,
  // so a guard that only reads status accepts the attach and the
  // document's purchase then exists nowhere in the ledger.
  await runCase("g4", false, async (notes) => {
    const target = await seedOne({
      payee: `Tombstone Deli ${NONCE}`,
      occurred_on: "2026-06-01",
      total_minor: amt(2),
    });
    await softDeleteViaApi(target.tx.id);
    // The stub links its own document to the transaction it writes, not
    // to an arbitrary one, so pre-commit the link the "agent" claims:
    // upload the attach file once with a guard-tripping phantom target to
    // learn its document id, then link that document and re-drive the
    // same bytes after the first ingest has errored (no live transaction,
    // nothing in flight → extracted again).
    const attach = stubFile({
      terminal: { status: "near_dup", transaction_ids: [target.tx.id] },
    });
    const first = await postBatch([attach]);
    await pollBatch(first.batchId);
    const docId = await docOfIngest(first.ingestIds[0]!);
    await q(
      `INSERT INTO document_links (document_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [docId, target.tx.id],
    );
    const second = await postBatch([attach]);
    await pollBatch(second.batchId);
    const [ing] = await q<{ status: string; error: string | null }>(
      `SELECT status, error FROM ingests WHERE id = $1`,
      [second.ingestIds[0]],
    );
    assert(
      ing!.status === "error",
      `expected error for an attach to a deleted txn, got ${ing!.status} (${ing!.error})`,
    );
    assert(String(ing!.error).includes("#134"), `error msg: ${ing!.error}`);
    notes.push("committed link to a soft-deleted txn is not a live attach → forced error");
  });

  // r1 — cross-batch order-number exact → 1.0 auto-apply + re-link (#135)
  let r1: { a: Seeded; b: Seeded; proposal: ProposalState } | null = null;
  await runCase("r1", false, async (notes) => {
    const seed: SeedTx = {
      payee: `EdgeMart ${NONCE}`,
      occurred_on: "2026-06-02",
      total_minor: amt(3),
      metadata: { order_number: `ORD-EDGE-${NONCE}`, payment: "Visa ****1111" },
    };
    const a = await seedOne(seed);
    const b = await seedOne(seed);
    const txA = await txState(a.tx.id);
    const txB = await txState(b.tx.id);
    // Removal is a soft delete: deleted_at set, status untouched.
    assert(txB.deleted_at !== null, "expected B soft-deleted (deleted_at set)");
    assert(txB.status === "posted", `soft delete must keep status, got ${txB.status}`);
    assert(isLive(txA), "expected A (the earlier row) to stay live");
    const linksA = await linksOf(a.tx.id);
    assert(linksA.length === 2, `expected 2 links on canonical, got ${linksA.length}`);
    assert((await linksOf(b.tx.id)).length === 0, "removed duplicate still owns links");
    // Reconcile is serialized per workspace and a pair is proposed once,
    // so there is exactly one proposal, whichever batch saw it first.
    const props = await proposalsBetween(a.tx.id, b.tx.id);
    assert(props.length === 1, `expected exactly 1 proposal for the pair, got ${props.length}`);
    const prop = props[0]!;
    assert(prop.score === 1 && prop.status === "auto_applied", `proposal: ${JSON.stringify(prop)}`);
    assert(prop.payload.duplicate === b.tx.id, "the LATER row must be the duplicate");
    // The apply must record exactly what it moved.
    const rec = prop.payload.applied;
    assert(rec && Array.isArray(rec.links), "proposal carries no applied.links record");
    assert(
      rec.links.length === 1 &&
        rec.links[0].document_id === b.docId &&
        rec.links[0].canonical_had_link === false,
      `applied.links wrong: ${JSON.stringify(rec.links)}`,
    );
    const evB = await q(
      `SELECT 1 FROM transaction_events
        WHERE transaction_id = $1 AND event_type = 'deleted' AND payload->>'proposal_id' = $2`,
      [b.tx.id, prop.id],
    );
    const evA = await q(
      `SELECT 1 FROM transaction_events
        WHERE transaction_id = $1 AND event_type = 'dedup_absorbed' AND payload->>'proposal_id' = $2`,
      [a.tx.id, prop.id],
    );
    assert(evB.length === 1 && evA.length === 1, "expected one event on each row of the pair");
    r1 = { a, b, proposal: prop };
    notes.push("later txn soft-deleted @1.0; earliest survives with both documents; moved link recorded");
  });

  // r2 — card-last4 conflict kills the pair → no proposal
  await runCase("r2", false, async (notes) => {
    const mk = (last4: string): SeedTx => ({
      payee: `CardConflict Deli ${NONCE}`,
      occurred_on: "2026-06-03",
      total_minor: amt(4),
      metadata: { payment: `Visa ****${last4}` },
    });
    const a = await seedOne(mk("1111"));
    const b = await seedOne(mk("2222"));
    // Assert specifically that the CONFLICT PAIR produced no proposal —
    // a dirty database can legitimately propose B against unrelated
    // same-amount rows from earlier runs, which is correct behavior.
    const props = await proposalsBetween(a.tx.id, b.tx.id);
    assert(props.length === 0, `conflict pair got ${props.length} proposal(s)`);
    assert(isLive(await txState(b.tx.id)), "B should stay live");
    assert(isLive(await txState(a.tx.id)), "A should stay live");
    notes.push("conflicting card last-4 → pair killed, both txns live");
  });

  // r3 — flip + re-run reconcile → no duplicate proposals
  await runCase("r3", false, async (notes) => {
    assert(r1, "r1 must run before r3");
    const ids = [r1.a.tx.id, r1.b.tx.id];
    const before = (await proposalsTouching(ids)).length;
    await rerunReconcile(r1.b.batchId);
    await rerunReconcile(r1.a.batchId);
    const after = (await proposalsTouching(ids)).length;
    assert(after === before, `proposals duplicated: ${before} → ${after}`);
    notes.push(`re-running both batches minted 0 new proposals (${after} stable)`);
  });

  // rf — a refund is never a duplicate of the purchase it reverses.
  // Production lost two refunds this way: the old cross-batch pass picked
  // the amount by sign, so the refund's positive card leg equalled the
  // purchase total, and the shared order number scored the pair 1.0.
  await runCase("rf", false, async (notes) => {
    // (1) cross-batch, legs booked correctly, NO flow metadata — the gate
    //     must hold on the signed total alone (old rows carry no flow).
    const base = {
      payee: `Refund Outfitters ${NONCE}`,
      occurred_on: "2026-06-04",
      metadata: { order_number: `ORD-RF-${NONCE}`, payment: "Visa ****1111" },
    };
    const purchase = await seedOne({ ...base, total_minor: amt(5) });
    const refund = await seedOne({ ...base, total_minor: -amt(5) });
    assert(
      (await proposalsBetween(purchase.tx.id, refund.tx.id)).length === 0,
      "refund was proposed as a duplicate of its purchase",
    );
    assert(isLive(await txState(refund.tx.id)), "refund was removed");
    assert(isLive(await txState(purchase.tx.id)), "purchase was removed");
    assert((await linksOf(refund.tx.id)).length === 1, "refund lost its document");
    // Proposals from before the gate are still on file in production:
    // applying one must be refused at the point of deletion too.
    const legacy = await applyHandMadeProposal(refund, purchase);
    assert(legacy === "direction_mismatch", `apply of a refund→purchase proposal: ${legacy}`);
    assert(isLive(await txState(refund.tx.id)), "apply removed the refund");
    notes.push("cross-batch refund vs purchase, same order number → no proposal, both live; a hand-made proposal is refused at apply");

    // (2) the refund's legs booked the wrong way round (positive expense
    //     leg), so the totals DO match: metadata.flow has to stop it.
    const base2 = {
      payee: `Refund Outfitters B ${NONCE}`,
      occurred_on: "2026-06-04",
      total_minor: amt(6),
    };
    const p2 = await seedOne({
      ...base2,
      metadata: { order_number: `ORD-RF2-${NONCE}`, flow: "purchase" },
    });
    const r2 = await seedOne({
      ...base2,
      metadata: { order_number: `ORD-RF2-${NONCE}`, flow: "refund", refund_of: p2.tx.id },
    });
    assert(
      (await proposalsBetween(p2.tx.id, r2.tx.id)).length === 0,
      "flow=refund vs flow=purchase was proposed",
    );
    assert(isLive(await txState(r2.tx.id)), "mis-signed refund was removed");
    notes.push("equal totals but flow refund/purchase → no proposal (metadata gate)");

    // (3) both in ONE batch — the in-batch pass applies the same gate.
    const base3 = {
      payee: `Refund Outfitters C ${NONCE}`,
      occurred_on: "2026-06-04",
      metadata: { order_number: `ORD-RF3-${NONCE}` },
    };
    const [p3, r3] = await seedBatch([
      { ...base3, total_minor: amt(7) },
      { ...base3, total_minor: -amt(7) },
    ]);
    assert(
      (await proposalsBetween(p3!.tx.id, r3!.tx.id)).length === 0,
      "in-batch refund vs purchase was proposed",
    );
    assert(isLive(await txState(p3!.tx.id)) && isLive(await txState(r3!.tx.id)), "in-batch pair lost a row");
    notes.push("same batch → no proposal either");

    // (4) and a refund uploaded twice still dedups against ITSELF.
    const refundAgain = await seedOne({ ...base, total_minor: -amt(5) });
    const again = await proposalsBetween(refund.tx.id, refundAgain.tx.id);
    assert(
      again.length === 1 && again[0]!.status === "auto_applied",
      `second copy of the refund should fold into the first: ${JSON.stringify(again)}`,
    );
    assert(isLive(await txState(refund.tx.id)), "first refund copy must survive");
    assert(isLive(await txState(purchase.tx.id)), "purchase must be untouched by the refund pair");
    notes.push("second copy of the same refund folds into the first; the purchase is untouched");

    // (5) the mis-booked refund again, but the PURCHASE carries no flow —
    //     which is what most rows on file look like. "refund" on one side
    //     only, with legs that read as money going out, must be enough.
    const base5 = {
      payee: `Refund Outfitters D ${NONCE}`,
      occurred_on: "2026-06-04",
      total_minor: amt(19),
    };
    const p5 = await seedOne({ ...base5, metadata: { order_number: `ORD-RF5-${NONCE}` } });
    const r5 = await seedOne({
      ...base5,
      metadata: { order_number: `ORD-RF5-${NONCE}`, flow: "refund" },
    });
    assert(
      (await proposalsBetween(p5.tx.id, r5.tx.id)).length === 0,
      "flow=refund vs a purchase with no flow was proposed",
    );
    assert(isLive(await txState(r5.tx.id)) && isLive(await txState(p5.tx.id)), "one-sided-flow pair lost a row");
    const legacy5 = await applyHandMadeProposal(r5, p5);
    assert(legacy5 === "direction_mismatch", `apply of a one-sided-flow proposal: ${legacy5}`);
    assert(isLive(await txState(r5.tx.id)), "apply removed the mis-booked refund");
    // ...while a flow on one side only is no obstacle when the legs on
    // both sides already read as a refund: a third copy of the refund
    // from (1), this time carrying flow, still folds into the first.
    const refundWithFlow = await seedOne({
      ...base,
      total_minor: -amt(5),
      metadata: { ...base.metadata, flow: "refund" },
    });
    const third = await proposalsBetween(refund.tx.id, refundWithFlow.tx.id);
    assert(
      third.length === 1 && third[0]!.status === "auto_applied",
      `a refund copy carrying flow should fold into the copy without: ${JSON.stringify(third)}`,
    );
    notes.push("flow=refund on one side, positive legs → no proposal; negative legs on both → still folds");

    // (6) money back booked through an INCOME account: income is keyed
    //     positive, so its signed total equals the purchase's. Only the
    //     class of the legs tells them apart.
    const [income] = await q(`SELECT 1 FROM accounts WHERE type = 'income' LIMIT 1`);
    if (!income) {
      notes.push("(income-booked refund not exercised: this workspace has no income account)");
    } else {
      const base6 = {
        payee: `Refund Outfitters E ${NONCE}`,
        occurred_on: "2026-06-04",
        metadata: { order_number: `ORD-RF6-${NONCE}` },
      };
      const p6 = await seedOne({ ...base6, total_minor: amt(20) });
      const r6 = await seedOne({ ...base6, total_minor: -amt(20), pl_account_type: "income" });
      const [legs] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM postings p JOIN accounts a ON a.id = p.account_id
          WHERE p.transaction_id = $1 AND a.type = 'income' AND p.amount_base_minor = $2`,
        [r6.tx.id, -amt(20)],
      );
      assert(legs!.n === 1, "seed did not book the refund through an income account");
      assert(
        (await proposalsBetween(p6.tx.id, r6.tx.id)).length === 0,
        "money back booked as income was proposed as a duplicate of the purchase",
      );
      assert(isLive(await txState(r6.tx.id)) && isLive(await txState(p6.tx.id)), "income-booked pair lost a row");
      const legacy6 = await applyHandMadeProposal(r6, p6);
      assert(legacy6 === "direction_mismatch", `apply of an income-refund→purchase proposal: ${legacy6}`);
      assert(isLive(await txState(r6.tx.id)), "apply removed the income-booked refund");
      notes.push("refund booked through an income account vs purchase, same order number → no proposal, apply refused");
    }
  });

  // sd — a soft-deleted transaction is not live for any dedup layer.
  await runCase("sd", false, async (notes) => {
    // (1) reconcile: the deleted row is not a survivor.
    const seed: SeedTx = {
      payee: `Reshoot Bakery ${NONCE}`,
      occurred_on: "2026-06-05",
      total_minor: amt(8),
      metadata: { order_number: `ORD-SD-${NONCE}` },
    };
    const wrong = await seedOne(seed);
    await softDeleteViaApi(wrong.tx.id);
    const reshot = await seedOne(seed);
    const props = await proposalsTouching([wrong.tx.id, reshot.tx.id]);
    assert(props.length === 0, `proposal against a deleted row: ${JSON.stringify(props)}`);
    assert(isLive(await txState(reshot.tx.id)), "the re-shot receipt's transaction was removed");
    assert(
      (await linksOf(reshot.tx.id)).join() === reshot.docId,
      "the re-shot receipt's document was moved off its transaction",
    );
    notes.push("same order number as a soft-deleted row → no proposal, new row live with its document");

    // (2) L1: the same BYTES re-uploaded after the delete extract again.
    const first = await seedOne({
      payee: `Reupload Cafe ${NONCE}`,
      occurred_on: "2026-06-05",
      total_minor: amt(9),
    });
    await softDeleteViaApi(first.tx.id);
    const again = await postBatch([first.file]);
    await pollReconciled(again.batchId);
    const [ing] = await q<{ status: string; error: string | null }>(
      `SELECT status, error FROM ingests WHERE id = $1`,
      [again.ingestIds[0]],
    );
    assert(
      ing!.status === "done",
      `re-upload after delete should extract again, got ${ing!.status} (${ing!.error})`,
    );
    const second = await txBySourceIngest(again.ingestIds[0]!);
    assert(isLive(second) && second.id !== first.tx.id, "no new live transaction from the re-upload");
    assert((await txState(first.tx.id)).deleted_at !== null, "the deleted row must stay deleted");
    notes.push("identical bytes after soft delete → extracted again (new live txn)");

    // (3) positive control: with a live transaction, L1 still dedups.
    const third = await postBatch([first.file]);
    await pollBatch(third.batchId);
    const [ing3] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`,
      [third.ingestIds[0]],
    );
    assert(ing3!.status === "dedup", `third upload should be born dedup, got ${ing3!.status}`);
    assert(
      ing3!.produced?.transaction_ids?.[0] === second.id,
      `dedup must point at the LIVE transaction, got ${JSON.stringify(ing3!.produced?.transaction_ids)}`,
    );
    notes.push("third upload → dedup, pointing at the live txn (not the deleted one)");
  });

  // l1 — the byte-level probe is check-then-insert. Requests carrying the
  // same bytes at the same instant must not all read "nothing live,
  // nothing in flight" and all extract.
  await runCase("l1", false, async (notes) => {
    const burst = async (file: UploadFile): Promise<{ done: string[]; statuses: string[] }> => {
      const ups = await Promise.all(Array.from({ length: 4 }, () => postBatch([file])));
      for (const u of ups) await pollReconciled(u.batchId);
      const rows = await q<{ id: string; status: string }>(
        `SELECT id, status FROM ingests WHERE id = ANY($1)`,
        [ups.map((u) => u.ingestIds[0])],
      );
      return {
        done: rows.filter((r) => r.status === "done").map((r) => r.id),
        statuses: rows.map((r) => r.status).sort(),
      };
    };
    // (1) a file nobody has seen.
    const file = stubFile(
      seedInstruction({ payee: `Burst Upload ${NONCE}`, occurred_on: "2026-06-15", total_minor: amt(24) }),
    );
    const first = await burst(file);
    assert(
      first.statuses.join() === "dedup,dedup,dedup,done",
      `4 simultaneous first uploads: expected 1 done + 3 dedup, got [${first.statuses.join(", ")}]`,
    );
    const tx = await txBySourceIngest(first.done[0]!);
    notes.push("4 simultaneous uploads of new bytes → 1 extraction, 3 dedup");

    // (2) the same file after its transaction was deleted: the probe now
    //     (correctly) finds nothing live, so only the in-flight check
    //     stands between four requests and four extractions.
    await softDeleteViaApi(tx.id);
    const again = await burst(file);
    assert(
      again.statuses.join() === "dedup,dedup,dedup,done",
      `4 simultaneous re-uploads after delete: expected 1 done + 3 dedup, got [${again.statuses.join(", ")}]`,
    );
    const fresh = await txBySourceIngest(again.done[0]!);
    assert(isLive(fresh) && fresh.id !== tx.id, "the re-upload did not produce a new live transaction");
    notes.push("4 simultaneous re-uploads after the delete → extracted once");
  });

  // rc — recurring equal-price charges at one merchant are not duplicates
  // of each other, and must not produce a proposal per pair. Production:
  // 12 scooter rides produced 51 proposals, up to 9 for one ride.
  await runCase("rc", false, async (notes) => {
    const ride = (payee: string, day: string, total: number): SeedTx => ({
      payee,
      occurred_on: day,
      total_minor: total,
      metadata: { payment: "Visa ****1111" },
    });
    // (1) six rides, each uploaded on its own.
    const payee = `Scoot Share ${NONCE}`;
    const days = ["2026-06-06", "2026-06-06", "2026-06-06", "2026-06-07", "2026-06-07", "2026-06-08"];
    const rides: Seeded[] = [];
    for (const d of days) rides.push(await seedOne(ride(payee, d, amt(10))));
    const ids = rides.map((r) => r.tx.id);
    const props = await proposalsTouching(ids);
    for (const id of ids) assert(isLive(await txState(id)), `ride ${id.slice(0, 8)} was removed`);
    assert(
      props.every((p) => p.status === "proposed" && p.score < 0.95),
      `a recurring charge was auto-applied: ${JSON.stringify(props.map((p) => [p.status, p.score]))}`,
    );
    assert(props.length <= 1, `expected ≤ 1 proposal for 6 rides, got ${props.length}`);
    notes.push(`6 equal-price rides in 6 batches → ${props.length} proposal(s), 0 removed (15 pairs possible)`);

    // (2) five rides in ONE batch (same day): the old in-batch pass
    //     auto-removed four of them at 1.0.
    const batch = await seedBatch(
      Array.from({ length: 5 }, () => ride(`Scoot Share Batch ${NONCE}`, "2026-06-06", amt(11))),
    );
    const bids = batch.map((r) => r.tx.id);
    const bprops = await proposalsTouching(bids);
    for (const id of bids) assert(isLive(await txState(id)), `batched ride ${id.slice(0, 8)} was removed`);
    assert(bprops.length === 0, `expected 0 proposals for 5 rides in one batch, got ${bprops.length}`);
    notes.push("5 equal-price rides in one batch → 0 proposals, 0 removed");
  });

  // ib — the in-batch pass no longer auto-applies on date+payee+amount
  // alone, and never when identifiers disagree.
  let ibOpen: { older: Seeded; newer: Seeded; proposal: ProposalState } | null = null;
  await runCase("ib", false, async (notes) => {
    const day = "2026-06-09";
    // (a) different order numbers → two purchases.
    const [a1, a2] = await seedBatch([
      { occurred_on: day, total_minor: amt(12), payee: `Twin Orders ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-1` } },
      { occurred_on: day, total_minor: amt(12), payee: `Twin Orders ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-2` } },
    ]);
    assert(
      (await proposalsBetween(a1!.tx.id, a2!.tx.id)).length === 0,
      "different order numbers were proposed as duplicates",
    );
    assert(isLive(await txState(a1!.tx.id)) && isLive(await txState(a2!.tx.id)), "a row was removed");
    notes.push("(a) same day/payee/amount, different order numbers → no proposal");

    // (b) no identifiers at all → "two coffees": a proposal for a person.
    const [b1, b2] = await seedBatch([
      { occurred_on: day, total_minor: amt(13), payee: `Two Coffees ${NONCE}` },
      { occurred_on: day, total_minor: amt(13), payee: `Two Coffees ${NONCE}` },
    ]);
    const bp = await proposalsBetween(b1!.tx.id, b2!.tx.id);
    assert(bp.length === 1, `expected 1 proposal, got ${bp.length}`);
    assert(
      bp[0]!.status === "proposed" && Math.abs(bp[0]!.score - 0.9) < 1e-6,
      `expected proposed @0.9, got ${bp[0]!.status} @${bp[0]!.score}`,
    );
    assert(isLive(await txState(b1!.tx.id)) && isLive(await txState(b2!.tx.id)), "a row was removed");
    const [older, newer] =
      bp[0]!.payload.duplicate === b2!.tx.id ? [b1!, b2!] : [b2!, b1!];
    ibOpen = { older, newer, proposal: bp[0]! };
    notes.push("(b) no identifiers → 1 proposal @0.9, NOT applied, both live");

    // (c) same order number → identity; the race repair still works.
    const [c1, c2] = await seedBatch([
      { occurred_on: day, total_minor: amt(14), payee: `Same Order ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-C` } },
      { occurred_on: day, total_minor: amt(14), payee: `Same Order ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-C` } },
    ]);
    const cp = await proposalsBetween(c1!.tx.id, c2!.tx.id);
    assert(
      cp.length === 1 && cp[0]!.status === "auto_applied" && cp[0]!.score === 1,
      `expected 1 auto-applied @1.0, got ${JSON.stringify(cp.map((p) => [p.status, p.score]))}`,
    );
    const live = [await txState(c1!.tx.id), await txState(c2!.tx.id)].filter(isLive);
    assert(live.length === 1, `expected exactly 1 live row, got ${live.length}`);
    assert(
      (await linksOf(live[0]!.id)).length === 2,
      "the survivor should hold both documents",
    );
    notes.push("(c) same order number → auto-applied @1.0, survivor holds both documents");

    // (d) same order number, the two extractions a DAY apart. The
    //     in-batch pass used to want the exact day, and the cross-batch
    //     pass skips same-batch rows, so this pair was seen by neither.
    const [d1, d2] = await seedBatch([
      { occurred_on: day, total_minor: amt(25), payee: `Day Drift ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-D` } },
      { occurred_on: "2026-06-10", total_minor: amt(25), payee: `Day Drift ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-D` } },
    ]);
    const dp = await proposalsBetween(d1!.tx.id, d2!.tx.id);
    assert(
      dp.length === 1 && dp[0]!.status === "auto_applied" && dp[0]!.score === 1,
      `expected 1 auto-applied @1.0 for a one-day drift, got ${JSON.stringify(dp.map((p) => [p.status, p.score]))}`,
    );
    notes.push("(d) same order number, one day apart, one batch → auto-applied @1.0");

    // (e) same order number under two spellings of the payee. Found, but
    //     the party is not provably the same, so it waits for a person.
    const [e1, e2] = await seedBatch([
      { occurred_on: day, total_minor: amt(26), payee: `Spelling Drift ${NONCE}`, metadata: { order_number: `ORD-IB-${NONCE}-E` } },
      { occurred_on: day, total_minor: amt(26), payee: `Spelling Drift ${NONCE}.com`, metadata: { order_number: `ORD-IB-${NONCE}-E` } },
    ]);
    const ep = await proposalsBetween(e1!.tx.id, e2!.tx.id);
    assert(
      ep.length === 1 && ep[0]!.status === "proposed" && ep[0]!.score < 0.95,
      `expected 1 open proposal below the threshold, got ${JSON.stringify(ep.map((p) => [p.status, p.score]))}`,
    );
    assert(isLive(await txState(e1!.tx.id)) && isLive(await txState(e2!.tx.id)), "a row was removed");
    notes.push(`(e) same order number, payee spelled two ways, one batch → 1 proposal @${ep[0]!.score}, NOT applied`);
  });

  // nd — a pair the agent already judged distinct is not re-raised.
  await runCase("nd", false, async (notes) => {
    const base = { payee: `Judged Diner ${NONCE}`, occurred_on: "2026-06-10", total_minor: amt(15) };
    const a = await seedOne(base);
    const b = await seedOne({
      ...base,
      metadata: {
        near_dup_check: {
          candidate_transaction_id: a.tx.id,
          verdict: "distinct",
          reason: "eval-dedup: different items",
        },
      },
    });
    assert(
      (await proposalsBetween(a.tx.id, b.tx.id)).length === 0,
      "reconcile re-raised a pair the agent judged distinct",
    );
    // Control: the same shape WITHOUT a verdict is proposed (case ib-b),
    // so the absence above is the verdict's doing, not a dead detector.
    notes.push("near_dup_check verdict=distinct naming the candidate → no proposal");
  });

  // pp — one proposal per pair, whichever batches see it, and a person's
  // rejection is not undone by the next reconcile.
  await runCase("pp", false, async (notes) => {
    const base = { payee: `Pair Once Grill ${NONCE}`, occurred_on: "2026-06-11", total_minor: amt(16) };
    const a = await seedOne(base);
    const b = await seedOne(base);
    const first = await proposalsBetween(a.tx.id, b.tx.id);
    assert(first.length === 1 && first[0]!.status === "proposed", `seed proposal: ${JSON.stringify(first)}`);
    // A's batch now sees B as an outside row: the same pair, from the
    // other side. The old key was per batch and minted a second row.
    await rerunReconcile(a.batchId);
    assert((await proposalsBetween(a.tx.id, b.tx.id)).length === 1, "pair proposed again from the other batch");
    const rej = await postJson(`/v1/batches/${first[0]!.batch_id}/reconcile/reject`, {
      proposal_ids: [first[0]!.id],
    });
    assert(rej.status === 200 && rej.json.rejected.length === 1, `reject → ${rej.status} ${rej.body}`);
    await rerunReconcile(a.batchId);
    await rerunReconcile(b.batchId);
    const after = await proposalsBetween(a.tx.id, b.tx.id);
    assert(
      after.length === 1 && after[0]!.status === "rejected",
      `a rejected pair came back: ${JSON.stringify(after.map((p) => p.status))}`,
    );
    notes.push("pair proposed once across both batches; stays rejected after two more reconciles");
  });

  // cl — the survivor must be live when a proposal is applied.
  await runCase("cl", false, async (notes) => {
    const base = { payee: `Survivor Check ${NONCE}`, occurred_on: "2026-06-12", total_minor: amt(17) };
    const a = await seedOne(base);
    const b = await seedOne(base);
    const [prop] = await proposalsBetween(a.tx.id, b.tx.id);
    assert(prop && prop.status === "proposed", "expected an open proposal to work with");
    const canonical = prop.payload.duplicate_of as string;
    const duplicate = prop.payload.duplicate as string;
    await softDeleteViaApi(canonical);
    const res = await postJson(`/v1/batches/${prop.batch_id}/reconcile/apply`, {
      proposal_ids: [prop.id],
    });
    assert(res.status === 200, `apply → ${res.status}`);
    assert(
      res.json.applied.length === 0 && String(res.json.skipped[0]?.reason).includes("canonical_not_live"),
      `apply onto a deleted survivor was not refused: ${res.body}`,
    );
    assert(isLive(await txState(duplicate)), "the only live copy was removed");
    assert((await linksOf(duplicate)).length === 1, "the live copy lost its document");
    const [after] = await proposalsBetween(a.tx.id, b.tx.id);
    assert(after!.status === "stale", `proposal should be stale, got ${after!.status}`);
    notes.push("apply with a deleted survivor → refused, proposal stale, duplicate keeps its document");

    // A second open proposal goes stale without anyone trying to apply
    // it: the next reconcile in the workspace closes it.
    const base2 = { payee: `Survivor Sweep ${NONCE}`, occurred_on: "2026-06-12", total_minor: amt(18) };
    const c = await seedOne(base2);
    const d = await seedOne(base2);
    const [open] = await proposalsBetween(c.tx.id, d.tx.id);
    assert(open && open.status === "proposed", "expected a second open proposal");
    await softDeleteViaApi(open.payload.duplicate_of as string);
    await rerunReconcile(a.batchId); // any batch of the workspace
    const [swept] = await proposalsBetween(c.tx.id, d.tx.id);
    assert(swept!.status === "stale", `sweep left the proposal ${swept!.status}`);
    notes.push("open proposal naming a deleted row → closed as stale by the next reconcile");
  });

  // un — undo restores the transaction AND gives it its documents back.
  await runCase("un", false, async (notes) => {
    // (1) the auto-applied proposal from r1.
    assert(r1, "r1 must run before un");
    const { a, b, proposal } = r1;
    const undo = await postJson(`/v1/batches/${proposal.batch_id}/reconcile/undo`, {
      proposal_ids: [proposal.id],
    });
    assert(undo.status === 200, `undo → ${undo.status}: ${undo.body}`);
    const done = undo.json.reverted?.[0];
    assert(done, `nothing reverted: ${undo.body}`);
    assert(
      done.restored === true &&
        done.links_source === "recorded" &&
        done.documents_relinked.join() === b.docId &&
        done.documents_removed_from_canonical.join() === b.docId,
      `undo detail wrong: ${JSON.stringify(done)}`,
    );
    assert(isLive(await txState(b.tx.id)), "duplicate was not restored");
    assert((await linksOf(b.tx.id)).join() === b.docId, "restored row did not get its own document back");
    assert((await linksOf(a.tx.id)).join() === a.docId, "survivor kept the other row's document");
    // The link comes back as the row it was, to the microsecond.
    const recordedAt = proposal.payload.applied.links[0].linked_at as string;
    assert(/\.\d{6}Z$/.test(recordedAt), `linked_at was recorded without microseconds: ${recordedAt}`);
    const [lk] = await q<{ at: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM document_links WHERE transaction_id = $1 AND document_id = $2`,
      [b.tx.id, b.docId],
    );
    assert(lk!.at === recordedAt, `restored link is stamped ${lk!.at}, the original was ${recordedAt}`);
    const [p1] = await proposalsBetween(a.tx.id, b.tx.id);
    assert(p1!.status === "reverted", `proposal should be reverted, got ${p1!.status}`);
    // Second undo: nothing to do, nothing changes.
    const twice = await postJson(`/v1/batches/${proposal.batch_id}/reconcile/undo`, {
      proposal_ids: [proposal.id],
    });
    assert(
      twice.json.reverted.length === 0 && twice.json.skipped[0]?.reason === "already_reverted",
      `second undo: ${twice.body}`,
    );
    // And the engine does not immediately propose the pair again.
    await rerunReconcile(b.batchId);
    const afterRerun = await proposalsBetween(a.tx.id, b.tx.id);
    assert(afterRerun.length === 1, "a reverted pair was proposed again");
    assert(isLive(await txState(b.tx.id)), "a reverted pair was removed again");
    notes.push("auto-applied → undo: row live again with its own document; second undo no-op; not re-proposed");

    // (2) a proposal a person applied (the open 0.9 one from ib-b).
    assert(ibOpen, "ib must run before un");
    const { older, newer } = ibOpen;
    const prop = ibOpen.proposal;
    const applied = await postJson(`/v1/batches/${prop.batch_id}/reconcile/apply`, {
      proposal_ids: [prop.id],
    });
    assert(applied.json.applied?.length === 1, `apply → ${applied.body}`);
    assert((await txState(newer.tx.id)).deleted_at !== null, "user apply did not remove the duplicate");
    assert((await linksOf(older.tx.id)).length === 2, "user apply did not move the document");
    const undo2 = await postJson(`/v1/batches/${prop.batch_id}/reconcile/undo`, {
      proposal_ids: [prop.id],
    });
    assert(undo2.json.reverted?.length === 1, `undo of a user apply: ${undo2.body}`);
    assert(isLive(await txState(newer.tx.id)), "user-applied duplicate was not restored");
    assert((await linksOf(newer.tx.id)).join() === newer.docId, "restored row is missing its document");
    assert((await linksOf(older.tx.id)).join() === older.docId, "survivor kept the moved document");
    // A proposal that was never applied cannot be undone.
    const never = await postJson(`/v1/batches/${prop.batch_id}/reconcile/undo`, {
      proposal_ids: [randomUUID()],
    });
    assert(never.json.reverted.length === 0 && never.json.skipped.length === 1, `undo of unknown id: ${never.body}`);
    notes.push("user-applied → undo: same round trip; unknown proposal id is skipped");

    // (3) a proposal on file that names one row as both sides. The engine
    //     cannot write one; undo must still not act on it, because "take
    //     the documents back off the survivor" would strip the row bare.
    const selfId = randomUUID();
    await q(
      `INSERT INTO reconcile_proposals (id, batch_id, kind, payload, score, status, resolved_at)
       VALUES ($1, $2, 'dedup', $3::jsonb, 1, 'auto_applied', now())`,
      [selfId, a.batchId, JSON.stringify({ duplicate: a.tx.id, duplicate_of: a.tx.id })],
    );
    const selfUndo = await postJson(`/v1/batches/${a.batchId}/reconcile/undo`, { proposal_ids: [selfId] });
    assert(
      selfUndo.json.reverted.length === 0 && selfUndo.json.skipped[0]?.reason === "malformed_payload",
      `undo of a self-pair: ${selfUndo.body}`,
    );
    assert((await linksOf(a.tx.id)).join() === a.docId, "undo of a self-pair took the row's own document");
    await q(`DELETE FROM reconcile_proposals WHERE id = $1`, [selfId]);
    notes.push("self-pair on file → undo refused, the row keeps its document");
  });

  // rd — a reconciled row is matched to a bank line and is never the one
  // removed, whichever of the two is older.
  await runCase("rd", false, async (notes) => {
    // (1) older posted, newer reconciled. The verdict keeps the pair
    //     apart while it is seeded; it is lifted together with the status
    //     change, and the batch reconciled again.
    const base = {
      payee: `Bank Matched ${NONCE}`,
      occurred_on: "2026-06-13",
      total_minor: amt(21),
    };
    const older = await seedOne({ ...base, metadata: { order_number: `ORD-RD-${NONCE}` } });
    const newer = await seedOne({
      ...base,
      metadata: {
        order_number: `ORD-RD-${NONCE}`,
        near_dup_check: { candidate_transaction_id: older.tx.id, verdict: "distinct" },
      },
    });
    assert((await proposalsBetween(older.tx.id, newer.tx.id)).length === 0, "seed pair was proposed early");
    await q(
      `UPDATE transactions SET status = 'reconciled', metadata = metadata - 'near_dup_check' WHERE id = $1`,
      [newer.tx.id],
    );
    await rerunReconcile(newer.batchId);
    const props = await proposalsBetween(older.tx.id, newer.tx.id);
    assert(props.length === 1, `expected 1 proposal, got ${props.length}`);
    assert(
      props[0]!.payload.duplicate === older.tx.id && props[0]!.payload.duplicate_of === newer.tx.id,
      "the reconciled row was named as the duplicate",
    );
    assert(props[0]!.status === "auto_applied", `expected auto_applied, got ${props[0]!.status}`);
    const survivor = await txState(newer.tx.id);
    assert(survivor.status === "reconciled" && survivor.deleted_at === null, "the reconciled row did not survive");
    assert((await txState(older.tx.id)).deleted_at !== null, "the posted copy was not removed");
    assert((await linksOf(newer.tx.id)).length === 2, "the reconciled row should hold both documents");
    notes.push("older posted + newer reconciled → the posted copy is the duplicate; reconciled row keeps both documents");

    // (2) both reconciled: two bank lines, two events.
    const base2 = {
      payee: `Bank Matched Twice ${NONCE}`,
      occurred_on: "2026-06-13",
      total_minor: amt(22),
    };
    const x = await seedOne({ ...base2, metadata: { order_number: `ORD-RD2-${NONCE}` } });
    const y = await seedOne({
      ...base2,
      metadata: {
        order_number: `ORD-RD2-${NONCE}`,
        near_dup_check: { candidate_transaction_id: x.tx.id, verdict: "distinct" },
      },
    });
    await q(
      `UPDATE transactions SET status = 'reconciled', metadata = metadata - 'near_dup_check' WHERE id = ANY($1)`,
      [[x.tx.id, y.tx.id]],
    );
    await rerunReconcile(y.batchId);
    assert((await proposalsBetween(x.tx.id, y.tx.id)).length === 0, "two reconciled rows were proposed as duplicates");
    notes.push("both reconciled → no proposal");
  });

  // ch — applies that build on each other are undone newest first.
  await runCase("ch", false, async (notes) => {
    const base = { payee: `Chain Mart ${NONCE}`, occurred_on: "2026-06-14", total_minor: amt(23) };
    const a = await seedOne(base);
    // B carries an order number A lacks: no identifier agrees, so B→A is
    // a 0.9 proposal that waits.
    const b = await seedOne({ ...base, metadata: { order_number: `ORD-CH-${NONCE}` } });
    const [pBA] = await proposalsBetween(a.tx.id, b.tx.id);
    assert(pBA && pBA.status === "proposed", `expected an open B→A proposal: ${JSON.stringify(pBA)}`);
    // C shares B's order number: auto-applied onto B.
    const c = await seedOne({ ...base, metadata: { order_number: `ORD-CH-${NONCE}` } });
    const [pCB] = await proposalsBetween(b.tx.id, c.tx.id);
    assert(pCB && pCB.status === "auto_applied" && pCB.payload.duplicate === c.tx.id, `expected C→B auto-applied: ${JSON.stringify(pCB)}`);
    // Now a person applies B→A. C's document travels on to A with B's.
    const ap = await postJson(`/v1/batches/${pBA.batch_id}/reconcile/apply`, { proposal_ids: [pBA.id] });
    assert(ap.json.applied?.length === 1, `apply B→A: ${ap.body}`);
    assert((await linksOf(a.tx.id)).length === 3, "A should hold all three documents");

    // Inner first: refused, and the refusal names the outer proposal.
    const inner = await postJson(`/v1/batches/${pCB.batch_id}/reconcile/undo`, { proposal_ids: [pCB.id] });
    const why = String(inner.json.skipped?.[0]?.reason ?? "");
    assert(
      inner.json.reverted.length === 0 && why.startsWith("survivor_folded") && why.includes(pBA.id),
      `undo of the inner apply was not refused with a pointer: ${inner.body}`,
    );
    assert((await txState(c.tx.id)).deleted_at !== null, "refused undo still restored C");
    assert((await linksOf(a.tx.id)).length === 3, "refused undo still moved a document");

    // Newest first: exact.
    const outer = await postJson(`/v1/batches/${pBA.batch_id}/reconcile/undo`, { proposal_ids: [pBA.id] });
    assert(outer.json.reverted?.length === 1, `undo B→A: ${outer.body}`);
    const inner2 = await postJson(`/v1/batches/${pCB.batch_id}/reconcile/undo`, { proposal_ids: [pCB.id] });
    assert(inner2.json.reverted?.length === 1, `undo C→B after B→A: ${inner2.body}`);
    for (const [name, row] of [["A", a], ["B", b], ["C", c]] as const) {
      assert(isLive(await txState(row.tx.id)), `${name} is not live after both undos`);
      assert(
        (await linksOf(row.tx.id)).join() === row.docId,
        `${name} should hold exactly its own document, has [${(await linksOf(row.tx.id)).join(", ")}]`,
      );
    }
    notes.push("C→B then B→A: undo of C→B refused until B→A is undone; newest-first leaves A, B, C each with its own document");
  });

  // cd — a cascade delete between apply and undo. The apply moved the
  // duplicate's document onto the survivor; deleting that document with
  // cascade keeps the survivor, which still has its own. Undo must not
  // then bring the duplicate back with nothing live behind it.
  await runCase("cd", false, async (notes) => {
    for (const hard of [false, true]) {
      const mode = hard ? "hard" : "soft";
      const base = {
        payee: `Cascade Seam ${mode} ${NONCE}`,
        occurred_on: "2026-06-16",
        total_minor: amt(hard ? 28 : 27),
      };
      const first = await seedOne(base);
      const second = await seedOne(base);
      const [prop] = await proposalsBetween(first.tx.id, second.tx.id);
      assert(prop && prop.status === "proposed", `[${mode}] expected an open proposal to work with`);
      const dup = prop.payload.duplicate === first.tx.id ? first : second;
      const surv = dup === first ? second : first;
      assert(prop.payload.duplicate_of === surv.tx.id, `[${mode}] proposal does not name the pair`);
      const undoUrl = `/v1/batches/${prop.batch_id}/reconcile/undo`;

      const applied = await postJson(`/v1/batches/${prop.batch_id}/reconcile/apply`, { proposal_ids: [prop.id] });
      assert(applied.json.applied?.length === 1, `[${mode}] apply: ${applied.body}`);
      assert((await linksOf(surv.tx.id)).length === 2, `[${mode}] apply did not move the document`);

      // Delete the moved document, the way "Document + transaction" does.
      const del = await api(`/v1/documents/${dup.docId}?cascade=true${hard ? "&hard=true" : ""}`, { method: "DELETE" });
      assert(del.status === 200, `[${mode}] cascade delete → ${del.status}: ${del.body}`);
      assert(
        del.json.transactions_kept.join() === surv.tx.id &&
          del.json.transactions_soft_deleted.length === 0 &&
          del.json.transactions_hard_deleted.length === 0 &&
          del.json.transactions_skipped.length === 0,
        `[${mode}] cascade report should keep the survivor and name nothing else: ${del.body}`,
      );
      assert(isLive(await txState(surv.tx.id)), `[${mode}] cascade removed the survivor`);
      assert(
        (await linksOf(surv.tx.id)).join() === (hard ? [surv.docId] : [surv.docId, dup.docId].sort()).join(),
        `[${mode}] survivor's links after the cascade are wrong`,
      );

      // Undo: refused by name, and nothing moved.
      const undo = await postJson(undoUrl, { proposal_ids: [prop.id] });
      assert(undo.status === 200, `[${mode}] undo → ${undo.status}: ${undo.body}`);
      const reason = String(undo.json.skipped?.[0]?.reason ?? "");
      assert(
        undo.json.reverted.length === 0 && reason.startsWith("no_live_document"),
        `[${mode}] undo with no live document was not refused by name: ${undo.body}`,
      );
      assert((await txState(dup.tx.id)).deleted_at !== null, `[${mode}] undo restored a transaction with no live document`);
      assert((await linksOf(dup.tx.id)).length === 0, `[${mode}] refused undo still moved a link`);
      const [still] = await proposalsBetween(first.tx.id, second.tx.id);
      assert(still!.status === "user_applied", `[${mode}] refused undo left the proposal ${still!.status}`);

      if (hard) {
        // The file is gone for good: the refusal says so, and stands.
        assert(reason.includes("1 gone"), `[hard] reason should say the document is gone: ${reason}`);
        notes.push("apply → hard cascade of the moved document → undo refused (no_live_document, gone); duplicate stays deleted, survivor keeps its own document");
        continue;
      }
      // Soft: the document is a tombstone. Bring it back and undo works.
      assert(reason.includes("1 deleted"), `[soft] reason should say the document is deleted: ${reason}`);
      const restored = await api(`/v1/documents/${dup.docId}/restore`, { method: "POST" });
      assert(restored.status === 200, `[soft] document restore → ${restored.status}`);
      const again = await postJson(undoUrl, { proposal_ids: [prop.id] });
      assert(again.json.reverted?.length === 1, `[soft] undo after restoring the document: ${again.body}`);
      assert(isLive(await txState(dup.tx.id)), "[soft] duplicate was not restored");
      assert((await linksOf(dup.tx.id)).join() === dup.docId, "[soft] restored row is missing its document");
      assert((await linksOf(surv.tx.id)).join() === surv.docId, "[soft] survivor kept the moved document");
      notes.push("apply → soft cascade of the moved document → undo refused (no_live_document); restore the document → undo restores the row with it");
    }
  });

  // cs — the mirror image of cd: the cascade takes the SURVIVOR's own
  // document. The moved document keeps the survivor alive; undo must not
  // take it away and leave the survivor live with no live document.
  await runCase("cs", false, async (notes) => {
    for (const hard of [false, true]) {
      const mode = hard ? "hard" : "soft";
      const base = {
        payee: `Survivor Seam ${mode} ${NONCE}`,
        occurred_on: "2026-06-17",
        total_minor: amt(hard ? 30 : 29),
      };
      const first = await seedOne(base);
      const second = await seedOne(base);
      const [prop] = await proposalsBetween(first.tx.id, second.tx.id);
      assert(prop && prop.status === "proposed", `[${mode}] expected an open proposal to work with`);
      const dup = prop.payload.duplicate === first.tx.id ? first : second;
      const surv = dup === first ? second : first;
      const undoUrl = `/v1/batches/${prop.batch_id}/reconcile/undo`;

      const applied = await postJson(`/v1/batches/${prop.batch_id}/reconcile/apply`, { proposal_ids: [prop.id] });
      assert(applied.json.applied?.length === 1, `[${mode}] apply: ${applied.body}`);

      // Delete the survivor's own receipt, "Document + transaction".
      const del = await api(`/v1/documents/${surv.docId}?cascade=true${hard ? "&hard=true" : ""}`, { method: "DELETE" });
      assert(del.status === 200, `[${mode}] cascade delete → ${del.status}: ${del.body}`);
      assert(
        del.json.transactions_kept.join() === surv.tx.id,
        `[${mode}] the moved document should keep the survivor: ${del.body}`,
      );

      const undo = await postJson(undoUrl, { proposal_ids: [prop.id] });
      assert(undo.status === 200, `[${mode}] undo → ${undo.status}: ${undo.body}`);
      const reason = String(undo.json.skipped?.[0]?.reason ?? "");
      assert(
        undo.json.reverted.length === 0 && reason.startsWith("survivor_no_live_document"),
        `[${mode}] undo that would strip the survivor was not refused by name: ${undo.body}`,
      );
      assert(isLive(await txState(surv.tx.id)), `[${mode}] survivor is no longer live`);
      assert((await linksOf(surv.tx.id)).includes(dup.docId), `[${mode}] refused undo still took the moved document`);
      assert((await txState(dup.tx.id)).deleted_at !== null, `[${mode}] refused undo restored the duplicate`);
      const [still] = await proposalsBetween(first.tx.id, second.tx.id);
      assert(still!.status === "user_applied", `[${mode}] refused undo left the proposal ${still!.status}`);

      if (hard) {
        // The survivor's file is gone: delete the survivor, then undo.
        await softDeleteViaApi(surv.tx.id);
      } else {
        const restored = await api(`/v1/documents/${surv.docId}/restore`, { method: "POST" });
        assert(restored.status === 200, `[soft] document restore → ${restored.status}`);
      }
      const again = await postJson(undoUrl, { proposal_ids: [prop.id] });
      assert(again.json.reverted?.length === 1, `[${mode}] undo after settling the survivor: ${again.body}`);
      assert(isLive(await txState(dup.tx.id)), `[${mode}] duplicate was not restored`);
      assert((await linksOf(dup.tx.id)).join() === dup.docId, `[${mode}] restored row is missing its document`);
      if (hard) {
        assert((await txState(surv.tx.id)).deleted_at !== null, "[hard] the deleted survivor came back");
        notes.push("apply → hard cascade of the survivor's own document → undo refused (survivor_no_live_document); delete the survivor → undo restores the duplicate with its document");
      } else {
        assert((await linksOf(surv.tx.id)).join() === surv.docId, "[soft] survivor kept the moved document");
        notes.push("apply → soft cascade of the survivor's own document → undo refused (survivor_no_live_document); restore that document → undo gives each row its own");
      }
    }
  });

  // b2 — branch 2: re-encoded copy of an extracted receipt → attach
  let starbucks1Tx: string | null = null;
  await runCase("b2", true, async (notes) => {
    const seed = await postBatch([
      { name: "starbucks-1.jpg", bytes: await readFile(path.join(UPLOADS_DIR, STARBUCKS_1)), mime: "image/jpeg" },
    ]);
    await pollBatch(seed.batchId);
    const [seedIng] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`, [seed.ingestIds[0]]);
    assert(seedIng!.status === "done", `seed extraction: ${seedIng!.status}`);
    starbucks1Tx = seedIng!.produced.transaction_ids[0];
    notes.push(`seed txn ${String(starbucks1Tx).slice(0, 8)}… (branch-1 INSERT ✓)`);

    const copy = await postBatch([
      { name: "starbucks-1-copy.jpg", bytes: await reencode(STARBUCKS_1, 70), mime: "image/jpeg" },
    ]);
    await pollBatch(copy.batchId);
    const [ing] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`, [copy.ingestIds[0]]);
    assert(ing!.status === "near_dup", `expected near_dup, got ${ing!.status}`);
    assert(ing!.produced.transaction_ids[0] === starbucks1Tx, "pointer mismatch");
    const links = await q(`SELECT 1 FROM document_links WHERE transaction_id = $1`, [starbucks1Tx]);
    assert(links.length === 2, `expected 2 links, got ${links.length}`);
    notes.push("re-encoded copy attached; zero new transactions");
  });

  // b3 — branch 3: same app template, different purchase → INSERT distinct
  await runCase("b3", true, async (notes) => {
    const before = await q(`SELECT count(*)::int AS n FROM transactions WHERE payee ILIKE '%starbucks%' AND status='posted' AND deleted_at IS NULL`);
    const up = await postBatch([
      { name: "starbucks-2.jpg", bytes: await readFile(path.join(UPLOADS_DIR, STARBUCKS_2)), mime: "image/jpeg" },
    ]);
    await pollBatch(up.batchId);
    const [ing] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`, [up.ingestIds[0]]);
    assert(ing!.status === "done", `expected done (distinct INSERT), got ${ing!.status} — a near_dup here means pHash overrode the differing receipt numbers (calibration regression!)`);
    const after = await q(`SELECT count(*)::int AS n FROM transactions WHERE payee ILIKE '%starbucks%' AND status='posted' AND deleted_at IS NULL`);
    assert((after[0] as any).n === (before[0] as any).n + 1, "no new txn inserted");
    const [meta] = await q<{ check: any }>(
      `SELECT metadata->'near_dup_check' AS check FROM transactions WHERE id = $1`,
      [ing!.produced.transaction_ids[0]],
    );
    notes.push(
      meta?.check
        ? `near_dup_check recorded: ${JSON.stringify(meta.check).slice(0, 100)}`
        : "WARN: near_dup_check metadata absent (candidate may not have surfaced)",
    );
  });

  // b4 — branch 4: candidate but no strong tiebreaker → INSERT + flag; then review API round-trip
  await runCase("b4", true, async (notes) => {
    const date = "Wed, 03 Jun 2026 18:30:00 -0700";
    const e1 = makeEml({ merchant: `Corner Cafe ${NONCE.toUpperCase()}`, totalUsd: "4.50", dateLine: date, item: "Drip Coffee" });
    const u1 = await postBatch([e1]);
    await pollBatch(u1.batchId);
    const [i1] = await q<{ status: string }>(`SELECT status FROM ingests WHERE id = $1`, [u1.ingestIds[0]]);
    assert(i1!.status === "done", `first email: ${i1!.status}`);

    const e2 = makeEml({ merchant: `Corner Cafe ${NONCE.toUpperCase()}`, totalUsd: "4.50", dateLine: date, item: "Drip Coffee" });
    const u2 = await postBatch([e2]);
    await pollBatch(u2.batchId);
    const [i2] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`, [u2.ingestIds[0]]);
    assert(i2!.status === "done", `second email should INSERT (no strong tiebreaker), got ${i2!.status}`);
    const tx2 = i2!.produced.transaction_ids[0];
    const [m] = await q<{ flagged: boolean | null }>(
      `SELECT (metadata->'near_dup_check'->>'flagged_for_review')::boolean AS flagged FROM transactions WHERE id = $1`,
      [tx2],
    );
    assert(m!.flagged === true, `expected flagged_for_review=true, got ${m!.flagged}`);
    notes.push(`second txn flagged for review (${String(tx2).slice(0, 8)}…)`);

    // review API round-trip
    const list = await api(`/v1/transactions?flagged=near_dup&limit=50`);
    assert(list.status === 200, `flagged list → ${list.status}`);
    assert(
      (list.json.items ?? list.json.transactions ?? []).some((t: any) => t.id === tx2),
      "flagged list missing the txn",
    );
    const dismiss = await api(`/v1/transactions/${tx2}/near-dup-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });
    assert(dismiss.status === 200, `dismiss → ${dismiss.status}: ${dismiss.body}`);
    const list2 = await api(`/v1/transactions?flagged=near_dup&limit=50`);
    assert(
      !(list2.json.items ?? list2.json.transactions ?? []).some((t: any) => t.id === tx2),
      "txn still flagged after dismiss",
    );
    const ev = await q(
      `SELECT 1 FROM transaction_events WHERE transaction_id = $1 AND event_type = 'near_dup_reviewed'`,
      [tx2],
    );
    assert(ev.length === 1, "audit event missing");
    notes.push("flagged list → dismiss → unflagged round-trip ✓ (audit event written)");
  });

  // race — two byte-different copies in ONE batch → ledger converges to 1 live txn
  await runCase("race", true, async (notes) => {
    const up = await postBatch([
      { name: "race-a.jpg", bytes: await reencode(RACE_IMAGE, 70), mime: "image/jpeg" },
      { name: "race-b.jpg", bytes: await reencode(RACE_IMAGE, 64), mime: "image/jpeg" },
    ]);
    // two concurrent heavy extractions + icon pipeline legitimately exceed
    // 10 min; wait for reconcile too, since path B is repaired by it.
    await pollBatch(up.batchId, 1_200_000, RECONCILE_DONE);
    const ings = await q<{ status: string }>(
      `SELECT status FROM ingests WHERE batch_id = $1`, [up.batchId]);
    const statuses = ings.map((i) => i.status).sort();
    // Soft delete keeps status `posted`: a live count must filter deleted_at.
    const live = await q(
      `SELECT id FROM transactions WHERE payee ILIKE '%mitsuwa%' AND status = 'posted' AND deleted_at IS NULL`);
    notes.push(`ingest outcomes: [${statuses.join(", ")}]`);
    if (statuses.join(",") === "done,near_dup") {
      notes.push("path A: second extraction saw the first's txn → L3a attach");
    } else if (statuses.join(",") === "done,done") {
      notes.push("path B: both raced past L3a → the in-batch pass must repair (needs a shared identifier)");
    }
    assert(live.length === 1, `expected exactly 1 live Mitsuwa txn, got ${live.length} — the race left a duplicate the system did not repair`);
    notes.push("ledger converged to 1 live transaction ✓");
  });

  // ── summary ──────────────────────────────────────────────────────────
  console.log("\n# summary");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.pass) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await db.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("fatal:", err);
  try {
    await db.end();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
