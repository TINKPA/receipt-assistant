# Receipt Assistant: developer guide

This codebase is yours: what it’s for and how it’s built are your call, and you’ll keep building on it.

This file is for whoever is **developing** this repo: a person, or an AI working in the checkout. It is not the extraction agent's instructions, and the extraction agent never sees it.

## Two audiences, two sets of files

| Reader | What it needs | Where that lives |
|---|---|---|
| Developer (you) | How the project is built, deployed and debugged | This file, `README.md`, `docs/` |
| Extraction agent (`claude -p`, spawned per receipt inside the container) | What to extract and how to write it to the ledger | `src/ingest/prompt.ts` and the modules it stitches together (`prompt-contract.ts`, `document-read-prompt.ts`, `line-item-prompt.ts`, `items-sql.ts`, `brand-icon-prompt.ts`), `src/ingest/lessons.md`, and `src/ingest/reextract-prompt.ts` for re-extract |
| Ask agent (`POST /v1/insights/ask`) | How to answer a question from the ledger. It has no tools: it writes SQL and the server runs it as a read-only role | `src/insights/ask.ts` |

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
| `ingests`, `batches`, `idempotency_keys`, `reconcile_proposals` | Upload workers, idempotency, reconcile flow. `ingests.document_id` is the stored document; `ingests.current_run_id` is the run that owns a `processing` ingest. |
| `agent_runs` | One row per `claude -p` run for a document (ingest or re-extract), written only by the server: writer, session id, model requested and observed, CLI version, turns, tokens, exit, outcome and error class. See "Run records" under "Agent transcripts". |
| `document_extractions` | One immutable row per reading of a document: the extraction record a run handed back under the server writer, as validated, with its errors, warnings and normalisations. `transaction_items`, `derivation_events` and `agent_runs` point back at it through `extraction_id`. Nothing writes it while `EXTRACTION_WRITER=agent_sql`. See "Extraction records" below. |

A "receipt" surfaces to the user as the pair `(documents row, linked transaction row(s))`. The agent reads a document, then writes a balanced transaction with its postings and items, and a `document_links` row.

### Delete semantics

Receipts can be wrong (mis-shot, wrong merchant, duplicate). Soft and hard delete are both supported on every layer; the user owns the call.

**`DELETE /v1/documents/:id`**
- default: soft delete (sets `deleted_at`). `GET` and link-creation hide the row; `?include_deleted=true` surfaces it. Re-uploading the same bytes resurrects it via the sha256 dedup path.
- `?hard=true`: removes the row and the image file. Refuses with 409 if links exist, unless `?cascade=true`.
- `?cascade=true`: in one DB transaction, also deletes each linked transaction for which this document is the **last live evidence**. Each linked transaction is sorted by whether it is already soft-deleted **before** anything else is asked about it: an already soft-deleted one is **skipped** (left alone, link kept), whatever other documents it has. Of the rest, a transaction that another non-deleted document is still linked to is **kept**: an invoice and a payment confirmation both support one purchase, and deleting either file must not delete the purchase. The ones that are neither go the usual way: `posted` → soft-deleted, `draft|error` → hard-deleted, `reconciled` → **aborts the whole operation with 409, no writes**. A reconciled transaction that is merely kept does not block. The document is soft-deleted and its link rows stay (as on any soft delete), so `restore` brings the association back.
- `?cascade=true&hard=true`: a full purge of the document. Transactions no other live document supports are hard-deleted, soft-deleted ones included; the supported ones only lose the link and get a `document_unlinked` event, and are reported as kept, or as skipped if they were already soft-deleted.
- A cascade answers **200 with a `CascadeDeleteReport`** (`transactions_kept`, `transactions_soft_deleted`, `transactions_hard_deleted`, `transactions_skipped`), not 204: "delete this receipt" can leave the receipt standing when a second document supports it, and `transactions_kept` is how a caller finds out. Every linked transaction is in exactly one list, and a soft-deleted one is never under `transactions_kept`. A delete without `cascade` is still 204.
- Every `hard_deleted` event, from any path, carries in its payload what the delete is about to erase: `transaction_id` (the FK nulls the column when the row goes, so the payload copy is the only pointer back, #202), `prior_status`, and `prior_deleted_at` (since when the row had been soft-deleted, or null). `check-ledger` dates a hard delete from it.
- A transaction's `version` does not move when its documents do. Its ETag does: see "ETags" under "HTTP error contract".

**`POST /v1/documents/:id/restore`** clears `deleted_at`.

**`DELETE /v1/transactions/:id`**
- default: soft delete. The row drops out of every money query; `POST /v1/transactions/:id/restore` brings it back.
- `?hard=true`: physical delete (postings and document_links cascade via FK).
- `reconciled` rejects both with 409.
- `If-Match` sent as the whole ETag must match its documents part too: 412, nothing deleted, when a document was linked, unlinked, deleted or restored since the tag was issued. The bare `W/"<version>"` form is held to the version only. See "ETags" under "HTTP error contract".

The `reconciled` guard exists because that state means the row has been matched to a bank line. Erasing it without unreconciling first leaves the bank side hanging.

### What counts as a live transaction

A transaction is **live** when `status IN ('posted','reconciled') AND deleted_at IS NULL`. A soft delete leaves `status = 'posted'`, so a status filter alone treats a deleted row as live; that is how a receipt re-uploaded after its transaction was deleted came to be closed as a duplicate of the deleted row.

The definition lives in the database as the view `ledger_live_transactions` (migration 0040), exposed to code as `liveTransactions` in `src/db/live.ts`. It has the columns of `transactions`.

- Read it wherever the question is "is this in the ledger". The dedup probes that live in code do: the byte-level probe in `src/routes/ingest.service.ts`, the pHash neighbour query and the `near_dup` guard in `src/ingest/worker.ts`, both passes in `src/reconcile/dedup.ts`, and the apply step in `src/reconcile/engine.ts`. Re-extract (`reExtractDocument`) uses it to pick the target when a document links to several transactions and only one is live.
- Keep reading `transactions` where deleted rows are wanted on purpose: restore, `include_deleted`, hard delete, audit, and anything that must tell "missing" from "deleted".
- Not yet moved: the hand-written predicate is still in `src/routes/reports.ts`, `accounts.ts`, `merchants.ts`, `brands.ts`, `src/insights/discover.ts`, and in the extraction prompt's own candidate query.
- **One dedup layer still ignores liveness: the agent's Message-ID pre-check** (`src/ingest/prompt.ts`, result set (3) of Turn A). It matches any earlier document with the same Message-ID, whether or not that document still has a live transaction, and closes the ingest as `done` with no transaction and `error = 'duplicate Message-ID'`; the worker accepts that as the one legitimate zero-transaction `done`. So an email re-forwarded after its transaction was deleted is not extracted again. This is the email twin of the byte-level case fixed above. Fixing it is a prompt change (join the check to the view, and deal with the `(workspace_id, message_id)` unique index when the new copy is stamped), so it needs a `PROMPT_VERSION` bump and the `--with-claude` cases of `eval-dedup`.
- The view is `SELECT t.*`, expanded at creation. A migration that **drops or retypes** a `transactions` column must `DROP VIEW` first and recreate it after; a migration that **adds** one must re-run the `CREATE OR REPLACE VIEW` for the column to show through. Postings and line items have no view: join them to this one.

### Reconcile proposals: apply, undo, stale

A dedup proposal names a `duplicate` (the newer row, unless that one alone is `reconciled`: a row matched to a bank line always survives) and a `duplicate_of` (the survivor). Status moves `proposed` → `auto_applied` | `user_applied` → `reverted`, or `proposed` → `rejected` | `stale`.

- **Apply** (`src/reconcile/engine.ts::applyDedupProposal`, used by auto-apply and by `POST /v1/batches/:id/reconcile/apply`) is one DB transaction: move the duplicate's document links to the survivor, soft-delete the duplicate, write an event on both rows, and store which links moved in `payload.applied.links`. It refuses when either row is not live, when the duplicate is `reconciled`, or when the two rows moved money in different directions. Direction is the class of the row's profit-and-loss legs (expense, income, both, neither) plus the sign of their total, then `metadata.flow` / `refund_of`; `directionLateral` and `flowsDisagree` in `src/reconcile/dedup.ts` are the one definition, shared with detection.
- **Undo** (`POST /v1/batches/:id/reconcile/undo`) restores the duplicate and moves those links back. For proposals applied before links were recorded it rebuilds the list from ingest history and link timestamps and reports `links_source: "inferred"`; it refuses rather than restore a row with no documents. **It does not restore a row with no live document either**: when every document the apply moved has since been deleted (a cascade delete of the moved document keeps the survivor and tombstones or removes the file), the proposal is skipped with `no_live_document: …`, the duplicate stays deleted and the proposal stays applied. Restore the document and undo again; if the file is gone for good, the row can still be brought back deliberately with a plain transaction restore. A duplicate that had no document when it was folded is restored as it was. **The same holds from the survivor's side**: when the survivor's own documents have all been deleted since the apply (a cascade of its own receipt keeps it, because the moved document still supports it), taking the moved documents back would leave it live with no live document, so the proposal is skipped with `survivor_no_live_document: …`. Restore one of the survivor's own documents, or delete the survivor, then undo again. A survivor that never had a document of its own (a manual entry) goes back to having none, as it started. Applies that built on each other (C folded into B, then B into A) are undone newest first: undo of the inner one is refused with `survivor_folded: undo proposal <id> … first`. A plain `POST /v1/transactions/:id/restore` on a row dedup removed still brings it back without its documents and leaves the proposal applied; run undo for that proposal afterwards (it moves the links and reports `restored: false`). `check-ledger` reports that state as `applied-duplicate-gone`.
- **Stale**: an open proposal naming a row that is no longer live is closed as `stale` by the next reconcile in the workspace. No ledger row changes.
- A pair is proposed once per workspace, whatever batch sees it; `stale` is the only status that lets it be proposed again.

What the detector will and will not propose is documented at the top of `src/reconcile/dedup.ts`. Two of its rules are heuristics, not proofs: the ±3-day window, and "two or more other same-total rows at the same merchant in that window means a recurring charge". The second threshold was chosen from the proposals on file in November 2026, and it has a known cost: three or more copies of one receipt that carry no printed identifier look like a recurring charge and get no proposal. A match on any of the five identifier keys can auto-apply (score 1.0), not only `order_number` and `payment_id` as before; an order, invoice or booking paid in two equal charges within three days at one merchant on one card would therefore be folded. It is recorded and undoable.

The byte-level probe is check-then-insert, so `createBatchFromFiles` runs one request at a time per workspace (an in-process chain, like reconcile's): the same bytes arriving in several requests at once are extracted once.

`scripts/check-ledger.ts <postgres-url> [--verbose] [--allow=<check>,…]` is a SELECT-only sweep (the session is opened read-only) that exits non-zero when a dedup or `near_dup` ingest points at a transaction that was not live when the ingest closed, an open proposal names a non-live row, an applied proposal's survivor was not live when it was applied or its duplicate is live again, a live document is linked only to non-live transactions, a live transaction that has (or had) a document has no live one left, a row sits deleted as the duplicate of a row whose money moved the other way, or un-retired items hang under a deleted transaction. A row deleted after the ingest or proposal pointed at it is a later decision and is not reported: a soft delete is dated by `deleted_at`, a hard delete by its `hard_deleted` event (`payload.transaction_id`, `prior_status`, `prior_deleted_at`). A missing row with no such event, or one that was already soft-deleted when the pointer was written and purged later, is still reported. It does not use the view, so it also runs against a database migration 0040 has not reached.

Three of its checks stay red under ordinary use and are what `--allow` is for: `document-has-live-txn` (a transaction was deleted and its document kept), `txn-has-live-document` (its mirror image: a document was deleted on its own with a plain `DELETE /v1/documents/:id`, or a transaction was restored after a cascade took it and its document; manual entries, which never had a document, are not looked at) and `items-under-live-txn` (nothing retires a deleted transaction's line items, and the item and product reads do not look at the parent's `deleted_at`). `--allow` only takes them out of the exit code; they are still counted and printed. `txn-has-live-document` is there for the same state reached without anyone choosing it. The cascade delete removes a transaction with its last live document, and undo refuses from both sides (`no_live_document` for the duplicate it would restore, `survivor_no_live_document` for the survivor it would strip), so neither creates it. A plain document delete that runs while a cascade of the transaction's other document is deciding still can, but only as the same end state as running the two one after the other. A gate built on `--allow` (after a deploy, say) names all three, plus any check the existing data already fails.

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
    "model":          "<EXTRACTION_MODEL>",     // CLAUDE_MODEL env (both compose files pin it), else "cli-default"
    "source":         "ingest" | "re-extract",
    "ran_at":         "<wall-clock at COMMIT>"
  }
}
```

`CLAUDE_MODEL` is pinned to `claude-sonnet-5` in both compose files and is passed as `--model` to both agents. Before the pin it was unset, the CLI chose, and rows said `cli-default`; the surviving transcripts (from 2026-09-25) show that default ran `claude-opus-5` until the switch to the setup-token on 2026-10-08 and `claude-sonnet-5` since. An override in `.env` must be a full model id, never an alias such as `sonnet`, because the stamp is the literal string.

Rows whose `prompt_version` differs from the source tree's are the ones worth re-extracting. Rows ingested before this existed have `metadata.extraction = NULL`; treat that as "unknown version, eligible". `model` here is what was *requested*; the model that actually answered is on the run's `agent_runs.model_observed` (`metadata.extraction` carries no run id yet, so join on `agent_runs.ingest_id = transactions.source_ingest_id`). `documents.ocr_model_version` records the model that produced `ocr_text` (NULL on old rows; no backfill is possible). `places.metadata.derivation` is the same idea for a place row.

### When to bump `PROMPT_VERSION`

Bump in the **same PR** as the prompt change. Ingest and re-extract share the one constant.

| Change | Bump? |
|---|---|
| New self-check block, new required field, fundamentally different reasoning flow | **Yes** (minor or major) |
| New tool exposure (e.g. the agent gains a new Bash command pattern) | **Yes** |
| Wording polish, typo fix, whitespace, log-only edit | **No** |
| Reordering existing instructions without semantic change | **No** |

The version is a flat string (`"3.3"`, `"3.3.1"` for a small additive iteration, `"4.0"` for a clean break). Bumping on every commit floods the field with noise and makes the re-extract eligibility filter useless.

**The legacy rendering is frozen while wave 1 is in flight.** `npm run build` runs `scripts/check-prompt-render.ts`, which renders the ingest prompt (`writer: 'agent_sql'`) and the re-extract prompt for fixed contexts that reach every branch the templates take on their context, and compares SHA-256 hashes with `scripts/prompt-render.golden.json`. The golden was taken before wave 1 touched a prompt file. The git sha, `EXTRACTION_MODEL`, the curated lessons body and the clock are pinned or normalised first, so only template text counts. A failure means the text production runs has changed: take the change out of the legacy rendering. Never update the golden to make it pass; `--update-golden` exists for the day the legacy writer is retired. `--dump=<dir>` writes the normalised renderings for a `diff -r` against the base commit.

Wave 1 adds three more constants for the server writer, all shipped dark. `RECORD_PROMPT_VERSION` (`prompt-contract.ts`, `"4.0"`) versions the record rendering of the ingest prompt, under the same rules as above. `EXTRACTION_CONTRACT_VERSION` (`src/ingest/contract/v1.ts`, `1`) versions the shape of the extraction record; any change to that shape bumps it, always together with `RECORD_PROMPT_VERSION`. `APPLIER_VERSION` (`src/ingest/apply/version.ts`, `"1.0"`) versions the rules that turn a record into ledger rows: bump it with any change to a projection, dedup or catalog rule, with no prompt bump. `PROMPT_VERSION` stays the legacy line until the agent-SQL writer is retired.

### Extraction records (`document_extractions`, wave 1)

Under the server writer the agent no longer writes SQL: it ends its final message with an optional ```` ```receipt-text ```` block and one ```` ```json ```` record, and the server derives the ledger from that record. What exists so far, all unused in production while `EXTRACTION_WRITER=agent_sql`:

- `src/ingest/contract/v1.ts`: the record as zod, every object `.strict()` (an unknown key anywhere is refused, which keeps ids, statuses, base amounts and provenance out of the record), and `renderContractForPrompt()`, which builds the prompt's description of the record from the schema's own `.describe()` texts so the two cannot drift.
- `src/ingest/contract/validate.ts`: normalisations (applied and listed on the record), errors (bounced to one `--resume` repair round, then stored as an invalid record) and warnings (stored), each with a stable rule id; `renderRepairRequest` (names a path and a rule, never a value); `diffRepair` (what a repair changed without being asked). Dates are judged against the upload time, never the clock.
- `src/ingest/contract/artefact.ts`: finds the record: the last ```` ```json ```` block with a `contract_version` in stdout, else in the session transcript's assistant text, never in a tool result, a tool call, a user turn or a thinking block. Caps: 256 KB record, 64 KB receipt text.
- `src/ingest/records.ts`: the only writer of `document_extractions`. In the caller's transaction it stores the record (valid or invalid), supersedes the document's current valid one, and sets `agent_runs.extraction_id`.

Rows are immutable: a trigger lets only `superseded_at` change (and the `ON DELETE SET NULL` foreign keys clear a reference to a deleted run, ingest or record). A partial unique index keeps one current valid record per document. A warning found while a record is applied therefore goes on the run's `apply_report`, never back onto the record. `scripts/check-contract.ts` exercises every rule with synthetic records and runs before every build; `scripts/check-extraction-records.ts --disposable --db=<throwaway>` checks the table, the trigger, the index and the writer against a real Postgres.

### The server applier (`src/ingest/apply/`, wave 1)

The code that turns a stored extraction record into ledger rows. It is complete and shipped dark: nothing calls it while `EXTRACTION_WRITER=agent_sql`, and wiring it into the worker (the writer switch, the stub record mode) comes next. The entry points are in `index.ts`:

- `recordExtraction` is T1: the record, valid or invalid, stored in one transaction fenced on `ingests.current_run_id`. An invalid record with no repair round left also errors the ingest (`extraction record rejected: <path>: <rule>`) and finishes the run `invalid_record` / `artefact_invalid`; `closeRunWithoutRecord` does the same for a run that handed back nothing (`artefact_missing`).
- `applyExtraction` is T2. The place is fetched first, outside any transaction (`places.ts`: a cache hit fetches nothing; a miss goes through `fetchPlaceV1Dual`, and a missing key or a failed fetch is the warning `place_fetch_failed`, not a failure). Then ONE transaction (`write.ts`): `lock_timeout` 10 s and `statement_timeout` 60 s, the workspace apply lock, the run fence (the ingest `FOR UPDATE` where `current_run_id` is this run and the status `processing`, and the run still `running`; otherwise `fenced_out`), no transaction already naming the ingest, the document live; then project, candidates, decide, and the branch. **Insert** writes, in order: the merchant's brand (a real name is never overwritten, only a slug stub upgraded; `user_chose_at` never written), product brand stubs, a new points account under `Assets`, the merchant (first sight wins), the place, the sold-item retire, the transaction (ids are the server's, metadata the fixed key set), postings, the link, items through the bound `itemsWriteSql` with `extraction_id`, `SET CONSTRAINTS ALL IMMEDIATE` plus the per-currency `amount_minor` check, owned items, product statistics over live transactions, parties (inside the transaction now, `line_no` resolved to this run's items), the `created` event, the document stamp. **Attach** locks the target `FOR UPDATE`, re-takes the decision under that lock (a changed answer is a retryable `attach_target_changed`), links, appends `merge_audit`, writes `document_linked` and stamps; no catalog write. **Unsupported** and **statement** stamp the document and close the ingest `unsupported`; a statement is recorded, not booked. Every branch closes the ingest (exactly one row) and finishes the run with `apply_report` in the same transaction, so a terminal ingest means the record was applied. 40001, 40P01 and 55P03 are retried twice in-process; after that, or on any other failure, a short transaction errors the ingest (`apply failed: <code>`) and finishes the run `failed` / `apply`, and the record stays valid and unapplied. A fenced-out apply touches only its own run.
- The document stamp: `ocr_text` is the record's receipt-text block (stamped with `model_observed`), else the server's decode of an email or HTML source (`ocr_model_version = 'server-decode/1'`); for an email, `message_id` and `source_meta` come from the server's MIME parse, never the model, and `message_id` stays with an earlier document that already holds it (the unique index).
- `applyMessageIdDuplicate` (X9) runs before any spawn: an email whose Message-ID an earlier document carries, with a live transaction, is linked to it and closed `dedup` (`duplicate_skip`). A Message-ID whose transaction was deleted is not a duplicate; null, nothing written.
- `reapplyRecord` applies a stored record again (an apply-only attempt; the run ends `reapplied`), `dryRun` projects and decides in a READ ONLY transaction, and `runPostCommitPasses` runs the points and FX passes on what an insert wrote.
- Lock order: the prologue reads the document without a lock. The document is locked where the lock order ("Editing a transaction through the API") puts it, after the transaction row: by `linkDocumentIn` on insert and attach, and by the stamp's UPDATE on the branches that link nothing. Locking it in the prologue, as the plan's sketch did, would put the document before the attach target and could deadlock with a cascade delete.
- `project.ts`: `project(record, catalog)` returns the draft: header, postings, line-item parameters for the bound `itemsWriteSql`, parties, owned-item lines, the merchant and brand to upsert, the points account to use or create, the place to fetch. Postings are signed as the legacy prompt signs them (a refund's total is negative), one pair per currency, `amount_base_minor = amount_minor` and no `fx_rate`, so the FX and points passes convert after commit as today. The expense account is `merchant.category`. The **mirror account is derived from `payment.method`**, not chosen by the model: cash → Cash, check and bank_transfer → Checking, points → the programme's points account, anything else → Credit Card (`MIRROR_BY_METHOD`). The header of `project.ts` lists the cases the plan left open. A missing account is `ProjectionError('account_missing')`, a seeding fault, never something to send back to the model.
- `accounts.ts`: the workspace's chart of accounts as `project` takes it, and the lookups by type and name the legacy prompt wrote as CTEs.
- `metadata.ts`: `transactions.metadata` as a fixed key set (`APPLIER_METADATA_KEYS`). No `metadata.items`; `metadata.extraction` carries `writer: 'server_apply'`, the run, session and record ids, and `APPLIER_VERSION`. A sold item that could not be retired (no `product_key`, no live instance, or more than one) says why in `owned_items_note`.
- `catalog.ts`, `places.ts`, `write.ts`: the writes above. Every value is a bound parameter.
- `candidates.ts`: the duplicate candidates of a record (by signed amount in the record's currency within ±3 days, by any identifier within ±30 days, by pHash neighbour), at most 25, from `ledger_live_transactions`. Run it inside the apply transaction after `takeWorkspaceApplyLock`, which serialises applies per workspace.
- `decide.ts`: attach or insert, decided in code (plan §7): the direction gate and `refund_of`, then attach only on exactly one strong candidate (same merchant, no identifier conflict, and an identifier match or the hard tuple of card, minute, total and line totals); several strong or no tiebreaker is an insert flagged `uncertain`; a conflict with every candidate is `distinct`. It reuses `IDENTIFIER_KEYS`, `compareIdentifiers`, `flowsDisagree` and `cardLast4` from `src/reconcile/dedup.ts`; change those there.
- `fingerprint.ts`: the fields two writers must agree on for one document, canonicalised and hashed, from a draft or from a stored transaction.

Three checks, and one in `check-ledger`. `scripts/check-apply-decide.ts` runs every §7 rule and every posting shape (purchase, refund, income, points, points plus cash, each payment method, JPY and KWD amounts) as a table, with no database, before every build. `scripts/check-projection-replay.ts --pg=<url>` opens a read-only session: `--from-ledger` synthesises a record for every live ingest transaction from its metadata, items and postings, projects it, and compares the money (account, sign, amount, currency); every mismatch lands in a class, explained only by a rule written in the script, and the exit code counts unexplained mismatches on rows with `prompt_version` 3.0 or later (the pre-A/B gate). The synthesis is partly circular, and the script says where: the total is the booked one, and a payment method with no payment text behind it is read off the booked mirror. `--records` re-projects the stored records and compares fingerprints with the transactions they produced. Run both after changing a projection or dedup rule, before bumping `APPLIER_VERSION`. `scripts/check-apply-extraction.ts --disposable --db=<throwaway>` migrates a throwaway Postgres and runs every write branch against it in a few seconds (34 fixtures: purchase, refund with and without `refund_of`, income and the sold-item guard, owned items, points plus cash, JPY and EUR through the FX pass, attach by identifier and by the hard tuple, attach refused for a non-candidate, a target deleted while the apply waited on its lock and the other direction, distinct, uncertain, unsupported, statement, Message-ID duplicate, parties, cached, uncached and unfetchable places, extras colliding with metadata keys, a missing fence, invalid JSON, a repair round, a double apply and a stale run, a missing account, an apply failing half-way, a retried serialization failure, re-apply, dry run), asserting the rows written and that no other table changed; the live Google place fixture runs only with `GOOGLE_MAPS_API_KEY` and `CHECK_APPLY_GOOGLE_PLACE_ID` in its environment. Run it after touching `src/ingest/apply/`, `records.ts` or `items-sql.ts`. `check-ledger`'s `apply-row-has-record` fails for a transaction written by the server applier that no longer has a current valid record behind it.

### Three ways to re-run a layer

| Endpoint | Re-runs | Calls out to | Writes |
|---|---|---|---|
| `POST /v1/places/:id/re-derive`, `POST /v1/admin/re-derive?scope=places` | Layer 2 of a place, from the stored `raw_response` | nothing | `places` projection columns, one `derivation_events` row |
| `POST /v1/places/:id/refresh` | Layer 1 of a place, then re-derive | Google Places v1 (en + zh-CN) | a `place_snapshots` row, `places.raw_response`, then as re-derive |
| `POST /v1/documents/:id/re-extract` | Layer 2 of a transaction, from the document file | `claude -p` | `payee` / `occurred_on` / `occurred_at` / items on the linked transaction, `documents.ocr_text`, one `derivation_events` row, one `agent_runs` row |

**Re-derive** is pure TypeScript: `src/projection/derive.ts::projectPlace(rawResponse)` encodes the place-naming rules (CJK extraction, branch-suffix stripping, the `is_native` heuristic with its `GLOBAL_ENGLISH_BRANDS` allowlist). The rules are stable enough to encode once, and an LLM call per place would cost 5–15 s each on the batch path for no gain. When you change them, bump `PROJECTION_VERSION` in the same PR and run the admin batch endpoint after deploy.

Re-derive **overwrites** projection columns (not COALESCE: NULL is a valid new value), with two exceptions kept in `src/routes/places.service.ts::reDerivePlace`:
- `places.custom_name` is never in the UPDATE column list. A new Layer 3 column on `places` must be added to that allowlist.
- zh names whose `display_name_zh_source` is `photo_ocr` or `receipt_ocr` are preserved. They came from a storefront photo or the receipt, which the projection never sees, so "Google has no Chinese name" must not erase them.

`lat`, `lng` and the legacy `formatted_address` are physical facts set at fetch time and are not touched.

It does not cascade to `merchants`: `merchants.canonical_name` / `brand_id` / `category` come from the agent reading the **receipt**, and `merchants.address` / `lat` / `lng` from `src/enrichment/merchants.ts`, so a change in a place's projection creates no inconsistency there.

**Refresh** (`src/google/places-fetch.ts::fetchPlaceV1Dual`) inserts the snapshot and updates `raw_response` in one transaction, then calls `reDerivePlace`, which opens its own. A crash between the two leaves Layer 2 stale until the next refresh, and one duplicate snapshot; both are harmless. It returns 503 when `GOOGLE_MAPS_API_KEY` is unset and 502 with the upstream status when Google answers non-2xx, so a caller can tell a dead place id from a bad day at Google. There is no Yelp client; the `yelp_*` columns are placeholders.

**Re-extract** (`src/routes/documents.service.ts::reExtractDocument`, prompt in `src/ingest/reextract-prompt.ts`) tells the agent to UPDATE the existing transaction, never INSERT. It needs exactly one linked transaction: zero is a 422, and more than one is a 422 unless the caller passes `?transaction_id=`. The service snapshots before and after, diffs, and writes the `derivation_events` row. It also records the run in `agent_runs` (`kind='re_extract'`) before the spawn, with the before snapshot, and finishes it with the outcome, the after snapshot and the event id; a run that fails still leaves that row, which is then the only record of what the transaction looked like before the agent touched it. The response carries `outcome` (`written` | `no_change`): key any tooling on that, never on a timestamp (#167). It does not touch postings (a re-run could change amounts and break sum-to-zero), `place_id`, `merchant_id` or `document_links`.

It is synchronous and bypasses `MAX_CLAUDE_CONCURRENCY`, so run calls strictly one at a time. Running it twice under the same prompt and model should leave the transaction unchanged apart from `metadata.extraction.ran_at`; `ocr_text` may differ slightly because vision OCR is not deterministic.

### Layer 3 on `transactions`

`src/projection/layer3.ts` lists the columns re-extract must not overwrite.

- **Hard**: `status`, `deleted_at`, `trip_id`, `narration`, `id`, `workspace_id`, `source_ingest_id`, `created_by`, `created_at`, `version`. Extraction never writes these, so the re-extract UPDATE simply does not name them. `version` is the exception: always `version + 1`. Since migration 0041 the agent's database role also has no UPDATE privilege on any of them except `version` (see "Agent sandbox"), so nothing that goes through the agent's own `$DATABASE_URL` can write them, whatever the prompt says.
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

**Some metadata keys belong to the server.** `SERVER_OWNED_TX_METADATA_KEYS` lists the provenance and bookkeeping keys (`extraction`, `extraction_history`, `re_extracted_at`, `source`, `source_ingest_id`, `classification`, `ocr_audit`, `allocation_audit`, `enrichment_skipped`, `photo_ocr`, `receipt_ocr_zh`, `items`, `merge_audit`, `near_dup_check`, `fx`, `points`, `user_edited`, and `mirror_account` and `printed_totals`, which only the server applier writes), each cited to the code that writes it. A PATCH that would change or remove one is a 422 (`server_owned`); echoing the current value back is a no-op. Receipt facts and projections (`order_number`, `merchant`, `category_hint`, `flow`, …) stay client-writable. **When you add a server-side writer of `transactions.metadata`, add its key to that list in the same PR.** The `updated` event stores old and new values of the head fields and of only the metadata keys that moved.

**Posting mutations** (`POST|PATCH|DELETE …/postings`) are refused with 409 on a `reconciled` (`transaction-reconciled`) or soft-deleted (`transaction-deleted`) transaction, and `resolvePostingMoney` in `src/routes/transactions.service.ts` decides the base-currency side for create, add and update alike:

| Posting currency | `fx_rate` / `amount_base_minor` |
|---|---|
| workspace base | server sets `amount_base_minor = amount_minor`, `fx_rate = NULL`; a different client value is a 422 |
| foreign cash | both required together; a patch that changes `amount_minor` or `currency` must restate them |
| points (`*_PT`) | both, or neither (the server applies the programme valuation) |

The pair is not checked against `amount_minor × fx_rate`: the FX pass settles rounding residue onto one leg, so the product is only approximate. `fx_rate` itself must fit the column (`numeric(20,10)`): below 10^10, and for cash not so small that it is stored as zero.

Every If-Match-guarded mutation takes the head row's lock (`lockTransactionRow`, `SELECT … FOR UPDATE`) before checking the version, so two requests with the same If-Match cannot both win, and a background pass that writes `metadata.fx` / `metadata.points` cannot be overwritten by a concurrent PATCH.

**Lock order: postings (in id order), then transaction head rows (in id order), then the document row.** One rule for every path that locks more than one of them. Keep new code on it.

- *Postings before the head row.* The FX and points passes update a transaction's postings and then its `metadata` in one DB transaction, so anything that writes or deletes existing postings takes their locks first: `lockPostingRow` in posting PATCH/DELETE, `lockPostingRowsOf` in the two hard-delete paths (`deleteTransaction`, the document cascade), whose FK cascade would otherwise reach the postings after the head row. A writer that goes head-first deadlocks with a pass: Postgres aborts one of them after a second, and when the pass is the victim a foreign leg is left unconverted.
- *Head rows before the document row.* Dedup apply and undo (`src/reconcile/engine.ts`) lock the proposal, then both transaction rows, and only then touch a document: inserting a `document_links` row makes the foreign key take `FOR KEY SHARE` on it, and undo reads the liveness of the moved documents and of the survivor's own under `FOR SHARE`, which also makes a plain document delete or restore wait instead of changing the answer before the undo commits. `DELETE /v1/transactions/:id` with a whole ETag reads the transaction's documents the same way, after its head row. The server applier (`src/ingest/apply/write.ts`) locks the attach target `FOR UPDATE`, or inserts the new transaction and its postings, before `linkDocumentIn` takes the document, and stamps the document last; its prologue only reads the document. Re-extract's SQL updates the transaction and then the document in one `BEGIN … COMMIT`. `cascadeDeleteDocument` (`src/routes/documents.service.ts`) used to lock the document first and the transactions after, and deadlocked with an apply or undo fired at the same pair (86 of 160 staged pairs on 7940db6; 0 of 240 since) and with re-extract's order (3 of 3). It only knows its transactions through the document's links, so it now reads the links without a lock, locks postings and head rows, locks the document `FOR UPDATE` last, and reads the links again. `FOR UPDATE` blocks the foreign key's `KEY SHARE`, so from then on no link to that document can be added; if the second read names a transaction the first did not (an apply or undo moved the document while the cascade waited), the attempt rolls back and starts over on the new link set (logged as `[documents] cascade delete of … starting over`), four times at most, then 409 `concurrent-update`.
- *Why not a weaker lock on the document, taken first.* `FOR NO KEY UPDATE` does not conflict with `KEY SHARE`, so it would also stop the apply/undo deadlock. It would not stop the one with re-extract, which holds the transaction row and then updates the document, and it would let a link be added to a document that is being deleted, so the cascade could act on a link set that is no longer true.
- *Linking.* A bare `INSERT INTO document_links` takes its foreign keys' `KEY SHARE` locks document first (the FK triggers fire in name order), against the rule. `linkDocumentIn` (`src/routes/documents.service.ts`) therefore takes both itself, transaction then document, inside its caller's DB transaction, and checks that the document is not deleted under that lock; `linkDocumentToTransaction`, behind `POST /v1/documents/:id/links`, runs it in a transaction of its own. A caller that already holds other head rows calls `linkDocumentIn` after them and before touching the document. The extraction agent's attach branch (`src/ingest/prompt.ts`, "ATTACH") still inserts the link and then updates the transaction, so it is outside the rule; it links a document uploaded moments earlier, and moving it onto the rule is a prompt change (bump `PROMPT_VERSION`).
- A plain document soft delete, restore or unlink writes one row and holds nothing else, so it cannot be part of a cycle (it may wait on a `FOR SHARE` above, never the other way round). Do not add a second lock to one of them without placing it in the order above; this is one reason the transaction ETag is derived from the documents instead of being bumped by them.

A deadlock or serialization failure that happens anyway (SQLSTATE `40P01`, `40001`) is a 409 `errors/concurrent-update` with `Retry-After: 1`, never a 500: the whole DB transaction rolled back, nothing was written, and the same request can be sent again. Apply and undo report it per proposal as `apply_failed (sqlstate 40P01); nothing was changed`.

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

## Money: minor units, exponents and base amounts

Three columns on `postings` carry every amount, and `src/ledger/money.ts` is the only place that relates them.

| Column | Unit |
|---|---|
| `amount_minor` | The posting's own currency, in that currency's own minor unit: cents for USD, fen for CNY, whole yen for JPY, fils (1/1000) for KWD, whole points for `HYATT_PT`. |
| `fx_rate` | The multiplier from that to base-currency minor units. NULL on a base-currency posting. |
| `amount_base_minor` | Workspace base currency, minor units. This is what every total sums. |

One equation holds for every converted posting, cash or points: `amount_base_minor = round(amount_minor × fx_rate)` (the leg that absorbs a transaction's rounding residual may be off by a unit or two).

- **`fx_rate` is not the published exchange rate when the two currencies have different decimals.** A rate source quotes whole units (1 JPY = 0.0065 USD); the posting needs cents per yen, 0.65. `postingFxRate(currency, base, publishedRate)` shifts it by the exponent difference, using the ISO 4217 table behind `currencyExponent()` (0 for JPY, KRW, VND and a dozen others, 3 for KWD and BHD, 2 for anything unlisted, 0 for a points code). The rate as published stays in `fx_rates.rate` and in `transactions.metadata.fx.rates[].rate`; that is the number to show a person.
- **`toBaseMinor(amountMinor, fxRate)` is the only native-to-base conversion.** The FX pass, the points pass, and `createTransaction` / `addPosting` all call it. It works in integers and rounds half away from zero, so opposite legs convert to opposite amounts. Do not write `amount * rate` anywhere else: multiplying a minor amount by a published rate is the bug that booked a yen receipt at a hundredth of its value (¥5,000 at 0.0065 came out as 33 cents instead of $32.50).
- **Sum `amount_base_minor`, label with the workspace base currency.** Reports, merchant and brand KPIs, account balances and dedup all do. `amount_minor` may only be summed within one currency (the points disclosure groups by programme). A new endpoint that sums it across rows adds yuan to dollars to points.
- **No endpoint takes a `currency` parameter to relabel a sum.** The four reports and `/v1/accounts/:id/balance` each had one, and it wrote the requested code next to the same base-currency total. The response's `currency` is always the base currency.
- **A client-supplied `fx_rate` is stored as sent.** `POST /v1/transactions` and the posting endpoints require `fx_rate` + `amount_base_minor` on a foreign cash posting and check neither against a published rate. The OpenAPI descriptions say the field is the minor-unit multiplier; a client that sends the quoted rate for a JPY posting books it at a hundredth of its value, and nothing refuses it. The boot check below notices only a rate sent that equals a published rate on record: the `fx_rates` row cached for the posting's date and currency, or a rate for that currency in the transaction's own `metadata.fx.rates[]`, matched on currency alone, not on date. Anything else goes unnoticed, such as a rounded rate, or the quoted rate on a date no rate was cached for in a transaction whose metadata does not carry it (a client of `POST /v1/transactions` rarely sends `metadata.fx`).

Who converts: the extraction agent writes the receipt's own numbers with `amount_base_minor = amount_minor` as a placeholder, and the worker then runs `valuePointsSafely` and `normalizeFxSafely` (`src/ingest/worker.ts`). Neither can fail the ingest. When the FX pass cannot resolve a rate the posting stays **unconverted**: `fx_rate` NULL, base amount still the native number. `src/fx/unconverted.ts` is the one SQL definition of that state, and everything that sums base amounts for a person discloses it: every report in its `fx` block (`unconverted_transaction_count`, per-currency amounts), the same way `points` counts unvalued programmes; the merchant and brand KPIs in `unconverted_transaction_count`, and their transaction rows in `unconverted`. Zero is what makes a total trustworthy.

Three different failures leave a posting unconverted, and `src/fx/rates.ts` tells them apart:

| Failure | Meaning | Handling |
|---|---|---|
| timeout, 5xx, network | The rate exists, the source is having a bad day | 3 attempts, then a cached rate within 10 days, else unconverted. Retry later. |
| HTTP 404, and the source still answers its probe (`FxRateNotPublishedError`) | The source has no rate for that currency (TWD, VND, KWD, AED …) or date (before 1999, far future) | One request, no retry, no stale fallback. Needs a rate supplied by hand, or the date corrected. |
| HTTP 404, and the probe (EUR→USD on a settled date) is a 404 too | That endpoint is not the rate source: the API moved, or `FX_API_BASE` is wrong | Same as the first row. The 404 says nothing about the currency. |

`scripts/backfill-fx.ts` is the only thing that revisits a posting after ingest. In particular, editing a transaction's date does not re-run FX: after correcting the date of an unconverted receipt, run `--unconverted`.

```bash
# Inside the app container (it has DATABASE_URL). Always --dry-run first.
docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --dry-run            # every foreign posting, forced
docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --exponent-mismatch  # only JPY/KRW/KWD…: rows booked at the wrong magnitude before exponents were respected
docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --unconverted        # retry failed conversions, touch nothing that converted
docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --unconverted --currency TWD --rate 0.0312   # supply a rate the source does not publish
docker exec -i receipt-assistant npx tsx scripts/backfill-fx.ts --currency TWD --date 2026-10-01 --rate 0.0312   # correct a rate supplied earlier
```

`tsx` is not in the runtime image; `npx` fetches it on first use, so the container needs to reach the npm registry for these.

`--rate` is used only for a date the source answered 404 for, and is recorded in `fx_rates` with source `manual`. It is not applied to a future date, and never replaces a published rate. To replace a manual rate (a typo), name the date with `--date` and leave `--unconverted` out, so the rate on record and every posting converted at it change together; without `--date` the recorded rate is kept and the output says so. The posting PATCH endpoint cannot set a rate by hand: it changes one leg per request, and a base amount changed on one leg fails the balance trigger.

A run that computes what the postings already hold writes nothing, so re-running is free of version bumps. A run that overwrites a rate or base amount a posting already carried inserts a `derivation_events` row first, in the same DB transaction: `entity_type = 'transaction'`, `entity_id` the transaction id, `before` / `after` holding `postings` (per posting id: `fx_rate`, `amount_base_minor`) and `metadata_fx`. A first conversion at ingest is not an overwrite and is recorded by `metadata.fx` alone.

**After deploying the exponent fix, run `--exponent-mismatch` once.** There is no migration for it: rows converted before the fix keep the published rate as their multiplier and stay at the wrong power of ten until the script repairs them. The server checks for exactly that state at boot (`src/fx/magnitude-check.ts`: a posting whose `fx_rate` equals the published rate for its date although its currency and the base differ in decimals) and logs `⚠️  [fx] … booked at the wrong power of ten` with the command. The script ends every run with the same check.

Regression checks, each against a throwaway Postgres (usage in the file header): `scripts/smoke-fx.ts` (the JPY and KWD magnitude cases, both kinds of 404, the targeted re-derive, the no-op and audit-event behaviour, the boot check, and `--rate` supplied, mistyped and corrected) and `scripts/smoke-points.ts`.

Not done:

- The frontend (separate repo) formats every amount as hundredths, so a JPY receipt's own amount renders as ¥50.00 for ¥5,000, and its detail page shows `postings.fx_rate` as "the rate" where `metadata.fx.rates[].rate` is the published one.
- `products.total_spent_minor` is still a sum of native line amounts (`transaction_items.effective_total_minor`), shown as dollars. It is written in two places: `recomputeProductStats` in `src/catalog/product-stats.ts` (the products route's recompute and merge call it, and so does the server applier), and the ingest and re-extract SQL in `src/ingest/items-sql.ts`, which is prompt text. They agree except on two points, both deliberate: the helper resets a product with no counted line left to zero, where the prompt SQL leaves its old numbers (a product a re-extract dropped keeps its count); and the helper takes `liveOnly`, which the routes pass as `false` (deleted transactions count, as in the prompt SQL) and the applier passes as `true`.
- A points leg whose valuation pass never ran (`fx_rate` NULL, as opposed to valued at 0) sits in the totals at its points count and is in neither disclosure block.

## Agent sandbox: what the two agents can reach

Both agents are `claude -p` children of the server, and both read text a stranger wrote. The extraction agent has a forwarded email pasted into its prompt. The Ask agent takes a question from whoever can reach the API, then reads `ocr_text`. So what they can do is decided by what they are handed, not by what a prompt asks of them.

`src/claude.ts` is the only place a child is spawned, and every spawn names a profile:

| | `extraction` (ingest, re-extract) | `ask` | `text` (backfill scripts) |
|---|---|---|---|
| Tools (`--tools`) | Bash, Read, Write, Edit, WebSearch | none | none |
| Permissions | bypassed: Bash is unrestricted here anyway | `dontAsk`, with nothing to approve | none needed |
| `DATABASE_URL` the child sees | logs in as `receipts_agent` | unset: the server runs its SQL, as `receipts_ro` | unset |
| Keys passed on | `GOOGLE_MAPS_API_KEY`, `LOGODEV_SECRET_KEY` | none | none |

Every profile also gets `--strict-mcp-config` with no config (no MCP servers, which includes the account's claude.ai connectors), `--disable-slash-commands` (no skills) and `--setting-sources ""` (user, project and local settings and their `CLAUDE.md` files are ignored; managed settings, where transcript retention is pinned, still apply). The child's environment is built from an allowlist in `buildClaudeEnv`, never copied from the server's. `runClaude` accepts only `--output-format`, `--model` and `--verbose` from a caller, so widening a profile is always a visible edit to `AGENT_PROFILES`.

The flags were read off `claude --help` of the pinned CLI (2.1.251). A CLI bump can change what they mean: re-run `check-agent-sandbox` and `probe-cli` (below) with every bump.

### Database roles

Migration 0041 creates two roles. `src/db/agent-roles.ts` says what each may do, and the server re-applies that file at every boot (`syncAgentRoles`), along with the role passwords from `RECEIPTS_AGENT_DB_PASSWORD` and `RECEIPTS_RO_DB_PASSWORD`. The server's own pool keeps using `DATABASE_URL`, which is not in either child's environment.

- **`receipts_agent`** holds exactly `AGENT_GRANTS`: SELECT on the 17 tables the prompt templates touch, INSERT where they insert, and UPDATE **per column**. No DELETE, no TRUNCATE, no DDL, no temp tables, no large objects, and no access at all to the remaining tables (`users`, `workspaces`, `idempotency_keys` and the rest). The column lists are what makes Layer 3 a server-side rule: `transactions.status` / `deleted_at` / `narration`, `places.custom_name`, `brands.user_chose_at`, `products.custom_name` and `documents.file_path` are not in them. Postings are insert-only.
- **`receipts_ro`** holds SELECT on every table and view in `public`, and nothing else.

To let the extraction agent do something new, edit `AGENT_GRANTS` in the same change as the prompt. No migration is needed, because boot applies the file.

**Tables added later.** `receipts_ro` can read a new table as soon as it exists (a default privilege, re-asserted at boot) and can never write to it. `receipts_agent` cannot see a new table or view until `AGENT_GRANTS` lists it. Three things keep that from failing quietly:

1. `npm run build` runs `scripts/check-agent-grants.ts`. It reads the SQL out of the rendered prompts (in any letter case, schema-qualified or not, views included) and fails when a statement is not covered by `AGENT_GRANTS`, or when a grant is no longer used by any template.
2. Boot logs the tables the role cannot touch, and logs an error for every difference between the live privileges and the file.
3. `check-agent-sandbox` fails on the same differences.

A table neither agent may read, such as a credential store, goes in `RO_DENY_TABLES` and stays out of `AGENT_GRANTS`.

**What boot does, and what its log lines mean.** After migrations, `syncAgentDbRoles` in `src/server.ts` applies the file and then logs in as each role with the URL an agent would be handed. None of it can stop the server from starting:

- `🔐 Agent DB roles synced` is the normal line. `⚠️ … built-in development password` means a password variable is unset.
- `❌ Agent DB role sync was blocked by another session` means a session held a lock the sync needs for more than ten seconds. Any role may take an advisory lock, and Postgres keeps a backend alive while it sleeps even after its client was killed, so an agent can leave such a session behind. Boot ends the sessions logged in as the two agent roles (no agent of this server exists yet) and tries once more.
- `❌ Agent DB role drift` is a privilege that differs from the file after the sync; `❌ Agent DB login check` means an agent started now could not log in. Either one is a reason not to trust extraction until it is understood.

Postgres lets any role change its own password and its own session defaults; no privilege controls that. The extraction agent can therefore lock `receipts_agent` out (`ALTER ROLE receipts_agent PASSWORD …`), and extraction then fails at its first psql call until the next restart puts the password back. The Ask path cannot do this (see below).

Roles belong to the cluster, not to a database dump. After restoring a dump into a fresh Postgres the restore prints "role does not exist" for the GRANT lines; that is harmless, and the first boot recreates both roles with their grants. `scripts/tx-restore.sh` needs `session_replication_role` and keeps using the owner connection. Migration 0041 needs a connection that may create roles (the compose files connect as the `postgres` superuser).

### How Ask reaches the database

The Ask model has no tools. `askLedger` (`src/insights/ask.ts`) calls `claude -p` with the question; the model replies with SQL in fenced blocks; the server runs each one with `runLedgerQuery` (`src/insights/ledger-query.ts`) and calls the model again with the rows, until it replies `ANSWER:` or five model calls are spent. `session_id` in the response names the last call, whose prompt carries every query and result.

`runLedgerQuery` logs in as `receipts_ro`, opens a read-only transaction, and sends the model's text as a single prepared statement, wrapped as the body of a cursor over `SELECT … FROM (<text>) q`. Only one query can parse there. It fetches at most 200 rows, each cut to 4000 characters by Postgres, under a 30 s statement timeout, and closes the connection afterwards. The read-only transaction is what stops the two things privileges do not: a role altering itself, and creating large objects.

Ask used to have Bash with an allowlist of one command under `--permission-mode dontAsk`. On CLI 2.1.251 that mode still runs the CLI's built-in "read-only" commands (`id`, `cat`, `tac`, `du`, `stat` and others) without consulting any allow rule, so it was never one command. If a later change gives Ask a tool again, that is the fact to re-check first.

### Checking it — `scripts/check-agent-sandbox.ts`

Sandbox only; it refuses the production container. Run it after changing a profile, `AGENT_GRANTS`, the pinned CLI version, the SQL in a prompt or the Ask schema digest, and before that change is deployed:

```bash
# sandbox up first: docker compose -f docker-compose.test.yml up -d --build
npx tsx scripts/check-agent-sandbox.ts             # runs inside receipt-assistant-test
npx tsx scripts/check-agent-sandbox.ts --db-only   # database half only, no model calls
```

It works by attempt. Logged in as each role it tries DROP, TRUNCATE, `COPY … PROGRAM`, DELETE, the columns and tables that are off limits, and expects SQLSTATE 42501 every time; as `receipts_agent` it runs the statements the templates issue and expects every one to succeed. It throws writes, second statements, `ALTER ROLE` and runaway queries at `runLedgerQuery`, selects as `receipts_ro` every table, view and column the Ask prompt's schema digest names, and runs the Ask loop against a scripted model. Then it starts one `claude -p` per profile with the production flags and reads the tool list the CLI reports: a tool outside the profile's list, or any MCP tool or server, is a failure, and Ask's list must be empty. The extraction run executes `psql "$DATABASE_URL"` and must arrive as `receipts_agent`; the Ask run is told to execute `id` and must have nothing to do it with; one real question goes through the Ask loop. Every database statement is inside a transaction that is rolled back.

A check that could not be carried out (usually because `claude` cannot authenticate in the sandbox) is reported as INCONCLUSIVE and fails the run. A green run means every claim was exercised.

### CLI behaviour the repair round needs — `scripts/probe-cli.ts`

Wave 1 has the agent hand back a record and, when it is invalid, sends the errors to the same session once with `claude -p --resume <session id>`. `scripts/probe-cli.ts` asks the pinned CLI, inside the sandbox container and with the profile's own `buildClaudeArgs` / `buildClaudeEnv`, whether that is safe: the `CLAUDE_MODEL` pin is accepted and is what the transcript shows; a resumed run offers exactly the profile's tools, still knows the conversation, and reads it from the prompt cache instead of paying for it again. It also records whether `--output-format json` changes anything but the envelope and whether `--input-format stream-json` takes a second message. About nine short model calls; it refuses the production container.

```bash
npx tsx scripts/probe-cli.ts --out=<private notes>/p0-cli-probes.md
```

On 2.1.251 (2026-11-13) all of it held, with three facts the implementation must respect: the resuming spawn's `--tools` decides the tool list, not the session's history, so the profile flags must be re-applied on resume; `--session-id` together with `--resume` is refused unless `--fork-session` is also given, so a resume spawn passes no `--session-id`; and a plain resume continues the same session id and JSONL file, so one run keeps one transcript. Keep `EXTRACTION_REPAIR_ROUNDS` at 0 for any CLI on which the probe's gating checks fail.

### What this does not bound

Know these before treating the sandbox as a wall. Ask is confined by construction: it has nothing to run. **The extraction agent is not confined.** Its limits stop a mistake and an injection that works through what the agent was handed. They do not stop a hostile receipt that tells it to go around them, because it has an unrestricted shell running as the server's own Unix user:

- **It can log in to Postgres as the owner.** The owner is a superuser, and until `RECEIPTS_DB_OWNER_PASSWORD` is set its password is the `postgres` printed in `docker-compose.yml` in a public repository, on the host named in the agent's own `$DATABASE_URL`. `psql postgresql://postgres:postgres@receipts-postgres/receipts` skips every grant above. Rotating the password (see below) removes the version of this that needs no looking; it does not remove the next one.
- **It can read the server's environment.** A process can read `/proc/<pid>/environ` of another process of its own user, which holds the owner `DATABASE_URL`, the API keys and the OAuth token whatever they are set to.
- **It can rewrite the server.** `/app`, `dist` included, is owned by the user the agent runs as. A change there lasts until the container is recreated.
- **It can start another `claude`** with every tool, because `CLAUDE_CODE_OAUTH_TOKEN` is in its environment (the CLI needs it there).
- **It can call the HTTP API**, which has no credential and will hard-delete on request, and it has outbound network because the prompts need `curl`. Whatever it can read (the receipt files, the tables in its grant list, the transcripts under `~/.claude`) it can send out.
- **Within its grants it is not scoped to one receipt.** It may UPDATE the granted columns (`payee`, `metadata`, …) on every transaction and add postings to any of them, as long as the result balances.

Closing the first four means running the agent as a different Unix user, or in a different container, from the server; the fifth is the API token and loopback ports of the next wave. None of that is in place.

**Rotating the owner password.** `POSTGRES_PASSWORD` only applies when the data directory is first created, so change the role first, then the variable:

```bash
PW=$(openssl rand -hex 24)   # hex: it is pasted into a URL
docker exec receipts-postgres psql -U postgres -qc "ALTER ROLE postgres PASSWORD '$PW'"
echo "RECEIPTS_DB_OWNER_PASSWORD=$PW" >> .env
docker compose up -d receipt-assistant
```

`docker exec receipts-postgres psql -U postgres` keeps working without it (local socket), so backups and `tx-restore.sh` are unaffected.

For Ask, what remains: the model reads the whole ledger, including `ocr_text` written by strangers, and what it reads can steer what it answers; and every question costs up to five model calls from whoever can reach the API.

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
   - `src/claude.ts::runClaude` is the only `claude` spawn site (the
     extractor's `runExtractorClaude` calls it). It takes `prompt` as a
     separate parameter, and `runSupervised`, which does the spawning,
     writes it to stdin. `stdio[0]` must be `"pipe"`, and the
     `child.stdin.on("error", …)` handler must stay — the child can exit
     before draining stdin (auth failure, bad flag) and the resulting
     `EPIPE` would otherwise crash the worker instead of rejecting the
     promise.

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
   in #164; `src/claude.ts` now owns only how a child is spawned:
   `runClaude` and the agent profiles (see "Agent sandbox").

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

## HTTP error contract

Every error leaves through `src/http/problem.ts::problemHandler` as `application/problem+json` carrying a `trace_id`. Clients branch on `type`.

**Throw, never format.** A handler throws an `HttpProblem` (or lets a zod error escape) and stops. Do not build an error body by hand and do not put `err.message` in one: for a failed query that message is Drizzle's `Failed query: <sql> params: <values>`. That holds for an error reported *inside* a 200 as well. A handler that lists per-item failures uses `renderProblem(err, req)` for a per-item problem document (`POST /v1/transactions/bulk`) or `publicErrorMessage(err)` for a one-line message (`POST /v1/admin/re-derive`), and logs the full error itself. `renderProblem` is the one mapping from "anything thrown" to a response:

| Thrown | Response |
|---|---|
| `HttpProblem`, `ZodError` | as thrown (a body that fails its schema is 422 `errors/validation`) |
| body-parser / multer / Express rejecting the request | 400 `malformed-body`, `malformed-upload`, `bad-request`; 413 `payload-too-large` |
| Postgres `22P02` and the other "that value cannot be that type" codes (a NUL byte in text, `\u0000` in jsonb, an impossible date, …) | 400 `invalid-parameter` |
| Postgres `23505` unique, `23P01` exclusion | 409 `conflict` |
| Postgres `23503` foreign key | 422 `invalid-reference` when the request names a row that does not exist, 409 `still-referenced` when it removes one something points at |
| Postgres `23514` check, `23502` not-null | 422 `constraint-violation` (a ledger trigger's own sentence is passed through as `detail`) |
| Postgres `40P01` deadlock, `40001` serialization failure | 409 `concurrent-update` with `Retry-After: 1` and `retry_after_seconds` in the body: nothing was written, retry |
| anything else | 500 `internal`: a fixed sentence and the `trace_id`, nothing from the error |

The SQLSTATE table is `src/http/pg-error.ts`. A mapped Postgres error logs one `[http] trace_id=… sqlstate=…` line; a 500 logs the full error, stack and cause chain under the same id, so `docker logs receipt-assistant 2>&1 | grep trace_id=<id>` is how you get from a user's error to its cause. For a deadlock that line says `sqlstate=40P01 pg="deadlock detected"`; which two statements met is in the Postgres log (`docker logs receipts-postgres`), and the fix is the lock order under "Editing a transaction through the API", not a retry loop. A problem that needs a response header carries it in `HttpProblem.headers` (`ConcurrentUpdateProblem` sets `Retry-After`), and `problemHandler` sends it.

**Malformed ids are a 400 `errors/invalid-id`, decided in one place.** `src/app.ts::UUID_PATH_PARAMS` lists, per router, the path parameters that are UUIDs; `src/http/params.ts::UUID_QUERY_PARAMS` lists the query-string ones. A request with a malformed one never reaches its handler. When you add a route with a new UUID parameter name, or a UUID filter to a `*Query` schema, add the name there. `:brandId` (a slug), `/v1/merchants/:id` (slug or UUID), `/v1/places/:id` (UUID or Google place id) and `:rank` are deliberately absent. The places one matters: `merchants.place_id` holds Google's `ChIJ…` id and the merchant page fetches `GET /v1/places/<that>`, so listing `placesRouter` turns every linked place into a 400. Before adding a parameter to either list, read the service and confirm it only ever takes a UUID. The `parseOrThrow(IdParam, req.params)` calls still in the route files are now redundant for this check.

**Boolean query flags use `QueryBoolean`** (`src/schemas/v1/common.ts`), never `z.coerce.boolean()`, which reads the string `"false"` as true. `true` / `1` / `false` / `0` are accepted; anything else is a 422.

**An unknown URL or method** is a 404 `errors/route-not-found`, distinct from `errors/not-found` (the record does not exist).

**Cursors.** `decodeCursor(cursor, requiredKeys)` throws 400 `errors/invalid-cursor` for anything this API could not have issued; pass `requiredKeys`, or a cursor from another endpoint reaches the SQL with fields missing. Where a service decodes the cursor, its route calls `assertCursorShape` first. `/v1/merchants/:id/transactions` has its own `<date>|<id>` cursor and rejects anything else the same way.

**ETags.** A resource with a `version` column uses `setEtag` / `requireIfMatch`. One without (documents) uses `sendWithRepresentationEtag`, a digest of the body. Never a constant: a tag that cannot move answers every revalidation with 304.

A transaction is the case in between: it has a `version`, and its body also lists its `documents`, which change without the transaction row being written (a document soft delete or restore, a link or unlink, a cascade that keeps the transaction, a dedup apply or undo moving links onto the survivor, an upload resurrecting a soft-deleted document, the agent attaching a file to an existing transaction). Its tag is `transactionEtag(version, documents)` in `src/http/etag.ts`: `W/"<version>-<digest of each linked document's id and deleted_at>"`, computed when the response is built. It is derived, not maintained by bumping `version` from those paths, because a bump has to be remembered by every writer (one of them is prompt SQL), would make document operations take the transaction's row lock (see the lock order), and would refuse a concurrent edit for a change the edit does not touch. `If-Match` on a transaction reads the **version part only** (`parseTransactionEtag`): a client that loaded the receipt before a document was deleted and then saves an edit has the edit applied, and the response carries the current documents and tag. The bare `W/"<version>"` form is still accepted there, for a client that builds the header from the body's `version`; it never matches `If-None-Match`, so every copy cached before this format revalidates once. **`DELETE /v1/transactions/:id` is the exception**: a delete is the one write that undoes a document change (a hard delete takes the links with it, and either kind removes the purchase a receipt was just attached to), so a delete sent with the whole tag must match it whole, documents part included, or it is a 412 with nothing deleted (`assertDocumentsMatchEtag` in `transactions.service.ts`, under the head-row lock). A delete sent with the bare form named no documents and is held to the version only. Not covered yet: the body's `items` (`POST …/items` adds lines without a version bump) and its `merchant` / `place` blocks (a rename writes another table). A revalidation after one of those is still a 304. The fix is to add them to `transactionEtag`, not to bump `version`. The same reasoning covers response *headers*: `/v1/brands/:id/icon` and `/v1/products/:id/image` revalidate, a 304 leaves the browser with the headers it stored, so their ETag is `storedImageEtag(contentHash)`, the content hash plus `STORED_IMAGE_HEADERS_VERSION` in `src/http/files.ts`. Bump that constant when the security headers on stored images change, as `RENDER_VERSION` is bumped for `/rendered`.

**`Idempotency-Key`** (`src/http/idempotency.ts`, mounted on `POST /v1/transactions`). The first request claims the key in `idempotency_keys` before the handler runs, so a concurrent duplicate gets 409 `errors/idempotency-in-progress` instead of running too. A row with `response_status = 0` is such a claim, held for a 2-minute lease; a completed request rewrites it with the real response and a 24 h expiry, a failed one deletes it. Expired rows are replaced on reuse and swept hourly. A key longer than 255 characters is a 400 `errors/invalid-idempotency-key` (the unique index cannot hold much more).

**Files whose path is a database value.** `brand_assets.local_path`, `product_assets.local_path` and `place_photos.file_path` are written by the extraction agent, and `documents.file_path` can be rewritten by anything with `psql`. Serve them only through `src/http/files.ts`:

- `resolveStoredFile(root, stored)` returns a path only for a regular file inside `root` (symlinks followed). Never `isAbsolute(p) ? p : join(root, p)`. `resolveInside` is the lexical half, for a path about to be written (brand uploads, the static-map cache directory named after `places.google_place_id`).
- `setStoredImageHeaders` sends `nosniff` plus a `sandbox` CSP and downgrades any non-image type to a download: an SVG opened at its own URL is a document on the app's origin. A route that answers 304 calls `setStoredAssetGuards` first so the 304 carries them too.
- `sendStoredFile(res, absPath)` streams the bytes. Never `createReadStream(p).pipe(res)`: it has no error listener, so a file that exists but cannot be opened ends the process. `sendStoredFile` opens the file before anything is sent, which makes that a 404 or 500 problem document, and `problemHandler` drops the `Cache-Control` / `ETag` the handler had staged so the error is not cached as the image.

`GET /v1/documents/:id/content`, `/rendered` and the re-extract preflight are contained this way. `resolveUploadPath` itself is not: the ingest worker, ingest retry and hard delete (which moves the file into `.trash/`) still follow whatever `file_path` says.

**Check:** `npx tsx scripts/check-http-errors.ts --disposable --db=<url of a throwaway Postgres>` boots the app in-process and asserts all of the above over real HTTP. It writes test rows and leaves them; never give it the ledger's URL. Run it after touching `src/http/`, `src/app.ts`, or how a route fails.

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

### Run records (`agent_runs`)

Every ingest and re-extract run has a row in `agent_runs` (migration 0042, `src/ingest/runs.ts`), written by the server, never by the agent:

- **Before the spawn** the worker inserts it `running`, in the same transaction that moves the ingest to `processing` and sets `ingests.current_run_id`, with a session id it minted. A run that dies at once (auth, spawn) still has its row and its transcript name.
- **After the exit** it becomes `finished` with `outcome` (`written`, `attached`, `unsupported`, `duplicate_skip`, `no_change`, `agent_error`, `failed`), `error_class` (`auth`, `quota`, `overloaded`, `timeout`, `spawn`, `crash`, `agent_reported`, `guard`, `no_closeout`, `apply`), the exit code or signal, and what `src/session-transcript.ts::summarizeSession` reads from the transcript: turns, tool calls, the three input buckets, output, and `model_observed`. The run is finished before the ingest's SSE event goes out.
- **At boot** every run still `running` becomes `abandoned` / `interrupted`, in the same transaction that errors the ingests of abandoned batches, and the boot log line `[ingest worker] boot recovery: …` gives the counts.
- **Timeouts** kill the agent's whole process group (`src/claude.ts::runSupervised`: SIGTERM, then SIGKILL after 15 s), and the worker's slot is released only after the child has closed, so the next extraction never overlaps a dying one. The CLI (2.1.251) runs every Bash tool command in a session of its own, outside that group, so on a timeout the server first reads which groups the CLI's descendants are in and signals those too, and SIGKILLs any of them still alive when the pipes close. After a **normal** exit only the CLI's own group is killed: a tool command the agent left running in the background is no longer the CLI's child by then and is not reached. If something outside the group holds the CLI's pipes after it exits, they are abandoned 15 s later and the exit code stands (it is not turned into a timeout). In the container node is PID 1, so stopping it ends every group; a server killed outside a container leaves its current agent group running.

`writer` is `agent_sql` (the agent writes the ledger, today's only path) or `stub` (the sandbox stub extractor); `EXTRACTION_WRITER` is read per run, and any value other than `agent_sql` is logged and ignored until the server writer is wired in. The server writer's close-outs (`src/ingest/apply/index.ts`, dark) also end runs `recorded_only`, `invalid_record` or `reapplied`, with the classes `fenced_out`, `artefact_missing` and `artefact_invalid`, and store `apply_report`. `scripts/check-ledger.ts` checks that no ended run leaves its ingest open (`run-without-terminal-ingest`).

### Finding a run

```sql
-- Ingest → run(s), newest first; session_id names the transcript.
SELECT id, status, outcome, error_class, session_id, model_observed, turns,
       input_tokens + cache_read_tokens + cache_creation_tokens AS billed_input, output_tokens
  FROM agent_runs WHERE ingest_id = $1 ORDER BY started_at DESC;
```

```bash
T=~/Developer/receipt-assistant-data/claude/projects/-app

# Runs from before agent_runs (migration 0042) have no row: the prompt
# carries the ingest id and the document/transaction ids, so grep finds
# them (docker logs rotate).
grep -l "$INGEST_ID" $T/*.jsonl

# Turns, billed input (fresh + cache read + cache write) and output tokens,
# deduplicated by message.id — the same parser that fills agent_runs.
npm run measure:turns -- --session=<id|path>
npm run measure:turns -- --dir=$T --last=20 --kind=ingest
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

### Accuracy eval — `scripts/eval-dates.ts`

Uploads a manifest of real documents to the sandbox, waits for extraction, and scores date, total, payee, classification, flow and currency per document, with the model, turns and tokens of each run. It defaults to the sandbox and refuses any stack whose container lacks `EXTRACTOR_STUB_ALLOWED=1` (or a base on port 3000) without `--allow-production`, and any with `MAX_CLAUDE_CONCURRENCY` other than 1 without `--allow-concurrency`; the model, writer and concurrency it read off the container go on the report. With `--reset` it waits for the sandbox to go idle and empties it before every trial (a copy of a document the ledger already holds is attached as a near-duplicate, not extracted). The report is rewritten after every trial, so a trial that fails or is interrupted keeps the ones before it. Corpus C1 is `scripts/eval-dates.fixtures.json`; private corpora live outside the repo. Every real extraction costs about a million tokens of quota. Usage, manifest format and scoring: `scripts/eval-dates.md`.

```bash
npm run eval:dates -- --dry-run            # resolve and copy only; no upload
npm run eval:dates -- --reset --limit=6    # the six-fixture sanity set
```

### Dedup regression matrix — `scripts/eval-dedup.ts`

The dedup system (#134/#135) has a dedicated regression harness that
must never be pointed at production. Run it after ANY change to
`src/ingest/prompt.ts` Phase 4a.0, the worker guards, `src/reconcile/*`,
the dedup probes, the pHash code, or the document cascade delete (it
meets apply and undo in cases `cd` and `cs`):

```bash
# sandbox up + reset first:
#   docker compose -p receipts-test -f docker-compose.test.yml up -d --build
#   ./scripts/sandbox-reset.sh
# on the mini (the sandbox listens on 127.0.0.1; from elsewhere, ssh -L both ports)
npx tsx scripts/eval-dedup.ts --base=http://localhost:3001 \
  --pg=postgresql://postgres:postgres@localhost:5433/receipts --with-claude
```

Stub cases are deterministic and take about a minute: `g1-g4` worker
guards, and the reconcile engine's rules — `r1-r3` (identifier match,
card conflict, idempotent re-run), `rf` (refund vs purchase), `sd`
(soft-deleted survivor, re-upload after delete), `l1` (the same bytes
in four requests at once), `rc` (recurring equal-price charges), `ib`
(in-batch identifier rules), `nd` (agent verdict respected), `pp` (one
proposal per pair), `cl` (survivor must be live at apply), `un`
(undo), `rd` (a reconciled row survives), `ch` (chained applies are
undone newest first), `cd` (apply, cascade-delete the moved document,
undo: refused with `no_live_document`), `cs` (apply, cascade-delete the
survivor's own document, undo: refused with `survivor_no_live_document`).
Every seed carries a per-run nonce in
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
that env on the production compose. Its `child` mode runs a fake agent
process through the same supervisor as `claude -p` (own process group,
group kill on timeout, a grandchild that outlives it, and one in a
session of its own as the CLI's Bash tool runs commands), for testing the
timeout and slot-release path without a real run; see the header of
`src/ingest/stub-extractor.ts`. Don't run the claude cases while
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

Auth is a **long-lived `claude setup-token`** supplied via the `CLAUDE_CODE_OAUTH_TOKEN` env var (read from `.env`), **not** an interactive `/login` session and **not** an API key (the child's environment is an allowlist built in `src/claude.ts::buildClaudeEnv`: `CLAUDE_CODE_OAUTH_TOKEN` is on it and `ANTHROPIC_API_KEY` is not, which is what forces subscription auth). The token is the SSOT-stored `anthropic/oauth-token` in personal-vault — a setup-token on the Max-subscription quota, ~365-day TTL, fp `632c964f037d` — **the same token OpenClaw (agents `main` + `autotrader`) already runs on**. One line in `.env`:

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
