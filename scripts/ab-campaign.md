# `ab-campaign` and `diff-arms`: running and judging the wave-1 A/B

The A/B compares the two writers on the same documents: arm A is the
legacy agent writing the ledger with SQL (`EXTRACTION_WRITER=agent_sql`),
arm B the server writing it from the agent's record (`server_apply`).
`docs/server-writer.md` ("A/B comparison", "Gates") says what is compared
and why; the private plan's §12 has the numbers. Two scripts carry it out:

- `scripts/ab-campaign.ts` runs it, unattended, over several nights, on
  the sandbox only, and remembers where it stopped.
- `scripts/diff-arms.ts` reads what a campaign left and writes the gate
  table G1-G9 and the adjudication worksheet.

Every real extraction spends the owner's Claude subscription, which also
serves the owner's other agents. A full campaign is about 210 extractions
plus 6 re-extracts (`--plan` prints the estimate).

## Night-run recipe

From the main checkout, on the commit under test (a worktree build cannot
name its commit without the `GIT_*` variables, and the campaign refuses an
image whose `/version` says `unknown`). The campaign also refuses a
checkout whose `src/` differs from the image's commit: the dumps, the
fingerprints and `check-projection-replay --records` run from the
checkout against rows the image wrote.

```bash
cd ~/Developer/receipt-assistant
git status                        # clean, on the commit under test

# 1. Build the sandbox once. The campaign never builds; it recreates the
#    container from this image for every arm and refuses another commit.
GIT_SHA=$(git rev-parse HEAD) GIT_SHORT_SHA=$(git rev-parse --short HEAD) \
GIT_BRANCH=$(git branch --show-current) MAX_CLAUDE_CONCURRENCY=1 \
  docker compose -f docker-compose.test.yml up -d --build

# 2. Look before spending: units, steps, extractions, tokens, hours.
npx tsx scripts/ab-campaign.ts --id=ab-1 --plan

# 3. The night. --stop-after is local time; no item starts after it, and no
#    item the median of the finished ones of its kind says cannot end by
#    then. A bare HH:MM more than 16 h away is refused (the night's command
#    re-run in the morning would run through the day); give a date then.
caffeinate -i npx tsx scripts/ab-campaign.ts --id=ab-1 --stop-after=07:30

# 4. The next nights: the same command resumes at the first unfinished item.

# 5. The gates, any time (files only, no stack):
npx tsx scripts/diff-arms.ts --campaign="$HOME/Documents/10_Projects/2026_Dev_ReceiptAssistant/notes/2026-11-13_design_wave1/ab/ab-1"
```

Before the first night: the pre-A/B gate (`check-projection-replay
--from-ledger`) has passed, `check-agent-sandbox` is green on this image,
the private C2 manifest and the Claude cases' manifest
(`~/Developer/receipt-assistant-data/eval/dedup-claude.manifest.json`)
exist, and `.env` sets neither `EXTRACTION_WRITER` nor
`MAX_CLAUDE_CONCURRENCY` (production reads it too; the campaign refuses
it). Do not run anything else on the sandbox while a campaign runs.

Defaults: `--manifest` is C1 (`scripts/eval-dates.fixtures.json`, set
`c1`) then C2 (the private `ab-manifest-c2.json`, set `c2`), both from
eval-dates's uploads directory; `--out` is
`<notes>/2026-11-13_design_wave1/ab/<id>`, which is private because it
holds dumps of real receipts (an `--out` inside a checkout is refused).
Flags and exit codes are in the header of `scripts/ab-campaign.ts`.

## What a campaign runs

In this order, each item once, every output under `--out`:

| Item | What |
|---|---|
| `t1-A`, `t1-B`, `t2-B`, `t2-A`, `t3-A`, `t3-B` | one unit per trial and arm; odd trials run A first, even trials B first |
| `c5` | gate G9: legacy re-extract on 3 arm-B transactions after a user edit and a manual item, twice each |
| `c3:stub-A`, `c3:stub-B` | gate G5: the `eval-dedup` stub matrix under each writer |
| `c3:a8-c3` | `a8` at `MAX_CLAUDE_CONCURRENCY=3`, so the three copies are in flight together |
| `c3:claude-B` | `b2`, `b3`, `b4` with the model, under `server_apply` |
| `c3:race-B`, `c3:race-A` | `race` three times on a reset sandbox, under each writer, at `--race-concurrency` (default 6, the sandbox's normal value) |
| `c4` | `check-apply-extraction --disposable` on a throwaway Postgres it starts and removes |

A **unit** recreates the sandbox app container from the campaign's image
with `EXTRACTION_WRITER` for the arm, `MAX_CLAUDE_CONCURRENCY=1` and
`EXTRACTION_REPAIR_ROUNDS=1` (set for that `up -d` only, never in
`.env`), waits for the boot line that names the writer, checks `/version`
and the image id, waits for the stack to be idle, runs
`scripts/sandbox-reset.sh`, then `eval-dates` on the unit's fixtures in
one batch with `--dump`, then `check-ledger` with no allow list and, in
arm B, `check-projection-replay --records`.

Fixtures per trial: a `c1` manifest runs its `good` fixtures in trials 1
and 2 and its hard buckets in trials 1 to 3; a `c2` manifest runs every
fixture in trials 1 to 3. A duplicate pair runs together, as often as the
member that needs more. The fixtures of all manifests go up in one batch:
the campaign writes the trial's manifest to `manifests/t<n>.json` and
reaches every source through symlinks under `sources/`. `fixtures.json`
records each fixture's set, bucket, trials and whether G1 gates it.

**c5** uses the ledger the last arm-B unit left when nothing has touched
the sandbox since (on three trials the last unit is `t3-B`, and c5 runs
right after it), and otherwise runs a small arm-B unit of its own first
(3 extractions; `--c5-keys` picks the fixtures). For each transaction it
`PATCH`es the payee (which sets `user_edited.payee`) and the narration,
adds a manual line (`POST …/items`), then calls
`POST /v1/documents/:id/re-extract` twice, one at a time, and records the
outcome, whether the payee, the flag, the narration and the manual line
survived, and how many `derivation_events` rows each run added.

## When it stops

| Event | What happens | Exit |
|---|---|---|
| A run ends with `error_class` quota, overloaded or auth, or the app log shows the words those classes are read from (a 429 or 529, a rate, usage or session limit, overloaded, a failed authentication or a 401); the log is what catches a run whose `agent_runs` row a race round's reset has emptied | the step is interrupted, the sandbox app is stopped (its queue would keep calling the API), the unit and its trial pair are marked **void**, and the campaign stops. The next run redoes both units of that trial. | 4 |
| `--stop-after` | no new item starts | 3 |
| a unit fails (eval-dates gave up, the stack misbehaved, the image changed) | the campaign stops; the unit is redone on the next run | 3 |
| a step's own tool fails (c3, c4, c5) | recorded; the campaign goes on to the next item | 3 |
| Ctrl-C | the running script writes its report, the item is marked interrupted and is redone on the next run | 130 |
| the runner is killed | the next run finds the item `running`, marks it interrupted and redoes it from its reset | |

However it ends, after touching the stack it recreates the sandbox app
quiet (default writer `agent_sql`, concurrency 1) and leaves the ledger as
the last item left it.

## The output directory

```
<out>/
  campaign.json         state: image, manifests, every item and attempt, voids
  campaign.md           the same as a table (counts and exit codes only)
  campaign.log          what the runner did, with times
  fixtures.json         every fixture: set, bucket, trials, gated, truth
  manifests/t<n>.json   the fixtures of trial n, as eval-dates read them
  sources/              symlinks to the documents
  units/<unit>/attempt-<n>/
    eval-dates.<run>.report.{json,md}   scores, runs, turns, tokens
    dump/<run>/t1/<fixture>.json        every row the run left, and fingerprints
    check-ledger.txt, replay-records.txt (B), app.log, unit.log, attempt.json
  steps/<step>/attempt-<n>/             c5.json, eval-dedup.json, logs
  gates.md, gates.json                  written by diff-arms
  worksheet.md, adjudication.json       written by diff-arms (private)
```

## diff-arms

Reads a campaign directory and nothing else. Every run of a done, not
void, unit is rescored against the manifests as they are now (so a ground
truth corrected after the run counts) with eval-dates's own `score`.

| Gate | How it is measured |
|---|---|
| G1 | the strict per-fixture majority of each arm over its trials, for date, total, payee, classification, flow and currency; (a) on gated fixtures, (b) pass counts per field, (c) on every fixture; hard buckets reported |
| G2 | from the dumped `agent_runs` and `document_extractions`: runs valid with no repair round, runs with no valid record after repair, `repair_changed_unnamed` warnings on money fields; each miss needs a root cause in `adjudication.json` |
| G3 | `check-ledger` and `--records` exit codes per unit; per arm-B transaction the per-currency balance, one `created` event, a `channel` party, the model; no narration, place or product `custom_name`, brand `user_chose_at`; every arm-B document's `ocr_text` and current valid record |
| G4 | per fixture and field, the majority value of each arm from the fingerprints; disagreements the expected differences do not explain need a verdict in `adjudication.json` |
| G5 | the `eval-dedup` JSON of each c3 part |
| G6 | per arm-B place, whether its fetched body carries the v1 English place; place linking on fixtures whose arm-B record gives a printed address; place id agreement |
| G7 | medians of billed input and turns and the p90 wall time from `agent_runs`, checked against the transcript parser `measure:turns` uses |
| G8 | the arm-B transcripts' `tool_use` inputs (and tool results, for permission errors) |
| G9 | `c5.json` |

A gate is `pass`, `fail`, `pending` (it needs a person: a G4 verdict, a G1
tie, a G2 root cause; or a step or planned unit has not run yet) or `n/a`.
A gate computed from the units (G1-G4, G6-G8) never passes until every
planned unit of both arms is done; a failure found earlier stands. G1
judges a fixture by the majority of its trials; a tie (1 of 2) against a
majority in the other arm, in either direction, is listed in
`adjudication.json` under `g1_ties` for a person to call `regression` or
`noise`. `gates.md` also reports c4 (`check-apply-extraction`), which no
gate names. Exit 0 every gate passes, 1 a gate fails, 2 one is pending or
n/a.

**Adjudication.** `worksheet.md` lists, per fixture, the truth and every
field of both arms side by side, the disagreements marked, and the ones
`docs/server-writer.md` expects (X1-X13, the tender table, the known gaps)
marked expected. Read each remaining disagreement against the document,
then set its `verdict` in `adjudication.json` (`B-worse`, `A-worse`,
`both-wrong`, `equal`, or `expected` for an expected difference the tool
did not recognise) with a note, answer each G1 tie, write each G2 miss's
root cause, and run `diff-arms` again; it keeps what was written as long
as the values it judged stay the same. When a later trial or a rerun of a
voided pair moves them, the answer is cleared (kept under `previous`) and
the gate is pending again. Both files hold values from
real receipts: keep them in the private notes. Stdout and `gates.md` carry
counts and fixture aliases (`m2-c2#04`) only, so they can go into a pull
request.

## Rehearsal without a model

Before the first real night, run a whole campaign on stubs: it exercises
the writer flips, the alternation, the void, the resume and the stop with
no model call and no quota.

- Stub fixtures: `.json` files (`"__stub__": true`) with both a
  `terminal` part and a `record` part and `"follow_writer": true`, so each
  takes the path of the arm it runs in (`src/ingest/stub-extractor.ts`).
  A child with `"exit_code": 1, "fail_as": "quota"` fails the way a quota
  outage does; swap such a file in to rehearse the void.
- `--stand-in-claude=<executable>` copies a stand-in over `claude` in the
  app container after every recreate, so c3's model cases and c5's
  re-extracts reach it instead of a model. The campaign is then marked a
  rehearsal for good, and diff-arms says so.
- `--env-file=<an empty file>` keeps the token and the Google key out of
  the sandbox for the rehearsal (rebuild with the real `.env` after).
- `--trials=2` and a `--throwaway-prefix` of your own keep it short.

```bash
npx tsx scripts/ab-campaign.ts --id=rehearsal-1 --out=<scratch>/rehearsal-1 \
  --manifest=<scratch>/stubs-c1.json --uploads-dir=<scratch>/stubs --set=c1 \
  --manifest=<scratch>/stubs-c2.json --uploads-dir=<scratch>/stubs --set=c2 \
  --trials=2 --stand-in-claude=<scratch>/stand-in-claude --env-file=<scratch>/empty.env
npx tsx scripts/diff-arms.ts --campaign=<scratch>/rehearsal-1
```

A rehearsal's gates say nothing about either writer: stub documents are
not readings.
