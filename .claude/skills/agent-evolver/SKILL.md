---
name: agent-evolver
description: Triage the extractor's runtime lesson proposals and promote the good ones into the curated lesson set. Use when reviewing `lessons.proposed.md`, when asked how the self-evolution loop is doing, when promoting or rejecting proposed lessons, or when the proposal queue has grown large. Triggers - "promote lessons", "review proposals", "triage lessons", "self-evolution status", "审一下提议", "促进经验", "自进化怎么样了".
---

# agent-evolver

The extractor proposes; a human gatekeeps; only vetted lessons reach the
prompt. This skill is the gatekeeping half. Without it the loop is a
write-only queue, which is exactly what happened between 2026-07-19 and
2026-07-30: 126 proposals accumulated and zero were promoted, because this
file did not exist while two source comments already pointed at it.

## The two files

| File | Home | Role |
|---|---|---|
| `src/ingest/lessons.md` | git, version-controlled | curated set, injected VERBATIM into every extractor prompt |
| `lessons.proposed.md` | mini only, `/data/prompt-lessons/` (bind mount from `~/Developer/receipt-assistant-data/prompt-lessons/`) | append-only raw proposals from Phase 6, never read back by the agent |

Read the proposals with:

```bash
scp mini:'~/Developer/receipt-assistant-data/prompt-lessons/lessons.proposed.md' /tmp/
```

The loader (`renderActiveLessons()` in `src/ingest/prompt-contract.ts`) drops
`#` comment lines and injects the rest. A missing or unreadable file injects
nothing, so a broken path fails silent. `Dockerfile:77` is what puts the file
next to the compiled module; `tsc` does not copy `.md`, so local `npm run
build` leaves `dist/ingest/lessons.md` absent and local dev renders no
lessons. That is expected, not a bug.

## Procedure

### Step 0 — Reconcile every proposal against HEAD before anything else

**This step is mandatory and it comes first. Do not sort, cluster, or count
until it is done.**

A proposal records the world as it was **at the moment the agent wrote it**,
not as it is now. The queue is append-only and never rotated, so it silts up
with claims the code has already fixed and, worse, with claims the code has
since **inverted**. For each proposal, open the actual source at HEAD and
decide which bucket it falls into:

- **Already fixed** → delete. Cite the PR that fixed it.
- **Now inverted** → reject loudly, and say so in the triage record so nobody
  re-promotes it from an older copy of the queue.
- **Still true and uncovered** → promotion candidate.
- **Still true but already stated in the prompt** → delete as redundant.

> **Why this step exists.** On 2026-07-30, four proposals (14/18/75/110) said
> non-USD receipts must have an approximate historical FX rate computed and
> written into `amount_base_minor`. That was correct when written. By then
> `prompt.ts:606-619` (from #184) said the opposite: write base equal to
> `amount_minor`, never write `fx_rate`, because `fx_rate IS NULL` is the
> marker the worker uses to trigger the real conversion in
> `src/fx/normalize.ts`. Promoting those four would have taught the agent to
> guess rates, suppressing the real conversion and leaving 1 CNY counted as
> 1 USD in every report.
>
> Those four were among the **most repeated** claims in the queue. Any
> promotion process that ranks by frequency selects them. Frequency measures
> how often the agent hit a wall, not whether the wall is still there.

### Step 1 — Cluster semantically, not textually

The agent rewords the same lesson every run, so `sort -u` collapses almost
nothing. Expect roughly 60% semantic duplication. Cluster by claim and keep
the sharpest phrasing, recording the merged proposal numbers so the evidence
trail survives.

### Step 2 — Separate lessons from defects

A claim that the agent had to work around the **same** template or schema
defect on many runs is a bug report, not a lesson. Promoting it teaches the
agent to keep paying the workaround forever. File an issue instead.

Signals it is a defect and not a lesson:

- the proposal names a SQL error, constraint, or trigger
- the proposal describes a decision tree that sends the agent down a path
  that cannot succeed
- the proposal asks for a field to be stored, or a query to read a field
- the same workaround appears many times across unrelated merchants

### Step 3 — Promote, with a token budget in mind

Every promoted line is injected into every extractor prompt on every ingest.
Measure before and after, and put the number in the PR body:

```bash
# with dist/ingest/lessons.md in place (tsc will not copy it, cp it yourself)
node -e 'import("./dist/ingest/prompt.js").then(m=>console.log(
  m.buildExtractorPrompt({filePath:"/tmp/x",ingestId:"0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12),
  workspaceId:"0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12),documentId:"0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12),
  userId:"0".repeat(8)+"-0000-0000-0000-"+"0".repeat(12)}).length))'
```

Reference point: batch 2 took the curated set from 4 to 24 lessons, the
lesson block from 233 to 1359 tokens, and the full prompt from 130,647 to
136,784 chars (4.2% of the prompt, 3.7% growth). #181 was a token-burn fix,
so treat prompt growth as a real cost. Prefer deleting a lesson the code has
fixed over letting the block grow.

Write each promotion as `- [classification] <one tight claim>` under a dated
batch comment. Keep it specific and evidence-based. Comment lines are free
because they are not injected, so use them to record what was rejected and
why.

### Step 4 — Ship it

Promotion is a normal repo change: branch, edit `src/ingest/lessons.md`,
commit, PR, deploy. Verify the deploy actually carries the lessons:

```bash
ssh mini 'export PATH="/usr/local/bin:$PATH"; \
  docker exec receipt-assistant grep -c "^- \[" /app/dist/ingest/lessons.md'
```

### Step 5 — Record the triage, then leave the queue alone

Write the full triage (promoted, rejected, filed as issues, held) to
`10_Projects/2026_Dev_ReceiptAssistant/notes/YYYY-MM-DD_analysis_lessons-proposal-triage.md`.
This record is what makes Step 0 cheap next time and what stops a rejected
proposal from being re-promoted later.

Do **not** truncate or rewrite `lessons.proposed.md` on the mini. It is
append-only agent output and the dated triage note is the durable artifact.
If it grows unwieldy, archive a copy alongside the triage note rather than
editing in place.

## Checking whether the loop is alive

All three segments must be verified separately; a quiet queue usually means
low traffic, not breakage.

```bash
# producer: Phase 6 present in the deployed build
ssh mini 'export PATH="/usr/local/bin:$PATH"; \
  docker exec receipt-assistant grep -c "Propose a lesson" /app/dist/ingest/prompt.js'
# consumer: curated lessons present and injected
ssh mini 'export PATH="/usr/local/bin:$PATH"; \
  docker exec receipt-assistant grep -c "Learned lessons (curated" /app/dist/ingest/prompt-contract.js'
# curator: is anything actually being promoted?
git log --date=short --format="%h %ad %s" -- src/ingest/lessons.md
```

Before concluding Phase 6 has stopped, check ingest volume. Phase 6 tells the
agent to skip unremarkable runs, so a few days with single-digit ingests and
no new proposals is correct behavior:

```sql
SELECT date_trunc('day', created_at)::date AS d, count(*)
  FROM ingests GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

Observed proposal rate: about one proposal per four ingests (126 proposals
across 479 ingests, 2026-07-19 to 2026-07-27).
