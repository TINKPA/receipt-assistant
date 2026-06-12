/**
 * eval-dedup.ts — dedup-system regression matrix (#134/#135 hardening).
 *
 * Runs the full L1/L2/L3 dedup behavior matrix against the SANDBOX
 * stack (never production): decision-tree branches, worker guard
 * negative paths (via the stub extractor), the L3b reconcile edges,
 * the same-batch concurrency race, and the flagged-review API.
 *
 * Prereqs:
 *   - sandbox up: docker compose -p receipts-test -f docker-compose.test.yml up -d --build
 *   - sandbox RESET first (scripts/sandbox-reset.sh) for a clean matrix
 *   - EXTRACTOR_STUB_ALLOWED=1 in the sandbox env (compose.test sets it)
 *
 * Usage (from the repo root; macOS host — `sips` is used to re-encode):
 *   npx tsx scripts/eval-dedup.ts --base=http://100.84.82.96:3001 \
 *       --pg=postgresql://postgres:postgres@100.84.82.96:5433/receipts \
 *       [--only=g1,g2] [--with-claude]
 *
 * Stub cases (g*, r*) are deterministic and fast (seconds). Claude
 * cases (b*, race) each pay a real extraction (~2-4 min) and are
 * gated behind --with-claude. Run them after any eval-dates batch
 * finishes to avoid auth-pool contention.
 *
 * Case matrix:
 *   g1   near_dup claimed without a committed link  → worker forces error (#134 guard)
 *   g2   done with produced=[] but txn written      → #133 self-heal repairs produced
 *   g3   done with produced=[] and no txn           → worker forces error (#125 guard)
 *   r1   cross-batch order-number exact match       → 1.0 auto-void + evidence re-link (#135)
 *   r2   cross-batch card-last4 conflict            → no proposal (score < 0.5)
 *   r3   reconcile flip+re-run                      → no duplicate proposals (idempotency)
 *   b2   re-encoded copy of extracted receipt       → branch-2 attach (near_dup, no new txn)
 *   b3   same-app-template different purchase (d≈2) → branch-3 INSERT distinct (pHash never decides)
 *   b4   candidates but no strong tiebreaker        → branch-4 INSERT + flagged_for_review,
 *        then GET ?flagged=near_dup + dismiss endpoint round-trip
 *   race two byte-different copies in ONE batch     → ledger converges to 1 live txn
 *        (either L3a attach in-flight, or L3b in-batch auto-void repairs after)
 */
import "dotenv/config";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

// ── CLI ────────────────────────────────────────────────────────────────
function argOf(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
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
// against a dirty sandbox never cross-match a previous run's rows
// (fixed values would near-dup-match across runs and auto-void each
// other — observed before this existed). Claude cases (b2/b3/race) use
// real corpus images and DO require a reset sandbox.
const NONCE = randomUUID().slice(0, 6);

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
  return { status: res.status, json, body };
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

async function pollBatch(batchId: string, timeoutMs = 420_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const { json } = await api(`/v1/batches/${batchId}`);
    if (json && TERMINAL_BATCH.has(json.status)) return json;
    if (Date.now() - start > timeoutMs)
      throw new Error(`batch ${batchId} not terminal after ${timeoutMs}ms (status=${json?.status})`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

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
          total_minor: 1234,
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

  // r1 — cross-batch order-number exact → 1.0 auto-void + re-link (#135)
  let r1BatchB: string | null = null;
  await runCase("r1", false, async (notes) => {
    const seed = {
      payee: `EdgeMart ${NONCE}`,
      occurred_on: "2026-06-02",
      total_minor: 5555,
      metadata: { order_number: `ORD-EDGE-${NONCE}`, payment: "Visa ****1111" },
      link_document: true,
    };
    const a = await postBatch([
      stubFile({ write_transaction: seed, terminal: { status: "done", transaction_ids: ["$TX"] } }),
    ]);
    await pollBatch(a.batchId);
    const b = await postBatch([
      stubFile({ write_transaction: seed, terminal: { status: "done", transaction_ids: ["$TX"] } }),
    ]);
    await pollBatch(b.batchId);
    r1BatchB = b.batchId;
    const [txA] = await q<{ id: string; status: string }>(
      `SELECT id, status FROM transactions WHERE source_ingest_id = $1`,
      [a.ingestIds[0]],
    );
    const [txB] = await q<{ id: string; status: string }>(
      `SELECT id, status FROM transactions WHERE source_ingest_id = $1`,
      [b.ingestIds[0]],
    );
    assert(txA && txB, "seed txns missing");
    assert(txB!.status === "voided", `expected B voided, got ${txB!.status}`);
    assert(txA!.status === "posted", `expected A posted, got ${txA!.status}`);
    const links = await q(`SELECT document_id FROM document_links WHERE transaction_id = $1`, [txA!.id]);
    assert(links.length === 2, `expected 2 links on canonical, got ${links.length}`);
    const orphan = await q(`SELECT 1 FROM document_links WHERE transaction_id = $1`, [txB!.id]);
    assert(orphan.length === 0, "voided duplicate still owns links");
    // The 1.0 proposal may land in EITHER batch depending on which
    // side's fire-and-forget reconcile saw the pair first (A's can run
    // after B's txn commits). Either way the earlier txn must survive.
    const [prop] = await q<{ score: string; status: string }>(
      `SELECT score, status FROM reconcile_proposals
        WHERE batch_id IN ($1, $2) AND kind='dedup'
        ORDER BY score DESC LIMIT 1`,
      [a.batchId, b.batchId],
    );
    assert(prop && Number(prop.score) === 1 && prop.status === "auto_applied",
      `proposal: ${JSON.stringify(prop)}`);
    notes.push(`later txn auto-voided @1.0; earliest survives with both documents`);
  });

  // r2 — card-last4 conflict kills the pair → no proposal
  await runCase("r2", false, async (notes) => {
    const mk = (last4: string) => ({
      payee: `CardConflict Deli ${NONCE}`,
      occurred_on: "2026-06-03",
      total_minor: 2750,
      metadata: { payment: `Visa ****${last4}` },
      link_document: true,
    });
    const a = await postBatch([
      stubFile({ write_transaction: mk("1111"), terminal: { status: "done", transaction_ids: ["$TX"] } }),
    ]);
    await pollBatch(a.batchId);
    const b = await postBatch([
      stubFile({ write_transaction: mk("2222"), terminal: { status: "done", transaction_ids: ["$TX"] } }),
    ]);
    await pollBatch(b.batchId);
    // Assert specifically that the CONFLICT PAIR produced no proposal —
    // a dirty sandbox can legitimately propose B against unrelated
    // same-amount rows from earlier runs, which is correct behavior.
    const [txAr] = await q<{ id: string }>(
      `SELECT id FROM transactions WHERE source_ingest_id = $1`, [a.ingestIds[0]]);
    const [txBr] = await q<{ id: string }>(
      `SELECT id FROM transactions WHERE source_ingest_id = $1`, [b.ingestIds[0]]);
    const props = await q(
      `SELECT 1 FROM reconcile_proposals
        WHERE kind='dedup'
          AND ((payload->>'duplicate' = $1 AND payload->>'duplicate_of' = $2)
            OR (payload->>'duplicate' = $2 AND payload->>'duplicate_of' = $1))`,
      [txAr!.id, txBr!.id],
    );
    assert(props.length === 0, `conflict pair got ${props.length} proposal(s)`);
    const [txB] = await q<{ status: string }>(
      `SELECT status FROM transactions WHERE source_ingest_id = $1`,
      [b.ingestIds[0]],
    );
    assert(txB!.status === "posted", `B should stay posted, got ${txB!.status}`);
    notes.push("conflicting card last-4 → pair killed, both txns live");
  });

  // r3 — flip + re-run reconcile → no duplicate proposals
  await runCase("r3", false, async (notes) => {
    assert(r1BatchB, "r1 must run before r3");
    const before = await q(`SELECT count(*)::int AS n FROM reconcile_proposals WHERE batch_id = $1`, [r1BatchB]);
    await q(`UPDATE batches SET status = 'extracted' WHERE id = $1`, [r1BatchB]);
    const res = await api(`/v1/batches/${r1BatchB}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert(res.status === 200 || res.status === 201, `reconcile → ${res.status}`);
    const after = await q(`SELECT count(*)::int AS n FROM reconcile_proposals WHERE batch_id = $1`, [r1BatchB]);
    assert(
      (after[0] as any).n === (before[0] as any).n,
      `proposals duplicated: ${(before[0] as any).n} → ${(after[0] as any).n}`,
    );
    notes.push(`re-run minted 0 new proposals (${(after[0] as any).n} stable)`);
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
    const before = await q(`SELECT count(*)::int AS n FROM transactions WHERE payee ILIKE '%starbucks%' AND status='posted'`);
    const up = await postBatch([
      { name: "starbucks-2.jpg", bytes: await readFile(path.join(UPLOADS_DIR, STARBUCKS_2)), mime: "image/jpeg" },
    ]);
    await pollBatch(up.batchId);
    const [ing] = await q<{ status: string; produced: any }>(
      `SELECT status, produced FROM ingests WHERE id = $1`, [up.ingestIds[0]]);
    assert(ing!.status === "done", `expected done (distinct INSERT), got ${ing!.status} — a near_dup here means pHash overrode the differing receipt numbers (calibration regression!)`);
    const after = await q(`SELECT count(*)::int AS n FROM transactions WHERE payee ILIKE '%starbucks%' AND status='posted'`);
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
    await pollBatch(up.batchId, 1_200_000); // two concurrent heavy extractions + icon pipeline legitimately exceed 10 min
    const ings = await q<{ status: string }>(
      `SELECT status FROM ingests WHERE batch_id = $1`, [up.batchId]);
    const statuses = ings.map((i) => i.status).sort();
    const live = await q(
      `SELECT id FROM transactions WHERE payee ILIKE '%mitsuwa%' AND status = 'posted'`);
    notes.push(`ingest outcomes: [${statuses.join(", ")}]`);
    if (statuses.join(",") === "done,near_dup") {
      notes.push("path A: second extraction saw the first's txn → L3a attach");
    } else if (statuses.join(",") === "done,done") {
      notes.push("path B: both raced past L3a → in-batch L3b exact pass must repair");
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
