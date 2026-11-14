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
# ledger it is sent to), one extraction at a time: the harness refuses a
# stack with MAX_CLAUDE_CONCURRENCY other than 1 (the sandbox's default is
# 6). From a worktree add --env-file ~/Developer/receipt-assistant/.env so
# the agent can log in.
MAX_CLAUDE_CONCURRENCY=1 docker compose -f docker-compose.test.yml up -d --build

npm run eval:dates -- --dry-run          # check the manifest; no upload, no quota
npm run eval:dates -- --reset            # one trial of corpus C1, about 1 hour
npm run eval:dates -- --reset --limit=6  # the six-fixture sanity set
```

Reports land next to the manifest as
`eval-dates.<run id>.report.{json,md}` (gitignored in `scripts/`), or in
`--out=<dir>`. They are rewritten after every trial and when the run ends
for any reason, Ctrl-C included.

Each real extraction costs about a million tokens of the owner's Claude
subscription. A full C1 trial is 24 of them.

## How it works

1. **Reads the manifest** (`scripts/eval-dates.fixtures.json` unless
   `--manifest=`) and resolves each entry's source file under
   `--uploads-dir` (default the iCloud project's `data/uploads/uploads/`,
   or `$UPLOADS_DIR`). An entry whose file is missing, or that does not
   validate, is **reported and skipped**; the run goes on. (One deleted
   photo used to abort the whole corpus at fixture 5.)
2. **Checks the stack under test.** It reads the environment of the
   container serving `--base` (`--container`, default
   `receipt-assistant-test`) with `docker inspect`, through a template that
   returns only `EXTRACTOR_STUB_ALLOWED`, `CLAUDE_MODEL`,
   `EXTRACTION_WRITER`, `EXTRACTION_REPAIR_ROUNDS`,
   `MAX_CLAUDE_CONCURRENCY`, `CLAUDE_TIMEOUT_MS` and whether
   `GOOGLE_MAPS_API_KEY` is set (never a secret's value). It refuses:
   - a container that does not publish `--base`'s port (the URL is served
     by something else);
   - one without `EXTRACTOR_STUB_ALLOWED=1`, i.e. not a sandbox, unless
     `--allow-production`. This is what stops a run through the
     frontend's `/api/` proxy, which reaches production on another port;
   - `MAX_CLAUDE_CONCURRENCY` other than 1, unless `--allow-concurrency`:
     neighbours in one batch extracted in parallel race on dedup, so
     attach and duplicate outcomes would depend on timing, not on the arm;
   - `--reset` when `scripts/sandbox-reset.sh` would empty a database of
     another compose project than the container's.

   The values go on the report (`conditions`, and per trial), with the
   image id, which names the build even when `/version` says
   `gitSha: unknown` (a worktree build). If the image or any of those
   values changes between trials, the run stops. `--container=none` skips
   all of it, for a server you run yourself outside docker; the report
   then says the conditions are unknown, and `--reset` is refused.
3. **Waits until the stack is idle** (no ingest queued or processing, no
   batch reconciling) and then, with `--reset`, **resets the sandbox**
   (`scripts/sandbox-reset.sh`), before every trial. A reset under a
   running extraction lets that agent write its brand, merchant and place
   rows into the fresh ledger, warming the next trial's lookups. The wait
   lasts as long as that work keeps moving, and gives up after
   `--stall-min` without movement.

   > **Run against a reset sandbox, never a populated ledger.** A copy of
   > a document the ledger already holds is found as a near-duplicate
   > (same pHash, same identifiers, same Message-ID) and attached instead
   > of extracted, so the trial scores nothing. That is why `--trials` above
   > 1 requires `--reset`, and why the default `--base` is the sandbox
   > (`http://127.0.0.1:3001`). A base on port 3000 is refused unless you
   > pass `--allow-production`.
4. **Copies each fixture under a new sha256** so the upload is never a
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
   as from the original, and after upload finds the upload's own document
   (by sha256, or with `--pg` by file path, since an errored or attached
   upload is not in `produced`) and compares the stored file
   (`GET /v1/documents/:id/content`) with the original: `pdf_check` is
   `text_kept` (same bytes as uploaded, same `pdftotext` output),
   `scan_kept` (the original has no text layer either), `changed`,
   `bytes_differ`, `not_found` (no document of its own, e.g. attached to
   its twin) or `unchecked` (no `pdftotext`). Appending to an email body
   instead of adding a header would corrupt a single-part base64 body.
5. **Uploads one batch per trial** (`POST /v1/ingest/batch`, at most 50
   files per batch) and polls until every ingest is terminal (`done`,
   `unsupported`, `error`, `dedup`, `near_dup`) **and** the batch has
   finished reconciling, since reconcile can still rewrite transactions.
   A failed poll (no answer, a dropped connection, 5xx, 429) is retried
   and never ends the run. The trial is **given up** only when no ingest
   or batch has changed state for `--stall-min` (default the stack's
   per-run timeout, `CLAUDE_TIMEOUT_MS` or 15 min, plus 5: the worker
   errors a run that takes longer, so a longer silence means the stack is
   stuck), after `--timeout-min` in all (default enough for every fixture
   to use the full per-run timeout at the stack's concurrency, plus 15),
   or when a batch is gone (404).
6. **Reads each transaction** over the API (`GET /v1/transactions/:id`)
   and scores it (below).
7. **Finds each run's transcript** in `--transcripts` (default the
   sandbox's `~/Developer/receipt-assistant-data/test-claude/projects/-app/`):
   by `agent_runs.session_id` when run records exist (needs `--pg`),
   otherwise by the ingest id in the prompt. It counts turns, tokens and
   the model with `summarizeSession` (`src/session-transcript.ts`), the
   parser that also fills `agent_runs` and `measure-ingest-turns.ts`, so
   the three agree: turns grouped by `message.id`, billed input is fresh +
   cache read + cache write, and the model is the one that answered most
   turns.
8. **Dumps the rows** with `--dump=<dir> --pg=<url>`: for every fixture the
   ingest, documents, links, transactions, postings (with account name and
   type), items, parties, events, place, merchant, owned items and, once
   they exist, `agent_runs`, as whole rows, one JSON file per fixture under
   `<dir>/<run id>/t<trial>/`. The connection is opened with
   `default_transaction_read_only=on` and refused otherwise, and a dump
   directory inside this repository is refused (letter case and symlinks
   do not get past it): the rows are real receipts. The wave-1 arm diff
   reads these.
9. **Writes the report** after every trial, and again when the run ends,
   stops or is interrupted: fields and buckets, cost medians, a
   per-fixture majority over trials, every run, errors, and the skipped
   fixtures. A trial that is given up ends the run (the stack still has
   its work in flight, so the next reset would land under it): its runs
   stay in the report marked `unfinished`, the trial is `complete: false`,
   and the aggregates and majority cover finished trials only. The trial
   in progress at Ctrl-C is not in the report.

Exit status: 0 every trial finished (and `--gate` passed); 1 refused, a
fatal error (the report says which), or `--gate` failed; 3 stopped before
every trial finished; 130 interrupted.

No auth headers (the seed-workspace middleware), no `--json-schema`.

## Flags

`--key=value`, or a bare `--flag` for the switches. The space form
(`--limit 5`) and unknown flags are refused.

| Flag | Default | What it does |
|---|---|---|
| `--base=<url>` | `http://127.0.0.1:3001` | API of the stack under test |
| `--container=<name>` | `receipt-assistant-test` | Container serving `--base`, checked and recorded (step 2); `none` to skip |
| `--allow-production` | off | Allow a stack without `EXTRACTOR_STUB_ALLOWED=1`, or a base on port 3000 |
| `--allow-concurrency` | off | Allow `MAX_CLAUDE_CONCURRENCY` other than 1 (never for an arm of the A/B) |
| `--manifest=<path>` | `scripts/eval-dates.fixtures.json` | Corpus to run |
| `--uploads-dir=<path>` | iCloud `data/uploads/uploads` | Where sources live (`$UPLOADS_DIR` also works) |
| `--limit=<n>` | all | First n manifest entries |
| `--trials=<n>` | 1 | Run the set n times, one batch each; needs `--reset` above 1 |
| `--reset` | off | `scripts/sandbox-reset.sh` before every trial, once the stack is idle |
| `--run-id=<id>` | `ed-<UTC time>-<hex>` | Names the report files and the dump directory |
| `--label=<text>` | none | Free text on the report, e.g. `arm A` |
| `--out=<dir>` | the manifest's directory | Where the report goes |
| `--dump=<dir>` | off | Write each fixture's rows (needs `--pg`; refused inside the repo) |
| `--pg=<url>` | none | Postgres of the stack under test, opened read-only. Sandbox: `postgresql://postgres:postgres@127.0.0.1:5433/receipts`. Also finds each upload's own document and, once run records exist, its transcript |
| `--transcripts=<dir>` | sandbox `test-claude/projects/-app` | Session JSONL directory; `none` to skip |
| `--stall-min=<n>` | per-run timeout + 5 | Give a trial up when nothing has moved this long |
| `--timeout-min=<n>` | from fixtures, timeout, concurrency | Hard cap per trial |
| `--gate` | off | Exit 1 if date accuracy < 90% (#27 AC#1) |
| `--dry-run` | off | Resolve and copy every fixture, check the copies, upload nothing |
| `--rescore=<batch id>[,<id>]` | off | Score batches that already ran, with the current manifest and code: no reset, upload or model calls. Items are matched to fixtures by upload filename. Use it after correcting ground truth, or to dump a run after the fact (before the next reset) |

Two arms are two runs. Recreate the sandbox for each with the conditions
that differ from the compose defaults named on the command line (the
sandbox's concurrency default is 6, and a value in `.env` would move
production too):

```bash
# arm A
MAX_CLAUDE_CONCURRENCY=1 EXTRACTION_WRITER=agent_sql \
  docker compose -f docker-compose.test.yml up -d
# arm B
MAX_CLAUDE_CONCURRENCY=1 EXTRACTION_WRITER=server_apply \
  docker compose -f docker-compose.test.yml up -d
```

Give each its own `--run-id` and `--label`; `--trials=n` repeats one arm.
The report records what the container actually ran with (`conditions`),
so a run with the wrong setting shows on its face, and the harness
refuses a concurrency other than 1.

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

Every field is scored twice:

- **Lenient** (`scoring.<field>_match`, `aggregate.fields`): a run that
  produced no value is not scored (null), as in #27.
- **Strict** (`scoring.strict`, `aggregate.fields_strict`): on a fixture
  that expects a transaction of its own (`expected_status` exactly
  `done`, bucket not `duplicate` or `good_rejects`), a field the ground
  truth names but the run left empty (an error, no transaction, no payee)
  is **wrong**. Otherwise as lenient. Compare arms on this view: under the
  lenient one an arm that errors more drops those documents from the
  denominator and looks more accurate.

With several trials the report adds, per fixture, the majority verdict
(`pass`, `fail`, `split` on a tie, `n/a`) for the bucket and for each
field, lenient at the top level and strict under `strict`. The Markdown
table shows the strict verdicts, which is how the wave-1 gate G1 compares
arms: an arm that books nothing on a fixture fails it.

The aggregate date accuracy for `--gate` is the lenient `correct /
scored` (#27 AC#1), checked against 90%.

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
