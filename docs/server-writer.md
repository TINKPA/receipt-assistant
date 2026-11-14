# The server writer

The extraction agent reads a document; server code writes the ledger. This document describes that design as it is built: the record the agent hands back, how the server checks and stores it, how it derives ledger rows from it, and how the change is rolled out. It is written for a maintainer who has only this repository.

Status: built and deployed dark. Production runs `EXTRACTION_WRITER=agent_sql`, the legacy path on which the agent writes the ledger itself through `psql`. Nothing in production calls the server writer until the flip described under "Rollout".

`CLAUDE.md` keeps the operational side: the environment variables, what the boot and log lines mean, the commands that run each check, and the queries that read a run. Code comments cite sections of this file as `docs/server-writer.md, "<heading>"`. The headings are stable on purpose; rename one only together with the comments that cite it.

## Why the agent no longer writes SQL

Under the legacy writer one `claude -p` run reads the document and then writes everything with `psql`: it reads duplicate candidates, the brand row and the place cache, decides attach or insert, inserts the transaction, postings, items, catalog rows and parties, and finally closes its own ingest row. That has five costs.

- **What an injection can reach.** The agent logs in as `receipts_agent`, which may insert into and update the tables the legacy prompt writes, on any row. A document is text a stranger wrote, and it is pasted into the prompt. A record carries one document's reading and nothing else: ids come from the server's context, the attach target is chosen by code from live candidates of the same direction, every statement is parameterised, every size is capped, and the free-form bags are never read by duplicate detection. The record agent has no `DATABASE_URL`, no WebSearch and no logo key.
- **Partial writes.** The write was several psql calls over several turns, and some of it (parties, the place, the document stamp) ran after the ledger transaction committed. A failure part way left a transaction without them. The server writes the ledger, the catalog, the parties, the place, the document stamp, the events, the ingest close and the run finish in one database transaction.
- **Lost evidence.** When the agent attached a document to an existing transaction, or rejected it as unsupported, its reading was thrown away. Every reading is now stored, unchanged, before anything is derived from it. A failed write is retried by applying the stored reading again, never by reading the document again, and a rule change can be measured by re-projecting stored readings.
- **Duplicate decisions.** The agent decided attach or insert from a candidate read that gave it payee, date and the five identifiers. Code sees those plus card last-4, the time of day and the line items, decides the same way every time, and decides under a lock, so two copies in flight cannot both insert.
- **Turns.** The candidate read, the write and the close-out were turns of their own. They are gone from the record run.

What stayed with the agent, on purpose, so that the A/B comparison measures the writer and not a change in reading: the whole reading of the document, the place resolution (Phase 3a) and the payee cross-check (Check C), signed totals, the choice of expense category, the model's own tax, tip and discount allocation across lines, and the brand slug. The products upsert and the items insert are the same SQL fragments the legacy prompt renders (`src/ingest/items-sql.ts`), bound instead of pasted.

The record is written after free reasoning, at the end of the final message. It is not the structured-output mode that "Known Pitfalls" in `CLAUDE.md` rules out: the model reasons in plain text first, and nothing forces its output into a schema while it reads.

What this does not change: the agent still has an unrestricted shell running as the server's own Unix user ("What this does not bound" in `CLAUDE.md`), and re-extract still runs on the legacy writer.

## The two writers

`EXTRACTION_WRITER` picks the writer per run: `agent_sql` (the default in both compose files) or `server_apply`. Any other value is logged once and runs `agent_sql`. The run row records what wrote the ledger in `agent_runs.writer`: `agent_sql`, `server_apply`, or `stub` for a legacy sandbox stub.

| | `agent_sql` (arm A) | `server_apply` (arm B) |
|---|---|---|
| Prompt | legacy rendering, `PROMPT_VERSION` | record rendering, `RECORD_PROMPT_VERSION` |
| Agent profile (`src/claude.ts`) | `extraction`: Bash, Read, Write, Edit, WebSearch; `DATABASE_URL` as `receipts_agent`; Google and logo keys | `extraction_record`: Bash, Read, Write; no `DATABASE_URL`; the Google key only (Phase 3a and Check C) |
| Who writes the ledger | the agent, through psql | `src/ingest/apply/`, from the stored record |
| Duplicate decision | the agent (prompt Phase 4a.0) | `src/ingest/apply/decide.ts` |
| Worker path | `extractAndClose` | `extractRecordAndApply` |
| Guards on what the agent claims (#125, #133, #134) | yes | none: this agent writes nothing to check |

A sandbox stub upload takes the path its file names, whatever the variable says: a `terminal` stub the legacy one, a `record` stub the server writer's (its run is `server_apply`, its record's origin `stub`).

### Two renderings of one prompt

`buildExtractorPrompt` renders one template two ways. Every block that is about writing is wrapped in `forWriter(writer, legacyText, recordText)`, so the reading text both arms share has one source and the arms cannot drift apart.

- The legacy rendering is frozen. `scripts/check-prompt-render.ts` hashes it for fixed contexts that reach every branch of the template and compares the hashes with a golden taken before the server writer touched any prompt file. It runs before every build. The golden is never updated to make the check pass.
- The record rendering drops psql, the legacy turns A, B and C, the Message-ID and near-duplicate steps, Phase 2.6's web search and brand upsert, the place fetch and projection (3b to 3d), the icon gate, the close-out and the provenance template. It keeps every reading rule: Phases 0 to 2.7, the date self-checks, Phase 3a, Check C, Phase 3e, the identifier contract, and the owned-item and party judgments. It ends with "Hand back your record" (see "The hand-back"), which includes the contract text generated from the schema.
- The decoded email body is fenced by a name drawn at random per run, so a sender cannot close the block early; the legacy rendering keeps its fixed name. An attachment's file name is printed quoted, cut and escaped.
- Lessons in `src/ingest/lessons.md` tagged `[write]` (SQL or template mechanics) are left out of the record rendering; lessons tagged `[record]` appear only there.
- `scripts/check-prompt-budget.ts` keeps a baseline for each rendering, and `scripts/check-agent-grants.ts` fails when the record rendering contains SQL, `psql`, `DATABASE_URL`, WebSearch, the logo key or the Google place-record endpoint.

## The run flow

Both writers start the same way. The worker claims an ingest, and in one short transaction (T0) inserts the `agent_runs` row (`running`, the writer, a session id the worker mints, the prompt version) and sets the ingest to `processing` with `ingests.current_run_id` pointing at that run. The run id is the fence every later write checks.

### The legacy writer

`agent_sql`: spawn `claude -p` with the legacy rendering on stdin; the agent reads, writes the ledger and closes the ingest itself; the worker reads the ingest row back, puts it through the guards, finishes the run, runs the points and FX passes, and sends the SSE event.

### The server writer

`server_apply`, in `extractRecordAndApply` (`src/ingest/worker.ts`):

1. **Decode.** An `.eml` or HTML upload is decoded by the server (`decodeSourceForAgent`): the text the agent is shown, and the envelope from the server's own MIME parse. Images and PDFs decode to nothing.
2. **Message-ID check, before any spawn.** When another document of the workspace carries the email's Message-ID and a live transaction stands behind it, the new document is linked to that transaction and the ingest closes `dedup` without spawning anything (see "The Message-ID duplicate").
3. **pHash neighbours.** The live transactions behind perceptually near documents become duplicate candidates for the applier, never a decision.
4. **Spawn, hand back, parse, validate, repair** (`runRecordExtraction` in `src/ingest/extractor.ts`). The record rendering goes on stdin with the `extraction_record` profile and the run's session id. The record is found in the output (see "The hand-back"), validated (see "Validation"), and while it is invalid and rounds are left, sent back to the same session (see "The repair round"). Nothing is written in this step.
5. **Store: T1** (`recordExtraction`). The record is stored, valid or invalid (see "The evidence store"). A record still invalid after the last round errors the ingest and finishes the run in the same transaction.
6. **Place prefetch**, outside any transaction (see "The place").
7. **Apply: T2** (`applyExtraction`). One fenced transaction derives and writes the ledger, closes the ingest and finishes the run (see "applyExtraction").
8. **After commit.** The points valuation, then the FX pass, on what the apply wrote (both idempotent, neither can fail the ingest); the SSE event; the batch's completion, which starts reconcile; and the record's `lesson_proposal`, appended to the proposed-lessons file after a successful apply, stripped of control characters.

Every exit finishes the run before the SSE event and the batch bookkeeping. A run that has lost its ingest to a newer run finishes `failed` / `fenced_out`, touches nothing else, and sends no `job.error`: the ingest is its new owner's to report.

A crash or deploy between T1 and T2 leaves a valid, unapplied record. Boot recovery errors the ingest as it does any in-flight one; a manual retry reads the document again, and the new record supersedes the old. Applying the stored record instead (an apply-only retry) needs the durable queue (P6 under "Phases"); `reapplyRecord` already exists for it.

## The extraction record

`src/ingest/contract/v1.ts` is the source of truth: a zod schema (`ExtractionV1Schema`) and the text the prompt shows for it, `renderContractForPrompt()`, which is generated from the same schema field by field from each field's `.describe()` text and checks. The prompt and the validator therefore cannot disagree about a name, an enum value, a cap or a format. A rule that spans fields lives in `validate.ts` and is also stated in the describe text of the field it governs.

### Shape

| Field | Required | What it carries |
|---|---|---|
| `contract_version` | always | the literal `1` |
| `classification` | always | `receipt_image`, `receipt_email`, `receipt_pdf`, `statement_pdf` or `unsupported`. The three `receipt_*` values book a transaction. |
| `unsupported` | when, and only when, `unsupported` | `{reason, note}`; reason `not_a_receipt`, `transfer`, `marketing`, `unreadable` or `other` |
| `source_used` | optional | which form was read: `image`, `pdf_text`, `pdf_raster`, `email_body`, `email_attachment`, `html` |
| `facts` | `receipt_*` only | `flow` (`purchase`, `refund`, `income`), `occurred_on`, `occurred_at` (with offset, or null), `payee`, `payee_as_printed`, `payee_source`, signed `total_minor`, `total_printed`, `currency` |
| `payment` | default `{method: "unknown"}` | `method` (see "Tenders"), `card_last4`, `card_network`, `as_printed` |
| `points`, `cash_component` | points currency only | the programme name; the cash part of a points-and-cash payment |
| `income` | income flow only | `deposit_account` (Checking, Savings, Cash) and `income_account` (Salary, Other) |
| `identifiers` | default `{}` | the five contract keys only: `order_number`, `confirmation_number`, `invoice_number`, `payment_id`, `approval_code` |
| `other_references` | optional | any other printed reference, snake_case keys; never read by duplicate detection |
| `merchant` | `receipt_*` only | `canonical_name`, `brand_id` (slug), `brand_name`, `category` (one of the seven expense accounts), `category_hint`, `domain_hint` (printed or the sender's domain only), `name_zh_printed` |
| `place` | optional | `google_place_id` or null, `resolved_via`, `address_printed` |
| `items` | default `[]` | the line items, in the legacy `ITEM_SCHEMA` names, plus `track_as_owned` |
| `sold_item` | income only | what an income record sold: `product_key`, `name_as_printed` |
| `parties` | default `[]` | `{role, display_name, brand_id, line_no}`: channel, seller, maker, acquirer |
| `printed_totals` | optional | printed subtotal, tax, tip, discount and fees |
| `statement_rows` | `statement_pdf` only | one row per statement line |
| `audit` | `receipt_*` | the agent's self-check: raw payee, the place lookup's name, whether a correction was applied, date candidates and the reason for the choice, the year check, a note, review flags |
| `receipt_facts` | optional | other printed facts, snake_case keys, small values |
| `lesson_proposal` | optional | one lesson for future extractions |

The receipt text does not travel inside the JSON. It has its own fenced block (see "The hand-back").

### Rules of thumb

- **Closed.** Every object is `.strict()`: a key the schema does not list is refused wherever it appears. That is how the keys the record must never carry are kept out: ids of any kind, statuses, account ids, base amounts, `fx_rate`, provenance, duplicate verdicts, email headers, place rows (`FORBIDDEN_PAYLOAD_KEYS`). The server has all of these already.
- **Ids come from the server.** The record never names a ledger row. Which transaction a document attaches to is decided by code.
- **Money in minor units, signed.** Integers in the currency's own minor unit at the exponent `src/ledger/money.ts` gives it: cents for USD, whole yen for JPY, fils for KWD, whole points for a `_PT` programme. A refund's total and lines are negative, a discount line is negative as printed, income stays positive.
- **Names follow the legacy template.** Field names are the legacy prompt's placeholders and `ITEM_SCHEMA` verbatim, so the model's job changes from "put these values in SQL" to "put these values in JSON".
- **Omit rather than invent.** A field the document does not show is left out, or null where null is allowed.
- **Two bags, bounded.** `other_references` (at most 20 keys) and `receipt_facts` (at most 30 keys and 4 KB) take whatever printed fact fits no field. They are stored under their own metadata keys, and nothing reads them as a ledger field.
- **One field, one meaning.** The five identifier keys are the only ones duplicate detection reads, and the same five as `IDENTIFIER_KEYS` in `src/reconcile/dedup.ts`; the build fails if the two lists differ.

### Versions

| Constant | Where | Names | Bump when |
|---|---|---|---|
| `EXTRACTION_CONTRACT_VERSION` | `src/ingest/contract/v1.ts` | the record's shape | any change to the zod shape, always together with `RECORD_PROMPT_VERSION` |
| `RECORD_PROMPT_VERSION` | `src/ingest/prompt-contract.ts` | the record rendering | any semantic change to it, under the rules for `PROMPT_VERSION` in `CLAUDE.md` |
| `APPLIER_VERSION` | `src/ingest/apply/version.ts` | the rules that turn a record into rows: projection, accounts, metadata, dedup, catalog | any change to one of those rules; no prompt bump |
| `PROMPT_VERSION` | `src/ingest/prompt-contract.ts` | the legacy rendering and re-extract | frozen while both writers exist |

Rows written by the server writer stamp the record prompt's version on `metadata.extraction.prompt_version` and on `transaction_items.extraction_version`, and `metadata.extraction.writer = 'server_apply'` tells the two prompt lines apart. When the legacy writer is retired the prompt constants collapse into one.

## The hand-back

The record prompt asks the agent to end its final message with, in this order and nothing after:

1. for a photo or a PDF (text layer included, because the server decodes only email and HTML): one ```` ```receipt-text ```` block with its full transcription, in a fence longer than any backtick run inside it;
2. exactly one ```` ```json ```` block holding the record, an object that starts with `"contract_version": 1`.

The server pulls the record out of the output (`parseArtefact` in `src/ingest/contract/artefact.ts`). The agent has no channel to push one in: no endpoint, socket or file path.

- **Where.** stdout first: `claude -p --output-format text` prints the final message. When stdout has no record (the model kept talking, or stdout was lost), the session transcript is read, newest message first, and only the text blocks of assistant messages: never a tool result, a tool call's input, a user turn, a thinking block or a sub-agent's message. Those carry text the agent was shown or wrote to a file, which is where a document could plant a fake record.
- **Which block.** Fences are read line by line as CommonMark reads them. The record is the last ```` ```json ```` block that mentions `contract_version`, found by reading back from the end of the message, so a transcribed line of bare backticks cannot throw the pairing out and let a planted block stand in for the record. An opener inside a properly closed receipt-text block is transcription and is passed over. The first such block met from the end is the record even when it does not parse: an earlier one is a draft the agent moved past.
- **Caps.** 256 KB for the json block, 64 KB for the receipt text. Over a cap is the `size_cap` error.
- **Storable text.** U+0000 is removed and a lone surrogate replaced in all model and document text (`pgSafeText`), because Postgres stores neither and one such character used to fail the record's storage whole.
- **Nothing found** is `artefact_missing`: no record is stored, and the last 2 KB of stdout go on the run's `agent_report`.

The run's `agent_report` records where the record was found (`artefact_source`: `stdout` or `transcript`) and whether the message went on after it (`trailing_text`).

## Validation

`validateExtraction` in `src/ingest/contract/validate.ts` never throws. It produces normalisations, errors and warnings, each with a stable `rule` id, stored on the record as `document_extractions.validation`. Every error is found in one pass, including the cross-field rules on a record whose shape is partly wrong, so one repair round hears about all of them. Dates are judged against the upload time (`ingests.created_at`), never the clock, so a record re-validated later gets the same verdict.

### Normalisations

Applied deterministically and listed on the record (`validation.normalizations`, with a count and the first ten paths each); never bounced.

| Rule | What |
|---|---|
| `unsafe_character_removed` | U+0000 removed and lone surrogates replaced, in every string and key |
| `trim` | strings trimmed |
| `empty_to_null` | `""` becomes null where the field may be null |
| `null_to_default` | a null where the field has a default (and may not be null) is dropped, so the default applies |
| `identifier_empty_dropped` | an empty identifier value is dropped |
| `reference_empty_dropped` | an empty `other_references` value is dropped |
| `currency_uppercased` | currency codes upper-cased |
| `domain_hint_lowercased` | `merchant.domain_hint` lower-cased |
| `item_currency_defaulted` | an item with no currency gets the transaction's |
| `item_line_type_defaulted` | an item with no `line_type` gets `product` |
| `brand_name_defaulted` | `merchant.brand_name` defaults to `canonical_name` |
| `party_line_dropped` | a party whose `line_no` names no item is dropped (and warned) |
| `channel_party_added` | a receipt with no `channel` party gets the merchant as its channel |
| `income_defaulted` | an income record with no `income` block gets Checking and Other (and is warned) |

### Validation errors

Errors cover structure, the contract and impossible values only. They bounce the record to the repair round; a record still in error after it is stored as `invalid` evidence.

| Rule | Condition |
|---|---|
| `json_parse` | the json block is not valid JSON, or not one object with `contract_version` |
| `schema` | the schema refuses it: a wrong type, enum value or format, a missing required field, a key that is not in the contract (a forbidden key says the server supplies it) |
| `required_for_classification` | a `receipt_*` record without `facts`, `merchant` or `audit`; `facts` or `merchant` on any other classification; `unsupported` without its block or the block on another classification; `statement_pdf` without `statement_rows` or rows on another classification |
| `calendar_date` | `occurred_on` or a statement row's date is not a real date; `occurred_at` is not a real date, time and offset |
| `future_date` | `occurred_on` is more than 2 days after the upload |
| `ancient_date` | `occurred_on` is before 2000-01-01 |
| `currency_unknown` | the main currency, the cash part's or a statement row's is neither an ISO 4217 code in the `money.ts` table nor a points code (`ISSUER_PT`) |
| `sign_flow_mismatch` | a purchase or income with a negative total, or a refund with a positive one |
| `points_contract` | a points currency without `points`; `points` with a cash currency or without `facts`; `cash_component` without `points`, or in a points currency or the main currency |
| `flow_fields` | `sold_item` or `income` on a flow other than income |
| `line_no_duplicate` | two items share a `line_no` |
| `parent_line_missing` | `parent_line_no` names no item, or the item itself |
| `item_currency_foreign` | an item's currency is neither the record's nor its cash part's |
| `size_cap` | a block over its byte cap, an array over its length cap (400 items, 50 parties, 1000 statement rows, and the smaller lists inside), or a bag over its key or byte cap |

### Validation warnings

Warnings are stored and never bounced. Those decided from the record alone are computed by the validator and stored on the record. Those found while the record is applied go on the run's `agent_runs.apply_report`, because by then the record row is written and immutable. A warning marked money is about an amount, a currency or the money's direction; gate G2 counts those.

| Rule | Where | Condition |
|---|---|---|
| `items_total_residual` (money) | record | per currency charged, the lines' effective amounts (`line_total + tax + tip − discount share`, leaving out the tax, tip and discount rows whose money is spread as shares) miss the total by more than max(5 minor units, 1%) |
| `printed_total_mismatch` (money) | record | `total_printed` cannot be read as an amount, or reads as another magnitude at the currency's exponent |
| `date_far_past` | record | more than 400 days before the upload |
| `occurred_at_date_mismatch` | record | the date in `occurred_at` differs from `occurred_on` |
| `email_without_time` | record | an email with no `occurred_at` |
| `raw_text_missing` | record | a photo or PDF handed back without a receipt-text block |
| `no_items` | record | a receipt with no line items |
| `income_defaults_applied` (money) | record | income without the `income` block |
| `party_line_dropped` | record | a party's `line_no` matched no item |
| `mixed_tender` (money) | record | a purchase or refund paid with `mixed` (see "Tenders") |
| `review_flag_<flag>` | record | one per entry of `audit.review_flags` |
| `repair_changed_unnamed` (money on money fields) | record | the repair round changed a field no error named |
| `refund_of_dropped` | apply | several purchases share an identifier with a refund, so none is named |
| `category_differs_from_merchant` | apply | the merchant row, fixed at first sight, has another category |
| `place_fetch_failed` | apply | the place was not cached and could not be fetched |
| `place_not_projectable` | apply | the fetched place has no English body with an address and a location |
| `account_overridden` (money) | apply | `points` named on a cash currency (booked to Credit Card), or income in a points currency (deposited in the points account) |
| `owned_items_skipped` | apply | `track_as_owned` on a line that cannot be tracked, or a sold item that could not be retired |

## The repair round

An invalid record goes back to the session that wrote it, at most `EXTRACTION_REPAIR_ROUNDS` times (default 1; an integer is clamped to 0 to 2). The server writes the list of problems (`renderRepairRequest`): one line per error naming its path and rule, never a value, with a request to re-read the region where the rule is about the reading, and an instruction to resend the whole corrected record (and the receipt-text block if one was given) and to change nothing else. A path prints a key the model invented quoted, cut to 40 characters and escaped, so it cannot forge a line of the request, `ingests.error` or a log line.

The round is `claude -p --resume <session id>` with the list on stdin. What the pinned CLI was measured to do (`scripts/probe-cli.ts`), and what the code relies on:

- The resuming spawn's `--tools` decides the tool list, not the session's history, so the profile's flags are applied again on every resume.
- `--session-id` together with `--resume` is refused unless `--fork-session` is also given, so a resume passes no `--session-id`.
- A plain resume continues the same session id and transcript file: one run keeps one transcript.
- The resumed turn reads the earlier conversation from the prompt cache instead of paying for it again.

Only server code fills `resumeSessionId`, and only with the session id it minted for the same run, so a document cannot steer a spawn into another conversation. `EXTRACTION_REPAIR_ROUNDS` stays 0 on a CLI version where the probe's gating checks fail.

What is kept between rounds:

- The round has its own timeout (300 s), shorter than a first read.
- Only what the round added is parsed: the new stdout, and the transcript from the byte offset it had before the resume, so the earlier record is never taken for the repaired one.
- A round that hands back no record leaves the earlier one standing.
- A reply that resends the json without the receipt-text block keeps the earlier transcription.
- The repaired record is compared with the one it replaces (`diffRepair`): a change at a path no error named is a `repair_changed_unnamed` warning, marked money when the path is an amount, a currency, the classification, the flow, the category, the payment method or an income account.
- The record's report notes each round and the errors it was asked to fix; the run stores `repair_rounds`.

Never sent back: a missing record (there is no field to name), and the output of a first spawn that failed (a run that timed out or crashed handed nothing back). A repair round whose spawn fails ends the loop: the earlier, invalid record is stored as evidence, and the run ends `agent_error` with that spawn's class (`agent_report.repair_spawn_failed` names it), because the outage is what happened, not a bad reading.

## The evidence store

`document_extractions` (migration 0043, `src/schema/document_extractions.ts`) holds one row per reading of a document. `src/ingest/records.ts` is its only writer.

- **Columns.** The record as validated (`result`; for an invalid one, what was handed back), the receipt text (`raw_text`), the validation report, the origin (`agent`, `stub`, `ledger_backfill`, `manual`), the run, ingest and document, the prompt version and git sha, the model that answered (never `cli-default`), a hash of the decoded source text the agent was shown, `input_meta` (the pHash neighbours, attachment sizes and hashes, the prompt size), and promoted copies for lookups: classification, flow, date, total, currency, payee, identifiers, card last-4. For an invalid record only the well-formed values are promoted.
- **Immutable.** A trigger refuses every UPDATE that changes anything but `superseded_at`, except an `ON DELETE SET NULL` foreign key clearing a reference to a run, ingest or record that is gone.
- **Supersession.** A newer valid reading of the same document is a new row that names the old one in `supersedes_id`; the old one gets `superseded_at`. A partial unique index keeps at most one current valid record per document. An invalid record supersedes nothing: it is evidence of what the agent handed back, not a reading the ledger can use. Writes for one document are serialised by a transaction-scoped advisory lock on the document id, not a row lock, so they stay out of the ledger's lock order.
- **Pointers.** Derived rows name their record: `agent_runs.extraction_id`, `transaction_items.extraction_id`, `derivation_events.extraction_id` (with `applier_version`, for re-extract on records), the transaction's `metadata.extraction.extraction_id`, the `created` and `document_linked` event payloads, a `merge_audit` entry, and `ingests.produced.extraction_ids`.
- **Deletion.** Deleting the document deletes its records: a hard delete is a purge.
- **Roles.** `receipts_agent` has no grant on the table; `receipts_ro` (Ask) reads it like every other table.

T1 (`recordExtraction`) is one transaction, fenced like the apply: it locks the ingest where `current_run_id` is this run and the status `processing`, and the run is still `running`; otherwise it stores nothing. A document hard-deleted while the agent read has no row to hang a record on: the ingest errors `apply failed: document_missing`. Otherwise the record is stored and the run pointed at it. When the record is invalid and no round is left, the same transaction errors the ingest (`extraction record rejected: <path>: <rule>`, with `(+N more)`) and finishes the run `invalid_record` / `artefact_invalid`, or `agent_error` when a repair round's spawn failed. A run that handed back no record at all is closed by `closeRunWithoutRecord`: the ingest errors `extraction record missing: …` and the run ends `invalid_record` / `artefact_missing`.

## applyExtraction

`src/ingest/apply/index.ts` holds the entry points the worker calls; `write.ts` holds the transaction's body.

| Entry point | What it does |
|---|---|
| `recordExtraction` | T1 (previous section) |
| `closeRunWithoutRecord` | the close for a run that handed back no record |
| `applyExtraction` | T2 for a record T1 just stored |
| `applyMessageIdDuplicate` | the Message-ID link before any spawn |
| `reapplyRecord` | apply a record already stored; the run ends `reapplied` |
| `dryRun` | project, find candidates and decide in a READ ONLY transaction |
| `runPostCommitPasses` | the points valuation, then the FX pass, on what an apply wrote |

### Transaction boundaries

| Step | Boundary | On failure |
|---|---|---|
| T0 claim | one short transaction | the ingest errors; nothing spawned |
| Spawn, parse, validate, repair | no database | the run's error class (`auth`, `quota`, `timeout`, `spawn`, `artefact_missing`, …) |
| T1 store | one transaction | nothing stored; the ingest errors |
| Place prefetch | network, outside any transaction | warning `place_fetch_failed`; the apply goes on without a place |
| T2 apply | one transaction | rolled back whole; the record stays valid and unapplied |
| After commit | separate, idempotent | logged; the FX and points passes can be run again |

The apply transaction never waits on Google: the place is fetched before it opens.

### Prologue and run fence

T2 begins, in this order:

1. `lock_timeout` 10 s and `statement_timeout` 60 s, for this transaction only.
2. The workspace apply lock: a transaction-scoped advisory lock on the workspace (`takeWorkspaceApplyLock`). Every server apply in a workspace takes it first, so "look for a duplicate, then insert" is atomic: two copies of one receipt applied at once are serialised, and the second sees the first one's transaction as a candidate. Production still runs one extraction at a time; the lock is the precondition for ever raising that.
3. The run fence: the ingest row `FOR UPDATE` where `current_run_id` is this run and the status is `processing`, and the run row still `running`. Zero rows is `fenced_out`: a newer run owns the ingest, or this run's apply already closed it.
4. No transaction may already carry `source_ingest_id` = this ingest (`already_applied`).
5. The document exists in the workspace and is not deleted, read without a lock (`document_missing`, `document_deleted`).

Then the Message-ID check runs again, under the lock (see "The Message-ID duplicate"), and the branch for the record's classification.

Because the ingest close is written in the same transaction as the ledger rows, a terminal ingest means the record was applied, and a second apply for the same run is fenced out. Every id written comes from the server's context (the ingest, run and record rows), never from the record.

### Lock order

The order in `CLAUDE.md` ("Editing a transaction through the API") is postings, then transaction head rows, then the document. The apply keeps it, with the ingest row in front:

- The ingest row is locked first, by the fence, and held to the end. T1 holds it the same way.
- A transaction head row is next: the attach target `FOR UPDATE`, or the new row the insert creates. The postings an insert writes are new rows and conflict with nothing.
- The document is locked last: by `linkDocumentIn` (which takes the transaction row and then the document, and re-checks `deleted_at` under the lock), and by the stamp's UPDATE on the branches that link nothing.
- The advisory locks (workspace apply lock, the record writer's per-document lock) are outside the row order.

The prologue reads the document without locking it on purpose. Locking it there (`FOR KEY SHARE`) would put the document before the attach target, against the order, and a cascade delete (head rows, then the document `FOR UPDATE`) could deadlock with it.

One cycle remains: a HARD document delete holds the document and then reaches the ingest row through `ingests.document_id ON DELETE SET NULL`, the other way round from an apply. When the two meet, Postgres ends one with 40P01. Either way nothing is lost: the delete answers 409 `concurrent-update`, or the apply retries, finds the document gone and errors its ingest (`document_missing`). Soft deletes never touch the ingest row.

### The insert, in order

For a `receipt_*` record, the pure projection runs first (`project(record, catalog)` in `project.ts`, over the workspace's chart of accounts and its merchant row for the brand; see "Accounts and postings"), then the candidates and the decision (see "Attach or insert"). An insert writes, in this order (the letters are the ones the code's comments use):

| | Write | Rule |
|---|---|---|
| a | the merchant's brand | upsert on `brand_id`. A real name is never overwritten; only a slug stub (a row whose name is its own `brand_id`) is upgraded to the record's name. The domain fills only an empty one. `user_chose_at` and `metadata` are never written. |
| b | product brand stubs | the legacy `brandFkGuard` fragment, bound, `DO NOTHING` |
| c | the points account | for a points currency with no account yet: `<programme> points`, an asset of subtype `points`, created under the workspace's `Assets` root |
| d | account ids | resolved by the projection; a missing account is `account_missing` |
| e | the merchant | the legacy upsert: an existing row only gets `updated_at`, so the first sight of a merchant fixes its name and category |
| o | the place | cache hit or insert (see "The place"); before f, so the transaction row carries `place_id` |
| l | the sold item (income only) | retire the one live owned instance of the product with the record's `product_key`; with no key, none or several instances, nothing is retired and `metadata.owned_items_note` says why. A condition the user set is kept. |
| f | the transaction | new id, payee, date, time, status `posted`, `source_ingest_id`, merchant, place, `created_by` the workspace owner, metadata from "Transaction metadata" |
| g | postings | one pair per currency, `amount_base_minor = amount_minor` and no `fx_rate` |
| h | the document link | `linkDocumentIn`, in the lock order |
| i | products and line items | one statement built from the `items-sql.ts` fragments with bound values: the products upsert (`DISTINCT ON` the product key) and the items insert, run 1, `extraction_version` the record prompt's version, `extraction_id` the record |
| j | balance | `SET CONSTRAINTS ALL IMMEDIATE` fires the deferred trigger (which checks the base-currency sum), then code checks that every currency sums to zero in `amount_minor` (`unbalanced`) |
| k | owned items | one row per unit of each durable product line marked `track_as_owned`, at most 100 per line and 500 per receipt |
| m | product statistics | the shared `recomputeProductStats`, for the products touched, over live transactions only |
| n | parties | one row per party, a line-level one pointing at the item of this run with its `line_no`; duplicates by the table's identity skipped |
| p | the `created` event | the shape `createTransaction` writes, plus the ingest, run and record ids |
| q | the document stamp | see "The document stamp"; then the ingest closes `done` and the run finishes `written` |

### The attach

When the decision is attach: the target is locked `FOR UPDATE` and the candidates are read and decided again under that lock. A different answer (the target was deleted or changed while the apply waited) is the retryable `attach_target_changed`, so the retry starts over and sees the change. Then the document is linked, an entry is appended to the target's `metadata.merge_audit` (the document, ingest, record and run, the tiebreaker, the reason built by code, `decided_by: 'applier'` and the applier version), a `document_linked` event is written, and the document is stamped. The ingest closes `near_dup` with the target as its transaction; the run finishes `attached`. Nothing is written to the catalog; the record keeps the items as evidence. The UPDATE moves the target's `version`, as the legacy attach did.

### Records that book nothing

- `unsupported`: the document is stamped and the ingest closes `unsupported` with the record's note (or `unsupported: <reason>`) as its error. The run finishes `unsupported`.
- `statement_pdf`: the statement is recorded, not booked. The document is stamped and the ingest closes `unsupported` with the error `statement recorded as evidence; statement booking is not built (#175)`. The run finishes `recorded_only`. `docs/statement-ingestion-design.md` is the design for booking statements.

### The Message-ID duplicate

An email whose Message-ID another document of the workspace carries, when that document is linked to a live transaction, is the same email forwarded again. It runs twice:

- before any spawn (`applyMessageIdDuplicate`), so the agent never reads a known email;
- inside T2, under the apply lock, because the first check cannot see a copy of the same email that was applied while this run read.

Each live transaction the earlier copy supports is locked `FOR UPDATE` in id order and re-read under the lock; the new document is linked to each, with a `merge_audit` entry (`decision: 'message_id'`) and a `document_linked` event; the document is stamped with the server's decode; the ingest closes `dedup` with `duplicate: same Message-ID as an email already linked to a transaction`, and the run finishes `duplicate_skip`. Before a spawn the run is finished with no session id, model or CLI version, since nothing ran. A Message-ID whose transactions are all deleted is not a duplicate: nothing is written, and the email is extracted again. Inside T2 the record stays stored as this document's reading.

### The document stamp

Every branch stamps the document in the apply transaction:

- `source_ingest_id`;
- `ocr_text`: the record's receipt-text block, with `ocr_model_version` the model that answered (else the one requested, never `cli-default`); else the server's own decode of an email or HTML source, with `ocr_model_version = 'server-decode/1'`; else the column keeps what it has;
- for an email, `message_id` and `source_meta {channel, sender, subject, received_at, message_id}` from the server's MIME parse, never from the model. `message_id` stays NULL when another document of the workspace already holds it (the unique index: that one is the original); `source_meta` still records it.

The stamp's UPDATE requires the document to be live; zero rows is `document_deleted`.

### Failures and retries

An attempt that fails with 40001 (serialization), 40P01 (deadlock), 55P03 (lock timeout) or a retryable refusal (`attach_target_changed`) is retried in-process: three attempts in all, with a short pause. After that, or on any other failure, a short transaction errors the ingest (`apply failed: <code>`, plus the message for the applier's own refusals and the constraint name for a Postgres one, never a value) and finishes the run `failed` / `apply`. The record stays valid and unapplied. The run's finish there runs under a savepoint and names the record only while it still exists, so the ingest's close commits even when the document, and with it the record, was hard-deleted between T1 and T2. A fenced-out apply touches only its own run.

| Code | Meaning |
|---|---|
| `fenced_out` | the ingest is not this run's, or the run is not running |
| `already_applied` | a transaction already names the ingest |
| `document_missing`, `document_deleted` | the document is gone, or was deleted during the apply |
| `record_missing`, `record_unusable` | the record is not this document's, is invalid, or no longer parses |
| `account_missing` | the chart of accounts lacks an account the projection needs: a seeding fault, never sent back to the model |
| `attach_target_changed` | retryable; see "The attach" |
| `unbalanced` | a currency does not sum to zero |
| a SQLSTATE, `internal` | anything else |

## Attach or insert

`src/ingest/apply/candidates.ts` finds the candidates; `decide.ts` makes the decision. The decision is pure: it reads only the record and the candidates found under the workspace apply lock. It reuses `IDENTIFIER_KEYS`, `compareIdentifiers`, `flowsDisagree` and `cardLast4` from `src/reconcile/dedup.ts`, so a change to how reconcile reads a pair changes it here too.

### Candidates

From `ledger_live_transactions`, so a soft-deleted row is never an attach target, at most 25, nearest `occurred_on` first:

- **(a) amount**: the signed sum of the profit-and-loss legs (expense positive, income negative) in the record's own currency and minor units equals the record's signed total, within ±3 days. Skipped when the total is 0: a zero total says nothing (#205).
- **(b) identifier**: any contract identifier value of the record equals any of the five keys on the row, within ±30 days. Any key against any key, so an invoice number filed as an order number is still found; the decision says what counts.
- **(c) pHash**: the live transactions behind the perceptually near documents (pHash distance at most 2) the worker found before the run.

Each candidate carries what the decision needs: its direction (`directionLateral`, shared with reconcile), its native total in the record's currency, identifiers, card last-4, time, merchant brand and canonical name, and the totals of its live line items.

### The decision

0. **Direction gate.** A candidate whose money moved the other way is dropped: its direction is `metadata.flow`, else its legs (an income leg is income; a negative expense total a refund; otherwise a purchase), with `flowsDisagree` as the second test. A candidate whose direction cannot be read is dropped too, because attaching across directions loses a money event. So is a candidate found only by amount when the total is 0. A refund whose dropped candidates include exactly one purchase sharing an identifier value names it in `metadata.refund_of`; several such purchases give the warning `refund_of_dropped`.
1. **No candidate left**: insert. `near_dup_check` is written only when a pHash neighbour was dropped by the gate (verdict `distinct`, not flagged).
2. **Strong match.** A candidate is strong when all three hold:
   - the same merchant: equal `brand_id` through its merchant row, or equal payee, or equal `metadata.merchant.canonical_name` (compared after Unicode normalisation, trimming, collapsing spaces and lower-casing);
   - no identifier conflict: no key both sides carry has different values;
   - a tiebreaker: either an identifier match (the same value under the same key, or the same value of six characters or more under two different keys) together with the same total in the record's currency and no conflicting card last-4; or the hard tuple: both card last-4 present and equal, both times present and equal to the minute, the same total, and the same multiset of line totals with items on both sides.

   Exactly one strong candidate: **attach** to it. More than one: insert, `uncertain`, flagged for review ("several candidates match").
3. **Every remaining candidate has an identifier conflict** (and no identifier match): insert, `distinct`, naming them.
4. **Otherwise**: insert, `uncertain`, flagged for review. When an identifier matched but the total, the card or another key differs, the reason says which.

An identifier alone never attaches. An order number is shared by every partial refund and split shipment of the order, and a subscription's id by every month of it; attaching the second refund, the second charge or next month's invoice to the first would file a money event as evidence and never book it. A different total, card or key tells them apart, so each blocks the attach and leaves the record to rule 3 or 4: booked, and flagged when a person must look. A flagged pair can be resolved later; a wrong attach loses a purchase. This is reconcile's own line: `scorePair` folds only equal totals, and a conflicting key or card sends a pair to review.

Not in applier 1.0, each a measured `APPLIER_VERSION` bump if ever: a "different time of day means distinct" rule, brand matching by name or domain, reuse of a candidate's category.

### What reconcile and the review queue read

An insert's verdict goes in `metadata.near_dup_check`: `candidate_transaction_id`, `candidate_transaction_ids`, `verdict` (`distinct` or `uncertain`), `flagged_for_review`, `reason`, `decided_by: 'applier'` and `applier_version`. `flagged_for_review` is what the review queue lists (`GET /v1/transactions?flagged=near_dup`) and what its dismiss clears. Reconcile reads an open `uncertain` naming a pair as "a person must look", and a typed `metadata.card_last4` before the free-text `payment` string, on every row of either writer.

## Accounts and postings

`project.ts` turns a valid receipt record into a draft: header, postings, item parameters, parties, owned-item lines, the brand and merchant to upsert, the points account to use or create, and the place. It is pure (no database, no clock, no ids), so a stored record can be projected again later and reach the same rows.

- **Expense account**: the record's `merchant.category`, one of the seven expense accounts, by exact name.
- **Paying account**: derived from `payment.method` (see "Tenders"), never chosen by the model. `metadata.mirror_account` records the account's name.
- **Postings**, signed as the legacy prompt signed them (a refund's total is negative), one pair per currency so each currency balances within itself:

  | Flow | Postings |
  |---|---|
  | purchase, refund | (expense, +T) (paying account, −T) |
  | income | (deposit account, +T) (income account, −T); the deposit and income accounts from the `income` block, Checking and Other by default |
  | points currency | (expense, +N) (points account, −N), and for a `cash_component` a second pair in that currency: (expense, ±C) (the method's account, ∓C), negative on a refund |

- **Points.** The points account is the workspace's account of subtype `points` for that currency, or a new one under `Assets`. `points` named on a cash currency names no programme, so it books to Credit Card; income in a points currency is deposited in the points account. Both raise `account_overridden`. The cash part of a points-and-cash record follows the method, with `points` meaning Credit Card.
- **Base amounts.** Every posting carries `amount_base_minor = amount_minor` and no `fx_rate`. That NULL is what the points valuation and the FX pass look for after commit, as on the legacy path. Amounts are the record's minor units, untouched (`src/ledger/money.ts` explains why a published rate is never multiplied in here).
- **Account lookup** is by type and exact name, deterministic when a name is duplicated: an open account before a closed one, a child before a root (the roots are never posted to), then the oldest id.
- **A missing account** is `account_missing`: a seeding fault, never sent back to the model.

### Tenders

| `payment.method` | Means | Books to |
|---|---|---|
| `card` | a credit card, or a card whose kind the document does not say; a phone wallet counts as a card unless the document says debit | Credit Card |
| `debit_card` | a debit, ATM or bank card: the tender line says DEBIT or names a debit-only network | Checking |
| `cash` | cash | Cash |
| `check`, `bank_transfer` | a check, a bank transfer | Checking |
| `gift_card` | a gift card, store credit, or a balance held in an app or account; never a card linked through one | Cash |
| `points` | a points or miles redemption | the programme's points account |
| `mixed` | two or more tenders that together paid the total | Credit Card, flagged |
| `other`, `unknown` | any other tender; the document does not say | Credit Card |

The table is `MIRROR_BY_METHOD` in `project.ts`. Why the less obvious rows are what they are:

- A gift card or balance books to Cash: there is no gift-card account, Cash is where the legacy writer put such payments, and a prepaid balance is not a charge on the card statements that reconcile matches against.
- A gift card or balance that covers only part of an order is not a second tender: the record's total is already what remained to pay, and the method is whatever paid that.
- A record states one method, so a mixed tender cannot be split. It books whole to Credit Card, the record carries the warning `mixed_tender`, and the inserted transaction is flagged for review through `metadata.near_dup_check.flagged_for_review` with a reason saying the split was not booked. When the duplicate check found candidates, it keeps its verdict and candidates and the reason is appended; with no candidate the flag names none, so reconcile reads no verdict about any pair from it. The flag is set only when the mixed tender actually picked a paying account (a purchase or refund, or the cash part of points plus cash), and only on insert. Income ignores the method.

## The place

The record names a Google place id, the result of the agent's Phase 3a judgment. The server fetches, projects, stores and links the place (`src/ingest/apply/places.ts`), in two halves, because one is a network call and the apply transaction must never wait on Google:

- **Prefetch**, outside any transaction. A place already in `places` is a cache hit and nothing is fetched. A miss is fetched with `fetchPlaceV1Dual` (English and Simplified Chinese, the same envelope a refresh stores). A missing key or a failed fetch is the warning `place_fetch_failed`, and the apply goes on without a place.
- **Write**, inside the apply. A cache hit bumps `hit_count` and `last_seen_at` and nothing else: `raw_response` is untouched and no snapshot is written. A miss with a fetched envelope inserts the row with the `projectPlace` columns (the one place-naming rule set, `src/projection/derive.ts`), the envelope as `raw_response` and `metadata.derivation`, plus one `place_snapshots` row. An envelope without an English address and location is `place_not_projectable` and links nothing. A row another apply inserted in the meantime turns the insert into a hit.

`custom_name` is never written. The receipt's own Chinese name (`merchant.name_zh_printed`, Phase 3e) is stored as `receipt_ocr`, its longest CJK run only, where the place has no Chinese name at all, on a miss and on a hit alike; a re-derive keeps a `receipt_ocr` name.

## Transaction metadata

`metadata.ts` builds `transactions.metadata` for an insert as a fixed key set (`APPLIER_METADATA_KEYS`), from the validated record and the run's own context. Nothing the model wrote reaches metadata except through a named field of the contract. Keys whose value would be absent are left out, never written as null.

| Key | From |
|---|---|
| `source`, `source_ingest_id`, `classification`, `flow` | `'ingest'`, the ingest, the record |
| `refund_of` | the decision |
| `category_hint`, `merchant {canonical_name, brand_id, category}` | the record's merchant |
| `extraction` | the provenance stamp below |
| `order_number`, `confirmation_number`, `invoice_number`, `payment_id`, `approval_code` | the identifiers, at the top level where every reader looks |
| `other_references`, `receipt_facts` | the two bags |
| `card_last4` | typed, for duplicate detection |
| `payment` | `<network> ****<last4>`, `****<last4>` or the tender line as printed: the string older duplicate readers parse |
| `payment_method` | what the frontend's Payment cell prints: the `payment` string, else a label for the method, absent for `unknown` with nothing printed |
| `mirror_account` | the paying account's name |
| `tax_minor`, `tip_minor`, `printed_totals` | the printed totals; the two top-level keys feed the frontend's Tax and Tip cells |
| `ocr_audit` | the record's `audit`, plus `payee_as_printed` and `payee_source` |
| `allocation_audit` | only when the lines miss the total: the effective sum, the total and the residual (other currencies listed after the main one) |
| `near_dup_check` | the decision's, or a review flag (see "Tenders") |
| `owned_items_note` | income: why no sold item was retired |

`metadata.extraction` holds `prompt_version`, `prompt_git_sha`, `model` (the model the transcript reports, else the one requested; never `cli-default`), `model_requested`, `source`, `ran_at`, `run_id`, `session_id`, `extraction_id`, `contract_version`, `applier_version` and `writer: 'server_apply'`.

`metadata.items` and `metadata.raw_text` are not written: `transaction_items` is canonical (`itemsFromMetadataFallback` serves legacy rows only), and the transcription is `documents.ocr_text`. The FX and points passes add `fx` and `points` after commit, as on the legacy path.

### Server-owned keys

`SERVER_OWNED_TX_METADATA_KEYS` (`src/projection/metadata-patch.ts`) lists the keys a PATCH may not change or remove (422 `server_owned`; echoing the stored value is a no-op). Of the keys the applier writes, these are server-owned: `source`, `source_ingest_id`, `classification`, `extraction`, `ocr_audit`, `allocation_audit`, `near_dup_check`, `mirror_account` and `printed_totals`, and on an attach `merge_audit`. `mirror_account` and `printed_totals` were added for the server writer: the first records a decision whose fact is the posting, so editing it would only make the two disagree; the second is evidence, like `ocr_audit`. The receipt facts and projections (`flow`, `merchant`, `category_hint`, the identifiers, `card_last4`, `payment`, `payment_method`, `tax_minor`, `tip_minor`, the bags, `refund_of`, `owned_items_note`) stay writable by a client. A new server-side writer of a metadata key adds it to that list in the same change.

## Outcomes and error classes

`agent_runs.outcome` and `error_class` under the server writer, with the ingest's status:

| Outcome | Error class | Ingest | When |
|---|---|---|---|
| `written` | | `done` | inserted |
| `attached` | | `near_dup` | attached to one strong candidate |
| `unsupported` | | `unsupported` | an unsupported document |
| `recorded_only` | | `unsupported` | a statement |
| `duplicate_skip` | | `dedup` | the Message-ID duplicate |
| `reapplied` | | as its branch | `reapplyRecord` |
| `invalid_record` | `artefact_invalid` | `error` | still invalid after the last round; the record is stored |
| `invalid_record` | `artefact_missing` | `error` | no record anywhere; nothing stored |
| `agent_error` | `auth`, `quota`, `overloaded`, `timeout`, `spawn`, `crash` | `error` | the first spawn failed, or a repair round's (then the invalid record is stored) |
| `failed` | `apply` | `error` | T2 or T1 failed; a stored record stays valid and unapplied |
| `failed` | `fenced_out` | untouched | the run lost its ingest |
| `interrupted` (run `abandoned`) | | `error` | the server restarted during the run |

The other values of the enum belong to other paths: `no_change` to re-extract, `adopted` to the durable queue (not built). The legacy writer uses `agent_reported`, `guard` and `no_closeout`.

## Expected differences from the legacy writer

The A/B comparison treats these as intended, not as regressions. The code cites them as X1 to X13.

| | Difference | Why |
|---|---|---|
| X1 | a brand's real name is never overwritten; only a slug stub is upgraded | the legacy upsert let the last receipt's spelling win (hole 2) |
| X2 | a new points account has the `Assets` root as its parent | hole 7 |
| X3 | parties, the place and the document stamp are inside the ledger transaction | the legacy statements for them ran after COMMIT (#265) |
| X4 | `created` and `document_linked` events are written | hole 1 |
| X5 | places get the v1 envelope; a cache hit only bumps counters; one snapshot per fetch | the legacy upsert replaced the cached body and wrote a snapshot on every visit (#264) |
| X6 | `ocr_text` is stamped on attach and unsupported too, and an email's is the server's decode | hole 5 |
| X7 | provenance names the record prompt and the model that answered; metadata is the fixed key set; no `metadata.items` or `metadata.raw_text`; `payment_method`, `tax_minor` and `tip_minor` are written | rows stamped `cli-default`; frontend cells that lost their data |
| X8 | duplicates are decided in code (`decided_by: 'applier'`): more inserts are flagged `uncertain` where the agent said `distinct` on time or items alone, and an identifier match whose total, card or another key differs is booked and flagged where the agent might have attached it | "Attach or insert" |
| X9 | a Message-ID duplicate is linked to the live transaction and closed `dedup`, before the spawn and again under the apply lock | the legacy check closed it `done` with no transaction, live or not |
| X10 | a statement PDF is recorded, not booked | statement booking is a design of its own (#175) |
| X11 | no web search for a brand's domain and no icon step | the domain comes only from the document |
| X12 | a sold item is retired by `product_key`, and product statistics leave deleted transactions out | the legacy name match contradicted the lessons file |
| X13 | `card_last4` is typed, and duplicate detection reads it | hole 6 |

The tenders (debit card to Checking, gift card or balance to Cash, a mixed tender flagged) also differ from the legacy agent, which mostly kept its Credit Card default.

X13 reaches the legacy side as soon as this code is deployed: reconcile's `cardLast4` reads a typed `card_last4` first on every row. That can only make reconcile more conservative (a card conflict suppresses a proposal without an identifier match and blocks auto-apply with one).

Kept on purpose: category picks the expense account; a merchant is fixed at first sight; the model's tax, tip and discount allocation; the agent's `brand_id`; signed totals; Phase 3a and Check C.

## Checks

| Check | When | What it proves |
|---|---|---|
| `scripts/check-contract.ts` | every build | every error rule bounces a synthetic record with the right rule and path; every record warning and normalisation is recorded; every forbidden key is refused at every level; the repair request names paths and rules, never values; the repair diff; the hand-back parser on prose, multiple fences, fences inside the receipt text, the transcript fallback with decoys that must be ignored, unparseable blocks and the caps; the generated contract text names every field |
| `scripts/check-apply-decide.ts` | every build | every rule of the duplicate decision, every posting shape (purchase, refund, income, points, points plus cash, each tender, JPY and KWD amounts) and the metadata key set, as tables, with no database |
| `scripts/check-prompt-render.ts` | every build | the legacy rendering has not changed by a byte |
| `scripts/check-prompt-budget.ts` | every build | neither rendering grew without its baseline moving in the same commit |
| `scripts/check-agent-grants.ts` | every build | the record rendering has no SQL and no database, web-search or logo-key text |
| `scripts/check-items-sql-parity.ts` | after touching `items-sql.ts` | the bound items SQL the applier runs writes the same rows as the SQL the prompts give the agent |
| `scripts/check-extraction-records.ts` | after touching the table or `records.ts` | the table, the immutability trigger, the current-record index and the writer, on a throwaway Postgres |
| `scripts/check-apply-extraction.ts` | after touching `src/ingest/apply/`, `records.ts` or `items-sql.ts` | every write branch on a throwaway Postgres: the rows written, the ingest close and run finish in the same transaction, that nothing else changed, and that failures, fenced runs and deleted targets leave nothing behind |
| `scripts/check-projection-replay.ts --from-ledger` | after a projection or dedup rule changes; the pre-A/B gate | a record synthesised from each live ingest transaction projects to the money it booked (account, sign, amount, currency); every mismatch is in a class, explained only by a rule written in the script |
| `scripts/check-projection-replay.ts --records` | the same; gate G3 | stored records re-project to the transactions they produced (fingerprints), and a record that booked nothing does so for a known reason |
| `scripts/check-ledger.ts` | after every deploy and trial | `apply-row-has-record` (a server-written transaction still has its record), `run-without-terminal-ingest`, `postings-native-balance` |
| `scripts/eval-dedup.ts --writer=server_apply` | after a dedup or worker change | the worker guards' record variants (g1, g3, g4) and the applier cases a1 to a9 with record stubs; with `--with-claude`, the agent cases |
| `scripts/check-agent-sandbox.ts` | after a profile, CLI or grant change | the record profile has no database URL, no logo key and no web search, and a resumed session offers exactly its tools |
| `scripts/probe-cli.ts` | with every CLI bump | the `--resume` behaviour the repair round relies on |

The applier cases of `eval-dedup`: a1 identifier attach; a2 identifier conflict, inserted `distinct`; a3 no identifier, inserted `uncertain` and flagged; a4 a refund sharing the purchase's order number, inserted with `refund_of`; a5 attach by the hard tuple; a6 a pHash neighbour with other identifiers, `distinct`; a7 the same Message-ID, closed `dedup` before any spawn; a8 three copies in one batch, one transaction (run at concurrency 3 to make them race; the apply lock is what holds); a9 one order number on two money events, each booked and flagged, never attached.

Usage, flags and the throwaway-database rules are in each script's header and in `CLAUDE.md`.

## Rollout

### Phases

| Phase | What | State |
|---|---|---|
| P0 | the A/B harness, the CLI probes, the model pin | done |
| P1 | run records (`agent_runs`), the run fence, the process-group kill | in production |
| P2 | the contract, the evidence store, the applier, code dedup, record stubs, the replay check | in production, dark |
| P3 | the record prompt, the database-less profile, the hand-back parser, the repair round | in production, dark |
| P4 | the A/B comparison on the sandbox | next |
| P5 | the production flip and a watch window | after P4 |
| P6 | a durable queue on `ingests`: leases, apply-only retries of a stored record, queue pauses on auth or quota outages | after P5 |
| P7 | re-extract on records: a new record superseding the old, applied to the soft fields and items under the Layer 3 rules | after P6 |
| P8 | the legacy writer retired: every profile without a database URL, `AGENT_GRANTS` empty, one prompt version | after a clean period on P5 |

### Sandbox check

Before the A/B, on the sandbox stack only, at concurrency 1, with `EXTRACTION_WRITER=server_apply` set for the sandbox's compose run (never in `.env`, which production reads too), and with an image whose `/version` names the commit under test:

1. The boot line names the writer and the repair rounds; the ledger is reset.
2. `check-agent-sandbox` is green with nothing inconclusive.
3. `eval-dedup --writer=server_apply` passes its stub cases.
4. A small smoke set covering each kind of document (a photo, a text PDF, a scanned PDF, a plain email, an email with a PDF attachment, a saved HTML confirmation, a refund, a long multi-item receipt) runs through `eval-dates`. Each run is `server_apply`, on the record prompt, `written`, with one current valid record; `check-ledger` is clean with no allow list; `--records` matches; every transaction has one `created` event, at least one channel party, a real model and `ocr_text`; turns are no more than the legacy path's; no transcript shows a psql call or a read of a credential path.
5. A real repair round is observed, provoked if none happens (a synthetic document with an impossible date, or one dated after its upload): the run has `repair_rounds` 1, the record's report names the rule, one transcript holds both rounds with a cached resumed turn, and no money field changed unasked.

### A/B comparison

Arm A is `agent_sql` on the legacy prompt; arm B is `server_apply` on the record prompt. Held equal: one image built from one commit (in which the legacy rendering is golden-equal to production's), the sandbox stack only, the CLI version, the pinned model, concurrency 1, the Google key present (Phase 3a and Check C affect payee and place), one repair round. The sandbox is reset before every arm of every trial, the arm order alternates by trial, and an infrastructure failure (auth, a session limit) voids that trial pair, which is run again rather than counted.

The corpus: the public fixtures of `scripts/eval-dates.fixtures.json`; a private set kept outside the repository with hand-read ground truth, chosen to cover what the public set lacks (emails with attachments, a Message-ID duplicate pair, a foreign currency, a refund, a points stay, a saved HTML page, a marketplace order with several parties, a zero-decimal currency, a two-level receipt); the `eval-dedup` cases in both writer modes; `check-apply-extraction`; and legacy re-extract run twice on arm-B transactions that carry user edits and a manual item. Each fixture runs several trials per arm.

The instruments: `eval-dates` scores date, total, payee, classification, flow and currency per document, with the run, model, turns and tokens; the fingerprint (`src/ingest/apply/fingerprint.ts`) compares what the two arms booked for one document field by field; `npm run measure:turns` gives the cost. Disagreements are settled by reading the document, in private notes.

### Gates

All must pass before the flip. Each compares arm B with arm A on the same fixtures; hard fixtures (known-ambiguous dates and totals) are reported, not gated.

| Gate | Passes when |
|---|---|
| G1 accuracy | B fails no ordinary fixture on date, total or payee that A passes; per field, B is correct on as many fixtures as A, within a small margin; classification, flow and currency are right wherever A's are |
| G2 hand-back | nearly every B run hands back a valid record without repair; a run that ends without a valid record after repair is rare; no repair changes a money field unasked; every miss is explained from its transcript |
| G3 ledger invariants | `check-ledger` shows no new violation after any trial, in either arm; every B transaction balances per currency and has one `created` event, a channel party, `writer = 'server_apply'` and a real model; nothing writes `custom_name`, `user_chose_at` or `narration`; every B document has `ocr_text` and a current valid record; `--records` reproduces every B fingerprint |
| G4 structural parity | after setting aside the expected differences, no adjudication finds B worse on a money field (classification, flow, sign, currency, total, expense and paying account, attach or insert), and B is worse on catalog fields (identifiers, brand, category, items, owned items, parties, place) only rarely and never the same way twice |
| G5 dedup | every stub case passes in both writer modes; a1 to a9 pass, a8 also at concurrency 3; the agent cases and `race` pass in B, and B does at least as well as A on `race` |
| G6 places | every place B creates is projectable; B links a place about as often as A on documents with a printed address; the two arms agree on the place id where both linked one |
| G7 cost | B's median billed input, median turns and slow-run wall time are no worse than A's |
| G8 safety | B transcripts show no psql call, no permission error and no read of a credential path or the process environment |
| G9 rollback compatibility | legacy re-extract on B rows gives `written` and then `no_change`, keeps Layer 3, and writes one derivation event per run |

The pre-A/B gate runs first, at no model cost: `check-projection-replay --from-ledger` over a production-shaped copy, with no unexplained money mismatch on rows written by recent legacy prompts. If a gate fails: find the cause, fix it, and re-run arm B on the affected fixtures plus a sanity set; after two failed rounds, stop and re-plan.

### Flip and watch

The flip is an environment change: set `EXTRACTION_WRITER=server_apply` in production's `.env` and recreate the app container (tag a rollback image first). The restart abandons at most the ingest in flight, as any deploy does.

Then watch, after each of the first ingests and daily for a week:

- `agent_runs` grouped by writer, outcome and error class, with median turns and billed input;
- `check-ledger` with the established allow list (the checks added for the server writer are never allowed);
- a few server-written transactions read against their documents.

Any one of these flips the writer back: a `check-ledger` violation on a server-written row; repeated apply failures; record-missing and record-invalid runs above a small share; a transcript with a write attempt or a credential-path read; a money error found in a spot check; new errors in mail ingest. An `uncertain` flag share well above the legacy arm's is a reason to investigate, not to roll back.

### Rollback

| Phase | Rollback |
|---|---|
| P1 | the rollback image; migration 0042 is additive and the old image ignores it |
| P2, P3 | nothing to do: the writer stays `agent_sql`, and the golden proves the legacy rendering unchanged |
| P5 | set `EXTRACTION_WRITER=agent_sql` and recreate the container. No data step: server-written rows are ordinary ledger rows, records stay as evidence, and legacy re-extract works on them (G9) |
| a wrong applier rule after the flip | fix it, bump `APPLIER_VERSION`, and measure the effect by re-projecting stored records before deploying |

## Labels used in the code

| Label | Meaning |
|---|---|
| T0, T1, T2 | the claim transaction, the record transaction, the apply transaction ("The run flow") |
| arm A, arm B | the legacy writer and the server writer, as the A/B comparison names them |
| Turn A, Turn B, Turn C | the legacy prompt's single read (candidates, brand, place cache, Message-ID), its single write, and its close-out of the ingest |
| X1 to X13 | the expected differences from the legacy writer ("Expected differences from the legacy writer") |
| G1 to G9 | the A/B gates ("Gates") |
| P0 to P8 | the rollout phases ("Phases") |
| a to q | the steps of an insert ("The insert, in order") |
| hole 1 | the legacy writer wrote no `created` event for most ingested transactions |
| hole 2 | the legacy brand upsert overwrote a brand's name with each receipt's spelling |
| hole 5 | an attached duplicate or an unsupported document lost its reading: no `ocr_text`, nothing kept |
| hole 6 | card last-4 was not typed; duplicate detection parsed it out of a free-text payment string |
| hole 7 | a new points account was created without a parent |
| hole 9 | the paying account was not derived from the tender: the legacy template credited Credit Card by default, and the choice was not recorded |

The hole numbers come from an audit of the legacy write path; only the ones the code cites are listed.
