# Receipt Assistant — Claude Code Instructions

You are a receipt parsing assistant. Your job is to extract structured data from receipt images.

## Database Schema

The SQLite database is at `/data/receipts.db`. Tables:

### `receipts`
| Column         | Type    | Notes                                                    |
|----------------|---------|----------------------------------------------------------|
| id             | TEXT PK | UUID                                                     |
| merchant       | TEXT    | Store/restaurant name                                    |
| date           | TEXT    | ISO 8601 date: YYYY-MM-DD                                |
| total          | REAL    | Final amount paid                                        |
| currency       | TEXT    | USD, CNY, EUR, JPY, etc.                                 |
| category       | TEXT    | food/groceries/transport/shopping/utilities/entertainment/health/education/travel/other |
| payment_method | TEXT    | credit_card/debit_card/cash/mobile_pay/other             |
| tax            | REAL    | Tax amount                                               |
| tip            | REAL    | Tip amount                                               |
| notes          | TEXT    | User notes                                               |
| raw_text       | TEXT    | Full OCR transcription                                   |
| image_path     | TEXT    | Path to original image                                   |

### `receipt_items`
| Column      | Type    | Notes                          |
|-------------|---------|--------------------------------|
| id          | INTEGER | Auto-increment                 |
| receipt_id  | TEXT FK | References receipts(id)        |
| name        | TEXT    | Item name                      |
| quantity    | REAL    | Default 1                      |
| unit_price  | REAL    | Price per unit                  |
| total_price | REAL    | Quantity × unit_price           |
| category    | TEXT    | Optional item-level category   |

## Rules

1. **Date format**: Always YYYY-MM-DD. If year is missing, use current year.
2. **Total**: Use the FINAL total (after tax, after tip). If subtotal and total both exist, use total.
3. **Currency detection**: $ → USD, ¥ → detect context (CNY vs JPY), € → EUR, £ → GBP.
4. **Category**: Pick the single most appropriate category from the allowed values.
5. **Don't guess**: If a field is not visible on the receipt, omit it. Don't fabricate data.
6. **Line items**: Extract as many as you can read. Include quantity and price when visible.
7. **Language**: Receipts may be in English, Chinese, or other languages. Handle all.
8. **raw_text**: Transcribe the full receipt text as-is for future reference.

## Known Pitfalls

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
   (`src/claude.ts::processReceipt`). One `claude -p` invocation reads
   the image, reasons in plain text, and writes the extracted fields
   to Postgres via a `psql` tool call — **no JSON-schema coercion
   anywhere in the flow**. A placeholder receipt row is seeded at
   upload time and `UPDATE`d by the agent.

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

## Schema editing workflow (OpenAPI contract)

The HTTP API contract lives in `src/schemas/` (one zod file per resource: `receipt.ts`, `job.ts`, `summary.ts`, `ask.ts`, `health.ts`, `common.ts`). Routes are registered in `src/openapi.ts`. The generated `openapi/openapi.json` is a build artifact — **never edit it by hand**, it gets overwritten.

When you change a schema or add a new endpoint:

1. Edit the relevant `src/schemas/*.ts` (or add a new file).
2. Register/update the route in `src/openapi.ts` with method, request, responses.
3. Add or modify the actual Express handler in `src/server.ts`.
4. Run `npm run openapi:generate` to regenerate `openapi/openapi.json`.
5. Commit the schema, route registration, handler, and regenerated spec **in the same commit**. A stale `openapi.json` misleads client codegen and breaks PR diffs.

**Never inline a new `z.object()` directly in `server.ts`.** Schemas defined inline don't appear in the OpenAPI spec, so frontend / macOS / future clients can't see them. The `src/schemas/` + registry layout exists so a single source describes every endpoint.

Pinned to `@asteasolutions/zod-to-openapi` v7 because the repo uses zod v3. v8 requires zod v4 — bump both together in a dedicated PR if/when needed.

## Image Reading

To read a receipt image, use the Bash tool:
```bash
# View the image (Claude can read image files directly)
cat /path/to/receipt.jpg
```

Or use the Read tool to inspect the file.

## Langfuse Observability

Self-hosted Langfuse runs alongside the app for LLM monitoring.
All `claude -p` calls auto-ingest session traces via `src/langfuse.ts`.

### Querying Langfuse via API

**Always use the Langfuse REST API for programmatic access** — don't
navigate the web UI manually when you need to inspect traces, compare
outputs, or verify data.

```bash
# List recent traces (with input/output)
curl -s http://$LANGFUSE_HOST/api/public/traces \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get a specific trace by ID
curl -s http://$LANGFUSE_HOST/api/public/traces/<trace-id> \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get observations (generations) for a trace
curl -s "http://$LANGFUSE_HOST/api/public/observations?traceId=<trace-id>" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
```

Local dev defaults:
- Host: `http://localhost:3333`
- Public key: `pk-receipt-local`
- Secret key: `sk-receipt-local`

### Manual Verification Flow

No verify script. Three curl calls are the contract:

```bash
# 1. Upload
JOB=$(curl -sS -X POST http://localhost:3000/receipt \
  -F "image=@$HOME/Desktop/RECEIPT/IMG.jpeg" | jq -r .jobId)

# 2. Poll until status=done
while :; do
  s=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .status)
  [[ "$s" == "done" || "$s" == "error" ]] && break
  sleep 2
done
RECEIPT=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .receiptId)

# 3. Inspect the receipt record (the data of record — merchant/date/
#    total/tip/items are all here)
curl -sS http://localhost:3000/receipt/$RECEIPT | jq .
```

For the Langfuse trace, query the API directly (see
"Query Langfuse" above). Never trust a wrapper script's display —
go to `/receipt/:id` for ground truth. (Earlier `verify-receipt.sh`
printed all-None while the DB had correct data; deleted to avoid
that trap.)

### Why API over UI

- **Scriptable**: can diff outputs, run assertions, batch-verify
- **Cross-reference**: compare Langfuse trace output with app API
  result in a single command pipeline
- **CI-ready**: verification scripts can hit the API directly
- **No context switching**: stay in terminal, no browser navigation

## Claude Code OAuth credentials — named volume, in-container login

Auth is **not** an env var, and is **not** a bind mount of the host's `~/.claude/.credentials.json`. `docker-compose.yml` mounts the Docker-managed named volume `claude-code-config` at `/home/node/.claude`; the container holds its own independent OAuth session, seeded once by running `docker exec -it receipt-assistant claude /login`. The in-container `claude` CLI refreshes both `accessToken` and `refreshToken` on expiry and writes rotation back into the volume. This matches the Anthropic-official devcontainer pattern (`anthropics/claude-code/.devcontainer/devcontainer.json`).

**Operate this via the `setup` skill**, not via shell scripts. The skill lives at `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/.claude/skills/setup/SKILL.md` and covers first-time bootstrap, migration from the earlier bind-mount / env-var architectures, and 401 diagnosis.

**Three-era timeline of what has and has not worked:**

- **Era 1 (pre-2026-04-19) — `CLAUDE_CODE_OAUTH_TOKEN` env var + entrypoint-synthesized credentials file.** Broke because the env var overrides the file and disables self-refresh; the synthesized file had `refreshToken: ""` so couldn't refresh even if the env var were removed. Result: 24h 401 cycle.
- **Era 2 (2026-04-19 → 2026-04-20) — host `~/.claude/.credentials.json` bind-mounted RW into the container.** Broke because host and container shared a single OAuth session: host's native `claude` CLI rotates the refresh token on every interactive use (Anthropic docs: "Refresh tokens rotate on each use"), which invalidates the container's next call. Result: 401 every few hours instead of every 24h.
- **Era 3 (2026-04-20 onward) — named volume `claude-code-config` + in-container `claude /login`.** Container has its own OAuth session, isolated from host and other containers. No drift, no rotation collisions. Refresh token eventually expires server-side (~weeks to months); at that point rerun `claude /login` inside the container.

**Hard rules, in one place so it's harder to lose:**

- **Never re-introduce `CLAUDE_CODE_OAUTH_TOKEN`** to `.env` or `docker-compose.yml`. Presence of the env var makes the CLI skip the file entirely (Anthropic auth precedence) → no refresh → Era 1's 24h 401s.
- **Never bind-mount the host's `~/.claude/` or `~/.claude/.credentials.json`** into the container. The host/container session collision is Era 2's 401-every-few-hours bug. Always use the Docker-managed named volume `claude-code-config`.
- **Never `docker compose down -v`** on this stack unless you want to re-run `claude /login`. The `-v` flag wipes named volumes, including `claude-code-config`. Use plain `docker compose down` or `docker compose stop`.
- **Never periodically sync host Keychain → the volume.** It re-introduces rotation collisions; Anthropic's in-container auto-refresh is the intended mechanism.
- **Recovery on 401:** `docker exec -it receipt-assistant claude /login`, follow the OAuth code flow, done. Do not touch host Keychain or host `~/.claude/` as part of recovery — they're unrelated to the container's OAuth session.

## GitHub Issues

**Every issue filed here must follow the cross-repo label taxonomy.** The full spec lives in the project-level doc: `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/CLAUDE.md` → "GitHub issue conventions". Do not open issues with only the legacy `bug` label.

Minimum label set (every issue):

- one `kind/*` — `bug` · `feature` · `enhancement` · `docs` · `refactor` · `chore`
- one `priority/*` — `p0` · `p1` · `p2` · `p3`
- one `area/*` — `api` · `extraction` · `db` · `docker` · `langfuse` · `mcp` · `ops`
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
