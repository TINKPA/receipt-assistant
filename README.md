# Receipt Assistant

An open-source, AI-native receipt parsing backend that extracts structured data from receipt images using Claude Code CLI, stores results in PostgreSQL, and monitors every AI call through Langfuse.

## Architecture

```
                     ┌──────────────┐
  Receipt Image ───► │  Express API │ ───► PostgreSQL (receipts db)
  (POST /receipt)    │   :3000      │              ▲
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

`--json-schema` mode constrains Claude's output format and **degrades OCR accuracy** (4/10 dates wrong vs 0/10 with plain text), because it skips chain-of-thought reasoning. The current flow (`src/claude.ts::processReceipt`) is a **single `claude -p` invocation** that reads the image, reasons about ambiguous characters in plain text, and writes the extracted fields directly to Postgres via a `psql` tool call — no JSON-schema coercion anywhere. A placeholder receipt row is seeded at upload time and `UPDATE`d by the agent. Full A/B rationale and the prior two-phase variant (kept around for anyone benchmarking a return) live in [`CLAUDE.md`](CLAUDE.md#known-pitfalls).

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
- receipt-assistant starts on ports 3000 (REST) and 3001 (MCP)
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

Credentials persist in the `claude-code-config` named Docker volume and survive every `docker compose down` / `up` / `restart`. The in-container CLI self-refreshes access + refresh tokens on expiry and writes rotation back into the volume. No env var, no host Keychain sync, no recurring script.

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
# 1. Upload — returns { jobId, receiptId }
curl -X POST http://localhost:3000/receipt -F "image=@receipt.jpg"

# 2. Poll job status (queued → done / error)
curl http://localhost:3000/jobs/<jobId>

# 3. Fetch the parsed receipt (merchant, date, total, items, ...)
curl http://localhost:3000/receipt/<receiptId> | jq .
```

## API Reference

The machine-readable contract is `openapi/openapi.json` (committed; OpenAPI 3.1). The table below is for quick reference — the spec is the source of truth.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/receipt` | Upload receipt image, returns jobId for async processing |
| `GET` | `/jobs/:id` | Poll job status (`queued` → `done` or `error`) |
| `GET` | `/jobs/:id/stream` | SSE stream for real-time progress |
| `GET` | `/receipts` | List receipts (`?from=&to=&category=&limit=`) |
| `GET` | `/receipt/:id` | Get single receipt with line items |
| `DELETE` | `/receipt/:id` | Delete a receipt |
| `GET` | `/receipt/:id/image` | Serve the original receipt image |
| `GET` | `/summary` | Spending summary by category (`?from=&to=`) |
| `POST` | `/ask` | Ask a natural language question about spending |
| `GET` | `/health` | Health check |

### OpenAPI contract (for client codegen)

Frontend, macOS, and any future client generate typed bindings from `openapi/openapi.json` instead of hand-writing `fetch` / `URLSession` calls.

| File / command | Purpose |
|---------------|---------|
| `openapi/openapi.json` | Generated spec — **commit-tracked**, source of truth for SDK codegen |
| `src/schemas/*.ts` | One zod schema per resource (`receipt`, `job`, `summary`, `ask`, `health`, `common`) |
| `src/openapi.ts` | Route registry: maps schemas to all 9 paths / 10 method+path pairs |
| `npm run openapi:generate` | Regenerate `openapi/openapi.json` after editing schemas |

See [`CLAUDE.md` → Schema editing workflow](CLAUDE.md#schema-editing-workflow-openapi-contract) for the edit-and-regen rules.

### MCP Tools (port 3001)

| Tool | Description |
|------|-------------|
| `process_receipt` | Parse a receipt image and save to database |
| `list_receipts` | List receipts with date/category filters |
| `spending_summary` | Spending aggregated by category |
| `get_receipt` | Get receipt details with line items |
| `ask_about_spending` | Natural language query about spending habits |

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
- **Framework**: Express 5 + FastMCP
- **Database**: PostgreSQL (shared with Langfuse)
- **AI**: Claude Code CLI (`claude -p`) with subscription auth
- **Monitoring**: Langfuse (self-hosted)
- **Image Processing**: heic-convert (HEIC → JPEG)

## Frontend

See [receipt-assistant-frontend](https://github.com/TINKPA/receipt-assistant-frontend) for the React dashboard.

## License

MIT
