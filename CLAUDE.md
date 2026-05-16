# Receipt Assistant — Claude Code Instructions

You are a receipt parsing assistant. Your job is to extract structured data from receipt images.

## Database Schema

Postgres (managed via Drizzle migrations in `drizzle/`). The receipt-as-flat-row SQLite layout that lived here in earlier eras has been replaced by a double-entry ledger. `src/schema/` is the source of truth for the table definitions; the high-level shape:

| Table | Purpose |
|---|---|
| `documents` | Uploaded receipt images / PDFs. Content-deduped per workspace by `sha256`. Soft-delete column `deleted_at`. |
| `document_links` | Many-to-many between `documents` and `transactions`. |
| `transactions` | Ledger header. `status ∈ {draft, posted, voided, reconciled, error}`; `voided_by_id` points to the mirror reversal row. |
| `postings` | The individual debit/credit lines under a transaction. Sum-to-zero is enforced by a deferred check trigger. |
| `places` | Geocoded merchant location, FK from `transactions.place_id`. |
| `transaction_events` | Append-only audit log. |
| `accounts`, `workspaces`, `users`, `workspace_members` | Multi-tenant scaffolding. |
| `ingests`, `batches`, `idempotency_keys`, `reconcile_proposals` | Operational tables for upload workers + idempotency + reconcile flow. |

A "receipt" surfaces to the user as the pair `(documents row, linked transaction row(s))`. The agent extracts a `Document`, then writes a balanced `Transaction` + `postings` and a `document_links` row.

### Delete semantics

Receipts can genuinely be wrong (mis-shot, wrong merchant, duplicate). Both soft and hard delete are supported on every layer; the user owns the call.

**`DELETE /v1/documents/:id`**
- default: soft delete (sets `deleted_at`). `GET` and link-creation hide the row; `?include_deleted=true` surfaces it. Re-uploading the same bytes resurrects via the sha256 dedup path.
- `?hard=true`: removes the row + image file. Refuses with 409 if links exist (caller must add `?cascade=true`).
- `?cascade=true`: in one DB transaction, also handles linked txns — `posted` → voided (mirror reversal), `draft|error` → hard-deleted, `voided` → left alone (link is kept as historical record), `reconciled` → **always aborts the whole operation with 409, no writes**. Combine with `?hard=true` for a full purge of every linked txn + the doc + the file.

**`POST /v1/documents/:id/restore`** — clears `deleted_at`.

**`DELETE /v1/transactions/:id`**
- default: only `draft|error` may be deleted; `posted|voided` return 409 must-void-instead.
- `?hard=true`: caller forces a hard delete (postings + document_links cascade via FK). `reconciled` is the one status that still rejects.

The `reconciled` guard exists because that state means the row has been matched to a bank line. Erasing it without unreconciling first leaves the bank side hanging — so we make the user click twice.

## Extraction Rules

These apply to the agent that reads a receipt image and writes a `transaction` + `postings` to the ledger:

1. **Date format**: Always YYYY-MM-DD. If year is missing, use current year.
2. **Total**: Use the FINAL total (after tax, after tip). If subtotal and total both exist, use total.
3. **Currency detection**: $ → USD, ¥ → detect context (CNY vs JPY), € → EUR, £ → GBP.
4. **Category**: Pick the single most appropriate category from the allowed values.
5. **Don't guess**: If a field is not visible on the receipt, omit it. Don't fabricate data.
6. **Line items**: Extract as many as you can read. Include quantity and price when visible.
7. **Language**: Receipts may be in English, Chinese, or other languages. Handle all.
8. **OCR text**: Persist the full receipt transcription on the `documents.ocr_text` column for future reference.

## Extraction provenance — `metadata.extraction` (Phase 1 of #80)

Every transaction the ingest agent writes stamps a `metadata.extraction` block recording the prompt/model under which it ran. Schema:

```jsonc
{
  "extraction": {
    "prompt_version": "2.5",                    // see src/ingest/prompt.ts → PROMPT_VERSION
    "prompt_git_sha": "<build-info gitSha>",
    "model":          "<CLAUDE_MODEL env or 'sonnet'>",
    "ran_at":         "<wall-clock at COMMIT>"
  }
}
```

This is the gate for [#91](https://github.com/TINKPA/receipt-assistant/issues/91) (`POST /v1/documents/:id/re-extract`) — rows whose `prompt_version` ≠ the current source-tree `PROMPT_VERSION` are eligible to be re-extracted. Phase 2 of the same epic ([#89](https://github.com/TINKPA/receipt-assistant/issues/89)) shipped re-derive for `places`; see the next section.

### When to bump `PROMPT_VERSION`

Bump in the **same PR** as the prompt change. Guideline:

| Change | Bump? |
|---|---|
| New self-check block, new required field, fundamentally different reasoning flow | **Yes** (minor or major) |
| Wording polish, typo fix, whitespace, log-only edit | **No** |
| New tool exposure (e.g. agent gains a new Bash command pattern) | **Yes** |
| Reordering existing instructions without semantic change | **No** |

The version is a flat string (`"2.5"` today; `"2.5.1"` for a small additive iteration, `"3.0"` for a clean break). Auto-bumping on every commit defeats the purpose — it floods the version field with noise and makes the re-extract eligibility filter useless.

Legacy rows ingested before Phase 1 shipped have `metadata.extraction = NULL`. Phase 2/Phase 4 treats NULL as "unknown version, eligible to be re-extracted."

## Backfill / re-derivation — `places` (Phase 2 of #80)

Phase 2 of the 3-layer data-model rollout ([#80](https://github.com/TINKPA/receipt-assistant/issues/80) / [#89](https://github.com/TINKPA/receipt-assistant/issues/89)) ships two endpoints that re-run Layer 2 projection over the existing `places.raw_response` — no Google calls, no Anthropic calls in the hot path.

```
POST /v1/places/{id}/re-derive          # single
POST /v1/admin/re-derive?scope=places   # batch over every place
```

### How the projection runs

Pure TypeScript, deterministic. `src/projection/derive.ts ::projectPlace(rawResponse)` is the single source of truth — it ports the rules in `src/ingest/prompt.ts` Phase 3c (CJK extraction, branch-suffix stripping, `is_native` heuristic with a `GLOBAL_ENGLISH_BRANDS` allowlist) into a rule-encoded function. No `claude -p` invocation, no Anthropic SDK call. Rationale: the heuristics are stable enough to encode once; running them through an LLM per place would add 5–15 s of latency × N for the batch path with no judgment-call payoff the rules can't deliver. The "AI-native" principle still holds — initial extraction (OCR, payee + items, merchant aggregation) stays LLM-driven; only the cheap re-projection step is deterministic.

When you change the projection logic (e.g. add a brand to `GLOBAL_ENGLISH_BRANDS`, refine the CJK strip rules), bump `PROJECTION_VERSION` in `src/projection/derive.ts` in the same PR and run `POST /v1/admin/re-derive?scope=places` after deploy to roll the new logic across the corpus.

### Field-write policy

Re-derive **overwrites** projection-domain fields with the new projection result (NOT COALESCE — re-derive is authoritative, NULL is a valid new value). Two narrow exceptions:

- **Layer 3 user-truth** (`places.custom_name_zh`) is never in the UPDATE column list. Mirrors the existing pattern at `src/ingest/prompt.ts:712-713`. New Layer 3 fields must be added to the service-side allowlist in `src/routes/places.service.ts ::reDerivePlace`.
- **OCR-sourced zh fields** (`display_name_zh_source IN ('photo_ocr', 'receipt_ocr')`) are preserved verbatim. The projection only consumes Google's response; a row whose Chinese name came from a storefront photo or the receipt's own letterhead is outside this projection's input domain and must not be reclassified to `NULL` just because Google has no Chinese.

Physical facts (`lat`, `lng`, the legacy `formatted_address`) are also untouched — those were set at fetch time and don't change with projection logic.

### Audit log — `derivation_events`

Every re-derive INSERTs one row into `derivation_events` **before** the UPDATE lands, inside the same transaction. Schema is shared across entity types (Phase 2 only writes `entity_type='place'`; #91 will add `'document'` / `'merchant'`):

```sql
SELECT entity_id, prompt_version, prompt_git_sha, model, ran_at, changed_keys
  FROM derivation_events
 WHERE entity_type = 'place' AND entity_id = $1
 ORDER BY ran_at DESC;
```

- **Diff a version bump after the fact**: `WHERE prompt_version = '2.6'` gives every row touched by that release.
- **Roll back a bad re-derive**: write the `before` jsonb back to the entity, then INSERT a new event documenting the rollback.
- **Audit no-op runs**: rows where `changed_keys = []` still get an event — so a version bump that happened to produce the same output is visible (and gives you a known-good checkpoint to compare future runs against).

The `places.metadata.derivation` jsonb on the row itself answers "what produced *this* current row" without a join — equivalent to `transactions.metadata.extraction` from Phase 1.

### Why no merchants cascade

The user-facing question raised during planning was: when re-derive changes `places.display_name_en`, should `merchants.canonical_name` auto-update for the linked brand? The code says no — `merchants.canonical_name` / `brand_id` / `category` come from the LLM looking at the **receipt** at ingest time, not from `places` projection output. `merchants.address` / `lat` / `lng` come from `src/enrichment/merchants.ts` calling Google's `findPlaceFromText` endpoint, which is separate from `places.raw_response`. So a `places` projection change doesn't introduce any new inconsistency in `merchants`, and a cascade UPDATE would be dead code. The cascade architecture slot belongs to [#91](https://github.com/TINKPA/receipt-assistant/issues/91) (re-extract), where re-reading the receipt with new place data can plausibly change `canonical_name`.

## Raw-response history — `place_snapshots` (Phase 3 of #80)

Phase 3 of the 3-layer data-model rollout ([#80](https://github.com/TINKPA/receipt-assistant/issues/80) / [#90](https://github.com/TINKPA/receipt-assistant/issues/90)) adds an append-only history of every Google / Yelp `raw_response` we've ever fetched for a place. `places.raw_response` becomes the *latest pointer*; `place_snapshots` is the full audit trail.

### What the table records

```sql
SELECT place_id, source, fetched_at, fetched_by_sha
  FROM place_snapshots
 WHERE place_id = $1
 ORDER BY fetched_at DESC;
```

One row per ingest that touched the place. `source` mirrors `places.source` (`'google_geocode' | 'google_places' | 'yelp'`). `fetched_by_sha` is `buildInfo.gitShortSha` at fetch time — NULL for rows produced by the migration backfill (provenance unknown for historical fetches). `raw_response` is the full body, identical to whatever was written to `places.raw_response` in the same transaction.

### Ingest write path

The CTE in `src/ingest/prompt.ts:704-727` inserts the new `place_snapshots` row in the **same statement** as the `places` upsert — `places` returns the (possibly-just-created) row id, `place_snapshots` reads it from the upsert CTE and inserts atomically. Both rows reflect the same fetch; if either fails the other rolls back. The snapshot insert is unconditional — even when the upsert is a no-op COALESCE round-trip on cached data, the visit is recorded.

### Why a separate table instead of versioning `places`

`places` is the hot read path: every transaction render joins it. Keeping it flat (one row per Google place_id) keeps that read cheap. Snapshot history is queried by hand or by the future refresh path (#91) — putting that cost into a sibling table that's only touched on writes and audit reads is the textbook split.

The same principle drove [`derivation_events`](#audit-log--derivation_events) (Phase 2) — Layer 2 stays a flat snapshot, audit history lives in a separate append-only table. `place_snapshots` is the same shape applied to Layer 1.

### Backfill

The migration (`drizzle/0012_place_snapshots.sql`) does a one-time backfill: every existing `places` row with `raw_response IS NOT NULL` gets one snapshot row, using `last_seen_at` as a best-effort `fetched_at` and `fetched_by_sha = NULL`. The `count(snapshots) ≥ count(places with raw_response)` invariant holds from the moment the migration commits.

### Hand-off to #91

Phase 4 (refresh) will INSERT a new snapshot for every Google / Yelp re-fetch, then diff snapshot N vs N−1 to surface what changed (renamed merchant, moved address, closed business). Without this table refresh would be destructive; with it, every re-fetch is non-lossy from day one.

## Refresh — `places` (Phase 4a of #80)

Phase 4a of the 3-layer data-model rollout ([#80](https://github.com/TINKPA/receipt-assistant/issues/80) / [#91](https://github.com/TINKPA/receipt-assistant/issues/91), first of three sub-PRs).

```
POST /v1/places/{id}/refresh    # re-fetch Google v1 + re-derive in one step
```

### What it does

1. Re-fetches `places/{google_place_id}` from Google v1 dual-language (en + zh-CN, `X-Goog-FieldMask: *`) via `src/google/places-fetch.ts ::fetchPlaceV1Dual` — a server-side TS port of the curl block that the ingest agent runs at `src/ingest/prompt.ts` Phase 3c.
2. INSERTs a new `place_snapshots` row with the fresh body (Phase 3 / #90 plumbing).
3. UPDATEs `places.raw_response` to the new envelope, bumps `last_seen_at`, increments `hit_count`.
4. Delegates to `reDerivePlace(workspaceId, placeId)` (Phase 2 / #89). That step writes the `derivation_events` row, applies projection, and protects Layer 3 + OCR-sourced zh fields.

The endpoint returns `{place_id, google_place_id, snapshot_id, derivation_event_id, changed_keys}`. `changed_keys=[]` is a successful no-op refresh — Google returned the same data, snapshot still landed for audit, no Layer-2 diff.

### Why no Yelp call

The issue body says "re-fetch Google + Yelp" but no Yelp client exists yet — `places.yelp_business_id`, `places.yelp_raw_response`, etc. are placeholder columns waiting on a Yelp ingest epic. Phase 4a is Google-only; when Yelp ingest lands, this endpoint will pick up the second fetch in the same `db.transaction` block.

### Why not atomic across the whole refresh

Snapshot insert + `places.raw_response` UPDATE happen in one transaction; `reDerivePlace` is a separate call (it opens its own transaction internally). A process crash between them leaves the new snapshot + new `raw_response` committed but Layer 2 columns stale. The next refresh re-projects correctly; the only artifact is one extra `place_snapshots` row with identical body to the previous. Acceptable — snapshot history is append-only by design and the duplicate is benign.

### Error shapes

| Condition | Status | `type` |
|---|---|---|
| Place not in DB | 404 | `errors/not-found` (matches existing convention) |
| `GOOGLE_MAPS_API_KEY` unset on the server | 503 | `errors/google-places-unavailable` |
| Google v1 returns non-2xx | 502 | `errors/google-places-upstream` (carries `upstream_status`, `google_place_id`, `language_code`) |

The 503 is intentionally a server-side fault: callers should retry once the deployment is fixed. The 502 surfaces the upstream status so frontends can distinguish "this place_id is dead in Google" (404 from Google) from "Google is having a bad day" (5xx) without re-doing the call.

### What's NOT included (deferred to 91b/91c)

- `POST /v1/documents/:id/re-extract` — re-running `claude -p` against retained image bytes, UPDATE-in-place of an existing transaction, Layer 3 shielding on the transaction surface. Sub-PR 91b lays the schema groundwork (`documents.ocr_model_version` column + Layer-3 tx field allowlist); 91c implements the prompt variant.
- Merchant cascade — if `places.display_name_en` changes, should `merchants.canonical_name` follow? Current answer: no (`merchants.canonical_name` comes from the LLM looking at the **receipt**, not from `places` projection — see "Why no merchants cascade" above). The cascade slot belongs to 91c (re-extract) when re-reading the receipt with new place data can plausibly change the merchant.

## Re-extract prep — `transactions` Layer 3 contract (Phase 4b of #80)

Phase 4b of the 3-layer data-model rollout ([#80](https://github.com/TINKPA/receipt-assistant/issues/80) / [#91](https://github.com/TINKPA/receipt-assistant/issues/91), second of three sub-PRs). Pure schema + contract — no endpoints. The point is to ship the surface that 91c (re-extract) reads from, isolated so 91c's PR is purely the prompt variant + UPDATE plumbing.

### `documents.ocr_model_version` (new column)

```sql
ALTER TABLE documents ADD COLUMN ocr_model_version text;
```

Records which model produced the current `documents.ocr_text`. NULL on legacy rows (anything ingested before Phase 4b). Set by the ingest worker on new uploads; overwritten by re-extract (Phase 4c).

Distinct from `transactions.metadata.extraction.model` (#88) because OCR text and transaction-structure extraction can in principle run under different models — today they share one call, so both end up equal, but the split matters once re-extract decouples them. Backfill is intentionally not attempted: we cannot reconstruct which model ran on each historical row.

### Layer 3 on `transactions`

`src/projection/layer3.ts` codifies which transaction columns re-extract MUST NOT overwrite. Two flavors:

**HARD Layer 3** — fields the ingest agent never writes from extraction. Any non-default value is by definition user state or system identity. Re-extract omits these from its UPDATE column list entirely (same pattern as `places.custom_name_zh`):

```ts
HARD_LAYER3_TX_FIELDS = [
  "status",            // explicit user actions (void/reconcile)
  "voided_by_id",
  "trip_id",           // user-assigned grouping
  "narration",         // user notes
  "id",                // immutable identity
  "workspace_id",
  "source_ingest_id",
  "created_by",
  "created_at",
  "version",           // optimistic concurrency — re-extract sets `version + 1`, never an arbitrary value
];
```

**SOFT Layer 3** — fields extraction DOES write but `PATCH /v1/transactions/:id` (via `UpdateTransactionRequest`) lets the user override. We can't distinguish "agent-written → user-accepted" from "agent-written → user-overrode" without a flag. Convention:

```jsonc
// transactions.metadata
{
  "user_edited": {
    "payee": true,
    "occurred_on": true
  }
}
```

`updateTransaction` will set the flag whenever a PATCH body specifies a value for one of `SOFT_LAYER3_TX_FIELDS` (`occurred_on`, `occurred_at`, `payee`). Re-extract reads via `isFieldUserEdited(metadata, field)` and skips flagged fields. The wire-up for both sides lands in 91c; 91b publishes the contract so both readers point at one source.

### Why a flag set, not per-field timestamps

Re-extract only needs to know *whether* the user has touched a field. The timestamp of the edit is recoverable from `transaction_events` if anyone asks — no need to duplicate it onto the row. Keeping `metadata.user_edited` boolean-shaped keeps the read cheap and the write path simple.

### What 91c will add

- `POST /v1/documents/:id/re-extract` — the actual endpoint
- A new prompt variant (or a flag on the existing prompt) that knows to UPDATE the existing transaction by `source_ingest_id` lookup, instead of INSERT-ing a new one
- Writer side of `metadata.user_edited` flagging in `updateTransaction`
- `derivation_events` rows with `entity_type='document'` (the audit-table extension was already designed into #89's schema)

## Re-extract — `documents` (Phase 4c of #80)

Phase 4c of the 3-layer data-model rollout ([#80](https://github.com/TINKPA/receipt-assistant/issues/80) / [#91](https://github.com/TINKPA/receipt-assistant/issues/91), last sub-PR — closes #91).

```
POST /v1/documents/{id}/re-extract    # re-OCR + UPDATE linked transaction
```

### What it does

1. Resolves the linked transaction via `document_links` (errors 422 on zero or >1 links — we don't pick).
2. Snapshots Layer-2 transaction fields (`payee`, `occurred_on`, `occurred_at`, `metadata.extraction`) + `documents.ocr_text` + `documents.ocr_model_version` BEFORE.
3. Spawns `claude -p` with `src/ingest/reextract-prompt.ts ::buildReExtractPrompt` — a narrow prompt that tells the agent to UPDATE the existing transaction by id, NOT INSERT a new one.
4. Agent re-reads the receipt image and runs one psql block:
   - `UPDATE transactions` with Layer-3 CASE shielding (see below)
   - `UPDATE documents` setting `ocr_text` + `ocr_model_version`
   - `INSERT INTO transaction_events` with `event_type='re_extracted'`
5. Snapshots AFTER, computes diff, writes one `derivation_events` row with `entity_type='document'`.

### Layer-3 shielding (the safety contract)

**HARD Layer 3** (`HARD_LAYER3_TX_FIELDS` in `src/projection/layer3.ts`): `status`, `voided_by_id`, `trip_id`, `narration`, `id`, `workspace_id`, `source_ingest_id`, `created_by`, `created_at`, `version`. The prompt's UPDATE doesn't mention these columns at all (omission = perfect shielding). `version` is the lone exception — re-extract always bumps it via `version + 1` to advance optimistic-concurrency.

**SOFT Layer 3** (`SOFT_LAYER3_TX_FIELDS`): `payee`, `occurred_on`, `occurred_at`. The agent generates new values but the SQL wraps them in CASE expressions:

```sql
payee = CASE
  WHEN (metadata->'user_edited'->>'payee')::boolean IS TRUE THEN payee
  ELSE '<NEW_PAYEE>'
END
```

`metadata.user_edited.<field> = true` is set by `updateTransaction` (PATCH path) whenever the user changes that field. The flag survives re-extract; once flagged, the field is read-only to re-extract forever (the user can re-flag by PATCHing back to the new agent value if they want re-extract to take over again).

### What's NOT included (deferred)

- **Postings rewrite.** Re-extract does not DELETE+INSERT `postings` for the transaction. Reason: postings carry the sum-to-zero ledger invariant; re-running extraction could produce different categories / amounts and risk balance violations. If category drift matters, edit postings explicitly via the postings endpoints. A later scope (call it 91d) can extend re-extract to safely rewrite postings inside a balance-checking transaction.
- **`place_id` / `merchant_id`.** Place refresh is `POST /v1/places/:id/refresh` (Phase 4a). Merchant aggregation has its own enrichment loop.
- **`document_links` rebuild.** The link is already correct — re-extract doesn't change which document points to which transaction.

### Error shapes

| Condition | Status | `type` |
|---|---|---|
| Document not found (or soft-deleted) | 404 | `errors/not-found` |
| Document has no `file_path` | 422 | `errors/document-no-file-path` |
| Document linked to zero transactions | 422 | `errors/document-no-transaction` |
| Document linked to >1 transaction | 422 | `errors/document-multiple-transactions` (carries `transaction_ids[]`) |

### Observability

The `session_id` field in the response is the pre-allocated UUID passed to `claude -p`; query the Langfuse trace API at `http://localhost:3333/api/public/traces?sessionId=<X>` to inspect the model's reasoning and the SQL it wrote. Re-extract follows the same Langfuse pattern as ingest — no UI scraping, REST only.

### Idempotency, sort of

Re-running re-extract on the same document with the same `REEXTRACT_PROMPT_VERSION` and model should produce no Layer-2 diff in the *transaction* (the agent should produce the same payee/date). It will always produce a `metadata.extraction` diff (the `ran_at` timestamp moves) and may produce an `ocr_text` diff (vision OCR is not 100% deterministic — punctuation, line-break differences). The `derivation_events` row is written every time regardless, so the audit trail tracks every re-run.

## Known Pitfalls

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
   (`src/claude.ts::processReceipt`). One `claude -p` invocation reads
   the image, reasons in plain text, and writes the extracted fields
   to Postgres via a `psql` tool call — **no JSON-schema coercion
   anywhere in the flow**. A placeholder receipt row is seeded at
   upload time and `UPDATE`d by the agent.

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

## Schema editing workflow (OpenAPI contract)

The HTTP API contract lives in `src/schemas/` (one zod file per resource: `receipt.ts`, `job.ts`, `summary.ts`, `ask.ts`, `health.ts`, `common.ts`). Routes are registered in `src/openapi.ts`. The generated `openapi/openapi.json` is a build artifact — **never edit it by hand**, it gets overwritten.

When you change a schema or add a new endpoint:

1. Edit the relevant `src/schemas/*.ts` (or add a new file).
2. Register/update the route in `src/openapi.ts` with method, request, responses.
3. Add or modify the actual Express handler in `src/server.ts`.
4. Run `npm run openapi:generate` to regenerate `openapi/openapi.json`.
5. Commit the schema, route registration, handler, and regenerated spec **in the same commit**. A stale `openapi.json` misleads client codegen and breaks PR diffs.

**Never inline a new `z.object()` directly in `server.ts`.** Schemas defined inline don't appear in the OpenAPI spec, so frontend / macOS / future clients can't see them. The `src/schemas/` + registry layout exists so a single source describes every endpoint.

Pinned to `@asteasolutions/zod-to-openapi` v7 because the repo uses zod v3. v8 requires zod v4 — bump both together in a dedicated PR if/when needed.

## Image Reading

To read a receipt image, use the Bash tool:
```bash
# View the image (Claude can read image files directly)
cat /path/to/receipt.jpg
```

Or use the Read tool to inspect the file.

## Langfuse Observability

Self-hosted Langfuse runs alongside the app for LLM monitoring.
All `claude -p` calls auto-ingest session traces via `src/langfuse.ts`.

### Querying Langfuse via API

**Always use the Langfuse REST API for programmatic access** — don't
navigate the web UI manually when you need to inspect traces, compare
outputs, or verify data.

```bash
# List recent traces (with input/output)
curl -s http://$LANGFUSE_HOST/api/public/traces \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get a specific trace by ID
curl -s http://$LANGFUSE_HOST/api/public/traces/<trace-id> \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get observations (generations) for a trace
curl -s "http://$LANGFUSE_HOST/api/public/observations?traceId=<trace-id>" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
```

Local dev defaults:
- Host: `http://localhost:3333`
- Public key: `pk-receipt-local`
- Secret key: `sk-receipt-local`

### Live trace: tail the JSONL while the extractor is running (recommended for debugging hangs / errors)

Langfuse only ingests the trace **after** `claude -p` exits — so if an extraction hangs, times out, or crashes mid-loop, Langfuse never sees it and you have nothing to inspect. **This is the right tool when something looks stuck.**

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

When to reach for this vs. Langfuse:

| Symptom | Use |
|---|---|
| Extraction is stuck in `processing` for >2 min | **Tail the JSONL** — Langfuse hasn't seen anything yet |
| `claude -p` timed out / hit `CLAUDE_TIMEOUT_MS` | **Tail the JSONL** — Langfuse's trace will be missing or partial; the JSONL has the last events the agent emitted |
| Agent exited with a SQL error, want to see what it tried to write | **Tail the JSONL** for the `tool_use:Bash` blocks; Langfuse compresses these |
| Reviewing a past, completed extraction | **Langfuse REST API** — that's its job |
| Comparing date-OCR accuracy across many receipts | **Langfuse REST API** + the app's `/v1/transactions` |

The JSONL is the source of truth Langfuse ingests from — when the two ever disagree, the JSONL is right.

### Manual Verification Flow

No verify script. Three curl calls are the contract:

```bash
# 1. Upload
JOB=$(curl -sS -X POST http://localhost:3000/receipt \
  -F "image=@$HOME/Desktop/RECEIPT/IMG.jpeg" | jq -r .jobId)

# 2. Poll until status=done
while :; do
  s=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .status)
  [[ "$s" == "done" || "$s" == "error" ]] && break
  sleep 2
done
RECEIPT=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .receiptId)

# 3. Inspect the receipt record (the data of record — merchant/date/
#    total/tip/items are all here)
curl -sS http://localhost:3000/receipt/$RECEIPT | jq .
```

For the Langfuse trace, query the API directly (see
"Query Langfuse" above). Never trust a wrapper script's display —
go to `/receipt/:id` for ground truth. (Earlier `verify-receipt.sh`
printed all-None while the DB had correct data; deleted to avoid
that trap.)

### Why API over UI

- **Scriptable**: can diff outputs, run assertions, batch-verify
- **Cross-reference**: compare Langfuse trace output with app API
  result in a single command pipeline
- **CI-ready**: verification scripts can hit the API directly
- **No context switching**: stay in terminal, no browser navigation

## Persistent data — three locations by category

App state is split across three host locations by data type. Each location is chosen to defeat a specific failure mode; do not collapse them back into one.

| Container path | Host bind | Category | Why this location |
|---|---|---|---|
| `/data` | `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/` | User content (receipt images, PII) | Outer project lives in iCloud, so the user's own receipt corpus syncs across their Macs. Pin via Finder → "Keep Downloaded" if Optimize Mac Storage is on. |
| `/var/lib/postgresql/data` | `~/Developer/receipt-assistant-data/postgres/` | Runtime state (DB binary) | Sibling dir outside any git repo and outside iCloud. Postgres binary contains extracted PII; this repo is public on GitHub. iCloud + Postgres fsync is hostile. Sibling is the right side of both lines. |
| `/home/node/.claude` | `~/Developer/receipt-assistant-data/claude/` | Runtime state (OAuth credentials) | Same reason: `.credentials.json` is sensitive; keep it far from `git add -f` and never on iCloud. |

`docker-compose.yml` uses absolute `${HOME}/...` paths so they resolve identically for any local user. Originals of all uploaded receipts also live in `~/Desktop/RECEIPT/`, which remains the human-curated source of truth.

### Why three locations (the four failure modes)

1. **OrbStack / Docker named volumes are not durable.** Lost the entire ledger on 2026-05-09 to a stack-wide volume wipe (every named volume in this project recreated at the same instant — signature of `docker compose down -v` or OrbStack reset). Recovery from Time Machine was impossible: OrbStack sets `com.apple.metadata:com_apple_backup_excludeItem` on its 8 TB sparse `data.img.raw`, so TM has never backed it up. Only the raw images in `~/Desktop/RECEIPT/` survived. → Move durable data out of Docker-managed storage entirely.

2. **This repo is public on GitHub.** A `data/` directory inside the repo with real receipt content or OAuth credentials would be one `.gitignore` mishap or `git add -f` away from leaking PII / secrets. → Postgres data and OAuth credentials live in a **sibling** dir (`~/Developer/receipt-assistant-data/`), not in any git tree at all. The `data/` directory in this repo is reserved for code-asset datasets (test fixtures, golden eval sets) — gitignored via `/data/` but conceptually it's where intentional dataset additions go.

3. **`~/Documents/` is iCloud-synced.** Postgres data files plus iCloud's continuous block-level reupload + revisioning is a hostile combination (constant churn, fsync semantics, possible truncation races). → Postgres lives outside iCloud. **User receipt images, however, intentionally live in iCloud** because the user wants their personal receipt corpus to sync across Macs; this is fine for static image files but requires "Keep Downloaded" pinning if Optimize Storage might evict them under the bind-mount.

4. **The outer project notebook lives in iCloud** (`~/Documents/10_Projects/2026_Dev_ReceiptAssistant/`, with `~/Developer/2026_Dev_ReceiptAssistant/` as a symlink back) because top-level docs (PLAN, CLAUDE.md, lab notes) are the kind of writing that should sync. The three code repos under `code/` are symlinks to `~/Developer/<repo>/` so the codebase itself stays off iCloud.

Bind mounts move the failure boundary: a container or volume reset no longer touches the host filesystem. The data only goes away if *you* `rm -rf` the bind path explicitly.

### Claude Code OAuth — bind mount at sibling dir

Auth is still **not** an env var, and still **not** a bind mount of the host's `~/.claude/.credentials.json`. The container holds its own independent OAuth session at `~/Developer/receipt-assistant-data/claude/`, seeded once via `docker exec -it receipt-assistant claude /login`. The in-container CLI refreshes both `accessToken` and `refreshToken` on expiry and writes rotation back into that path on the host. No collision with the host's native `claude` CLI because nothing is shared.

**Operate this via the `setup` skill** — first-time bootstrap, 401 diagnosis, recovery procedures all live there.

### Five-era timeline of OAuth approaches

- **Era 1 (pre-2026-04-19) — `CLAUDE_CODE_OAUTH_TOKEN` env var + entrypoint-synthesized credentials file.** Broke because the env var overrides the file and disables self-refresh; the synthesized file had `refreshToken: ""`. Result: 24h 401 cycle.
- **Era 2 (2026-04-19 → 2026-04-20) — host `~/.claude/.credentials.json` bind-mounted RW.** Broke because host and container shared a single OAuth session: host's `claude` CLI rotates the refresh token on every interactive use, invalidating the container's next call. Result: 401 every few hours.
- **Era 3 (2026-04-20 → 2026-05-09) — Docker-managed named volume `claude-code-config`.** Worked operationally but vulnerable to volume wipes (and was wiped along with everything else on 2026-05-09).
- **Era 4 (2026-05-09 → 2026-05-11) — host bind mount at `~/Developer/2026_Dev_ReceiptAssistant/data/claude/`.** Volume-reset-resilient but mixed runtime state into the outer project notebook, which complicated the 2026-05-11 outer-project iCloud migration.
- **Era 5 (2026-05-11 onward) — host bind mount at `~/Developer/receipt-assistant-data/claude/`.** Sibling dir, deliberately outside this repo and outside iCloud. Same OAuth isolation, with the runtime-state-leaks-into-docs-notebook problem solved by physical separation.

### Hard rules

- **Never re-introduce `CLAUDE_CODE_OAUTH_TOKEN`** to `.env` or `docker-compose.yml`. Env var overrides the on-disk credentials file and disables self-refresh → Era 1's 24h 401 cycle.
- **Never bind-mount the host's `~/.claude/` or `~/.claude/.credentials.json`** into the container. The host/container collision is Era 2's bug. Use the dedicated `~/Developer/receipt-assistant-data/claude/`, which the host's native CLI never touches.
- **Never `rm -rf ~/Developer/receipt-assistant-data/`** — that's the postgres ledger + the OAuth session in one stroke. `docker compose down -v` is harmless (bind mounts are not Docker-managed) but the host directory is unforgiving.
- **Never periodically sync host Keychain → `receipt-assistant-data/claude/`.** Re-introduces rotation collisions; in-container auto-refresh is the intended mechanism.
- **Never move runtime data (postgres, claude) into this repo or into the outer iCloud notebook.** Repo placement risks a public-repo PII / credential leak; iCloud placement is incompatible with Postgres write semantics and risks credential exfil via sync. Only `data/uploads/` (user images) belongs in iCloud — postgres + claude stay in the sibling dir.
- **Recovery on 401:** `docker exec -it receipt-assistant claude /login`, follow the OAuth code flow.

## GitHub Issues

**Every issue filed here must follow the cross-repo label taxonomy.** The full spec lives in the project-level doc: `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/CLAUDE.md` → "GitHub issue conventions". Do not open issues with only the legacy `bug` label.

Minimum label set (every issue):

- one `kind/*` — `bug` · `feature` · `enhancement` · `docs` · `refactor` · `chore`
- one `priority/*` — `p0` · `p1` · `p2` · `p3`
- one `area/*` — `api` · `extraction` · `db` · `docker` · `langfuse` · `ops`
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
