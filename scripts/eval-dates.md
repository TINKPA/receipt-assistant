# `eval-dates` — Date-OCR evaluation harness

`scripts/eval-dates.ts` round-trips a manifest of receipt fixtures through
the live `/v1/ingest/batch` worker pipeline and scores the extracted
`(date, total, payee)` per fixture against committed ground truth. It's
the durable AC#3 deliverable for [receipt-assistant#27].

[receipt-assistant#27]: https://github.com/TINKPA/receipt-assistant/issues/27

## TL;DR

```bash
# from inside ~/Developer/receipt-assistant/
docker compose up -d                # backend + postgres + claude container
npm run eval:dates                  # ~5-10 min for the default 23 fixtures
cat scripts/eval-dates.report.md    # human-readable table
```

Reports land at `scripts/eval-dates.report.{json,md}` (gitignored — the
manifest is committed, the per-run report is not).

## How it works

1. Reads `scripts/eval-dates.fixtures.json`.
2. For each fixture, locates the source JPG at
   `${UPLOADS_DIR}/<sha256>.jpg` (default
   `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads/`).
3. Re-encodes via `sips -s formatOptions 75` into a tmpdir. The
   re-encode is **load-bearing**: it bumps each file's SHA past
   `documents.sha256` dedupe so the worker actually re-runs `claude -p`
   on every fixture every run. Without this you'd score against cached
   extractions from weeks ago and miss any current-pipeline regressions.
4. POSTs all fixtures in a single multipart batch to `/v1/ingest/batch`.
5. Polls `/v1/batches/<id>` every 3 s until every ingest reaches a
   terminal state (`done` / `unsupported` / `error`). 10 min timeout.
6. For each `done` ingest, `GET /v1/transactions/<tx_id>` to pull
   `occurred_on`, `payee`, and `max(|postings.amount_minor|)` (the
   expense-leg total).
7. Scores per bucket (table below), emits JSON + Markdown reports.

The harness uses no auth headers — every request hits the seed
workspace via `contextMiddleware` (`src/http/context.ts`). No
`--json-schema` is involved anywhere; the worker owns the
`claude -p` invocation. **No direct DB access**: the harness only
talks to the HTTP API.

## CLI flags

| Flag                | Default                                                                                  | What it does                          |
|---------------------|------------------------------------------------------------------------------------------|---------------------------------------|
| `--base=<url>`      | `http://localhost:3000`                                                                  | API base                              |
| `--manifest=<path>` | `scripts/eval-dates.fixtures.json`                                                       | Alternate manifest (for prompt A/Bs)  |
| `--uploads-dir=<p>` | `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/uploads`                 | Where the SHA-named JPGs live         |
| `--limit=<n>`       | all                                                                                      | Run a subset (debug)                  |
| `--gate`            | off                                                                                      | Exit 1 if date_accuracy < 90% (AC#1)  |

`UPLOADS_DIR=...` env var is also honored.

## Buckets and pass criteria

The manifest assigns each fixture to one of five buckets. The harness
scores each fixture by the bucket-specific rule below; the aggregate
`date_accuracy` reported at the top of the report is a uniform metric
across every extracted fixture and is what AC#1 (≥ 90%) measures
against.

| Bucket          | Pass means                                                                       | Why this exists                                                                                                   |
|-----------------|----------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `hard_date`     | `transactions.occurred_on == ground_truth.date`                                  | Known-failing date OCR (Wilson 30↔03, etc.). A prompt fix that unsticks any of these moves the needle.            |
| `hard_total`    | `max(\|postings.amount_minor\|) == ground_truth.total_minor`                     | Subtotal-vs-final / handwritten-tip confusion fixtures.                                                            |
| `hard_all`      | All three of date, total, payee match                                            | Pathological fixture (WingHopFung). Single image stress-tests three independent dimensions.                       |
| `good_rejects`  | `ingest_status == "unsupported"`                                                 | Blurry photos where the worker correctly refuses to guess. Currently empty — add fixtures as they surface.        |
| `good`          | Date + total + payee all match                                                   | Regression guard. A prompt that improves `hard_date` but breaks any of these is net-bad.                          |

Within each bucket:
- `date_match` — `occurred_on === ground_truth.date` (string compare,
  YYYY-MM-DD).
- `total_match` — `max(|amount_minor|) === ground_truth.total_minor`.
  Null if the manifest entry has no total or the ingest didn't produce
  a transaction.
- `payee_match` — case-insensitive substring of **any** of the
  manifest's `merchant_tokens` in the extracted payee. Tokens are
  lowercase CamelCase splits of the filename merchant slug (e.g.
  `WingHopFung` → `["wing", "hop", "fung"]`). The match passes if the
  worker resolves the payee to *anything* recognizable — store
  numbers, district names, and the canonical brand name all match.

## Adding a fixture to the manifest

1. Identify the receipt in the live DB:
   ```bash
   docker exec receipts-postgres psql -U postgres -d receipts -c "
     SELECT i.filename, d.sha256, t.occurred_on, t.payee
     FROM ingests i
     JOIN documents d ON d.source_ingest_id = i.id
     LEFT JOIN transactions t ON t.source_ingest_id = i.id
     WHERE i.filename ILIKE '%PARTIAL%' AND i.status = 'done';
   "
   ```
2. Confirm `${UPLOADS_DIR}/<sha>.jpg` exists on disk.
3. Decide the bucket. Rules of thumb:
   - DB `occurred_on` ≠ filename date → `hard_date`
   - DB total ≠ filename total → `hard_total`
   - Both wrong + payee also drifts → `hard_all`
   - Status returns `unsupported` → `good_rejects` (rare — add when
     a deliberately-blurry photo is part of the corpus)
   - Otherwise → `good`
4. Add an entry to `scripts/eval-dates.fixtures.json`:
   ```jsonc
   {
     "sha256": "<from query>",
     "original_filename": "<from query>",
     "bucket": "<bucket>",
     "ground_truth": {
       "date": "YYYY-MM-DD",                       // from filename
       "merchant_tokens": ["lower", "case", "tokens"],
       "total_minor": 1234                          // null if filename has no total
     },
     "expected_status": "done",                     // or "unsupported"
     "notes": "Why this fixture is in the manifest — one short sentence."
   }
   ```
5. Re-run `npm run eval:dates` and verify the new entry shows in
   the report.

The manifest is the durable artifact. The JPGs themselves stay in
`data/uploads/uploads/` (iCloud, gitignored per the
three-data-locations invariant — these are real PII receipts).
Anyone with access to that uploads dir can run the eval; the manifest
defines what "correct" means.

## Interpreting the report

The Markdown report has three sections:

- **Aggregate**: top-line `date_accuracy`. Compare against the 90% AC#1
  threshold. Numerator = fixtures whose extracted date matches ground
  truth. Denominator = fixtures with *any* extraction (so
  `good_rejects` don't dilute the metric).
- **By bucket**: pass counts per bucket. Use this to localize a
  regression — e.g. if `hard_date` passes drop from 2/5 to 0/5 but
  `good` passes drop from 14/14 to 12/14, the prompt change has a
  *different* failure mode than just "couldn't fix the hard ones".
- **Per-fixture**: every row shows extracted vs ground-truth date and
  total side-by-side. `✅`/`❌` mark match/mismatch; `—` means
  the dimension wasn't applicable (e.g. no total in filename, or no
  extraction at all).

### Known stragglers (do not panic)

- **WingHopFung wine** (`hard_all`) — non-deterministic across runs
  per the [2026-04-21 issue comment][nd-comment]. Faded thermal
  paper; pixel-level OCR is beyond what prompt iteration can fix.
  Expect this to fail on most runs.
- **Wilson wristband** (`hard_date`) — 09/30 → 09/03 deterministic
  across 3 rounds of Phase 2.5 self-check iteration. A digit-order
  read error. Expect this to fail until a model upgrade or image
  preprocessing lands.

[nd-comment]: https://github.com/TINKPA/receipt-assistant/issues/27#issuecomment-4285867967

### When `date_accuracy < 90%`

That's the issue #27 starting condition. The harness gives you a
deterministic, repeatable measurement; the next move depends on
what's failing:

- **All `hard_*` failing, `good` clean** → the prompt is at its
  current ceiling; pivot to A/B trials with prompt variants (see
  the original issue body) or to a model bump.
- **`good` regressed** → a recent prompt or model change has
  broader cost than the win it was after; revert and investigate.
- **A new failure mode in a previously-`good` fixture** → promote
  that fixture to a `hard_*` bucket and continue iterating.

## Bash AC#1 wrapper (per the issue body)

The issue body asks for `scripts/eval-dates.sh`. Since every existing
script in this repo runs through `tsx`, the package.json `eval:dates`
script is the canonical entry point and what gets used in practice.
If a CI runner needs an exact `.sh` filename to invoke, this
single-line wrapper is the bridge:

```bash
#!/usr/bin/env bash
exec npm run eval:dates -- --gate "$@"
```

(Not committed by default — add `scripts/eval-dates.sh` only if a
specific CI integration demands it.)
