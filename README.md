# Receipt Assistant

An open-source, AI-native receipt parsing backend that extracts structured data from receipt images using Claude Code CLI, stores results in PostgreSQL, and keeps the full transcript of every AI call as Claude Code session JSONL.

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
                  │   reasons in text     │        ┌───────────────┐
                  │   writes to Postgres  │───────►│ session JSONL │
                  │   via psql tool call  │        │ ~/.claude/    │
                  └───────────────────────┘        │ projects/-app │
                                                   └───────────────┘
```

### Single-call agent pipeline

`--json-schema` mode constrains Claude's output format and **degrades OCR accuracy** (4/10 dates wrong vs 0/10 with plain text), because it skips chain-of-thought reasoning. The current flow (`src/ingest/prompt.ts::buildExtractorPrompt`, spawned by `src/ingest/extractor.ts`) is a **single `claude -p` invocation** that reads the image, reasons about ambiguous characters in plain text, and writes the whole balanced transaction directly to Postgres via `psql` tool calls — no JSON-schema coercion anywhere. Node never parses fields; it seeds the `ingests` row and waits for the agent to close it. Full A/B rationale and the prior two-phase variant (kept around for anyone benchmarking a return) live in [`CLAUDE.md`](CLAUDE.md#known-pitfalls).

The agent is handed only what its job needs: five tools (Bash, Read, Write, Edit, WebSearch), no MCP servers, an allowlisted environment, and a `DATABASE_URL` that logs in as a Postgres role (`receipts_agent`) which can read, insert into and update only the tables and columns the prompt writes, with no DELETE and no DDL. That stops mistakes and simple injections. It is not a wall: the agent has an unrestricted shell running as the server's own user, and a hostile receipt that tells it to go around the role can. The natural-language Ask agent is confined properly: it has no tools at all, and the server runs the SQL it writes as a SELECT-only role (`receipts_ro`) in a read-only transaction. The details, and the list of what is still open, are in [`CLAUDE.md`](CLAUDE.md#agent-sandbox-what-the-two-agents-can-reach).

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

The root `docker-compose.yml` runs **receipt-assistant + its own postgres**.

Everything runs in Docker — there is no `npm run dev` on the host.

### Prerequisites

- Docker Desktop (or Docker Engine) with Compose v2
- A Claude Code subscription (Pro / Max / Team / Enterprise), and the `claude` CLI on some machine to mint a token with

### 1. Bring everything up

```bash
docker compose up -d --build
```

What happens:
- dedicated `receipts-postgres` starts and auto-creates the `receipts` database
- the receipt-assistant image is built (multi-stage: tsc in a builder stage, lean runtime)
- receipt-assistant starts on port 3000 (REST)

Follow progress with:

```bash
docker compose logs -f
```

Once everything is up:

```bash
curl http://localhost:3000/health
# { "status": "ok", "service": "receipt-assistant", "version": "1.0.0" }
```

### 2. Give the container a Claude token (one-time)

Auth is a long-lived setup-token on your Claude subscription, passed as an environment variable. Mint one and put it in `.env` **before** step 1 (or re-run `docker compose up -d receipt-assistant` afterwards):

```bash
claude setup-token          # prints a token valid for about a year
cp .env.example .env        # then set CLAUDE_CODE_OAUTH_TOKEN=<that token>
```

While you are in `.env`, set `RECEIPTS_AGENT_DB_PASSWORD` and `RECEIPTS_RO_DB_PASSWORD` (`openssl rand -hex 24` each). They are the passwords of the two restricted database roles: the extraction agent logs in as one, and the server runs the Ask model's queries as the other. The server sets them on the roles at every boot. Left unset, a built-in development password is used and boot prints a warning. On a new install also set `RECEIPTS_DB_OWNER_PASSWORD` (hex) before the first `up`, so the database owner does not keep the default password; on an existing database follow "Rotating the owner password" in `CLAUDE.md` instead. The server must connect as a role that may create roles (the compose files use the `postgres` superuser): migration 0041 creates the two restricted ones.

When the token variable is set it is the only credential the container uses, and it does not refresh itself: when it expires or is revoked, extraction returns 401 until you mint a new one. Rotation, 401 diagnosis and the reasons behind this design are in [`CLAUDE.md`](CLAUDE.md#claude-code-oauth--long-lived-setup-token-era-6-2026-10-08-onward).

### 3. After changing source code

```bash
docker compose up -d --build receipt-assistant
```

Only the app is rebuilt; the DB keeps running. Layer caching in
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
| Reconcile | `/v1/batches/:id/reconcile` (+ `/apply`, `/reject`, `/undo`) | Review, apply and take back a batch's reconcile proposals |
| Ledger | `/v1/transactions` (+ `/bulk`, `/:id/restore`, `/:id/reconcile`, `/:id/unreconcile`, `/:id/items`, `/:id/postings`) | Double-entry transactions with their postings and line items |
| | `/v1/accounts` (+ `/:id/balance`, `/:id/register`), `GET /v1/postings`, `GET /v1/items` | Chart of accounts; posting and line-item search |
| Documents | `/v1/documents` (+ `/:id/content`, `/:id/rendered`, `/:id/links`, `/:id/restore`, `/:id/re-extract`) | Stored receipt files and their links to transactions |
| Catalog | `/v1/products`, `/v1/owned-items`, `/v1/wish-items`, `/v1/brands`, `/v1/merchants/:id`, `/v1/places/:id` | Products, owned and wished-for items, brands, merchants, places |
| Reports | `GET /v1/reports/summary`, `/cashflow`, `/net_worth`, `/trends` | Spending and balance aggregates |
| Insights | `GET /v1/insights`, `POST /v1/insights/ask` | Generated insights; natural-language questions about spending |
| Meta | `GET /health`, `GET /version`, `POST /v1/admin/re-derive` | Health check, build info, batch re-projection |

### Errors

Every error is an RFC 7807 `application/problem+json` document. Branch on `type`; `trace_id` is the handle for finding the cause in the server log (`docker logs receipt-assistant 2>&1 | grep trace_id=<id>`).

| Status | `type` (after `https://receipts.dev/errors/`) | When |
|--------|-----------------------------------------------|------|
| 400 | `invalid-id` | An id in the path or query string is not a UUID (`/v1/places/{id}` also takes a Google place id, `/v1/merchants/{id}` a brand slug) |
| 400 | `malformed-body`, `malformed-upload`, `invalid-cursor`, `invalid-parameter`, `invalid-idempotency-key` | Body is not JSON / not parseable multipart; cursor was not issued by this API; a value cannot be read as its type; `Idempotency-Key` is over 255 characters |
| 404 | `not-found` · `route-not-found` | The record does not exist · no such URL or method |
| 409 | `conflict`, `still-referenced`, `idempotency-conflict`, `idempotency-in-progress`, … | The request collides with current state |
| 409 | `concurrent-update` | Another request was changing the same records at the same moment (a database deadlock or serialization failure). Nothing was written; send the same request again after `Retry-After` seconds |
| 412 / 428 | `version-mismatch` / `precondition-required` | `If-Match` is stale / missing |
| 413 | `payload-too-large` | Body or upload over the endpoint's limit |
| 422 | `validation`, `invalid-reference`, `constraint-violation`, … | The body is well-formed but not acceptable |
| 500 | `internal` | Unexpected. The body is a fixed sentence plus `trace_id`; nothing from the error itself is returned |

`scripts/check-http-errors.ts` asserts this contract over real HTTP against a throwaway database (usage in its header). See [`CLAUDE.md` → HTTP error contract](CLAUDE.md#http-error-contract) for how the server side is put together.

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

## Agent transcripts

Every `claude -p` call is recorded by Claude Code itself — prompt, reasoning, every tool call and result, per-turn token usage — at `~/Developer/receipt-assistant-data/claude/projects/-app/<session-id>.jsonl` (bind-mounted from the container). The image pins `cleanupPeriodDays` to 36500 (100 years, i.e. permanent) in managed settings; the CLI default would delete them after 30 days.

Every run also has a row in `agent_runs`, written by the server: the session id that names its transcript, the model that answered, turns, tokens, how it ended and why.

```sql
-- The run(s) for an ingest
SELECT session_id, status, outcome, error_class, model_observed, turns FROM agent_runs WHERE ingest_id = '<ingest-id>';
```

```bash
# Turns and billed tokens for the 20 most recent extraction runs
npm run measure:turns -- --dir=$HOME/Developer/receipt-assistant-data/claude/projects/-app --last=20 --kind=ingest

# A run from before agent_runs existed: the prompt carries the ingest id
grep -l "<ingest-id>" ~/Developer/receipt-assistant-data/claude/projects/-app/*.jsonl
```

See [`CLAUDE.md` → Agent transcripts](CLAUDE.md#agent-transcripts-session-jsonl) for run records and live tailing.

The sandbox stack keeps its own transcripts in `~/Developer/receipt-assistant-data/test-claude/projects/-app/`.

## Scripts

Everything in `scripts/` is run with `npx tsx scripts/<name>.ts` (or directly, for `.sh`). The ones with an npm alias:

| Command | Purpose |
|---------|---------|
| `npm run openapi:generate` | Regenerate `openapi/openapi.json` |
| `npm run check:prompt-render` | Fail if a legacy extraction or re-extract prompt rendering differs from its golden hash (also runs before every build) |
| `npm run check:prompt-budget` | Fail if the extraction prompt outgrew its recorded baseline (also runs before every build) |
| `npm run check:ingest-classification` | Assert the ingest-failure classifier against real error strings |
| `npm run check:agent-grants` | Fail if the SQL in the prompts is not covered by the extraction agent's database grants (also runs before every build) |
| `npm run check:agent-sandbox` | On the sandbox stack: prove by attempt what the agents' database roles and tool lists allow and refuse |
| `npm run check:contract` | Exercise every rule of the extraction record contract, its validator and its hand-back parser on synthetic records (also runs before every build) |
| `npm run check:apply-decide` | Exercise the server applier's duplicate decision and its projection to postings, line items and metadata on synthetic records (also runs before every build) |
| `npm run measure:turns` | Turns, billed tokens and model per extraction, from session JSONL (the parser that also fills `agent_runs`) |
| `npm run eval:dates` | On the sandbox: extraction accuracy (date, total, payee, classification, flow, currency) plus turns and tokens per run, against a document manifest (`scripts/eval-dates.md`) |
| `npm run db:migrate:prod` | Apply migrations inside the runtime image |

The rest are sandbox regression harnesses (`eval-dedup.ts`, `smoke-*.ts`, and `probe-cli.ts`, which records how the pinned `claude` CLI handles `--resume` and output formats), checks that need a throwaway Postgres (`check-extraction-records.ts`, `check-apply-extraction.ts`, which runs every write branch of the server applier, and `check-http-errors.ts`), a read-only replay of the server applier's projection against a ledger (`check-projection-replay.ts`), one-off data backfills (`backfill-*.ts`) and ledger snapshot/restore (`tx-snapshot.sh`, `tx-restore.sh`); each documents its own usage in its header.

The sandbox is a second stack (`docker-compose.test.yml`: API on 3001, its own image tag, database and data directories) that shares no state with production. `scripts/sandbox-reset.sh` returns it to an empty ledger without a restart, and `scripts/check-sandbox-reset.sh` checks that the reset still keeps exactly what a boot writes (run it after adding a migration). See [`CLAUDE.md` → Sandbox stack](CLAUDE.md#sandbox-stack-docker-composetestyml).

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript (ES2022)
- **Framework**: Express 5
- **Database**: PostgreSQL 17
- **AI**: Claude Code CLI (`claude -p`) with subscription auth
- **Tracing**: Claude Code session JSONL (no separate stack)
- **Image Processing**: sharp (perceptual hashes for dedup)

## Frontend

See [receipt-assistant-frontend](https://github.com/TINKPA/receipt-assistant-frontend) for the React dashboard.

## License

MIT
