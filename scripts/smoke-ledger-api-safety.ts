/**
 * smoke-ledger-api-safety.ts — real HTTP requests proving that an
 * ordinary API call cannot silently destroy ledger data.
 *
 * Four groups, each building its own fixtures through the public API:
 *
 *   A  PATCH /v1/transactions/:id treats `metadata` as a JSON Merge Patch
 *      (RFC 7396): the exact body the web client's Edit modal sends
 *      (`{"metadata":{}, …}`) leaves metadata intact, nested objects
 *      merge, `null` removes, and server-owned keys cannot be changed.
 *   B  DELETE /v1/documents/:id?cascade=true only deletes a transaction
 *      when that document is its last live evidence.
 *   C  Posting mutations refuse a reconciled or soft-deleted transaction
 *      and keep `amount_minor` / `amount_base_minor` consistent; two
 *      PATCHes with the same If-Match cannot both win.
 *   D  Account routes: merge-patch body parsing, metadata merge, cycle
 *      rejection, base-currency balance labelling, register running
 *      balance across a `from` filter.
 *
 * It WRITES: transactions, documents and accounts named `smoke-<nonce>`
 * are created and left behind (deleted or closed where the API allows).
 * Point it at a sandbox or a throwaway copy, never at production — it
 * refuses port 3000, and both arguments are required so nothing is
 * reached by default.
 *
 *   npx tsx scripts/smoke-ledger-api-safety.ts \
 *     --base=http://127.0.0.1:<port> \
 *     --pg=postgresql://postgres:postgres@127.0.0.1:<pgport>/receipts
 *
 * `--pg` is read-only here: it is used to look at `transaction_events`,
 * which has no API. Exit code 0 = every check passed.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

// ── CLI ────────────────────────────────────────────────────────────────
function argOf(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const BASE = argOf("base");
const PG_URL = argOf("pg");
if (!BASE || !PG_URL) {
  console.error("usage: smoke-ledger-api-safety.ts --base=<server url> --pg=<postgres url>");
  process.exit(2);
}
if (new URL(BASE).port === "3000") {
  console.error("Refusing to run against port 3000 (production). This script writes fixtures.");
  process.exit(2);
}

const NONCE = randomUUID().slice(0, 8);
const db = new pg.Client({ connectionString: PG_URL });

// ── helpers ────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

interface ApiResult {
  status: number;
  json: any;
  etag: string | null;
}

async function api(
  method: string,
  pathname: string,
  opts: { body?: unknown; headers?: Record<string, string>; form?: FormData } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty or non-JSON body */
  }
  return { status: res.status, json, etag: res.headers.get("etag") };
}

const MERGE = { "Content-Type": "application/merge-patch+json" };
const etagOf = (version: number): string => `W/"${version}"`;

async function getTx(id: string): Promise<any> {
  const r = await api("GET", `/v1/transactions/${id}`);
  if (r.status !== 200) throw new Error(`GET transaction ${id} → ${r.status}`);
  return r.json;
}

async function patchTx(
  id: string,
  version: number,
  body: unknown,
  headers: Record<string, string> = MERGE,
): Promise<ApiResult> {
  return api("PATCH", `/v1/transactions/${id}`, {
    body,
    headers: { ...headers, "If-Match": etagOf(version) },
  });
}

let expenseAccountId = "";
let fundingAccountId = "";

async function createTx(opts: {
  amount?: number;
  status?: "posted" | "draft";
  occurredOn?: string;
  metadata?: Record<string, unknown>;
  documentIds?: string[];
  debitAccountId?: string;
  label: string;
}): Promise<any> {
  const amount = opts.amount ?? 1000;
  const r = await api("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      occurred_on: opts.occurredOn ?? "2026-01-15",
      payee: `smoke-${NONCE} ${opts.label}`,
      status: opts.status ?? "posted",
      postings: [
        { account_id: opts.debitAccountId ?? expenseAccountId, amount_minor: amount },
        { account_id: fundingAccountId, amount_minor: -amount },
      ],
      ...(opts.documentIds ? { document_ids: opts.documentIds } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
  });
  if (r.status !== 201) {
    throw new Error(`createTx(${opts.label}) → ${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json;
}

async function uploadDoc(label: string): Promise<string> {
  const form = new FormData();
  // Unique bytes per call: the upload path dedups on sha256.
  form.append(
    "file",
    new Blob([`smoke-${NONCE} ${label} ${randomUUID()}\n`], { type: "text/plain" }),
    `smoke-${NONCE}-${label}.txt`,
  );
  form.append("kind", "other");
  const r = await api("POST", "/v1/documents", { form });
  if (r.status !== 201) throw new Error(`uploadDoc(${label}) → ${r.status}`);
  return r.json.id as string;
}

async function events(txId: string, eventType: string): Promise<any[]> {
  // `payload->>'transaction_id'` also finds events of a hard-deleted row,
  // whose `transaction_id` column the FK has nulled.
  const res = await db.query(
    `SELECT transaction_id, payload
       FROM transaction_events
      WHERE event_type = $1
        AND (transaction_id = $2::uuid OR payload->>'transaction_id' = $3::text)
      ORDER BY created_at`,
    [eventType, txId, txId],
  );
  return res.rows;
}

// ── A. metadata merge patch ────────────────────────────────────────────
async function groupMetadata(): Promise<void> {
  console.log("\nA. PATCH /v1/transactions/:id — metadata is a merge patch");
  const seedMeta = {
    source: "smoke",
    order_number: `SMK-${NONCE}`,
    extraction: { prompt_version: "0.0", model: "smoke", source: "ingest" },
    fx: { base_currency: "USD", rates: [] },
    merge_audit: [{ reason: "seed" }],
    // Nulls nested inside values, as real extraction output has them
    // (inside `ocr_audit` and `items` on most rows). A strict RFC 7396
    // echo would strip these; step 6b checks that it does not.
    ocr_audit: { note: null, fields: [{ name: "total", corrected: null }] },
    payment: { tip: null, card: "visa" },
    nested: { keep: 1, drop: 2, deep: { x: 1 } },
  };
  const created = await createTx({ label: "metadata", metadata: seedMeta });
  const id = created.id as string;
  check("fixture keeps the metadata it was created with", same(created.metadata, seedMeta));

  // 1. The exact body the web client's Edit modal sends.
  let r = await patchTx(id, created.version, { metadata: {}, payee: `smoke-${NONCE} renamed` });
  check("web-client save (metadata:{} + payee) → 200", r.status === 200, r.json);
  let tx = await getTx(id);
  check(
    "…metadata intact apart from user_edited",
    same(tx.metadata, { ...seedMeta, user_edited: { payee: true } }),
    tx.metadata,
  );
  check("…payee changed", tx.payee === `smoke-${NONCE} renamed`);

  // 2. Narration-only save, sent as application/json.
  r = await patchTx(id, tx.version, { metadata: {}, narration: "note" }, {});
  tx = await getTx(id);
  check(
    "narration-only save as application/json leaves metadata untouched",
    r.status === 200 && same(tx.metadata, { ...seedMeta, user_edited: { payee: true } }),
    tx.metadata,
  );

  // 3. metadata:{} alone is a no-op.
  const v3 = tx.version;
  r = await patchTx(id, v3, { metadata: {} });
  tx = await getTx(id);
  check("metadata:{} alone → 200, version not bumped", r.status === 200 && tx.version === v3);

  // 4. Recursive merge, null removes, unnamed keys survive.
  r = await patchTx(id, tx.version, {
    metadata: { nested: { drop: null, deep: { y: 2 } }, added: "v", order_number: `SMK-${NONCE}-b` },
  });
  tx = await getTx(id);
  check(
    "nested merge + null removal + scalar replace",
    r.status === 200 &&
      same(tx.metadata, {
        ...seedMeta,
        order_number: `SMK-${NONCE}-b`,
        nested: { keep: 1, deep: { x: 1, y: 2 } },
        added: "v",
        user_edited: { payee: true },
      }),
    tx.metadata,
  );
  r = await patchTx(id, tx.version, { metadata: { added: null } });
  tx = await getTx(id);
  check("top-level null removes the key", r.status === 200 && !("added" in tx.metadata));

  // 5. Server-owned keys cannot be changed or removed.
  const before = tx;
  const refused: Array<[string, unknown]> = [
    ["extraction", null],
    ["extraction", { prompt_version: "9.9" }],
    ["user_edited", { payee: null }],
    ["user_edited", { occurred_on: true }],
    ["fx", { base_currency: "EUR" }],
    ["merge_audit", []],
    ["source", "forged"],
    ["items", [{ raw_name: "forged" }]],
    ["near_dup_check", { flagged_for_review: false }],
    // Removing a null-valued member is still a change to the key.
    ["ocr_audit", { note: null }],
  ];
  for (const [key, value] of refused) {
    r = await patchTx(id, before.version, { metadata: { [key]: value }, narration: "must not apply" });
    const violation = (r.json?.violations ?? []).find(
      (v: any) => v.path === `metadata.${key}` && v.code === "server_owned",
    );
    check(
      `patch of server-owned metadata.${key} = ${JSON.stringify(value)} → 422`,
      r.status === 422 && Boolean(violation),
      { status: r.status, body: r.json },
    );
  }
  tx = await getTx(id);
  check(
    "…and nothing was written by the refused patches",
    tx.version === before.version && same(tx.metadata, before.metadata) && tx.narration === "note",
  );

  // 6. Echoing a server-owned key with its current value is a no-op.
  r = await patchTx(id, tx.version, {
    metadata: { source: "smoke", extraction: { prompt_version: "0.0" }, user_edited: { payee: true } },
  });
  const afterEcho = await getTx(id);
  check(
    "echoing current server-owned values → 200, version not bumped",
    r.status === 200 && afterEcho.version === tx.version,
    { status: r.status, body: r.json },
  );

  // 6b. Read-modify-write: GET the object, add a key, PATCH it all back.
  // Scripts have backfilled keys this way; the echoed server-owned keys
  // are unchanged, so the patch is accepted and only the new key lands.
  r = await patchTx(id, afterEcho.version, {
    metadata: { ...afterEcho.metadata, flow: "purchase" },
  });
  const afterRmw = await getTx(id);
  check(
    "read-modify-write of the whole object adds a key and keeps the rest",
    r.status === 200 && same(afterRmw.metadata, { ...afterEcho.metadata, flow: "purchase" }),
    { status: r.status, body: r.json },
  );
  check(
    "…including the nulls nested inside echoed values",
    afterRmw.metadata.payment.tip === null &&
      "tip" in afterRmw.metadata.payment &&
      afterRmw.metadata.ocr_audit.fields[0].corrected === null &&
      "note" in afterRmw.metadata.ocr_audit,
    { payment: afterRmw.metadata.payment, ocr_audit: afterRmw.metadata.ocr_audit },
  );
  r = await patchTx(id, afterRmw.version, { metadata: { flow: null } });
  check("…and the key can be removed again", r.status === 200 && same(r.json.metadata, afterEcho.metadata));
  r = await patchTx(id, r.json.version, { metadata: { payment: { tip: null } } });
  check(
    "an explicit nested null still removes a stored null",
    r.status === 200 && same(r.json.metadata.payment, { card: "visa" }),
    r.json?.metadata?.payment,
  );
  afterEcho.metadata = r.json.metadata;
  afterEcho.version = r.json.version;

  // 7. The same patch through the bulk endpoint.
  r = await api("POST", "/v1/transactions/bulk", {
    body: {
      operations: [
        { op: "update", id, if_match: etagOf(afterEcho.version), patch: { metadata: {}, narration: "bulk" } },
      ],
    },
  });
  tx = await getTx(id);
  check(
    "bulk update with metadata:{} leaves metadata intact",
    r.status === 200 && r.json.results[0].status === 200 && same(tx.metadata, afterEcho.metadata) && tx.narration === "bulk",
    r.json,
  );

  // 8. The audit trail has both sides of what moved, and only that.
  const updated = await events(id, "updated");
  const first = updated[0]?.payload;
  check(
    "first `updated` event records old and new payee + the metadata keys that moved",
    Boolean(first) &&
      first.old.payee === `smoke-${NONCE} metadata` &&
      first.new.payee === `smoke-${NONCE} renamed` &&
      same(first.old.metadata, {}) &&
      same(first.new.metadata, { user_edited: { payee: true } }),
    first,
  );
  const merge = updated.find((e) => e.payload?.new?.metadata?.added === "v")?.payload;
  check(
    "merge event records old and new values of exactly the changed keys",
    Boolean(merge) &&
      same(merge.old.metadata, { order_number: `SMK-${NONCE}`, nested: seedMeta.nested }) &&
      same(merge.new.metadata, {
        order_number: `SMK-${NONCE}-b`,
        nested: { keep: 1, deep: { x: 1, y: 2 } },
        added: "v",
      }),
    merge,
  );
  // 8 writes above: payee, narration, merge, key removal, flow added,
  // flow removed, nested null removed, bulk. The no-op, the echo and the
  // refusals wrote none.
  check("no event was written for the no-op or refused patches", updated.length === 8, updated.length);

  await api("DELETE", `/v1/transactions/${id}`, { headers: { "If-Match": etagOf(tx.version) } });
}

// ── B. cascade document delete ─────────────────────────────────────────
async function groupCascade(): Promise<void> {
  console.log("\nB. DELETE /v1/documents/:id?cascade=true — last live evidence only");

  // Soft.
  const [d1, d2] = [await uploadDoc("b-soft-1"), await uploadDoc("b-soft-2")];
  const t1 = await createTx({ label: "cascade soft", documentIds: [d1, d2] });
  let r = await api("DELETE", `/v1/documents/${d1}?cascade=true`);
  let tx = await getTx(t1.id);
  check(
    "soft cascade of 1 of 2 documents → 204, transaction still live",
    r.status === 204 && tx.deleted_at === null,
    { status: r.status, deleted_at: tx.deleted_at },
  );
  check(
    "…the document is tombstoned and still linked (restorable association)",
    tx.documents.length === 2 &&
      tx.documents.find((d: any) => d.id === d1)?.deleted_at !== null &&
      tx.documents.find((d: any) => d.id === d2)?.deleted_at === null,
    tx.documents,
  );
  check("…and the transaction was not written to", tx.version === t1.version);
  r = await api("DELETE", `/v1/documents/${d2}?cascade=true`);
  tx = await getTx(t1.id);
  check(
    "soft cascade of the last live document → transaction soft-deleted",
    r.status === 204 && tx.deleted_at !== null,
  );

  // Hard.
  const [d3, d4] = [await uploadDoc("b-hard-1"), await uploadDoc("b-hard-2")];
  const t2 = await createTx({ label: "cascade hard", documentIds: [d3, d4] });
  r = await api("DELETE", `/v1/documents/${d3}?cascade=true&hard=true`);
  tx = await getTx(t2.id);
  check(
    "hard cascade of 1 of 2 documents → 204, transaction survives with the other",
    r.status === 204 && tx.deleted_at === null && tx.documents.length === 1 && tx.documents[0].id === d4,
    tx.documents,
  );
  check("…postings untouched", tx.postings.length === 2);
  const gone = await api("GET", `/v1/documents/${d3}?include_deleted=true`);
  check("…the document row is gone", gone.status === 404);
  const unlinked = await events(t2.id, "document_unlinked");
  check(
    "…and a document_unlinked event names the document",
    unlinked.length === 1 && unlinked[0].payload.document_id === d3,
    unlinked,
  );
  r = await api("DELETE", `/v1/documents/${d4}?cascade=true&hard=true`);
  const t2gone = await api("GET", `/v1/transactions/${t2.id}`);
  check("hard cascade of the last document → transaction hard-deleted", r.status === 204 && t2gone.status === 404);
  const hardDeleted = await events(t2.id, "hard_deleted");
  check(
    "…its hard_deleted event carries transaction_id in the payload (column is NULL)",
    hardDeleted.length === 1 &&
      hardDeleted[0].transaction_id === null &&
      hardDeleted[0].payload.transaction_id === t2.id &&
      hardDeleted[0].payload.document_id === d4,
    hardDeleted,
  );

  // Draft → hard-deleted even in soft mode; same payload rule.
  const d5 = await uploadDoc("b-draft");
  const t3 = await createTx({ label: "cascade draft", status: "draft", documentIds: [d5] });
  r = await api("DELETE", `/v1/documents/${d5}?cascade=true`);
  const draftEvents = await events(t3.id, "hard_deleted");
  check(
    "soft cascade hard-deletes a draft; event payload carries transaction_id",
    r.status === 204 && draftEvents.length === 1 && draftEvents[0].payload.transaction_id === t3.id,
    draftEvents,
  );

  // Reconciled: blocks only when it would be deleted.
  const [d6, d7] = [await uploadDoc("b-rec-1"), await uploadDoc("b-rec-2")];
  const t4 = await createTx({ label: "cascade reconciled", documentIds: [d6, d7] });
  r = await api("POST", `/v1/transactions/${t4.id}/reconcile`, { headers: { "If-Match": etagOf(t4.version) } });
  check("fixture reconciled", r.status === 200 && r.json.status === "reconciled", r.json);
  r = await api("DELETE", `/v1/documents/${d6}?cascade=true`);
  check("cascade that keeps a reconciled transaction is allowed", r.status === 204, r.json);
  r = await api("DELETE", `/v1/documents/${d7}?cascade=true`);
  tx = await getTx(t4.id);
  const d7row = await api("GET", `/v1/documents/${d7}`);
  check(
    "cascade that would delete a reconciled transaction → 409, no writes",
    r.status === 409 &&
      String(r.json?.type).endsWith("/cascade-blocked-reconciled") &&
      tx.deleted_at === null &&
      tx.status === "reconciled" &&
      d7row.status === 200,
    { status: r.status, body: r.json },
  );
  // Tidy: take the reconciled fixture back out of the ledger.
  r = await api("POST", `/v1/transactions/${t4.id}/unreconcile`, {
    body: {},
    headers: { "If-Match": etagOf(tx.version) },
  });
  await api("DELETE", `/v1/transactions/${t4.id}`, { headers: { "If-Match": etagOf(r.json.version) } });
}

// ── C. posting mutations ───────────────────────────────────────────────
async function groupPostings(): Promise<void> {
  console.log("\nC. Posting mutations — state guards and amount consistency");
  // Always the debit leg, found by sign: the two legs share a created_at,
  // so their order in the response is not stable across reads.
  const postingUrl = (tx: any): string =>
    `/v1/transactions/${tx.id}/postings/${tx.postings.find((p: any) => p.amount_minor > 0).id}`;

  // Create-time rule.
  let r = await api("POST", "/v1/transactions", {
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      occurred_on: "2026-01-15",
      payee: `smoke-${NONCE} mismatch`,
      postings: [
        { account_id: expenseAccountId, amount_minor: 1000, amount_base_minor: 900 },
        { account_id: fundingAccountId, amount_minor: -1000, amount_base_minor: -900 },
      ],
    },
  });
  check(
    "create: base-currency posting with a different amount_base_minor → 422",
    r.status === 422 && r.json.violations?.[0]?.code === "mismatch",
    r.json,
  );

  // A draft bypasses the balance trigger, so one leg can move alone.
  let draft = await createTx({ label: "posting draft", status: "draft" });
  r = await api("PATCH", postingUrl(draft), {
    body: { amount_minor: 1500 },
    headers: { "If-Match": etagOf(draft.version) },
  });
  check(
    "update: base-currency amount_minor moves amount_base_minor with it",
    r.status === 200 && r.json.amount_minor === 1500 && r.json.amount_base_minor === 1500 && r.json.fx_rate === null,
    r.json,
  );
  draft = await getTx(draft.id);
  const attempt = async (name: string, body: unknown, code: string): Promise<void> => {
    const res = await api("PATCH", postingUrl(draft), {
      body,
      headers: { "If-Match": etagOf(draft.version) },
    });
    check(
      `update: ${name} → 422 ${code}`,
      res.status === 422 && (res.json.violations ?? []).some((v: any) => v.code === code),
      { status: res.status, body: res.json },
    );
  };
  await attempt("base-currency amount_base_minor that disagrees", { amount_base_minor: 999 }, "mismatch");
  await attempt("currency change without fx_rate + amount_base_minor", { currency: "EUR" }, "required");
  await attempt("fx_rate without amount_base_minor", { currency: "EUR", fx_rate: "1.1" }, "required");
  await attempt("non-numeric fx_rate", { currency: "EUR", fx_rate: "abc", amount_base_minor: 1650 }, "invalid");
  await attempt("opposite-sign base amount", { currency: "EUR", fx_rate: "1.1", amount_base_minor: -1650 }, "sign_mismatch");
  await attempt("account outside the workspace", { account_id: randomUUID() }, "not_found");
  const unchanged = await getTx(draft.id);
  check("…none of the refused patches wrote anything", unchanged.version === draft.version);

  r = await api("PATCH", postingUrl(draft), {
    body: { currency: "EUR", fx_rate: "1.1", amount_base_minor: 1650 },
    headers: { "If-Match": etagOf(draft.version) },
  });
  check(
    "update: foreign posting with the full pair → 200",
    r.status === 200 && r.json.currency === "EUR" && r.json.amount_base_minor === 1650 && Number(r.json.fx_rate) === 1.1,
    r.json,
  );
  draft = await getTx(draft.id);
  await attempt("foreign amount_minor alone (base would go stale)", { amount_minor: 3000 }, "required");
  r = await api("PATCH", postingUrl(draft), {
    body: { memo: "memo only" },
    headers: { "If-Match": etagOf(draft.version) },
  });
  check(
    "update: memo-only patch leaves the amounts alone",
    r.status === 200 && r.json.memo === "memo only" && r.json.amount_minor === 1500 && r.json.amount_base_minor === 1650,
    r.json,
  );
  draft = await getTx(draft.id);
  r = await api("PATCH", postingUrl(draft), { body: {}, headers: { "If-Match": etagOf(draft.version) } });
  const afterEmpty = await getTx(draft.id);
  check("update: empty patch → 200, version not bumped", r.status === 200 && afterEmpty.version === draft.version);

  // Add + remove, and what the events remember.
  r = await api("POST", `/v1/transactions/${draft.id}/postings`, {
    body: { account_id: expenseAccountId, amount_minor: 777, memo: "third leg" },
    headers: { "If-Match": etagOf(draft.version) },
  });
  check("add: base-currency posting gets amount_base_minor = amount_minor", r.status === 201 && r.json.amount_base_minor === 777, r.json);
  const thirdId = r.json.id as string;
  draft = await getTx(draft.id);
  r = await api("DELETE", `/v1/transactions/${draft.id}/postings/${thirdId}`, {
    headers: { "If-Match": etagOf(draft.version) },
  });
  const removed = await events(draft.id, "posting_removed");
  check(
    "remove: posting_removed event keeps the removed posting's values",
    r.status === 204 && removed[0]?.payload.old?.amount_minor === 777 && removed[0]?.payload.old?.memo === "third leg",
    removed,
  );
  const updatedEvents = await events(draft.id, "posting_updated");
  check(
    "posting_updated events carry old and new values of the changed fields",
    same(updatedEvents[0]?.payload.old, { amount_minor: 1000, amount_base_minor: 1000 }) &&
      same(updatedEvents[0]?.payload.new, { amount_minor: 1500, amount_base_minor: 1500 }),
    updatedEvents[0]?.payload,
  );
  draft = await getTx(draft.id);
  await api("DELETE", `/v1/transactions/${draft.id}?hard=true`, { headers: { "If-Match": etagOf(draft.version) } });

  // State guards.
  let posted = await createTx({ label: "posting guards" });
  r = await api("POST", `/v1/transactions/${posted.id}/reconcile`, { headers: { "If-Match": etagOf(posted.version) } });
  posted = r.json;
  const guard = async (state: string, slug: string): Promise<void> => {
    const ifMatch = { "If-Match": etagOf(posted.version) };
    const upd = await api("PATCH", postingUrl(posted), { body: { memo: "x" }, headers: ifMatch });
    const add = await api("POST", `/v1/transactions/${posted.id}/postings`, {
      body: { account_id: expenseAccountId, amount_minor: 1 },
      headers: ifMatch,
    });
    const del = await api("DELETE", postingUrl(posted), { headers: ifMatch });
    check(
      `${state} transaction: update / add / delete posting → 409 ${slug}`,
      // `json.status` too: the problem body must carry the numeric HTTP
      // status, not the transaction's status string.
      [upd, add, del].every(
        (x) => x.status === 409 && x.json?.status === 409 && String(x.json?.type).endsWith(`/${slug}`),
      ),
      [upd.json, add.json, del.json],
    );
  };
  await guard("reconciled", "transaction-reconciled");
  r = await api("POST", `/v1/transactions/${posted.id}/unreconcile`, {
    body: {},
    headers: { "If-Match": etagOf(posted.version) },
  });
  posted = r.json;
  r = await api("DELETE", `/v1/transactions/${posted.id}`, { headers: { "If-Match": etagOf(posted.version) } });
  posted = await getTx(posted.id);
  await guard("soft-deleted", "transaction-deleted");
  const still = await getTx(posted.id);
  check("…and the guarded transaction's postings are unchanged", same(still.postings, posted.postings));

  // The two mutations whose write and audit event used to be separate
  // autocommitted statements.
  const itemsTx = await createTx({
    label: "items",
    metadata: { near_dup_check: { verdict: "uncertain", flagged_for_review: true } },
  });
  const line = { line_no: 1, raw_name: "smoke line", line_total_minor: 1000, item_class: "other" };
  r = await api("POST", `/v1/transactions/${itemsTx.id}/items`, { body: { items: [line] } });
  const dup = await api("POST", `/v1/transactions/${itemsTx.id}/items`, { body: { items: [line] } });
  const itemEvents = await events(itemsTx.id, "items_added");
  check(
    "items: add → 201 with one items_added event; repeat line_no → 409 and no second event",
    r.status === 201 && dup.status === 409 && itemEvents.length === 1,
    { first: r.status, repeat: dup.status, events: itemEvents.length },
  );
  r = await api("POST", `/v1/transactions/${itemsTx.id}/near-dup-review`, { body: { action: "dismiss" } });
  const again = await api("POST", `/v1/transactions/${itemsTx.id}/near-dup-review`, { body: { action: "dismiss" } });
  const reviewed = await getTx(itemsTx.id);
  const reviewEvents = await events(itemsTx.id, "near_dup_reviewed");
  check(
    "near-dup dismiss: flag cleared with one event; second dismiss → 404",
    r.status === 200 &&
      again.status === 404 &&
      reviewed.metadata.near_dup_check.flagged_for_review === false &&
      reviewed.metadata.near_dup_check.verdict === "uncertain" &&
      reviewEvents.length === 1,
    { first: r.status, repeat: again.status, meta: reviewed.metadata.near_dup_check },
  );
  await api("DELETE", `/v1/transactions/${itemsTx.id}`, { headers: { "If-Match": etagOf(reviewed.version) } });

  // Optimistic concurrency: same If-Match twice, in parallel.
  const racer = await createTx({ label: "race" });
  const results = await Promise.all(
    ["one", "two", "three", "four"].map((n) => patchTx(racer.id, racer.version, { narration: n })),
  );
  const statuses = results.map((x) => x.status).sort();
  check(
    "4 concurrent PATCHes with the same If-Match → exactly one 200, the rest 412",
    same(statuses, [200, 412, 412, 412]),
    statuses,
  );
  const afterRace = await getTx(racer.id);
  check("…and the version moved exactly once", afterRace.version === racer.version + 1, afterRace.version);
  await api("DELETE", `/v1/transactions/${racer.id}`, { headers: { "If-Match": etagOf(afterRace.version) } });
}

// ── D. account routes ──────────────────────────────────────────────────
async function groupAccounts(baseCurrency: string): Promise<void> {
  console.log("\nD. Account routes");
  const mk = async (name: string, extra: Record<string, unknown> = {}): Promise<any> => {
    const r = await api("POST", "/v1/accounts", {
      body: { name: `smoke-${NONCE} ${name}`, type: "asset", ...extra },
    });
    if (r.status !== 201) throw new Error(`create account ${name} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const parent = await mk("parent");
  let child = await mk("child", { parent_id: parent.id, metadata: { k1: 1, k2: 2 } });
  const grandchild = await mk("grandchild", { parent_id: child.id });

  let r = await api("PATCH", `/v1/accounts/${child.id}`, {
    body: { subtype: "smoke", metadata: { k2: null, k3: 3 } },
    headers: { ...MERGE, "If-Match": etagOf(child.version) },
  });
  check(
    "PATCH as application/merge-patch+json is parsed (subtype applied)",
    r.status === 200 && r.json.subtype === "smoke",
    r.json,
  );
  check("…and account metadata merges instead of being replaced", same(r.json.metadata, { k1: 1, k3: 3 }), r.json?.metadata);
  child = r.json;
  r = await api("PATCH", `/v1/accounts/${child.id}`, {
    body: { metadata: {} },
    headers: { ...MERGE, "If-Match": etagOf(child.version) },
  });
  check("account metadata:{} changes nothing", r.status === 200 && same(r.json.metadata, { k1: 1, k3: 3 }));
  child = r.json;

  r = await api("PATCH", `/v1/accounts/${parent.id}`, {
    body: { parent_id: grandchild.id },
    headers: { "If-Match": etagOf(parent.version) },
  });
  check(
    "re-parenting an account under its own descendant → 422 cycle",
    r.status === 422 && r.json.violations?.[0]?.code === "cycle",
    r.json,
  );

  // Balance + register on a fresh account with two dated postings.
  const reg = await mk("register");
  const regTxns = [
    await createTx({ label: "reg 1", amount: 100, occurredOn: "2026-02-01", debitAccountId: reg.id }),
    await createTx({ label: "reg 2", amount: 250, occurredOn: "2026-03-01", debitAccountId: reg.id }),
  ];
  r = await api("GET", `/v1/accounts/${reg.id}/balance?as_of=2026-12-31`);
  check(
    "balance is labelled with the workspace base currency",
    r.status === 200 && r.json.balance_minor === 350 && r.json.currency === baseCurrency,
    r.json,
  );
  const other = baseCurrency === "EUR" ? "JPY" : "EUR";
  r = await api("GET", `/v1/accounts/${reg.id}/balance?currency=${other}`);
  check(`balance in ${other} (no conversion exists) → 422`, r.status === 422, r.json);
  r = await api("GET", `/v1/accounts/${reg.id}/balance?currency=${baseCurrency}`);
  check(`balance with currency=${baseCurrency} still works`, r.status === 200, r.json);
  r = await api("GET", `/v1/accounts/${parent.id}/balance?include_children=true`);
  check("subtree balance still resolves", r.status === 200 && r.json.includes_children === true, r.json);

  r = await api("GET", `/v1/accounts/${reg.id}/register?from=2026-03-01`);
  check(
    "register with `from` shows 1 row whose running balance includes earlier postings",
    r.status === 200 && r.json.items.length === 1 && r.json.items[0].running_balance_after_minor === 350,
    r.json?.items?.map((i: any) => i.running_balance_after_minor),
  );
  r = await api("GET", `/v1/accounts/${reg.id}/register`);
  check(
    "register without `from` is unchanged (350 then 100)",
    same(r.json.items.map((i: any) => i.running_balance_after_minor), [350, 100]),
    r.json?.items?.map((i: any) => i.running_balance_after_minor),
  );

  // Tidy: the two register fixtures leave the ledger, and the fixture
  // accounts are closed so they drop out of pickers.
  for (const t of regTxns) {
    await api("DELETE", `/v1/transactions/${t.id}`, { headers: { "If-Match": etagOf(t.version) } });
  }
  for (const a of [grandchild, child, parent, reg]) {
    const cur = await api("GET", `/v1/accounts/${a.id}`);
    await api("PATCH", `/v1/accounts/${a.id}`, {
      body: { closed_at: new Date().toISOString() },
      headers: { "If-Match": etagOf(cur.json.version) },
    });
  }
}

// ── main ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await db.connect();
  await db.query("SET default_transaction_read_only = on");
  console.log(`smoke-ledger-api-safety  base=${BASE}  nonce=${NONCE}`);

  const accounts = await api("GET", "/v1/accounts?flat=true");
  if (accounts.status !== 200) throw new Error(`GET /v1/accounts → ${accounts.status}`);
  const parents = new Set(accounts.json.map((a: any) => a.parent_id).filter(Boolean));
  const leaves = accounts.json.filter((a: any) => !parents.has(a.id));
  const probe = await api("GET", `/v1/accounts/${accounts.json[0].id}/balance`);
  const baseCurrency = probe.json.currency as string;
  const expense = leaves.find((a: any) => a.type === "expense" && a.currency === baseCurrency);
  const funding = leaves.find(
    (a: any) => (a.type === "liability" || a.type === "asset") && a.currency === baseCurrency,
  );
  if (!expense || !funding) throw new Error("need one expense and one asset/liability leaf account in the base currency");
  expenseAccountId = expense.id;
  fundingAccountId = funding.id;

  await groupMetadata();
  await groupCascade();
  await groupPostings();
  await groupAccounts(baseCurrency);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("smoke-ledger-api-safety crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
