# Receipt Assistant

An open-source, AI-native receipt parsing backend that extracts structured data from receipt images using Claude Code CLI, stores results in PostgreSQL, and monitors every AI call through Langfuse.

## Architecture

```
                     ┌──────────────┐
  Receipt Image ───► │  Express API │ ───► PostgreSQL (receipts db)
  (/v1/ingest/batch) │   :3000      │              ▲
                     └──────┬───────┘              │
                            │                      │ writes via psql tool
                            ▼                      │
                  ┌── Single-call agent ──┐        │
                  │   claude -p           │────────┘
                  │   reads image         │
                  │   reasons in text     │        ┌─────────────┐
                  │   writes to Postgres  │───────►│ Langfuse    │
                  │   via psql tool call  │        │ :3333       │
                  └───────────────────────┘        │ auto-ingest │
                                                   └─────────────┘
```

### Single-call agent pipeline

`--json-schema` mode constrains Claude's output format and **degrades OCR accuracy** (4/10 dates wrong vs 0/10 with plain text), because it skips chain-of-thought reasoning. The current flow (`src/ingest/prompt.ts::buildExtractorPrompt`, spawned by `src/ingest/extractor.ts`) is a **single `claude -p` invocation** that reads the image, reasons about ambiguous characters in plain text, and writes the whole balanced transaction directly to Postgres via `psql` tool calls — no JSON-schema coercion anywhere. Node never parses fields; it seeds the `ingests` row and waits for the agent to close it. Full A/B rationale and the prior two-phase variant (kept around for anyone benchmarking a return) live in [`CLAUDE.md`](CLAUDE.md#known-pitfalls).

The rules the agent is given are **not** duplicated per prompt: `src/ingest/prompt-contract.ts`, `document-read-prompt.ts`, `line-item-prompt.ts` and `items-sql.ts` hold the single copy that both the ingest prompt and `reextract-prompt.ts` interpolate (#164).

### Quality & Business Flags

Every extraction includes metadata stored as PostgreSQL JSONB:

```json
{
  "quality": {
    "confidence_score": 0.72,
    "missing_fields": ["notes"],
    "warnings": ["truncated_merchant", "handwritten_tip", "partial_ocr"]
  },
  "business": {
    "is_reimbursable": false,
    "is_tax_deductible": true,
    "is_recurring": false,
    "is_split_bill": false
  }
}
```

## Quick Start

Two independent units live in the root `docker-compose.yml`:

1. **receipt-assistant + its own postgres** — the app and its database,
   deployable on their own.
2. **Langfuse stack** (postgres, clickhouse, minio, redis, web, worker) —
   optional developer observability, pulled in via `include:`. Comment out
   the `include:` line in `docker-compose.yml` to run the app without it;
   trace ingestion fails silently when Langfuse is unreachable.

Everything runs in Docker — there is no `npm run dev` on the host.

### Prerequisites

- Docker Desktop (or Docker Engine) with Compose v2.20+ (for `include:` support)
- A Claude Code subscription (Pro / Max / Team / Enterprise) to log in with

### 1. Bring everything up

```bash
docker compose up -d --build
```

What happens:
- dedicated `receipts-postgres` starts and auto-creates the `receipts` database
- the receipt-assistant image is built (multi-stage: tsc in a builder stage, lean runtime)
- receipt-assistant starts on port 3000 (REST)
- the Langfuse stack starts in parallel

First-time pull of the Langfuse images is 2–3 GB; expect 3–5 minutes on a
fresh machine. Follow progress with:

```bash
docker compose logs -f
```

Once everything is up:

```bash
curl http://localhost:3000/health
# { "status": "ok", "service": "receipt-assistant", "version": "1.0.0" }
```

Langfuse dashboard: http://localhost:3333 (admin@local.dev / admin123)

### 2. Log the container into Claude (one-time)

The container holds its own OAuth session, independent of anything on the host. Bootstrap it **once**:

```bash
docker exec -it receipt-assistant claude /login
# Follow the prompt: open the URL in a browser, authenticate,
# paste the returned code back into the terminal.
```

Credentials persist on the host at `~/Developer/receipt-assistant-data/claude/` (bind-mounted into the container at `/home/node/.claude`) and survive every `docker compose down` / `up` / `restart` — and OrbStack resets, unlike Docker named volumes. The in-container CLI self-refreshes access + refresh tokens on expiry and writes rotation back into the bind path. No env var, no host Keychain sync, no recurring script.

Eventually the refresh token expires server-side (weeks to months). When that happens the next call returns 401 — rerun the same `claude /login` inside the container. For full bootstrap, migration, and 401-recovery procedures, invoke the **`setup` skill** in Claude Code inside this project.

### 3. After changing source code

```bash
docker compose up -d --build receipt-assistant
```

Only the app is rebuilt; the DB and Langfuse keep running. Layer caching in
the Dockerfile means unchanged `package.json` skips the `npm ci` step, so
rebuilds are typically 10–20 seconds.

### 4. Test with a receipt

```bash
BASE=http://localhost:3000
BATCH=$(curl -sS -X POST "$BASE/v1/ingest/batch" -F "file=@receipt.jpg" | jq -r .batchId)
until [[ "$(curl -sS "$BASE/v1/batches/$BATCH" | jq -r .status)" =~ ^(extracted|reconciled|failed)$ ]]; do sleep 3; done
curl -sS "$BASE/v1/batches/$BATCH" | jq '.items[] | {id,status,error,produced}'
TX=$(curl -sS "$BASE/v1/batches/$BATCH" | jq -r '.items[0].produced.transaction_ids[0]')
curl -sS "$BASE/v1/transactions/$TX" | jq .
```

- Line 2 uploads the file and returns a `batchId`. Extraction runs in the background.
- Line 3 polls until the batch is `extracted`, `reconciled` or `failed`; line 4 shows each file's result.
- Lines 5 and 6 fetch the transaction the agent wrote: payee, date, postings and line items.

## API Reference

The machine-readable contract is `openapi/openapi.json` (committed; OpenAPI 3.1). The table below is for quick reference — the spec is the source of truth. A running server also serves it at `/openapi.json`, with Swagger UI at `/docs`.

| Area | Endpoints | What it covers |
|------|-----------|----------------|
| Ingest | `POST /v1/ingest/batch` | Upload receipt files (images, PDFs, `.eml`); returns a `batchId` for async extraction |
| | `GET /v1/batches`, `GET /v1/batches/:id`, `GET /v1/batches/:id/stream` | Batch status, per-file results, SSE progress |
| | `GET /v1/ingests`, `GET /v1/ingests/problems`, `POST /v1/ingests/:id/retry` | Per-file ingest rows; list and retry failures |
| Reconcile | `/v1/batches/:id/reconcile` (+ `/apply`, `/reject`) | Review and apply a batch's reconcile proposals |
| Ledger | `/v1/transactions` (+ `/bulk`, `/:id/restore`, `/:id/reconcile`, `/:id/unreconcile`, `/:id/items`, `/:id/postings`) | Double-entry transactions with their postings and line items |
| | `/v1/accounts` (+ `/:id/balance`, `/:id/register`), `GET /v1/postings`, `GET /v1/items` | Chart of accounts; posting and line-item search |
| Documents | `/v1/documents` (+ `/:id/content`, `/:id/rendered`, `/:id/links`, `/:id/restore`, `/:id/re-extract`) | Stored receipt files and their links to transactions |
| Catalog | `/v1/products`, `/v1/owned-items`, `/v1/wish-items`, `/v1/brands`, `/v1/merchants/:id`, `/v1/places/:id` | Products, owned and wished-for items, brands, merchants, places |
| Reports | `GET /v1/reports/summary`, `/cashflow`, `/net_worth`, `/trends` | Spending and balance aggregates |
| Insights | `GET /v1/insights`, `POST /v1/insights/ask` | Generated insights; natural-language questions about spending |
| Meta | `GET /health`, `GET /version`, `POST /v1/admin/re-derive` | Health check, build info, batch re-projection |

### OpenAPI contract (for client codegen)

The frontend, and any future client, generates typed bindings from `openapi/openapi.json` instead of hand-writing `fetch` calls.

| File / command | Purpose |
|---------------|---------|
| `openapi/openapi.json` | Generated spec — **commit-tracked**, source of truth for SDK codegen |
| `src/schemas/v1/*.ts` | One zod schema file per resource (`transaction`, `document`, `ingest`, `account`, …) |
| `src/routes/*.ts` | Each resource's handlers, plus a `registerXOpenApi(registry)` that registers its paths |
| `src/openapi.ts` | Builds the registry by calling every `registerXOpenApi` |
| `npm run openapi:generate` | Regenerate `openapi/openapi.json` after editing schemas |

See [`CLAUDE.md` → Schema editing workflow](CLAUDE.md#schema-editing-workflow-openapi-contract) for the edit-and-regen rules.

## Langfuse Monitoring

Every `claude -p` call is automatically traced in Langfuse with:
- Model name, token usage, latency
- Input prompt and output
- Phase tags (`phase-1/quick`, `phase-2/full`)
- Tool calls

### Query traces via API

```bash
# List recent traces
curl -s http://localhost:3333/api/public/traces \
  -u "pk-receipt-local:sk-receipt-local"

# Get a specific trace
curl -s http://localhost:3333/api/public/traces/<trace-id> \
  -u "pk-receipt-local:sk-receipt-local"
```

## Scripts

| Script | Usage |
|--------|-------|
| `scripts/benchmark.sh` | Upload 10 receipts sequentially, measure per-phase timing via SSE |

OAuth credential management lives in the **`setup` skill** (see `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/.claude/skills/setup/SKILL.md`) — there is no recurring shell script for token refresh. The in-container CLI self-refreshes via the RW volume mount configured in `docker-compose.yml`.

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript (ES2022)
- **Framework**: Express 5
- **Database**: PostgreSQL 17 (its own instance; Langfuse runs a separate one)
- **AI**: Claude Code CLI (`claude -p`) with subscription auth
- **Monitoring**: Langfuse (self-hosted)
- **Image Processing**: heic-convert (HEIC → JPEG)

## Frontend

See [receipt-assistant-frontend](https://github.com/TINKPA/receipt-assistant-frontend) for the React dashboard.

## License

MIT
