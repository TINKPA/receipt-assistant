# `eval-dates`: extraction accuracy harness

`scripts/eval-dates.ts` uploads a manifest of real documents to a running
stack, waits for the worker to extract them, and scores what landed in the
ledger against ground truth. It began as the date harness for
[receipt-assistant#27] and is the instrument for the wave-1 A/B, which
compares the agent writing the ledger itself (`agent_sql`) with the server
writing it from the agent's record (`server_apply`) on the same documents.

[receipt-assistant#27]: https://github.com/TINKPA/receipt-assistant/issues/27

Per document it scores **date, total, payee, classification, flow
(purchase / refund / income) and currency**, and records the model the run
was stamped with, the model its transcript shows, turns and billed tokens.

## TL;DR

```bash
# The sandbox, never production (a fixture is a real transaction in the
# ledger it is sent to). From a worktree add
# --env-file ~/Developer/receipt-assistant/.env so the agent can log in.
docker compose -f docker-compose.test.yml up -d --build

npm run eval:dates -- --dry-run          # check the manifest; no upload, no quota
npm run eval:dates -- --reset            # one trial of corpus C1, about 1 hour
npm run eval:dates -- --reset --limit=6  # the six-fixture sanity set
```

Reports land next to the manifest as
`eval-dates.<run id>.report.{json,md}` (gitignored in `scripts/`), or in
`--out=<dir>`.

Each real extraction costs about a million tokens of the owner's Claude
subscription. A full C1 trial is 24 of them.

## How it works

1. **Reads the manifest** (`scripts/eval-dates.fixtures.json` unless
   `--manifest=`) and resolves each entry's source file under
   `--uploads-dir` (default the iCloud project's `data/uploads/uploads/`,
   or `$UPLOADS_DIR`). An entry whose file is missing, or that does not
   validate, is **reported and skipped**; the run goes on. (One deleted
   photo used to abort the whole corpus at fixture 5.)
2. **Resets the sandbox** with `--reset` (`scripts/sandbox-reset.sh`),
   before every trial.

   > **Run against a reset sandbox, never a populated ledger.** A copy of
   > a document the ledger already holds is found as a near-duplicate
   > (same pHash, same identifiers, same Message-ID) and attached instead
   > of extracted, so the trial scores nothing. That is why `--trials` above
   > 1 requires `--reset`, and why the default `--base` is the sandbox
   > (`http://127.0.0.1:3001`). A base on port 3000 is refused unless you
   > pass `--allow-production`.
3. **Copies each fixture under a new sha256** so the upload is never a
   byte duplicate, without changing what the agent reads:

   | Source | Copy | Uploaded as |
   |---|---|---|
   | Image | `sips` re-encode to JPEG at quality 75 (unchanged since #27, so old baselines stay comparable) | `image/jpeg` |
   | PDF | a comment line appended after the final `%%EOF`; pages and text layer untouched | `application/pdf` |
   | `.eml` | one `X-Eval-Nonce:` header put before the first line | `message/rfc822` |
   | HTML | a comment appended at the end | `text/html` |

   Until wave 1 every file went through `sips` and was sent as
   `image/jpeg`, which turned the two text-layer PDF fixtures into photos
   of a page: they could never exercise the agent's `pdftotext` path. The
   harness now checks that `pdftotext` reads the same text from a PDF copy
   as from the original, and after upload that the stored file
   (`GET /v1/documents/:id/content`) is the copy and still has text
   (`pdf_text_layer` in the report). Appending to an email body instead
   of adding a header would corrupt a single-part base64 body.
4. **Uploads one batch per trial** (`POST /v1/ingest/batch`, at most 50
   files per batch) and polls until every ingest is terminal (`done`,
   `unsupported`, `error`, `dedup`, `near_dup`) **and** the batch has
   finished reconciling, since reconcile can still rewrite transactions.
5. **Reads each transaction** over the API (`GET /v1/transactions/:id`)
   and scores it (below).
6. **Finds each run's transcript** in `--transcripts` (default the
   sandbox's `~/Developer/receipt-assistant-data/test-claude/projects/-app/`)
   by the ingest id in the prompt, and counts turns and tokens the way
   `measure-ingest-turns.ts` does (grouped by `message.id`; billed input is
   fresh + cache read + cache write).
7. **Dumps the rows** with `--dump=<dir> --pg=<url>`: for every fixture the
   ingest, documents, links, transactions, postings (with account name and
   type), items, parties, events, place, merchant, owned items and, once
   they exist, `agent_runs`, as whole rows, one JSON file per fixture under
   `<dir>/<run id>/t<trial>/`. The connection is opened with
   `default_transaction_read_only=on` and refused otherwise, and a dump
   directory inside this repository is refused: the rows are real
   receipts. The wave-1 arm diff reads these.
8. **Writes the report**: fields and buckets over all trials, cost
   medians, a per-fixture majority over trials, every run, errors, and the
   skipped fixtures.

No auth headers (the seed-workspace middleware), no `--json-schema`.

## Flags

`--key=value`, or a bare `--flag` for the switches. The space form
(`--limit 5`) and unknown flags are refused.

| Flag | Default | What it does |
|---|---|---|
| `--base=<url>` | `http://127.0.0.1:3001` | API of the stack under test |
| `--allow-production` | off | Allow a base on port 3000 |
| `--manifest=<path>` | `scripts/eval-dates.fixtures.json` | Corpus to run |
| `--uploads-dir=<path>` | iCloud `data/uploads/uploads` | Where sources live (`$UPLOADS_DIR` also works) |
| `--limit=<n>` | all | First n manifest entries |
| `--trials=<n>` | 1 | Run the set n times, one batch each; needs `--reset` above 1 |
| `--reset` | off | `scripts/sandbox-reset.sh` before every trial |
| `--run-id=<id>` | `ed-<UTC time>-<hex>` | Names the report files and the dump directory |
| `--label=<text>` | none | Free text on the report, e.g. `arm A` |
| `--out=<dir>` | the manifest's directory | Where the report goes |
| `--dump=<dir>` | off | Write each fixture's rows (needs `--pg`; refused inside the repo) |
| `--pg=<url>` | none | Postgres of the stack under test, opened read-only. Sandbox: `postgresql://postgres:postgres@127.0.0.1:5433/receipts` |
| `--transcripts=<dir>` | sandbox `test-claude/projects/-app` | Session JSONL directory; `none` to skip |
| `--timeout-min=<n>` | 60 | Per-trial polling timeout |
| `--gate` | off | Exit 1 if date accuracy < 90% (#27 AC#1) |
| `--dry-run` | off | Resolve and copy every fixture, check the copies, upload nothing |
| `--rescore=<batch id>[,<id>]` | off | Score batches that already ran, with the current manifest and code: no reset, upload or model calls. Items are matched to fixtures by upload filename. Use it after correcting ground truth, or to dump a run after the fact (before the next reset) |

Two arms are two runs: flip the sandbox between them
(`EXTRACTION_WRITER=server_apply docker compose -f docker-compose.test.yml up -d`)
and give each its own `--run-id` and `--label`. `--trials=n` repeats one
arm.

## Corpora

| Set | Manifest | Contents |
|---|---|---|
| C1 | `scripts/eval-dates.fixtures.json` (in the repo) | 25 photos and PDFs of the owner's receipts; 24 runnable (one source photo is gone and is reported as skipped) |
| C2 | private, outside the repo (wave-1 notes) | 13 documents chosen from production by kind: emails (PDF attachment, a Message-ID duplicate pair, non-USD, refund, income, marketplace, two plain), saved HTML pages (a points stay, an order page), a JPY email and a two-level package photo. Named by document id and stored path; ground truth hand-read from each document |

**The first six C1 entries are the sanity set**: five `good` fixtures and
the hard text-layer PDF, two PDFs in all. `--limit=6` runs exactly those,
for a quick check that the pipeline still works end to end. Keep a
text-layer PDF among the first six when editing the manifest.

## Manifest entries

```jsonc
{
  "key": "refund-email",             // optional; default document_id, else sha256[:12]
  "sha256": "<64 hex>",              // source <uploads-dir>/<sha256>.<ext>   (C1)
  "stored_path": "<file>.eml",       // source <uploads-dir>/<stored_path>   (C2; documents.file_path)
  "document_id": "<uuid>",           // provenance only
  "original_filename": "x.jpeg",     // optional upload filename; never in the prompt
  "bucket": "good",                  // hard_date | hard_total | hard_all | good_rejects | good | duplicate
  "ground_truth": {
    "date": "YYYY-MM-DD",            // null: not scored (nothing printed says when)
    "merchant_tokens": ["acme"],     // lowercase; the payee passes if it contains any
    "total_minor": -4250,            // signed as the ledger books it; scored on magnitude; null skips
    "currency": "USD",               // default USD; points use the ledger code, e.g. HYATT_PT
    "flow": "refund",                // default purchase
    "classification": "receipt_email", // default from the file type; may be a list
    "duplicate_of": "<key>"          // bucket duplicate only: the twin in the same manifest
  },
  "expected_status": "done",         // or a list of acceptable statuses
  "notes": "Why it is in the set; how the truth was read."
}
```

The source's extension decides the copy and the content type. Classification
defaults: image → `receipt_image`, PDF → `receipt_pdf`, email →
`receipt_email`, HTML → either `receipt_email` or `receipt_pdf` (production
has filed saved pages under both). A `good_rejects` fixture expects
`unsupported`.

### Adding a C1 fixture

1. Find the receipt read-only in production:
   ```bash
   docker exec -e PGOPTIONS='-c default_transaction_read_only=on' receipts-postgres \
     psql -U postgres -d receipts -c "
       SELECT i.filename, d.sha256, d.file_path, t.occurred_on, t.payee
         FROM ingests i
         JOIN documents d ON d.source_ingest_id = i.id
         LEFT JOIN transactions t ON t.source_ingest_id = i.id
        WHERE i.filename ILIKE '%PARTIAL%' AND i.status = 'done';"
   ```
2. Read the ground truth **off the document**, not off the ledger row: the
   ledger is what is being tested.
3. Pick the bucket: date wrong in the ledger → `hard_date`; total wrong →
   `hard_total`; both and the payee → `hard_all`; refused as not a receipt
   → `good_rejects`; otherwise `good`.
4. Add the entry, then `npm run eval:dates -- --dry-run` to check it
   resolves.

The repository is public. C1 entries name the fixture by sha256 and carry
the merchant tokens and totals the ground truth needs; nothing else about
the receipt (no addresses, card digits or order numbers) goes in the file.
Documents that are more personal than a till receipt, such as emails, go
in a private manifest outside the repo, like C2.

## Scoring

| Field | Correct when | Not scored when |
|---|---|---|
| `date` | `occurred_on` equals `ground_truth.date` | no transaction, or the truth is null |
| `total` | the largest posting magnitude in the scored currency equals `|total_minor|` (that is the mirror leg, so a split across expense accounts still scores once) | no transaction, or the truth is null |
| `payee` | the payee contains any merchant token (case-insensitive) | no transaction, or no tokens |
| `classification` | `ingests.classification` is one of the expected values | the agent never classified (e.g. a byte duplicate) |
| `flow` | income leg present → `income`; else expense legs summing negative → `refund`; else `purchase` (#221: never read the sign of a leg picked by sign) | no transaction |
| `currency` | the spend leg's currency (a `_PT` currency when there is one: a points stay with a cash part has two) | no transaction |

**Bucket pass** keeps the #27 rules: `good` needs date, total and payee
(a field the truth leaves null is skipped); `hard_date` the date;
`hard_total` the total; `hard_all` all three; `good_rejects` status
`unsupported`; `duplicate` an acceptable status and no transaction of its
own (none, or its twin's). Classification, flow and currency are reported
on their own and not folded into the pass.

With several trials the report adds, per fixture and field, the majority
verdict (`pass`, `fail`, `split` on a tie, `n/a`), which is how the wave-1
gate G1 compares arms.

The aggregate date accuracy is `correct / scored`, so documents that were
never extracted do not dilute it; `--gate` checks it against 90%.

## Known stragglers (do not panic)

- **WingHopFung wine** (`hard_all`): non-deterministic across runs per the
  [2026-04-21 issue comment][nd-comment]. Faded thermal paper.
- **Wilson wristband** (`hard_date`): 09/30 read as 09/03, deterministic
  across 3 rounds of Phase 2.5 self-check iteration.
- **Haidilao** (`hard_date`): the source photo is gone from the uploads
  directory; the entry is kept and reported as skipped.

[nd-comment]: https://github.com/TINKPA/receipt-assistant/issues/27#issuecomment-4285867967

### When `date_accuracy < 90%`

- **All `hard_*` failing, `good` clean**: the prompt is at its ceiling;
  A/B prompt variants or a model change.
- **`good` regressed**: a recent prompt or model change costs more than it
  wins; revert and investigate.
- **A new failure in a previously `good` fixture**: promote it to a
  `hard_*` bucket and keep iterating.
