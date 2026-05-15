# Receipt Assistant — Claude Code Instructions

You are a receipt parsing assistant. Your job is to extract structured data from receipt images.

## Database Schema

Postgres (managed via Drizzle migrations in `drizzle/`). The receipt-as-flat-row SQLite layout that lived here in earlier eras has been replaced by a double-entry ledger. `src/schema/` is the source of truth for the table definitions; the high-level shape:

| Table | Purpose |
|---|---|
| `documents` | Uploaded receipt images / PDFs. Content-deduped per workspace by `sha256`. Soft-delete column `deleted_at`. |
| `document_links` | Many-to-many between `documents` and `transactions`. |
| `transactions` | Ledger header. `status ∈ {draft, posted, voided, reconciled, error}`; `voided_by_id` points to the mirror reversal row. |
| `postings` | The individual debit/credit lines under a transaction. Sum-to-zero is enforced by a deferred check trigger. |
| `places` | Geocoded merchant location, FK from `transactions.place_id`. |
| `transaction_events` | Append-only audit log. |
| `accounts`, `workspaces`, `users`, `workspace_members` | Multi-tenant scaffolding. |
| `ingests`, `batches`, `idempotency_keys`, `reconcile_proposals` | Operational tables for upload workers + idempotency + reconcile flow. |

A "receipt" surfaces to the user as the pair `(documents row, linked transaction row(s))`. The agent extracts a `Document`, then writes a balanced `Transaction` + `postings` and a `document_links` row.

### Delete semantics

Receipts can genuinely be wrong (mis-shot, wrong merchant, duplicate). Both soft and hard delete are supported on every layer; the user owns the call.

**`DELETE /v1/documents/:id`**
- default: soft delete (sets `deleted_at`). `GET` and link-creation hide the row; `?include_deleted=true` surfaces it. Re-uploading the same bytes resurrects via the sha256 dedup path.
- `?hard=true`: removes the row + image file. Refuses with 409 if links exist (caller must add `?cascade=true`).
- `?cascade=true`: in one DB transaction, also handles linked txns — `posted` → voided (mirror reversal), `draft|error` → hard-deleted, `voided` → left alone (link is kept as historical record), `reconciled` → **always aborts the whole operation with 409, no writes**. Combine with `?hard=true` for a full purge of every linked txn + the doc + the file.

**`POST /v1/documents/:id/restore`** — clears `deleted_at`.

**`DELETE /v1/transactions/:id`**
- default: only `draft|error` may be deleted; `posted|voided` return 409 must-void-instead.
- `?hard=true`: caller forces a hard delete (postings + document_links cascade via FK). `reconciled` is the one status that still rejects.

The `reconciled` guard exists because that state means the row has been matched to a bank line. Erasing it without unreconciling first leaves the bank side hanging — so we make the user click twice.

## Extraction Rules

These apply to the agent that reads a receipt image and writes a `transaction` + `postings` to the ledger:

1. **Date format**: Always YYYY-MM-DD. If year is missing, use current year.
2. **Total**: Use the FINAL total (after tax, after tip). If subtotal and total both exist, use total.
3. **Currency detection**: $ → USD, ¥ → detect context (CNY vs JPY), € → EUR, £ → GBP.
4. **Category**: Pick the single most appropriate category from the allowed values.
5. **Don't guess**: If a field is not visible on the receipt, omit it. Don't fabricate data.
6. **Line items**: Extract as many as you can read. Include quantity and price when visible.
7. **Language**: Receipts may be in English, Chinese, or other languages. Handle all.
8. **OCR text**: Persist the full receipt transcription on the `documents.ocr_text` column for future reference.

## Extraction provenance — `metadata.extraction` (Phase 1 of #80)

Every transaction the ingest agent writes stamps a `metadata.extraction` block recording the prompt/model under which it ran. Schema:

```jsonc
{
  "extraction": {
    "prompt_version": "2.5",                    // see src/ingest/prompt.ts → PROMPT_VERSION
    "prompt_git_sha": "<build-info gitSha>",
    "model":          "<CLAUDE_MODEL env or 'sonnet'>",
    "ran_at":         "<wall-clock at COMMIT>"
  }
}
```

This is the gate for [#91](https://github.com/TINKPA/receipt-assistant/issues/91) (`POST /v1/documents/:id/re-extract`) and Phase 2 [#89](https://github.com/TINKPA/receipt-assistant/issues/89) — rows whose `prompt_version` ≠ the current source-tree `PROMPT_VERSION` are eligible to be re-derived.

### When to bump `PROMPT_VERSION`

Bump in the **same PR** as the prompt change. Guideline:

| Change | Bump? |
|---|---|
| New self-check block, new required field, fundamentally different reasoning flow | **Yes** (minor or major) |
| Wording polish, typo fix, whitespace, log-only edit | **No** |
| New tool exposure (e.g. agent gains a new Bash command pattern) | **Yes** |
| Reordering existing instructions without semantic change | **No** |

The version is a flat string (`"2.5"` today; `"2.5.1"` for a small additive iteration, `"3.0"` for a clean break). Auto-bumping on every commit defeats the purpose — it floods the version field with noise and makes the re-extract eligibility filter useless.

Legacy rows ingested before Phase 1 shipped have `metadata.extraction = NULL`. Phase 2/Phase 4 treats NULL as "unknown version, eligible to be re-extracted."

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

## Persistent data — three locations by category

App state is split across three host locations by data type. Each location is chosen to defeat a specific failure mode; do not collapse them back into one.

| Container path | Host bind | Category | Why this location |
|---|---|---|---|
| `/data` | `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/data/uploads/` | User content (receipt images, PII) | Outer project lives in iCloud, so the user's own receipt corpus syncs across their Macs. Pin via Finder → "Keep Downloaded" if Optimize Mac Storage is on. |
| `/var/lib/postgresql/data` | `~/Developer/receipt-assistant-data/postgres/` | Runtime state (DB binary) | Sibling dir outside any git repo and outside iCloud. Postgres binary contains extracted PII; this repo is public on GitHub. iCloud + Postgres fsync is hostile. Sibling is the right side of both lines. |
| `/home/node/.claude` | `~/Developer/receipt-assistant-data/claude/` | Runtime state (OAuth credentials) | Same reason: `.credentials.json` is sensitive; keep it far from `git add -f` and never on iCloud. |

`docker-compose.yml` uses absolute `${HOME}/...` paths so they resolve identically for any local user. Originals of all uploaded receipts also live in `~/Desktop/RECEIPT/`, which remains the human-curated source of truth.

### Why three locations (the four failure modes)

1. **OrbStack / Docker named volumes are not durable.** Lost the entire ledger on 2026-05-09 to a stack-wide volume wipe (every named volume in this project recreated at the same instant — signature of `docker compose down -v` or OrbStack reset). Recovery from Time Machine was impossible: OrbStack sets `com.apple.metadata:com_apple_backup_excludeItem` on its 8 TB sparse `data.img.raw`, so TM has never backed it up. Only the raw images in `~/Desktop/RECEIPT/` survived. → Move durable data out of Docker-managed storage entirely.

2. **This repo is public on GitHub.** A `data/` directory inside the repo with real receipt content or OAuth credentials would be one `.gitignore` mishap or `git add -f` away from leaking PII / secrets. → Postgres data and OAuth credentials live in a **sibling** dir (`~/Developer/receipt-assistant-data/`), not in any git tree at all. The `data/` directory in this repo is reserved for code-asset datasets (test fixtures, golden eval sets) — gitignored via `/data/` but conceptually it's where intentional dataset additions go.

3. **`~/Documents/` is iCloud-synced.** Postgres data files plus iCloud's continuous block-level reupload + revisioning is a hostile combination (constant churn, fsync semantics, possible truncation races). → Postgres lives outside iCloud. **User receipt images, however, intentionally live in iCloud** because the user wants their personal receipt corpus to sync across Macs; this is fine for static image files but requires "Keep Downloaded" pinning if Optimize Storage might evict them under the bind-mount.

4. **The outer project notebook lives in iCloud** (`~/Documents/10_Projects/2026_Dev_ReceiptAssistant/`, with `~/Developer/2026_Dev_ReceiptAssistant/` as a symlink back) because top-level docs (PLAN, CLAUDE.md, lab notes) are the kind of writing that should sync. The three code repos under `code/` are symlinks to `~/Developer/<repo>/` so the codebase itself stays off iCloud.

Bind mounts move the failure boundary: a container or volume reset no longer touches the host filesystem. The data only goes away if *you* `rm -rf` the bind path explicitly.

### Claude Code OAuth — bind mount at sibling dir

Auth is still **not** an env var, and still **not** a bind mount of the host's `~/.claude/.credentials.json`. The container holds its own independent OAuth session at `~/Developer/receipt-assistant-data/claude/`, seeded once via `docker exec -it receipt-assistant claude /login`. The in-container CLI refreshes both `accessToken` and `refreshToken` on expiry and writes rotation back into that path on the host. No collision with the host's native `claude` CLI because nothing is shared.

**Operate this via the `setup` skill** — first-time bootstrap, 401 diagnosis, recovery procedures all live there.

### Five-era timeline of OAuth approaches

- **Era 1 (pre-2026-04-19) — `CLAUDE_CODE_OAUTH_TOKEN` env var + entrypoint-synthesized credentials file.** Broke because the env var overrides the file and disables self-refresh; the synthesized file had `refreshToken: ""`. Result: 24h 401 cycle.
- **Era 2 (2026-04-19 → 2026-04-20) — host `~/.claude/.credentials.json` bind-mounted RW.** Broke because host and container shared a single OAuth session: host's `claude` CLI rotates the refresh token on every interactive use, invalidating the container's next call. Result: 401 every few hours.
- **Era 3 (2026-04-20 → 2026-05-09) — Docker-managed named volume `claude-code-config`.** Worked operationally but vulnerable to volume wipes (and was wiped along with everything else on 2026-05-09).
- **Era 4 (2026-05-09 → 2026-05-11) — host bind mount at `~/Developer/2026_Dev_ReceiptAssistant/data/claude/`.** Volume-reset-resilient but mixed runtime state into the outer project notebook, which complicated the 2026-05-11 outer-project iCloud migration.
- **Era 5 (2026-05-11 onward) — host bind mount at `~/Developer/receipt-assistant-data/claude/`.** Sibling dir, deliberately outside this repo and outside iCloud. Same OAuth isolation, with the runtime-state-leaks-into-docs-notebook problem solved by physical separation.

### Hard rules

- **Never re-introduce `CLAUDE_CODE_OAUTH_TOKEN`** to `.env` or `docker-compose.yml`. Env var overrides the on-disk credentials file and disables self-refresh → Era 1's 24h 401 cycle.
- **Never bind-mount the host's `~/.claude/` or `~/.claude/.credentials.json`** into the container. The host/container collision is Era 2's bug. Use the dedicated `~/Developer/receipt-assistant-data/claude/`, which the host's native CLI never touches.
- **Never `rm -rf ~/Developer/receipt-assistant-data/`** — that's the postgres ledger + the OAuth session in one stroke. `docker compose down -v` is harmless (bind mounts are not Docker-managed) but the host directory is unforgiving.
- **Never periodically sync host Keychain → `receipt-assistant-data/claude/`.** Re-introduces rotation collisions; in-container auto-refresh is the intended mechanism.
- **Never move runtime data (postgres, claude) into this repo or into the outer iCloud notebook.** Repo placement risks a public-repo PII / credential leak; iCloud placement is incompatible with Postgres write semantics and risks credential exfil via sync. Only `data/uploads/` (user images) belongs in iCloud — postgres + claude stay in the sibling dir.
- **Recovery on 401:** `docker exec -it receipt-assistant claude /login`, follow the OAuth code flow.

## GitHub Issues

**Every issue filed here must follow the cross-repo label taxonomy.** The full spec lives in the project-level doc: `~/Documents/10_Projects/2026_Dev_ReceiptAssistant/CLAUDE.md` → "GitHub issue conventions". Do not open issues with only the legacy `bug` label.

Minimum label set (every issue):

- one `kind/*` — `bug` · `feature` · `enhancement` · `docs` · `refactor` · `chore`
- one `priority/*` — `p0` · `p1` · `p2` · `p3`
- one `area/*` — `api` · `extraction` · `db` · `docker` · `langfuse` · `ops`
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
