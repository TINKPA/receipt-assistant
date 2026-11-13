# Receipt Assistant: developer guide

This codebase is yours: what it’s for and how it’s built are your call, and you’ll keep building on it.

This file is for whoever is **developing** this repo: a person, or an AI working in the checkout. It is not the extraction agent's instructions, and the extraction agent never sees it.

## Two audiences, two sets of files

| Reader | What it needs | Where that lives |
|---|---|---|
| Developer (you) | How the project is built, deployed and debugged | This file, `README.md`, `docs/` |
| Extraction agent (`claude -p`, spawned per receipt inside the container) | What to extract and how to write it to the ledger | `src/ingest/prompt.ts` and the modules it stitches together (`prompt-contract.ts`, `document-read-prompt.ts`, `line-item-prompt.ts`, `items-sql.ts`, `brand-icon-prompt.ts`), `src/ingest/lessons.md`, and `src/ingest/reextract-prompt.ts` for re-extract |
| Ask agent (`POST /v1/insights/ask`) | How to answer a question from the ledger, read-only | `src/insights/ask.ts` |

Keep them apart:

- **A rule for an agent goes in its prompt, never in this file.** Changing what the extraction agent does is a prompt change; see "When to bump `PROMPT_VERSION`".
- **`CLAUDE.md` must not be in the runtime image.** Claude Code auto-loads a `CLAUDE.md` from its working directory, and both agents run with cwd `/app`. A copy there costs about 18.7K input tokens on every turn of every extraction (#227). The `Dockerfile` does not copy it and `.dockerignore` keeps it out of the build context.

## Database schema

Postgres, managed by Drizzle migrations in `drizzle/`. `src/schema/` is the source of truth for table definitions. The ledger is double-entry:

| Table | Purpose |
|---|---|
| `documents` | Uploaded receipt images / PDFs / `.eml`. Content-deduped per workspace by `sha256`. Soft delete is `deleted_at`. |
| `document_links` | Many-to-many between `documents` and `transactions`. |
| `transactions` | Ledger header. Writable `status ∈ {draft, posted, reconciled, error}`. `voided` survives in the `txn_status` enum only as a leftover (#170/#173); nothing writes it. Soft delete is `deleted_at`. |
| `postings` | Debit/credit lines under a transaction. Sum-to-zero is enforced by a deferred check trigger. |
| `transaction_items` | Line items under a transaction. |
| `places`, `place_snapshots` | Geocoded merchant location (FK from `transactions.place_id`) and the append-only history of every raw response fetched for it. |
| `merchants`, `brands`, `products`, `owned_items`, `wish_items` | Catalog. |
| `transaction_events`, `derivation_events` | Append-only audit logs: user/agent edits, and re-derive / re-extract runs. |
| `accounts`, `workspaces`, `users`, `workspace_members` | Multi-tenant scaffolding. |
| `ingests`, `batches`, `idempotency_keys`, `reconcile_proposals` | Upload workers, idempotency, reconcile flow. |

A "receipt" surfaces to the user as the pair `(documents row, linked transaction row(s))`. The agent reads a document, then writes a balanced transaction with its postings and items, and a `document_links` row.

### Delete semantics

Receipts can be wrong (mis-shot, wrong merchant, duplicate). Soft and hard delete are both supported on every layer; the user owns the call.

**`DELETE /v1/documents/:id`**
- default: soft delete (sets `deleted_at`). `GET` and link-creation hide the row; `?include_deleted=true` surfaces it. Re-uploading the same bytes resurrects it via the sha256 dedup path.
- `?hard=true`: removes the row and the image file. Refuses with 409 if links exist, unless `?cascade=true`.
- `?cascade=true`: in one DB transaction, also deletes each linked transaction for which this document is the **last live evidence**. A transaction that another non-deleted document is still linked to is **kept**: an invoice and a payment confirmation both support one purchase, and deleting either file must not delete the purchase. The transactions that are not kept go the usual way: `posted` → soft-deleted, `draft|error` → hard-deleted, already soft-deleted → left alone, `reconciled` → **aborts the whole operation with 409, no writes**. A reconciled transaction that is merely kept does not block. The document is soft-deleted and its link rows stay (as on any soft delete), so `restore` brings the association back.
- `?cascade=true&hard=true`: a full purge of the document. Transactions it was the last live evidence of are hard-deleted; kept transactions only lose the link, and get a `document_unlinked` event.
- A cascade answers **200 with a `CascadeDeleteReport`** (`transactions_kept`, `transactions_soft_deleted`, `transactions_hard_deleted`, `transactions_skipped`), not 204: "delete this receipt" can leave the receipt standing when a second document supports it, and `transactions_kept` is how a caller finds out. A delete without `cascade` is still 204.
- Every `hard_deleted` event, from any path, carries `transaction_id` in its payload: the FK nulls the column when the row goes, so the payload copy is the only pointer back (#202).

**`POST /v1/documents/:id/restore`** clears `deleted_at`.

**`DELETE /v1/transactions/:id`**
- default: soft delete. The row drops out of every money query; `POST /v1/transactions/:id/restore` brings it back.
- `?hard=true`: physical delete (postings and document_links cascade via FK).
- `reconciled` rejects both with 409.

The `reconciled` guard exists because that state means the row has been matched to a bank line. Erasing it without unreconciling first leaves the bank side hanging.

### What counts as a live transaction

A transaction is **live** when `status IN ('posted','reconciled') AND deleted_at IS NULL`. A soft delete leaves `status = 'posted'`, so a status filter alone treats a deleted row as live; that is how a receipt re-uploaded after its transaction was deleted came to be closed as a duplicate of the deleted row.

The definition lives in the database as the view `ledger_live_transactions` (migration 0040), exposed to code as `liveTransactions` in `src/db/live.ts`. It has the columns of `transactions`.

- Read it wherever the question is "is this in the ledger". The dedup probes that live in code do: the byte-level probe in `src/routes/ingest.service.ts`, the pHash neighbour query and the `near_dup` guard in `src/ingest/worker.ts`, both passes in `src/reconcile/dedup.ts`, and the apply step in `src/reconcile/engine.ts`. Re-extract (`reExtractDocument`) uses it to pick the target when a document links to several transactions and only one is live.
- Keep reading `transactions` where deleted rows are wanted on purpose: restore, `include_deleted`, hard delete, audit, and anything that must tell "missing" from "deleted".
- Not yet moved: the hand-written predicate is still in `src/routes/reports.ts`, `accounts.ts`, `merchants.ts`, `brands.ts`, `src/insights/discover.ts`, `src/insights/ask.ts`, and in the extraction prompt's own candidate query.
- **One dedup layer still ignores liveness: the agent's Message-ID pre-check** (`src/ingest/prompt.ts`, result set (3) of Turn A). It matches any earlier document with the same Message-ID, whether or not that document still has a live transaction, and closes the ingest as `done` with no transaction and `error = 'duplicate Message-ID'`; the worker accepts that as the one legitimate zero-transaction `done`. So an email re-forwarded after its transaction was deleted is not extracted again. This is the email twin of the byte-level case fixed above. Fixing it is a prompt change (join the check to the view, and deal with the `(workspace_id, message_id)` unique index when the new copy is stamped), so it needs a `PROMPT_VERSION` bump and the `--with-claude` cases of `eval-dedup`.
- The view is `SELECT t.*`, expanded at creation. A migration that **drops or retypes** a `transactions` column must `DROP VIEW` first and recreate it after; a migration that **adds** one must re-run the `CREATE OR REPLACE VIEW` for the column to show through. Postings and line items have no view: join them to this one.

### Reconcile proposals: apply, undo, stale

A dedup proposal names a `duplicate` (the newer row, unless that one alone is `reconciled`: a row matched to a bank line always survives) and a `duplicate_of` (the survivor). Status moves `proposed` → `auto_applied` | `user_applied` → `reverted`, or `proposed` → `rejected` | `stale`.

- **Apply** (`src/reconcile/engine.ts::applyDedupProposal`, used by auto-apply and by `POST /v1/batches/:id/reconcile/apply`) is one DB transaction: move the duplicate's document links to the survivor, soft-delete the duplicate, write an event on both rows, and store which links moved in `payload.applied.links`. It refuses when either row is not live, when the duplicate is `reconciled`, or when the two rows moved money in different directions. Direction is the class of the row's profit-and-loss legs (expense, income, both, neither) plus the sign of their total, then `metadata.flow` / `refund_of`; `directionLateral` and `flowsDisagree` in `src/reconcile/dedup.ts` are the one definition, shared with detection.
- **Undo** (`POST /v1/batches/:id/reconcile/undo`) restores the duplicate and moves those links back. For proposals applied before links were recorded it rebuilds the list from ingest history and link timestamps and reports `links_source: "inferred"`; it refuses rather than restore a row with no documents. Applies that built on each other (C folded into B, then B into A) are undone newest first: undo of the inner one is refused with `survivor_folded: undo proposal <id> … first`. A plain `POST /v1/transactions/:id/restore` on a row dedup removed still brings it back without its documents and leaves the proposal applied; run undo for that proposal afterwards (it moves the links and reports `restored: false`). `check-ledger` reports that state as `applied-duplicate-gone`.
- **Stale**: an open proposal naming a row that is no longer live is closed as `stale` by the next reconcile in the workspace. No ledger row changes.
- A pair is proposed once per workspace, whatever batch sees it; `stale` is the only status that lets it be proposed again.

What the detector will and will not propose is documented at the top of `src/reconcile/dedup.ts`. Two of its rules are heuristics, not proofs: the ±3-day window, and "two or more other same-total rows at the same merchant in that window means a recurring charge". The second threshold was chosen from the proposals on file in November 2026, and it has a known cost: three or more copies of one receipt that carry no printed identifier look like a recurring charge and get no proposal. A match on any of the five identifier keys can auto-apply (score 1.0), not only `order_number` and `payment_id` as before; an order, invoice or booking paid in two equal charges within three days at one merchant on one card would therefore be folded. It is recorded and undoable.

The byte-level probe is check-then-insert, so `createBatchFromFiles` runs one request at a time per workspace (an in-process chain, like reconcile's): the same bytes arriving in several requests at once are extracted once.

`scripts/check-ledger.ts <postgres-url> [--verbose] [--allow=<check>,…]` is a SELECT-only sweep (the session is opened read-only) that exits non-zero when a dedup or `near_dup` ingest points at a transaction that was not live when the ingest closed, an open proposal names a non-live row, an applied proposal's survivor was not live when it was applied or its duplicate is live again, a live document is linked only to non-live transactions, a row sits deleted as the duplicate of a row whose money moved the other way, or un-retired items hang under a deleted transaction. A row soft-deleted after the ingest or proposal pointed at it is a later decision and is not reported. It does not use the view, so it also runs against a database migration 0040 has not reached.

Two of its checks stay red under ordinary use and are what `--allow` is for: `document-has-live-txn` (a transaction was deleted and its document kept) and `items-under-live-txn` (nothing retires a deleted transaction's line items, and the item and product reads do not look at the parent's `deleted_at`). `--allow` only takes them out of the exit code; they are still counted and printed.

## The three-layer data model (#80)

Every derived value belongs to one of three layers, and the rule is that a lower layer can always be re-run without destroying a higher one.

| Layer | What it is | Examples |
|---|---|---|
| 1. Raw | What we fetched or were given, kept verbatim | the document file, `places.raw_response`, `place_snapshots` |
| 2. Projection | Derived from Layer 1 by a prompt or by code | `transactions.payee` / `occurred_on`, items, `places.display_name_*` |
| 3. User truth | An explicit user decision | `places.custom_name`, `transactions.narration`, any field the user PATCHed |

### Provenance: `metadata.extraction`

Every transaction the agent writes carries the prompt and model it ran under:

```jsonc
{
  "extraction": {
    "prompt_version": "<PROMPT_VERSION>",       // src/ingest/prompt-contract.ts
    "prompt_git_sha": "<build-info gitSha>",
    "model":          "<EXTRACTION_MODEL>",     // CLAUDE_MODEL env, else "cli-default"
    "source":         "ingest" | "re-extract",
    "ran_at":         "<wall-clock at COMMIT>"
  }
}
```

Rows whose `prompt_version` differs from the source tree's are the ones worth re-extracting. Rows ingested before this existed have `metadata.extraction = NULL`; treat that as "unknown version, eligible". `documents.ocr_model_version` records the model that produced `ocr_text` (NULL on old rows; no backfill is possible). `places.metadata.derivation` is the same idea for a place row.

### When to bump `PROMPT_VERSION`

Bump in the **same PR** as the prompt change. Ingest and re-extract share the one constant.

| Change | Bump? |
|---|---|
| New self-check block, new required field, fundamentally different reasoning flow | **Yes** (minor or major) |
| New tool exposure (e.g. the agent gains a new Bash command pattern) | **Yes** |
| Wording polish, typo fix, whitespace, log-only edit | **No** |
| Reordering existing instructions without semantic change | **No** |

The version is a flat string (`"3.3"`, `"3.3.1"` for a small additive iteration, `"4.0"` for a clean break). Bumping on every commit floods the field with noise and makes the re-extract eligibility filter useless.

### Three ways to re-run a layer

| Endpoint | Re-runs | Calls out to | Writes |
|---|---|---|---|
| `POST /v1/places/:id/re-derive`, `POST /v1/admin/re-derive?scope=places` | Layer 2 of a place, from the stored `raw_response` | nothing | `places` projection columns, one `derivation_events` row |
| `POST /v1/places/:id/refresh` | Layer 1 of a place, then re-derive | Google Places v1 (en + zh-CN) | a `place_snapshots` row, `places.raw_response`, then as re-derive |
| `POST /v1/documents/:id/re-extract` | Layer 2 of a transaction, from the document file | `claude -p` | `payee` / `occurred_on` / `occurred_at` / items on the linked transaction, `documents.ocr_text`, one `derivation_events` row |

**Re-derive** is pure TypeScript: `src/projection/derive.ts::projectPlace(rawResponse)` encodes the place-naming rules (CJK extraction, branch-suffix stripping, the `is_native` heuristic with its `GLOBAL_ENGLISH_BRANDS` allowlist). The rules are stable enough to encode once, and an LLM call per place would cost 5–15 s each on the batch path for no gain. When you change them, bump `PROJECTION_VERSION` in the same PR and run the admin batch endpoint after deploy.

Re-derive **overwrites** projection columns (not COALESCE: NULL is a valid new value), with two exceptions kept in `src/routes/places.service.ts::reDerivePlace`:
- `places.custom_name` is never in the UPDATE column list. A new Layer 3 column on `places` must be added to that allowlist.
- zh names whose `display_name_zh_source` is `photo_ocr` or `receipt_ocr` are preserved. They came from a storefront photo or the receipt, which the projection never sees, so "Google has no Chinese name" must not erase them.

`lat`, `lng` and the legacy `formatted_address` are physical facts set at fetch time and are not touched.

It does not cascade to `merchants`: `merchants.canonical_name` / `brand_id` / `category` come from the agent reading the **receipt**, and `merchants.address` / `lat` / `lng` from `src/enrichment/merchants.ts`, so a change in a place's projection creates no inconsistency there.

**Refresh** (`src/google/places-fetch.ts::fetchPlaceV1Dual`) inserts the snapshot and updates `raw_response` in one transaction, then calls `reDerivePlace`, which opens its own. A crash between the two leaves Layer 2 stale until the next refresh, and one duplicate snapshot; both are harmless. It returns 503 when `GOOGLE_MAPS_API_KEY` is unset and 502 with the upstream status when Google answers non-2xx, so a caller can tell a dead place id from a bad day at Google. There is no Yelp client; the `yelp_*` columns are placeholders.

**Re-extract** (`src/routes/documents.service.ts::reExtractDocument`, prompt in `src/ingest/reextract-prompt.ts`) tells the agent to UPDATE the existing transaction, never INSERT. It needs exactly one linked transaction: zero is a 422, and more than one is a 422 unless the caller passes `?transaction_id=`. The service snapshots before and after, diffs, and writes the `derivation_events` row. The response carries `outcome` (`written` | `no_change`): key any tooling on that, never on a timestamp (#167). It does not touch postings (a re-run could change amounts and break sum-to-zero), `place_id`, `merchant_id` or `document_links`.

It is synchronous and bypasses `MAX_CLAUDE_CONCURRENCY`, so run calls strictly one at a time. Running it twice under the same prompt and model should leave the transaction unchanged apart from `metadata.extraction.ran_at`; `ocr_text` may differ slightly because vision OCR is not deterministic.

### Layer 3 on `transactions`

`src/projection/layer3.ts` lists the columns re-extract must not overwrite.

- **Hard**: `status`, `deleted_at`, `trip_id`, `narration`, `id`, `workspace_id`, `source_ingest_id`, `created_by`, `created_at`, `version`. Extraction never writes these, so the re-extract UPDATE simply does not name them. `version` is the exception: always `version + 1`.
- **Soft**: `payee`, `occurred_on`, `occurred_at`. Extraction writes them and the user may override them. `updateTransaction` sets `metadata.user_edited.<field> = true` whenever a PATCH names one, and the re-extract SQL wraps each in a CASE that keeps the current value when the flag is set:

```sql
payee = CASE
  WHEN (metadata->'user_edited'->>'payee')::boolean IS TRUE THEN payee
  ELSE '<NEW_PAYEE>'
END
```

Once flagged, a field is read-only to re-extract. The flag is a boolean, not a timestamp: when the edit happened is in `transaction_events`.

### Editing a transaction through the API

Three rules keep an ordinary API call from destroying ledger data. All three are checked by `scripts/smoke-ledger-api-safety.ts` (below).

**`PATCH /v1/transactions/:id` merges `metadata`, it never replaces it** (RFC 7396, `src/projection/metadata-patch.ts`). Objects merge recursively, `null` removes a key, and `metadata: {}` changes nothing. One refinement of the RFC: a value sent back exactly as stored is left as stored, nested nulls included, so GET → change a key → PATCH the whole object back is safe (strict RFC 7396 would strip every null inside the echoed values, and most rows carry nulls inside `items` and `ocr_audit`). Only the top-level keys that moved are written, as a jsonb expression, so untouched keys never round-trip through JavaScript. This matters because the deployed web client sends `metadata: {}` on every save: the OpenAPI schema used to give the field `default: {}`, and openapi-typescript renders a defaulted property as required. PATCH request schemas use `MetadataPatch` (no default) for that reason; do not put `Metadata` on a PATCH body. The other three PATCH routes that take `metadata` (accounts, owned items, wish items) follow the same rule through `metadataPatchSet`; none of them has server-owned keys.

**Some metadata keys belong to the server.** `SERVER_OWNED_TX_METADATA_KEYS` lists the provenance and bookkeeping keys (`extraction`, `extraction_history`, `re_extracted_at`, `source`, `source_ingest_id`, `classification`, `ocr_audit`, `allocation_audit`, `enrichment_skipped`, `photo_ocr`, `receipt_ocr_zh`, `items`, `merge_audit`, `near_dup_check`, `fx`, `points`, `user_edited`), each cited to the code that writes it. A PATCH that would change or remove one is a 422 (`server_owned`); echoing the current value back is a no-op. Receipt facts and projections (`order_number`, `merchant`, `category_hint`, `flow`, …) stay client-writable. **When you add a server-side writer of `transactions.metadata`, add its key to that list in the same PR.** The `updated` event stores old and new values of the head fields and of only the metadata keys that moved.

**Posting mutations** (`POST|PATCH|DELETE …/postings`) are refused with 409 on a `reconciled` (`transaction-reconciled`) or soft-deleted (`transaction-deleted`) transaction, and `resolvePostingMoney` in `src/routes/transactions.service.ts` decides the base-currency side for create, add and update alike:

| Posting currency | `fx_rate` / `amount_base_minor` |
|---|---|
| workspace base | server sets `amount_base_minor = amount_minor`, `fx_rate = NULL`; a different client value is a 422 |
| foreign cash | both required together; a patch that changes `amount_minor` or `currency` must restate them |
| points (`*_PT`) | both, or neither (the server applies the programme valuation) |

The pair is not checked against `amount_minor × fx_rate`: the FX pass settles rounding residue onto one leg, so the product is only approximate. `fx_rate` itself must fit the column (`numeric(20,10)`): below 10^10, and for cash not so small that it is stored as zero.

Every If-Match-guarded mutation takes the head row's lock (`lockTransactionRow`, `SELECT … FOR UPDATE`) before checking the version, so two requests with the same If-Match cannot both win, and a background pass that writes `metadata.fx` / `metadata.points` cannot be overwritten by a concurrent PATCH.

**Lock order: postings (in id order) before the head row.** The FX and points passes update a transaction's postings and then its `metadata` in one DB transaction, so anything that writes or deletes existing postings takes their locks first: `lockPostingRow` in posting PATCH/DELETE, `lockPostingRowsOf` in the two hard-delete paths (`deleteTransaction`, the document cascade), whose FK cascade would otherwise reach the postings after the head row. A writer that goes head-first deadlocks with a pass: Postgres aborts one of them after a second, which is a 500 for the API call or, when the pass is the victim, a foreign leg left unconverted. Keep new code on the same order.

```bash
# Sandbox or throwaway DB only: it writes fixtures (and refuses port 3000).
npx tsx scripts/smoke-ledger-api-safety.ts --base=http://<host>:<port> \
  --pg=postgresql://postgres:postgres@<host>:<pgport>/receipts
```

### Audit queries

```sql
-- Every re-derive / re-extract of one entity ('place' or 'document')
SELECT entity_id, prompt_version, prompt_git_sha, model, ran_at, changed_keys
  FROM derivation_events
 WHERE entity_type = 'place' AND entity_id = $1
 ORDER BY ran_at DESC;

-- Every raw response ever fetched for a place
SELECT place_id, source, fetched_at, fetched_by_sha
  FROM place_snapshots
 WHERE place_id = $1
 ORDER BY fetched_at DESC;
```

A `derivation_events` row is written before the UPDATE, in the same transaction, even when `changed_keys = []`, so a no-op run is still a known-good checkpoint. To roll back a bad run, write the row's `before` jsonb back and insert a new event recording the rollback. The ingest prompt inserts a `place_snapshots` row in the same statement as the `places` upsert, on every visit, cached or not; `fetched_by_sha` is NULL on rows the original migration backfilled.

## Known Pitfalls

0. **Never pass a prompt (or any payload) as a `claude` CLI *argument* —
   it must go on stdin.** Linux caps a **single** `execve` argument at
   `MAX_ARG_STRLEN = 32 * 4096 = 131072` bytes. This is a separate limit
   from the total `ARG_MAX`, so `getconf ARG_MAX` reports a healthy
   2097152 while every spawn dies with the kernel's opaque
   `spawn E2BIG` — no mention of which argument, or that a size is
   involved.

   `buildExtractorPrompt()` is **~135 KB of fixed contract text** before
   any document-specific content (it stitches together `prompt.ts`,
   `line-item-prompt.ts`, `prompt-contract.ts`, `items-sql.ts`, and
   `document-read-prompt.ts`), so it sits permanently over the ceiling.
   The prompt is expected to keep growing; stdin is what makes that safe.

   Incident 2026-07-28: the prompt crossed 131072 bytes and **every
   ingest in production failed instantly** — the first casualty was a
   Subway `.eml`, which made it look like an oversized-email bug. It was
   not: the ingest path passes only `filePath` into the prompt and the
   agent opens the file itself. Any document would have failed
   identically. Fixed in #194 by moving the prompt to `child.stdin`.

   Guard rails now in place, do not remove them:
   - `src/claude.ts::assertArgvSafe()` runs before every spawn and
     throws a message naming the offending argument and its byte size.
   - Both `src/claude.ts::runClaude` and
     `src/ingest/extractor.ts::runClaude` take `prompt` as a separate
     parameter and write it to stdin. `stdio[0]` must be `"pipe"`, and
     the `child.stdin.on("error", …)` handler must stay — the child can
     exit before draining stdin (auth failure, bad flag) and the
     resulting `EPIPE` would otherwise crash the worker instead of
     rejecting the promise.

   The same exposure applies to `src/ingest/reextract-prompt.ts`, which
   *does* inline user-sized text (`renderDecodedSource` embeds the
   decoded `.eml`/HTML body). Because the prompt now travels on stdin,
   no truncation cap is needed — but never move it back to argv.

1. **`--json-schema` degrades OCR accuracy vs plain-text output**:
   Tested 10 receipts with Sonnet, same prompt, same model:
   - `--json-schema` mode: 4/10 dates wrong (including year errors,
     fallbacks to today's date, merchant names unreadable)
   - Plain text mode: all 4 disagreements were more accurate

   Notable case: AYCE Sushi receipt — JSON-schema couldn't read the
   merchant name at all ("Unknown"), text mode read "GYOTAKU".
   JSON-schema fell back to today's date, text mode got 2026-03-06.

   Root cause: `--json-schema` forces direct JSON output with no
   reasoning space. Text mode allows chain-of-thought ("is this a 3
   or a 9? Given the date context…") which improves ambiguous OCR.

   **Current solution**: Single-call agent pipeline
   (`src/ingest/prompt.ts::buildExtractorPrompt` →
   `src/ingest/extractor.ts::defaultClaudeExtractor`). One `claude -p`
   invocation reads the image, reasons in plain text, and writes the
   whole v1 ledger transaction to Postgres via `psql` tool calls —
   **no JSON-schema coercion anywhere in the flow**. The pre-v1
   `src/claude.ts::processReceipt` that used to own this was deleted
   in #164; `src/claude.ts` now only exports `runClaude` /
   `detectPsqlCommand` for `src/insights/ask.ts`.

   An earlier two-phase variant (Phase 1: image → plain-text OCR;
   Phase 2: separate `claude -p` call structuring the text into JSON
   without seeing the image, with Phase 1's date marked `UNVERIFIED`
   to avoid anchor bias) was replaced by the single-call flow. Worth
   knowing if you A/B a return to two-phase — don't forget the
   `UNVERIFIED` anchor-bias mitigation.

   Open regression: date accuracy remains the weakest dimension —
   Wilson receipt returned `2023-01-07` and `2026-04-18` on two runs
   against ground truth `2025-09-03`. Tracked in
   [#27](https://github.com/TINKPA/receipt-assistant/issues/27).
   Costco gas receipt digits are genuinely ambiguous in the sample
   photo angle; treat it as a known-hard fixture, not a regression.

2. **Handwritten amounts**: Tips and totals written by hand are
   frequently missed or misread. The `handwritten_tip` warning flag
   helps surface this, but accuracy is model-dependent.

3. **Confidence self-assessment is unreliable**: Opus gave 0.88
   confidence on a result where it missed the date entirely.
   Don't use confidence_score as sole quality gate.

4. **`npm run db:migrate` fails in the prod runtime image — `tsx` is
   dev-only.** That script runs `tsx scripts/migrate.ts`, but the
   production image installs prod deps only, so `tsx` is absent
   (`tsx: not found`). To apply migrations manually inside the
   container, use the **compiled, tsx-free** entry:
   `docker exec receipt-assistant npm run db:migrate:prod`
   (= `node dist/db/migrate.js`). `src/db/migrate.ts` has a main-guard
   so the same compiled file both *exports* `runMigrations()` (used by
   `server.ts` at boot) and *runs* migrations when executed directly.
   Idempotent — re-applying already-applied migrations is a no-op.
   (Server boot auto-migrates anyway; this is for manual mid-deploy
   application, as in #159.)

## Schema editing workflow (OpenAPI contract)

The HTTP API contract lives in `src/schemas/v1/` (one zod file per resource: `transaction.ts`, `document.ts`, `ingest.ts`, `account.ts`, …, plus a shared `common.ts`). Each `src/routes/<resource>.ts` registers its own paths in a `registerXOpenApi(registry)` function, which `src/openapi.ts` calls. The generated `openapi/openapi.json` is a build artifact — **never edit it by hand**, it gets overwritten.

When you change a schema or add a new endpoint:

1. Edit the relevant `src/schemas/v1/*.ts` (or add a new file).
2. Register/update the route in that resource's `registerXOpenApi` (`src/routes/<resource>.ts`) with method, request, responses.
3. Add or modify the actual Express handler in the same `src/routes/<resource>.ts`.
4. Run `npm run openapi:generate` to regenerate `openapi/openapi.json`.
5. Commit the schema, route registration, handler, and regenerated spec **in the same commit**. A stale `openapi.json` misleads client codegen and breaks PR diffs.

**Never inline a new request/response `z.object()` directly in `src/routes/*.ts`.** Schemas defined inline don't appear in the OpenAPI spec, so the frontend and any future client can't see them. The `src/schemas/` + registry layout exists so a single source describes every endpoint.

Pinned to `@asteasolutions/zod-to-openapi` v7 because the repo uses zod v3. v8 requires zod v4 — bump both together in a dedicated PR if/when needed.

## Agent transcripts (session JSONL)

There is no observability stack. Langfuse was removed; it only ever re-read the file below and truncated each field to 2–5K characters. Claude Code writes the full transcript of every `claude -p` run itself — prompt, thinking, every tool call and result, per-turn `usage` — to:

```
container: /home/node/.claude/projects/-app/<session-id>.jsonl
host:      ~/Developer/receipt-assistant-data/claude/projects/-app/<session-id>.jsonl
```

`src/session-transcript.ts::getSessionJsonlPath` is the one place that path is computed.

**Retention is pinned in the image, not by default.** The CLI deletes transcripts older than `cleanupPeriodDays` (default 30). The Dockerfile writes `/etc/claude-code/managed-settings.json` with `cleanupPeriodDays: 36500` — intended as permanent; the CLI has no "never" value. Managed settings outrank every other scope. Do not drop that line, and do not "fix" it to `0` (fails validation) or to an astronomical number (the sweep's `now − N days` cutoff leaves the JS Date range past ~1e8 days). Runs made on the host (e.g. `scripts/smoke-v1-ingest.ts`) land in the host's own `~/.claude/projects/` under the host's retention, not here.

Pre-removal history: every Langfuse trace (May–Oct 2026, 1300 traces / 21,826 observations, fields truncated) is exported to `~/Developer/receipt-assistant-data/langfuse-export/{traces,observations}.jsonl`. It is the only copy of runs older than the 30-day window that had already been swept.

Sandbox runs (`docker-compose.test.yml`) are kept apart, in `~/Developer/receipt-assistant-data/test-claude/projects/-app/`; everything below works the same with `test-claude` in the path and `receipt-assistant-test` as the container. Until that directory existed the sandbox mounted production's, so the production directory also holds older sandbox sessions. They can be told apart by the ingest id in the prompt: nothing deletes `ingests` rows, so an id production's table does not have came from the sandbox.

### Finding a run

```bash
T=~/Developer/receipt-assistant-data/claude/projects/-app

# Ingest / re-extract → session: the prompt carries the ingest id and the
# document/transaction ids, so grep is the durable lookup (docker logs rotate).
grep -l "$INGEST_ID" $T/*.jsonl

# Turns, billed input (fresh + cache read + cache write) and output tokens,
# deduplicated by message.id — the numbers Langfuse used to approximate.
npm run measure:turns -- --session=<id|path>
npm run measure:turns -- --last=20
```

### Live trace: tail the JSONL while the extractor is running

The transcript is written in real time, so a hung, timed-out or crashed extraction is fully inspectable while it happens. **This is the right tool when something looks stuck.**

`src/ingest/extractor.ts` (both `defaultClaudeExtractor` and `defaultClaudeReExtractor`) logs the live transcript path to stdout the instant it spawns the subprocess. Grep `docker logs` for the spawn line, then `tail -f` the JSONL on the host — it's bind-mounted, so no `docker exec` needed and the file is being written in real time by the in-container `claude` CLI:

```bash
# 1. Find the spawn line for the most recent extraction (or grep by ingestId).
docker logs receipt-assistant --since 5m 2>&1 | grep '\[claude\] extract' | tail -3
# → [claude] extract ingestId=<id> sessionId=<uuid> jsonl=/home/node/.claude/projects/-app/<uuid>.jsonl

# 2. Translate the container path to the host bind-mount and tail it.
#    /home/node/.claude/  ←→  ~/Developer/receipt-assistant-data/claude/
SID=<uuid-from-spawn-line>
tail -f ~/Developer/receipt-assistant-data/claude/projects/-app/$SID.jsonl

# 3. To pretty-print as the agent runs (one event per line, type + tool + short payload):
tail -f ~/Developer/receipt-assistant-data/claude/projects/-app/$SID.jsonl \
  | python3 -c "
import json, sys
for line in sys.stdin:
    e = json.loads(line)
    t = e.get('type')
    if t == 'assistant':
        for b in e.get('message', {}).get('content', []) or []:
            if b.get('type') == 'tool_use':
                cmd = b.get('input', {}).get('command') or b.get('input', {}).get('file_path') or ''
                print(f'  tool: {b[\"name\"]:>10}  {str(cmd)[:120]}')
            elif b.get('type') == 'thinking' and b.get('thinking'):
                print(f'  think: {b[\"thinking\"][:140]}')
            elif b.get('type') == 'text' and b.get('text'):
                print(f'  text : {b[\"text\"][:140]}')
    elif t == 'user':
        c = e.get('message', {}).get('content', [])
        if isinstance(c, list):
            for b in c:
                if b.get('type') == 'tool_result':
                    inner = b.get('content', '')
                    if isinstance(inner, list):
                        inner = ' '.join(x.get('text','') for x in inner if x.get('type')=='text')
                    print(f'  result: {str(inner)[:120]}')
"
```

### Dedup regression matrix — `scripts/eval-dedup.ts`

The dedup system (#134/#135) has a dedicated regression harness that
must never be pointed at production. Run it after ANY change to
`src/ingest/prompt.ts` Phase 4a.0, the worker guards, `src/reconcile/*`,
the dedup probes, or the pHash code:

```bash
# sandbox up + reset first:
#   docker compose -p receipts-test -f docker-compose.test.yml up -d --build
#   ./scripts/sandbox-reset.sh
npx tsx scripts/eval-dedup.ts --base=http://<mini>:3001 \
  --pg=postgresql://postgres:postgres@<mini>:5433/receipts --with-claude
```

Stub cases are deterministic and take about a minute: `g1-g4` worker
guards, and the reconcile engine's rules — `r1-r3` (identifier match,
card conflict, idempotent re-run), `rf` (refund vs purchase), `sd`
(soft-deleted survivor, re-upload after delete), `l1` (the same bytes
in four requests at once), `rc` (recurring equal-price charges), `ib`
(in-batch identifier rules), `nd` (agent verdict respected), `pp` (one
proposal per pair), `cl` (survivor must be live at apply), `un`
(undo), `rd` (a reconciled row survives), `ch` (chained applies are
undone newest first). Every seed carries a per-run nonce in
its payee and its amount, so they need no reset and can be pointed at
any throwaway server started with `EXTRACTOR_STUB_ALLOWED=1`, not only
the sandbox. "Removed" in this harness means soft-deleted: `deleted_at`
set, status still `posted`.

`--with-claude` adds the agent decision-tree branches (`b2` attach,
`b3` distinct-despite-pHash, `b4` flag+review round-trip) and the
same-batch `race` case (~15 min total); those do need a reset sandbox.
The in-batch pass no longer removes a row on date + payee + amount
alone, so `race` only converges on its second path when both
extractions wrote the same identifier. That path has not been re-run
since the change.

The stub extractor is double-gated (`EXTRACTOR_STUB_ALLOWED=1`,
test compose only + `{"__stub__":true}` file magic) — never enable
that env on the production compose. Don't run the claude cases while
an `eval-dates` batch is draining: both share the worker queue and
the auth pool, and harness poll timeouts will fire while queued.

### Manual Verification Flow

No verify script. Three curl calls are the contract. The pre-v1
`POST /receipt` → `GET /jobs/:id` → `GET /receipt/:id` recipe that used
to live here is **gone** — `src/app.ts` mounts only `/v1/*`, so those
three paths 404. Point at the **mini** (production); `localhost` is the
dev box and lands in the wrong DB.

```bash
BASE=http://100.110.13.13:3000

# 1. Upload
BATCH=$(curl -sS -X POST "$BASE/v1/ingest/batch" \
  -F "file=@/path/to/receipt.jpeg" | jq -r .batchId)

# 2. Poll until the batch reaches a terminal state
until [[ "$(curl -sS "$BASE/v1/batches/$BATCH" | jq -r .status)" \
         =~ ^(extracted|reconciled|failed)$ ]]; do sleep 3; done
curl -sS "$BASE/v1/batches/$BATCH" | jq '.items[] | {id,status,error,produced}'

# 3. Inspect the transaction (the data of record — payee/date/total/
#    postings/items are all here)
TX=$(curl -sS "$BASE/v1/batches/$BATCH" | jq -r '.items[0].produced.transaction_ids[0]')
curl -sS "$BASE/v1/transactions/$TX" | jq .
```

For what the agent did, read its session JSONL (see "Agent
transcripts" above). Never trust a wrapper script's display —
go to `/v1/transactions/:id` for ground truth. (Earlier
`verify-receipt.sh` printed all-None while the DB had correct data;
deleted to avoid that trap.)

Re-extract is a single synchronous call — it bypasses
`MAX_CLAUDE_CONCURRENCY`, so run these strictly one at a time:

```bash
curl -sS --max-time 1000 -X POST "$BASE/v1/documents/$DOC/re-extract" | jq .
# PASS: changed_keys contains "metadata_extraction".
```

### Why API over UI

- **Scriptable**: can diff outputs, run assertions, batch-verify
- **Cross-reference**: compare the session JSONL with the app API
  result in a single command pipeline
- **CI-ready**: verification scripts can hit the API directly
- **No context switching**: stay in terminal, no browser navigation

## Sandbox stack (`docker-compose.test.yml`)

A second copy of the app and its database, for evals, the dedup matrix and frontend test runs. API on 3001, Postgres on 5433.

```bash
docker compose -f docker-compose.test.yml up -d --build   # builds receipt-assistant:sandbox from this checkout
./scripts/sandbox-reset.sh                                # empty ledger, about a second, no restart
```

It shares no state with production. Everything the sandbox can write is its own:

| | Production | Sandbox |
|---|---|---|
| Compose project | `receipt-assistant` | `receipts-test` |
| Image | `receipt-assistant:local` | `receipt-assistant:sandbox` |
| Containers | `receipt-assistant`, `receipts-postgres` | `receipt-assistant-test`, `receipts-test-postgres` |
| Postgres data | `receipt-assistant-data/postgres/` | `receipt-assistant-data/test-postgres/` |
| `/data` | four mounts: uploads (iCloud), `brand-assets/`, `product-assets/`, `prompt-lessons/` | one directory, `receipt-assistant-data/test-uploads/`, holding all four |
| `/home/node/.claude` | `receipt-assistant-data/claude/` | `receipt-assistant-data/test-claude/` |

Three rules keep it that way; the compose file's header explains each.

- **`name:` is pinned.** Both files declare the same service names, so without it Compose treats the running production containers as stale instances of the sandbox's and removes them (#193).
- **The image tag is the sandbox's own.** A tag is a pointer. While both files said `receipt-assistant:local`, building the sandbox from a branch moved the tag production runs, and the next `docker compose up -d receipt-assistant` on production would have started that branch build and run its migrations against the real ledger.
- **No production path is mounted, not even read-only.** Every bind source in the sandbox file is a `test-*` directory. The sandbox used to mount production's Claude directory and `brand-assets/` read-write.

What the two stacks do share is the account behind the keys: `.env` gives both the same `CLAUDE_CODE_OAUTH_TOKEN`, Google Maps key and logo.dev keys, so sandbox agent runs spend the same subscription quota. Compose reads `.env` from the directory the compose file is in. A git worktree has none, so there the token renders empty and every real extraction fails on auth (stub uploads still work); pass `--env-file ~/Developer/receipt-assistant/.env`. After rotating the token, run `docker compose -f docker-compose.test.yml up -d` so the sandbox picks up the new value.

A build from a git worktree is stamped `unknown`: the `Dockerfile` copies `.git` to read the commit, and in a worktree `.git` is a one-line pointer to a host path the builder cannot follow. `/version` and every `metadata.extraction.prompt_git_sha` that image writes then say `unknown`, so an eval run cannot be tied to its commit. When that matters, check the branch out in the main checkout and build there.

### What `scripts/sandbox-reset.sh` does

It clears every table in the `public` schema except boot scaffolding, in one transaction, and moves everything under `test-uploads/` to the Trash. The table list comes from the catalog at run time, so a table added by a later migration is cleared without editing the script.

Scaffolding is what a boot leaves in an empty database. The app creates it only at boot, so clearing it would break the running stack:

| Kept | Written by |
|---|---|
| `users`, `workspaces`, `workspace_members`, `accounts`, `points_valuations` | `src/db/seed.ts`, which does nothing once the seed workspace exists |
| `points_programmes` | `drizzle/0039_points_seed.sql`; a migration never runs twice |

Rows of any other workspace or user are deleted from those tables too. **A migration that seeds reference rows into a new table must add that table to `keep` in the script**, or the reset will empty it and nothing will put the rows back. `./scripts/check-sandbox-reset.sh` catches a list that has fallen behind: it boots an empty throwaway Postgres (migrations, then seed), runs the reset, and fails if the reset changed anything or kept a table the boot left empty. Run it after adding a migration. It starts and removes its own container; neither stack has to be up.

Three limits.

- **Scaffolding is kept, not restored.** Seeded rows carry no marker, so the reset cannot tell them from later ones. In the seed workspace, accounts and valuations that a test or an agent added survive, and so does any edit to a seeded row (the extraction agent adds a points account the first time it sees a programme; a frontend test may rename or delete `Credit Card`, which the extraction prompt looks up by name). `points_programmes` has no workspace column, so every row in it survives; `scripts/smoke-points.ts` adds two. The summary line prints the counts. The script's header has the rebuild recipe for a factory-fresh database.
- **It does not wait for extractions in flight.** It warns when it sees queued or processing ingests, and an agent still running will write rows after the reset.
- **It is meant for a quiet stack.** On a busy one it is still all-or-nothing: two resets started together run one after the other, and a reset that cannot get every table within 30 s exits 3 with nothing cleared. A request that is mid-flight when its rows vanish fails (a 404, a foreign-key error, sometimes a deadlock error).

It refuses to run against production three ways: the container name `receipts-postgres`, the compose project `receipt-assistant`, and any container or data directory that is a production path, whatever it is spelled like (compared by inode, so letter case and symlinks do not get past it). The data directory must also be named `test-*`; everything in it goes to the Trash.

## Persistent data — three locations by category

App state is split across three host locations by data type. Each location is chosen to defeat a specific failure mode; do not collapse them back into one.

| Container path | Host bind | Category | Why this location |
|---|---|---|---|
| `/data` | `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/` | User content (receipt images, PII) | Outer project lives in iCloud, so the user's own receipt corpus syncs across their Macs. Pin via Finder → "Keep Downloaded" if Optimize Mac Storage is on. |
| `/var/lib/postgresql/data` | `~/Developer/receipt-assistant-data/postgres/` | Runtime state (DB binary) | Sibling dir outside any git repo and outside iCloud. Postgres binary contains extracted PII; this repo is public on GitHub. iCloud + Postgres fsync is hostile. Sibling is the right side of both lines. |
| `/home/node/.claude` | `~/Developer/receipt-assistant-data/claude/` | Runtime state (OAuth credentials — now an inert escape-hatch; live auth is the `CLAUDE_CODE_OAUTH_TOKEN` setup-token, see below) + every agent session transcript (`projects/-app/*.jsonl`, the only trace store) | Same reason: `.credentials.json` is sensitive and transcripts carry receipt PII; keep both far from `git add -f` and never on iCloud. |

`docker-compose.yml` uses absolute `${HOME}/...` paths so they resolve identically for any local user. Originals of all uploaded receipts also live in `~/Desktop/RECEIPT/`, which remains the human-curated source of truth.

The sandbox stack mounts none of these. It has its own `test-postgres/`, `test-uploads/` and `test-claude/` beside them in `~/Developer/receipt-assistant-data/`; see "Sandbox stack".

### Why three locations (the four failure modes)

1. **OrbStack / Docker named volumes are not durable.** Lost the entire ledger on 2026-05-09 to a stack-wide volume wipe (every named volume in this project recreated at the same instant — signature of `docker compose down -v` or OrbStack reset). Recovery from Time Machine was impossible: OrbStack sets `com.apple.metadata:com_apple_backup_excludeItem` on its 8 TB sparse `data.img.raw`, so TM has never backed it up. Only the raw images in `~/Desktop/RECEIPT/` survived. → Move durable data out of Docker-managed storage entirely.

2. **This repo is public on GitHub.** A `data/` directory inside the repo with real receipt content or OAuth credentials would be one `.gitignore` mishap or `git add -f` away from leaking PII / secrets. → Postgres data and OAuth credentials live in a **sibling** dir (`~/Developer/receipt-assistant-data/`), not in any git tree at all. The `data/` directory in this repo is reserved for code-asset datasets (test fixtures, golden eval sets) — gitignored via `/data/` but conceptually it's where intentional dataset additions go.

3. **`~/Documents/` is iCloud-synced.** Postgres data files plus iCloud's continuous block-level reupload + revisioning is a hostile combination (constant churn, fsync semantics, possible truncation races). → Postgres lives outside iCloud. **User receipt images, however, intentionally live in iCloud** because the user wants their personal receipt corpus to sync across Macs; this is fine for static image files but requires "Keep Downloaded" pinning if Optimize Storage might evict them under the bind-mount.

4. **The outer project notebook lives in iCloud** (`~/Documents/10_Projects/2026_Dev_ReceiptAssistant/`, with `~/Developer/2026_Dev_ReceiptAssistant/` as a symlink back) because top-level docs (PLAN, CLAUDE.md, lab notes) are the kind of writing that should sync. The three code repos under `code/` are symlinks to `~/Developer/<repo>/` so the codebase itself stays off iCloud.

Bind mounts move the failure boundary: a container or volume reset no longer touches the host filesystem. The data only goes away if *you* `rm -rf` the bind path explicitly.

### Claude Code OAuth — long-lived setup-token (Era 6, 2026-10-08 onward)

Auth is a **long-lived `claude setup-token`** supplied via the `CLAUDE_CODE_OAUTH_TOKEN` env var (read from `.env`), **not** an interactive `/login` session and **not** an API key (`src/claude.ts` deletes `ANTHROPIC_API_KEY` to force subscription auth; it passes `CLAUDE_CODE_OAUTH_TOKEN` through). The token is the SSOT-stored `anthropic/oauth-token` in personal-vault — a setup-token on the Max-subscription quota, ~365-day TTL, fp `632c964f037d` — **the same token OpenClaw (agents `main` + `autotrader`) already runs on**. One line in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=<setup-token from personal-vault anthropic/oauth-token>
```

Why this replaced the per-container `/login` session (Era 5): that session self-refreshed its access+refresh tokens in-container, but the refresh token still lapsed or got server-invalidated periodically and failed **silently** with *"OAuth session expired and could not be refreshed"* (8 incidents Aug–Sep 2026) — the daily receipt cron would then surface a confusing shell-level failure while nothing got ingested. A setup-token is purpose-built for unattended use: one value, valid ~1 year, no refresh dance.

**Precedence — verified 2026-10-08:** when `CLAUDE_CODE_OAUTH_TOKEN` is set it is the **sole** auth gate. Proof: a garbage value `401`s (`OAuth access token is invalid`) even though the mounted `~/Developer/receipt-assistant-data/claude/.credentials.json` is still valid. So the bind mount is now only an **inert escape-hatch** — it is *not* a live fallback. The deliberate trade: self-refresh is off, so the token must be **rotated before its ~2027-07-31 expiry** or extraction hard-`401`s.

**Rotation (do all five, or consumers drift):** on the mini run `claude setup-token`, then (1) update `.env` here and `docker compose up -d receipt-assistant`, (2) if the sandbox stack is up, `docker compose -f docker-compose.test.yml up -d`, because it reads the same `.env` and keeps the old token until its container is recreated, (3) `openclaw models auth paste-token --provider anthropic --agent main`, (4) the same for `--agent autotrader`, (5) update the personal-vault `anthropic/oauth-token` record. Keep the value out of git — it lives only in `.env` (gitignored) and the vault.

**Operate this via the `setup` skill** — first-time bootstrap, 401 diagnosis, recovery procedures all live there.

### What earlier auth setups taught us

The current setup is Era 6. Five approaches failed before it, and the hard rules below are what each cost us.

| Era | When | Approach | How it failed |
|---|---|---|---|
| 1 | before 2026-04-19 | `CLAUDE_CODE_OAUTH_TOKEN` holding a short-lived *access* token | The env var disables refresh: 401 every 24 h |
| 2 | 2026-04-19 → 04-20 | Host `~/.claude/.credentials.json` bind-mounted | Host CLI rotated the shared refresh token: 401 every few hours |
| 3 | 2026-04-20 → 05-09 | Docker named volume | Wiped with every other volume on 2026-05-09 |
| 4 | 2026-05-09 → 05-11 | Bind mount inside the iCloud project notebook | Runtime state mixed into synced docs |
| 5 | 2026-05-11 → 10-08 | Bind mount at `~/Developer/receipt-assistant-data/claude/` with in-container `/login` | Refresh token lapsed silently, 8 times in Aug–Sep 2026 |

### Hard rules

- **`CLAUDE_CODE_OAUTH_TOKEN` must be a long-lived `claude setup-token`, never a short-lived access token.** The env var overrides the on-disk credentials file and disables self-refresh — fatal for a short-lived token (Era 1's 24h 401 cycle) but correct for a ~365-day setup-token (Era 6, current). It is the **sole** auth gate when set (a stale/garbage value hard-401s with no fallback), so rotate it before its ~2027-07-31 expiry.
- **Never bind-mount the host's `~/.claude/` or `~/.claude/.credentials.json`** into the container. The host/container collision is Era 2's bug. Use the dedicated `~/Developer/receipt-assistant-data/claude/`, which the host's native CLI never touches.
- **Never `rm -rf ~/Developer/receipt-assistant-data/`** — that's the postgres ledger + the OAuth session in one stroke. `docker compose down -v` is harmless (bind mounts are not Docker-managed) but the host directory is unforgiving.
- **Never periodically sync host Keychain → `receipt-assistant-data/claude/`.** Re-introduces rotation collisions; in-container auto-refresh is the intended mechanism.
- **Never move runtime data (postgres, claude) into this repo or into the outer iCloud notebook.** Repo placement risks a public-repo PII / credential leak; iCloud placement is incompatible with Postgres write semantics and risks credential exfil via sync. Only `data/uploads/` (user images) belongs in iCloud — postgres + claude stay in the sibling dir.
- **Recovery on 401 (Era 6):** the setup-token has expired or been revoked — mint a new one with `claude setup-token` on the mini, put it in `.env`, `docker compose up -d receipt-assistant`, and update the vault + OpenClaw (full steps under "Rotation" above). The `claude /login` escape-hatch only takes effect if you first **unset** `CLAUDE_CODE_OAUTH_TOKEN` (the env var wins over any on-disk `/login` session).

## GitHub Issues

**Every issue filed here must follow the cross-repo label taxonomy.** The full spec lives in the project-level doc: `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/CLAUDE.md` → "GitHub issue conventions". Do not open issues with only the legacy `bug` label.

Minimum label set (every issue):

- one `kind/*` — `bug` · `feature` · `enhancement` · `docs` · `refactor` · `chore`
- one `priority/*` — `p0` · `p1` · `p2` · `p3`
- one `area/*` — `api` · `extraction` · `db` · `docker` · `ops`
- one `status/*` — `needs-triage` · `confirmed` · `in-progress` · `blocked`
- **bugs also require** one `severity/*` — `critical` · `major` · `minor` · `trivial`

Body template (Summary → Steps to reproduce → Expected → Actual → Root cause → Proposed fix → Acceptance criteria → Impact). See the project-level CLAUDE.md for the full template and the list of reference issues (#25, #27, #28) to copy from.

Filing command:

```bash
gh issue create \
  --title "..." \
  --label "kind/bug,priority/p1,severity/major,area/api,status/confirmed" \
  --body "$(cat <<'EOF'
## Summary
...
EOF
)"
```

Run `gh label list` to see the exact label set; colors and descriptions are already configured.
