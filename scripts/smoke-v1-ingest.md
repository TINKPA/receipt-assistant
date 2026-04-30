# smoke-v1-ingest — host-side `/v1/*` API ingestion smoke test

Black-box end-to-end test of the new `/v1/*` ledger API against the already-running Docker stack. Uploads N real receipt images, extracts structured fields with host-side `claude -p` (plain-text + fenced JSON, **no** `--json-schema`), creates balanced 2-posting transactions, links the documents, and reports extraction accuracy against ground truth parsed from filenames.

## Prerequisites

- `receipt-assistant` container running on `localhost:3000` and `receipts-postgres` healthy. Check with `docker ps`.
- Accounts seeded (`Expenses:Groceries`, `Expenses:Dining`, `Expenses:Transport`, `Expenses:Other`, `Liabilities:Credit Card`). Run `npm run db:seed` once if the target DB is fresh.
- `claude` CLI v2.x on host PATH, logged in (subscription auth).
- Node 22 (for built-in `fetch`, `FormData`, `Blob`).

## Run

From the inner repo (`~/Developer/receipt-assistant/`):

```bash
npx tsx scripts/smoke-v1-ingest.ts
```

### Args

| Flag                  | Default                                 | Meaning                                      |
|-----------------------|-----------------------------------------|----------------------------------------------|
| `--base=<url>`        | `http://localhost:3000`                 | API base URL                                 |
| `--files=<glob>`      | hard-coded 15 diverse receipts          | Override file selection (e.g. `/path/*.jpeg`)|
| `--concurrency=<n>`   | `3`                                     | Parallel `claude -p` workers                 |
| `--limit=<n>`         | `15`                                    | Cap the number processed                     |

## What it asserts

For each receipt:

1. `POST /v1/documents` with multipart `file`, `kind=receipt_image` — 201 on new, 200 on dedup.
2. `claude -p` extracts `{payee, occurred_on, total_minor, category_hint}` — plain text reasoning, trailing ` ```json ` fence parsed by the harness.
3. `category_hint` → expense account (groceries/dining/cafe/retail/transport/other). Fallback is `Expenses:Other`. "cafe" folds into `Expenses:Dining` (no dedicated cafe seed).
4. `POST /v1/transactions` with a balanced pair (expense debit, credit-card credit) and a deterministic `Idempotency-Key: smoke-<sha256(filename|file-sha256)[:24]>`. Re-running the harness on the same receipts is therefore idempotent — the tx is not duplicated.
5. `POST /v1/documents/:id/links` — exercises the explicit link endpoint even though `document_ids` on the transaction already links it. Must return 204.

### Idempotent reruns — 409 recovery

Claude's extraction is non-deterministic. On a rerun, if the extracted body differs from the body the server already stored under the same `Idempotency-Key`, `POST /v1/transactions` correctly returns `409 idempotency-conflict`. The harness treats that response as "already ingested" — it falls back to `GET /v1/transactions?limit=200` filtered by `metadata.ground_truth_file`, recovers the prior transaction id, and re-exercises the `/links` endpoint against it. The row is tagged `[reused prior tx]` in the output and the first-run extraction values are retained for accuracy tallying. This keeps the harness safely re-runnable without operator cleanup between invocations.

## Accuracy metrics

Ground truth is parsed from the filename:

```
YYYY-MM-DD_Receipt_<Merchant>_<description>_<TOTAL>.jpeg
```

- **date_match** — exact string equality vs `occurred_on`.
- **total_match** — exact integer equality in minor units. Filenames without a trailing total (e.g. `..._groceries.jpeg`) are skipped from the denominator.
- **payee_match** — any CamelCase token from `<Merchant>` (split on case boundaries) appears, case-insensitive, as a substring of the extracted payee.

## Output

Stdout shows one line per receipt plus an aggregate table:

```
Receipts processed : 15 / 15
Extractions parsed : 15 / 15
Date matches       : 14 / 15  (93%)
Total matches      : 13 / 15  (87%)
Payee substring    : 15 / 15  (100%)
Round-trip success : 15 / 15
```

Plus a `Failures` section with raw Claude output tail for any extraction errors, and a machine-readable JSON report at `scripts/smoke-v1-ingest.report.json` for diffing future runs.

## Non-goals

- Not a DB-level integrity test — see `src/routes/transactions.service.ts` for the constraint-trigger logic.
- Not a Langfuse trace check — extraction happens on the host, not in the container, so the Langfuse trace volume is not written.
- Not a load test. 15 receipts, concurrency 3, ~15–60s per extraction.
