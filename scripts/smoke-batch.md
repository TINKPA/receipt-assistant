# smoke-batch — manual end-to-end verification of `/v1/ingest/batch`

Phase 1 of issue #32 ships the batch ingestion endpoint but no automated CLI harness — integration tests cover the happy path with a stubbed extractor. This doc shows how to exercise the **real** `claude -p` pipeline end-to-end against the running Docker stack.

## Prerequisites

- `receipt-assistant` running on `localhost:3000` (the usual `docker compose up`).
- `claude` CLI v2.x authenticated on host + in-container (see the `setup` skill if 401s appear).
- Two or three real receipt images on disk — e.g. `~/Desktop/RECEIPT/*.jpeg`.

## Step 1 — Submit a batch

Upload multiple files in one request:

```bash
BATCH=$(curl -sS -X POST http://localhost:3000/v1/ingest/batch \
  -F "files=@$HOME/Desktop/RECEIPT/image-a.jpeg;type=image/jpeg" \
  -F "files=@$HOME/Desktop/RECEIPT/image-b.jpeg;type=image/jpeg" \
  -F "files=@$HOME/Desktop/RECEIPT/image-c.jpeg;type=image/jpeg" \
  -F "auto_reconcile=false")

echo "$BATCH" | jq .
BATCH_ID=$(echo "$BATCH" | jq -r .batchId)
echo "batchId=$BATCH_ID"
```

Expected: HTTP 202 + JSON with `batchId`, `status="pending"`, `items[]`, `poll`.

## Step 2 — Poll for completion

Each file spawns its own `claude -p` (bounded by `MAX_CLAUDE_CONCURRENCY`, default 3). Expect 15–60 seconds per file.

```bash
while :; do
  STATUS=$(curl -sS http://localhost:3000/v1/batches/$BATCH_ID | jq -r .status)
  echo "status=$STATUS"
  [[ "$STATUS" == "extracted" || "$STATUS" == "failed" ]] && break
  sleep 5
done
```

## Step 3 — Inspect the aggregated state

```bash
curl -sS http://localhost:3000/v1/batches/$BATCH_ID | jq .
```

Expected shape:

```json
{
  "id": "…",
  "status": "extracted",
  "file_count": 3,
  "counts": { "total": 3, "done": 3, "error": 0, "unsupported": 0, "queued": 0, "processing": 0 },
  "items": [ { "id": "…", "status": "done", "classification": "receipt_image",
               "produced": { "transaction_ids": ["…"], "document_ids": ["…"], "receipt_ids": [] },
               "…": "…" }, … ]
}
```

## Step 4 — Follow the provenance

Pick one ingest row and trace to the transaction it produced:

```bash
INGEST_ID=$(curl -sS http://localhost:3000/v1/batches/$BATCH_ID | jq -r '.items[0].id')
curl -sS http://localhost:3000/v1/ingests/$INGEST_ID | jq .

# Reverse lookup from the transaction back to its ingest.
curl -sS "http://localhost:3000/v1/transactions?source_ingest_id=$INGEST_ID" | jq '.items[0]'
```

## Step 5 — Langfuse trace (optional)

Each `claude -p` invocation records a Langfuse trace keyed on the pre-allocated session-id. Pull traces via the REST API (**never** scrape the UI):

```bash
curl -sS http://localhost:3333/api/public/traces \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | jq '.data[0:3]'
```

## What to verify manually

- All 3 ingests reach `status="done"` (or `"unsupported"` for known-hard cases).
- Each produced transaction has a matching document linked.
- `/v1/transactions?source_ingest_id=<id>` returns exactly one row per ingest.
- Langfuse traces exist with reasonable `total_tokens` values.
- On the **hard fixtures** from CLAUDE.md (Costco gas receipt, handwritten tip, AYCE sushi), `date_match` accuracy is the known weak dimension — don't panic if 1/3 fails on dates. That's tracked in issue #27.

## Failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `counts.error > 0` with "401" in `ingests.error` | Claude CLI can't reach Anthropic | Run the `setup` skill — credential file drift |
| `counts.unsupported` hit for a real receipt | Agent's final JSON fence was malformed | Inspect Langfuse trace output; the fallback coercer logs a reason |
| Ingest stuck at `processing` for >5 min | Worker hang (rare) | Restart container; `recoverStaleBatches()` will mark it `failed` on boot |
| `statement_pdf` classification → marked `unsupported` with note "Phase 2" | Expected Phase 1 behavior | Statement pipeline deferred; file as `receipt_pdf` if it's actually a single-invoice doc |

## Automation hook (not implemented yet)

A scripted version analogous to `scripts/smoke-v1-ingest.ts` is Phase 2 work — at that point it should also exercise the reconcile + SSE endpoints. For Phase 1, this document is the contract.
