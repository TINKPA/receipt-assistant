# Async Pipeline Rewrite — Study & Reference Notes

> **Context**: Receipt Assistant backend, April 2026. This document captures the design decisions, experiments, bugs, and lessons from collapsing a 3-call Claude CLI pipeline into a single-call agent pipeline with async UX.
>
> **Related**: GitHub issue TINKPA/receipt-assistant#6

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Two Ways to Solve It](#2-two-ways-to-solve-it)
3. [The Key Insight](#3-the-key-insight)
4. [Experiment Methodology](#4-experiment-methodology)
5. [Experiment Results](#5-experiment-results)
6. [Final Configuration](#6-final-configuration)
7. [Implementation — Backend](#7-implementation--backend)
8. [Implementation — Frontend](#8-implementation--frontend)
9. [Bugs Encountered & Fixes](#9-bugs-encountered--fixes)
10. [Lessons Learned](#10-lessons-learned)
11. [Interview Talking Points](#11-interview-talking-points)
12. [Open Issues](#12-open-issues)

---

## 1. The Problem

### Symptoms
- Every receipt upload took **60–120 seconds** end-to-end
- Users stared at a spinner in the upload modal the entire time
- Labeled "unacceptable" in GitHub issue #6

### Root Cause — 3 Sequential `claude -p` Subprocesses

The existing architecture (`src/claude.ts`) spawned three CLI subprocesses in strict sequence per receipt:

| Phase | What it does | Time | Why it existed |
|-------|--------------|------|----------------|
| **1** | Quick extract: merchant, date, total via `--json-schema` | 10–30s | Give the user a fast preview via SSE |
| **2.1** | Plain-text OCR with chain-of-thought, no schema | 30–60s | `--json-schema` degrades OCR — let Claude "think" first |
| **2.2** | Format the text output into JSON via `--json-schema` | 15–30s | Turn Phase 2.1's text into structured data |

**Each subprocess had cold-start overhead** — auth bootstrap, config load, session JSONL setup, full API round-trip. ~5-10s wasted per call just starting up.

### The `--json-schema` Trap (documented in CLAUDE.md)

Tested 10 receipts with Sonnet, same prompt:
- `--json-schema` mode: **4/10 dates wrong** (year errors, fallbacks to today, merchants unreadable)
- Plain text mode: **0/10 dates wrong**

Root cause: `--json-schema` forces direct JSON output with no reasoning space. Text mode allows chain-of-thought ("is this a 3 or a 9? Given the date context...") which dramatically improves ambiguous OCR.

This is why Phase 2 was split into two steps in the first place — a prompt-engineering workaround for a model-level limitation.

---

## 2. Two Ways to Solve It

### Path A: Make the Pipeline Faster (the GitHub issue's suggestion)
- Use the Anthropic API/SDK directly instead of shelling out to CLI
- Prompt caching across requests
- Parallelize where possible
- Collapse 3 calls into 1–2

### Path B: Make the Wait Invisible (user's handwritten plan)
1. **Compress uploads** — JPG only, compress before upload
2. **Immediate acknowledgment** — respond right away after upload
3. **Background processing** — agent does its thing
4. **Async retrieval** — user comes back later to see results

**We chose Path B.** It solves the UX problem (no spinners) even if the pipeline itself stays slow, and it's complementary to Path A — you can still make the pipeline faster later.

---

## 3. The Key Insight

During discussion, a critical observation emerged:

> **If the user isn't waiting, Phase 1's "quick preview" is unnecessary.**

Phase 1 existed to give the user a fast glimpse while waiting. Remove the wait → remove the need for Phase 1.

That led to a bigger realization:

> **Claude CLI with `--dangerously-skip-permissions` is a full agent with bash tools. We don't need to extract structured output and parse it in Node.js — we can give Claude the image, the DB connection info, and the table schema, and let it write to PostgreSQL itself.**

This collapses:
- 3 calls → 1 call
- `--json-schema` (bad OCR) → plain text mode (good OCR)
- Node.js output parsing → no parsing (data goes straight to the DB)
- 2 files of extraction logic → one function

---

## 4. Experiment Methodology

Before rewriting, we validated the single-call approach with **21 experiments across 8 different receipts** to de-risk the design.

### Test receipts (variety of difficulty)
| # | Receipt | Challenge |
|---|---------|-----------|
| 1 | Ralphs (grocery) | Simple baseline |
| 2 | Costco (gas) | Known hard case — ambiguous date digits |
| 3 | Broken Shaker (bar) | Handwritten tip ($20), service charge, 6 items |
| 4 | GYOTAKU (AYCE sushi) | Top of receipt folded — merchant obscured |
| 5 | NBC Seafood | Chinese + English mixed |
| 6 | 99 Ranch Market | Long receipt, photographed from distance |
| 7 | Circle K (gas) | Another gas station for consistency |
| 8 | Target | Crumpled/rotated receipt |

### Variables tested
- Prompt structure (minimal, medium, verbose, two-step reasoning)
- `--max-turns`: 5, 10, 15
- `--effort`: low, high
- `--output-format`: text vs json
- Model: sonnet
- DB write method: direct UPDATE vs BEGIN/COMMIT transaction
- INSERT vs UPDATE patterns (with/without pre-existing placeholder row)

### How we measured
- **Success**: Did data appear in PostgreSQL correctly?
- **Accuracy**: Compared each field against the actual receipt image
- **Speed**: Wall-clock time from spawn to process exit
- **Honest failure**: When Claude couldn't read something, did it set NULL/error or hallucinate?

---

## 5. Experiment Results

### 21/21 experiments succeeded in writing to PostgreSQL

The core approach works. Every experiment wrote data to the DB in one call.

### Timing (with optimal config)

| Receipt | `--max-turns 5` | `--max-turns 10` | Notes |
|---------|-----------------|------------------|-------|
| Ralphs (simple) | **31s** | 49s | 2x faster with lower turn limit |
| Circle K (gas) | **63s** | — | |
| Broken Shaker (6 items, tip) | **93s** | 298s | 3.2x faster, identical accuracy |
| NBC Seafood | 164s | — | Chinese recognition worked |
| Costco gas | — | 99s | Date off by 3 days (known hard case) |
| GYOTAKU | 90-202s | — | Merchant always wrong (image issue) |
| Target (crumpled) | 1276s | — | Rate limiting during concurrent batch |

### Accuracy by field type
| Field | Correct rate | Notes |
|-------|--------------|-------|
| Total, tax, tip | ~100% | Even handwritten tips on Broken Shaker ($20) and GYOTAKU ($10) |
| Category | 100% | When enum values were in the prompt |
| Payment method | 100% | When enum values were in the prompt |
| Merchant | ~90% | Failed only when receipt was physically obscured |
| Date | ~95% | Failed only on ambiguous photographed digits |
| Line items | High | 6/6 on Broken Shaker, 8-10 on AYCE receipts |

### What DID NOT work (debunked)
- ❌ `--effort high` → **1200s+ per receipt** (10-20x slower), no accuracy gain
- ❌ `--max-turns 10+` → diminishing returns, sometimes 5+ min
- ❌ SQL transactions (`BEGIN/COMMIT`) → wastes turns on wrapper SQL
- ❌ Ultra-minimal prompts → Claude wastes turns figuring out the task
- ❌ Ultra-verbose prompts → no accuracy gain, slower
- ❌ 6+ concurrent calls → API rate limiting tanked everything
- ❌ `--json-schema` → degrades OCR (previously documented, reconfirmed)

---

## 6. Final Configuration

```typescript
const args = [
  "-p", prompt,
  "--output-format", "text",           // not json — reasoning space
  "--dangerously-skip-permissions",    // agent gets bash tools
  "--model", process.env.CLAUDE_MODEL || "sonnet",
  // NO --max-turns — trust the agent
  // NO --effort high — 10-20x slowdown
  // NO --json-schema — degrades OCR
];

const { sessionId } = await runClaude(args, 300_000); // 5 min timeout
```

### Prompt template (validated)
```
You are a receipt parser agent. Read the receipt image at "{imagePath}"
and save extracted data to PostgreSQL.

RULES:
- merchant: Store name from receipt header
- date: YYYY-MM-DD, read from receipt. NEVER use today's date.
- total: Final amount after tax+tip. Use handwritten total if present.
- category: food|groceries|transport|shopping|utilities|entertainment|health|education|travel|other
- payment_method: credit_card|debit_card|cash|mobile_pay|other

DB: {psqlCommand} "<SQL>"
UPDATE receipts SET merchant=..., date=..., status='done' WHERE id='{receiptId}';
INSERT INTO receipt_items (receipt_id, name, quantity, unit_price, total_price) VALUES ('{receiptId}', ...);

Escape single quotes by doubling them.
If you cannot confidently read a field, use NULL rather than guessing.
```

### Critical prompt elements (don't skip these)
1. **"NEVER use today's date as fallback"** — without this, Claude silently defaults to today when the date is hard to read
2. **Enum values in the prompt** (`credit_card|debit_card|...`) — otherwise Claude writes "Mastercard" instead of "credit_card"
3. **"Escape single quotes by doubling them"** — prevents SQL injection errors
4. **"Use NULL rather than guessing"** — prevents hallucination on unreadable fields

---

## 7. Implementation — Backend

### `src/claude.ts` — Major rewrite
**Before**: 350 lines with `extractReceiptQuick`, `extractReceipt`, two JSON schemas, three result types.

**After**: One `processReceipt(imagePath, receiptId)` function that returns `{ sessionId }` (nothing else — data lives in the DB).

Also kept: `runClaude`, `buildClaudeEnv`, `getSessionJsonlPath`, `askClaude`.

Added: `detectPsqlCommand()` — detects whether to use local `psql` (inside Docker) or `docker exec langfuse-postgres-1 psql` (local dev).

### `src/db.ts` — Schema migration + new functions
```sql
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'done';
```

New functions:
- `insertReceiptPlaceholder(id, imagePath, notes?)` — writes `status='processing'`, `merchant='Processing...'`, today's date, total=0. Called immediately on upload.
- `updateReceiptStatus(id, status, error?)` — marks failures.

### `src/jobs.ts` — Simplified state machine
**Before**: `queued → quick_done → processing_full → done → error` (5 states) with `quickResult` and `fullResult` on the Job object.

**After**: `queued → done → error` (3 states). No result fields — data is in the DB.

```typescript
async function runJob(jobId: string) {
  const job = jobs.get(jobId)!;
  try {
    const { sessionId } = await processReceipt(job.imagePath, job.receiptId);
    emit(jobId, { type: "done", data: { receiptId: job.receiptId } });
    ingestSession(getSessionJsonlPath(sessionId), ["single-call", "receipt"]).catch(() => {});
  } catch (err: any) {
    // Smart recovery — see Bug #2 below
    const receipt = await getReceipt(job.receiptId).catch(() => null) as any;
    if (receipt && receipt.status === "done") {
      emit(jobId, { type: "done", data: { receiptId: job.receiptId } });
    } else {
      await updateReceiptStatus(job.receiptId, "error", err.message).catch(() => {});
      emit(jobId, { type: "error", data: { error: err.message } });
    }
  }
}
```

`submitJob` is now async — it inserts the placeholder row before queuing so the receipt appears in `GET /receipts` immediately.

### `src/server.ts` — JPG-only, HEIC gone, image serving
- Added multer `fileFilter` rejecting non-JPEG with a 400
- Removed the entire `heic-convert` block (~15 lines)
- Simplified SSE/poll endpoints to emit only `done`/`error`
- Added `GET /receipt/:id/image` — serves the original receipt image file for the detail view

### `Dockerfile` — Added postgresql-client
```dockerfile
RUN apt-get update && apt-get install -y \
    python3 make g++ curl postgresql-client \
    && rm -rf /var/lib/apt/lists/*
```
Claude needs `psql` available inside the container to write to the DB.

---

## 8. Implementation — Frontend

### `src/lib/api.ts` — Compression + new fetch
Added `browser-image-compression`:
```typescript
async function compressImage(file: File): Promise<File> {
  if (file.size <= 500 * 1024) return file; // skip small files
  return imageCompression(file, {
    maxSizeMB: 1,
    maxWidthOrHeight: 2048,
    useWebWorker: true,
    fileType: 'image/jpeg',
  });
}
```

Updated `mapReceipt()` to handle the new `status` field:
- `status: 'processing'` → returns a row with `description: 'Processing...'`, `amount: 0`, `status: 'Processing'`
- `status: 'error'` → error styling

Added `fetchReceiptDetail(id)` and the `ReceiptDetail` type.

### `src/components/AddTransactionModal.tsx` — Strip polling loop
**Before**: 5-state UI (`idle → uploading → processing → quick_done → done → error`) with polling every 2s

**After**: 3 states (`idle → uploading → close` or `→ error`)

```typescript
const handleUpload = async () => {
  if (!file) return;
  setState('uploading');
  try {
    const result = await uploadReceipt(file);
    onComplete?.({ jobId: result.jobId, receiptId: result.receiptId });
    handleClose();  // ← close immediately
  } catch (err: any) {
    setState('error');
    setError(err.message);
  }
};
```

Also changed `accept` from `"image/*,.heic,.heif"` to `"image/jpeg,.jpg,.jpeg"`.

### `src/components/ProcessingToast.tsx` — New component
- Floating bottom-right notification per in-flight job
- Polls `GET /api/jobs/{jobId}` every **5 seconds** (not 2s — user isn't staring)
- On `done`: checkmark, auto-dismiss 3s, triggers data refresh
- On `error`: error message, dismiss 5s
- **Persists job IDs to `localStorage`** so browser refresh doesn't lose tracking
- Exports `useProcessingJobs()` hook for App.tsx

### `src/components/ReceiptDetail.tsx` — New full-page view
Props: `receiptId`, `onBack`

Sections:
- Back button
- Processing banner (if `status='processing'`, auto-polls every 5s)
- Header: merchant, date, total, category, payment method
- Tax/tip breakdown
- Line items table
- Receipt image (from `GET /receipt/:id/image`)
- Notes
- Raw text (collapsible)
- Extraction quality (confidence, warnings)

### `src/App.tsx` — Wiring it together
Added:
- `useProcessingJobs()` hook for in-flight jobs
- `selectedReceiptId` state for detail view routing
- `<ProcessingToast>` rendered alongside the modal
- `onSelectReceipt` callback passed down to Dashboard and Transactions

### `src/components/Transactions.tsx` + `Dashboard.tsx` — Processing UI
- Added "Processing" status with `animate-pulse` and spinner icon
- Processing rows show `description='Processing...'`, `amount='--'`, non-clickable
- Non-processing rows are clickable and navigate to detail view

---

## 9. Bugs Encountered & Fixes

### Bug #1: Receipts hitting `--max-turns` limit

**Symptom**: Ralphs receipt had `merchant='Ralphs'` but `status='error'` with error message "Reached max turns (5)". Inspection of the Claude session log showed Claude successfully extracted the data, ran UPDATE, INSERT item 1, INSERT item 2, then a verification SELECT — exactly 5 turns, exceeding the limit on the (unnecessary) verification step.

**Root cause**: `--max-turns 5` was too tight for receipts that legitimately needed more than 5 turns (multi-item receipts + Claude's tendency to verify its work).

**Fix**: Removed `--max-turns` entirely. Trust the agent.

**Lesson**: Don't constrain an agent with limits tuned to a specific execution pattern. Let it complete the task.

### Bug #2: Error handler overwriting successful writes

**Symptom**: Even when Claude successfully wrote data, the row ended up with `status='error'`.

**Root cause**: When Claude exited non-zero (e.g. because it hit "Reached max turns" on a verification step), our error handler blindly called `updateReceiptStatus(job.receiptId, 'error', err.message)`, overwriting Claude's successful `status='done'` write.

**Fix**: Before marking as error, re-fetch the row. If `status === 'done'`, Claude already succeeded — treat it as success.

```typescript
} catch (err: any) {
  const receipt = await getReceipt(job.receiptId).catch(() => null) as any;
  if (receipt && receipt.status === "done") {
    emit(jobId, { type: "done", data: { receiptId: job.receiptId } });
  } else {
    await updateReceiptStatus(job.receiptId, "error", err.message).catch(() => {});
    emit(jobId, { type: "error", data: { error: err.message } });
  }
}
```

**Lesson**: When a process writes side effects before exiting with an error, check for those side effects before treating the error as definitive. Non-zero exit codes don't always mean "no work got done."

### Bug #3: 120s timeout too tight

**Symptom**: "Claude CLI timed out after 120000ms" on complex receipts.

**Fix**: Increased to 180s, then **300s (5 minutes)** per user request. Rationale: users aren't waiting anyway — the UX is async — so being generous with the timeout costs nothing and prevents false failures on hard receipts.

**Lesson**: Match timeouts to the worst reasonable case of the underlying work, not the best. When UX is async, timeouts can be generous.

### Bug #4: Concurrent calls causing rate limiting

**Symptom**: During experiments, running 6-7 concurrent `claude -p` calls caused some to take 1200-1500s. But identical prompts in isolation completed in 31-93s.

**Root cause**: API rate limiting when too many concurrent sessions.

**Fix (preventative)**: Confirmed `MAX_CLAUDE_CONCURRENCY=3` environment variable in `jobs.ts` is well-chosen. Don't raise it.

**Lesson**: Parallelism has a ceiling imposed by the API, not your hardware. Measure before raising concurrency.

### Bug #5: NOT NULL constraints breaking unreadable receipts

**Symptom**: Upside-down receipts caused Claude to spend all turns trying to satisfy `merchant NOT NULL`, `date NOT NULL`, `total NOT NULL`.

**Status**: Known open issue. Options:
- Relax the constraints to allow NULL for these fields
- Give Claude explicit fallback guidance for unreadable receipts (e.g. "if you can't read merchant, set it to 'Unknown'")

---

## 10. Lessons Learned

### Design
1. **Look for UX fixes before engine fixes**. The GitHub issue asked for faster extraction. The real fix was making the wait invisible. Sometimes the best optimization is not doing the work synchronously.
2. **Agents can eliminate intermediate representations**. Instead of `image → extract → JSON → parse → DB`, go straight `image → DB` and let the agent handle everything in between.
3. **Start with experiments, not code**. 21 quick experiments validated the approach in one afternoon and surfaced pitfalls (rate limiting, `--effort high`, max-turns) before a single line of production code was written.
4. **Write prompts for agents, not models**. Claude CLI with tools is fundamentally different from the API. Give it tools, connection info, and trust it to orchestrate.

### Prompt engineering
5. **Negative instructions matter** ("NEVER use today's date"). Positive instructions alone aren't enough when the default behavior is wrong.
6. **Include enums in the prompt**. Without explicit `credit_card|debit_card|...`, Claude writes free-form values like "Mastercard".
7. **Concise beats verbose AND minimal**. Ultra-verbose doesn't help, ultra-minimal wastes turns figuring out the task.
8. **Don't over-constrain agents**. `--max-turns 5`, `--effort high`, `--json-schema` — every constraint we removed made things faster or more accurate.

### Systems
9. **Async flips the cost model**. 30s vs 120s matters a lot when users wait. When they don't, the difference is meaningless — just be correct.
10. **Trust but verify side effects**. When Claude writes to the DB itself, don't trust the process exit code — check the DB state before declaring failure.
11. **Placeholders > polling for "in progress" UX**. Inserting a placeholder row in the DB makes async processing visible in the normal `GET /receipts` flow, no special endpoints needed.
12. **Image quality, not prompt, is the hard ceiling**. GYOTAKU's obscured merchant and Costco's ambiguous date digits failed regardless of prompt variation. Prompts can't overcome physics.

### Production readiness
13. **Rate limiting is the real concurrency ceiling**. Not CPU, not memory — the API's limit on simultaneous sessions.
14. **Schema migrations must be `IF NOT EXISTS`-safe**. `ALTER TABLE ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'done'` lets old and new code coexist.
15. **The Dockerfile matters**. Don't assume tools are available — we had to add `postgresql-client` for `psql` to exist inside the container.

---

## 11. Interview Talking Points

### "Tell me about a time you simplified a system"
> The receipt extraction pipeline had grown to three sequential Claude CLI subprocesses — quick extract, OCR reasoning, JSON structuring. Each added cold-start overhead and the total was 60-120 seconds per receipt. I noticed that the only reason for the multi-phase design was to give users a fast preview while waiting. So I asked: what if they weren't waiting at all? I restructured the UX to be fully async — upload returns immediately, processing happens in the background, results show up later — and that eliminated the need for the quick preview entirely. Then I realized the Claude CLI is a full agent with bash tools, so we didn't need to parse structured output at all. We could just give Claude the image, the database connection, and let it write the data directly. One call replaced three, and the system got simpler and more accurate at the same time.

### "How do you de-risk a design decision?"
> Before committing to the single-call agent design, I ran 21 experiments across 8 different receipts with varying difficulty — simple groceries, handwritten tips, Chinese restaurants, crumpled photos. I tested different prompts, CLI flags, concurrency levels, and DB write patterns. That surfaced critical findings — `--effort high` made things 10-20x slower with no accuracy gain, `--max-turns 5` was too tight for multi-item receipts, 6+ concurrent calls hit API rate limits. Those were all decisions I would have gotten wrong if I'd just built the straight-line implementation. The experiments took an afternoon and saved days of production debugging.

### "Tell me about a bug that taught you something"
> The agent-writes-to-DB pattern has a subtle failure mode — when the subprocess exits non-zero (for any reason), does that mean the work failed, or just that it partially failed? In one case, Claude successfully extracted receipt data, ran the UPDATE, INSERTed line items, then ran a verification SELECT that hit the max-turns limit. From Node.js's perspective the process exited with an error. Our error handler dutifully marked `status='error'`, overwriting Claude's successful write. The fix was to re-read the row before marking it as error — if `status='done'`, Claude already succeeded, and we should treat it as a success. The lesson: when a process writes side effects, exit codes aren't the source of truth — the side effects are.

### "How do you think about async vs sync UX?"
> The question I ask is: what does the user actually need? For receipt upload, they need confirmation that the image was received, and they need the data to be available when they come back. They do NOT need the data right now. So the sync approach — wait 60-120 seconds with a spinner — gave them nothing they wanted and took away something they did want (the ability to close the tab and keep working). Async with an immediate ack and a background processing indicator gives them everything they need. And it makes the timeout budget way more forgiving — I could raise the timeout to 5 minutes without anyone noticing, which let me remove brittle constraints like `--max-turns 5` that were causing false failures on legitimate work.

### "How do you prompt LLMs to be more reliable?"
> A few specific patterns from this work: (1) Negative instructions matter — I had to explicitly say "NEVER use today's date as fallback" because Claude would silently default to today when the date was hard to read. Positive instructions weren't enough. (2) Enum values in the prompt — without explicitly writing `credit_card|debit_card|cash|...`, the model would write free-form values like "Mastercard". (3) Concise beats verbose — I tested both ultra-minimal prompts and ultra-verbose ones. Ultra-minimal wasted turns figuring out the task. Ultra-verbose added no accuracy. The sweet spot was medium — enough structure to define the task, not so much that it bloats context. (4) For agents with tools, don't over-constrain. Removing `--max-turns 5` and `--effort high` both made things dramatically faster and more reliable. Trust the agent to decide when it's done.

---

## 12. Open Issues

### Things still worth addressing
1. **NOT NULL constraints vs unreadable receipts** — When Claude can't read merchant/date/total, it spends turns trying to satisfy constraints. Fix: relax the constraints to nullable, or add explicit prompt fallback ("if unreadable, use 'Unknown'").
2. **`status='done'` might not get set** — The current design relies on Claude remembering to include `status='done'` in its UPDATE. If it forgets, the row stays in `processing` forever. Hardening option: Node.js side re-reads and forces `status='done'` on successful completion.
3. **Error recovery depends on Claude's behavior** — The "check DB before marking error" fix only helps if Claude actually set `status='done'` before crashing. If Claude wrote partial data without the status update, we're back to square one.
4. **Image serving** — `GET /receipt/:id/image` serves files from disk. If deployed across multiple instances with local filesystems, this won't work. Need either shared storage (S3) or DB-stored image data.
5. **localStorage job persistence** — The ProcessingToast stores in-flight job IDs in localStorage, but never cleans up after the page loads fresh if the server already finished the work. Minor, but could accumulate cruft.

### Things tried that didn't work
- Running 6+ concurrent experiments (API rate limited, test data became unreliable)
- Using SQL transactions for atomic writes (wasted turns on BEGIN/COMMIT)
- Ultra-minimal prompts (Claude wasted turns figuring out the task)

---

## Appendix: Quick Reference

### File map (what changed)

**Backend** (`receipt-assistant/src/`)
- `claude.ts` — Rewritten. Now ~120 lines, down from ~350. Single `processReceipt()` function.
- `db.ts` — Added `status` column migration, `insertReceiptPlaceholder()`, `updateReceiptStatus()`
- `jobs.ts` — Simplified state machine, added smart error recovery
- `server.ts` — JPG-only filter, removed HEIC, simplified SSE/poll, added image endpoint
- `Dockerfile` — Added `postgresql-client`

**Frontend** (`receipt-assistant-frontend/src/`)
- `lib/api.ts` — Added `compressImage()`, `fetchReceiptDetail()`, processing status handling
- `types.ts` — Added `'Processing'` to status union
- `components/AddTransactionModal.tsx` — Stripped polling loop, JPG-only accept
- `components/ProcessingToast.tsx` — **NEW** — floating notification with polling
- `components/ReceiptDetail.tsx` — **NEW** — full-page detail view
- `components/Transactions.tsx` — Processing badge, clickable rows
- `components/Dashboard.tsx` — Processing badge, clickable rows
- `App.tsx` — Wiring for processing jobs and detail view routing

### Commands to run locally

```bash
# Backend (from receipt-assistant/)
npx tsc
UPLOAD_DIR=/tmp/receipt-uploads \
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/receipts" \
node dist/server.js

# Frontend (from receipt-assistant-frontend/)
npm run dev

# DB inspection
docker exec langfuse-postgres-1 psql -U postgres -d receipts -c "SELECT id, merchant, status FROM receipts ORDER BY created_at DESC LIMIT 10;"

# Clear DB
docker exec langfuse-postgres-1 psql -U postgres -d receipts -c "DELETE FROM receipt_items; DELETE FROM receipts;"
```

### Environment facts
- PostgreSQL: `langfuse-postgres-1` container, port **5433** on host (not 5432!)
- Mac local IP for iPhone access: `192.168.50.239:3000`
- Claude CLI: `/Users/tinazhang/.local/bin/claude` (v2.1.101)
- Session JSONL logs: `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl`
