# Statement ingestion & reconciliation — design

**Status:** PROPOSAL. Nothing here is built. This document is the design gate
required by [#175](https://github.com/TINKPA/receipt-assistant/issues/175);
implementation is blocked until the recommendations below are accepted or
amended.

**Written:** 2026-07-28, against `main` @ `988ffc4`.

**Scope:** make bank/credit-card statements the ledger's ground truth, with
receipts as the detail layer attached to statement-backed transactions.

---

## 0. Summary for the impatient

Three open questions were posed in #175. Two of them rest on premises that turn
out not to match the code, which makes this project meaningfully smaller than
the issue assumes.

| # | Question | Recommendation | Size |
|---|---|---|---|
| 1 | Does a statement line *create* a transaction or *confirm* one? | **Confirm-first, create-on-demand.** A statement line is evidence, never itself a transaction. | Real work |
| 2 | Credit card vs debit card vs bank account taxonomy | **The schema already models this.** `accounts.type` + `accounts.subtype` + `institution` + `last4` exist today. The gap is *data*, not schema: production has one generic "Credit Card" account. | Much smaller than assumed |
| 3 | Money flow needs a graph model | **The ledger is already a graph.** `accounts` are nodes, `postings` are edges, a `transaction` is a hyperedge. This needs *queries and a view*, not a parallel data model. | Do not build a second model |

The genuinely new machinery is: two tables (`statements`, `statement_lines`), a
join table for matches, a parser, and a matching engine. Everything else is
populating data and writing queries against structures that already exist.

---

## 1. Ledger integration — does a statement line create or confirm?

### 1.1 Recommendation: confirm-first, create-on-demand

**A statement line is evidence about a transaction, not a transaction.** It
should never silently mint ledger entries, because the statement's own
description (`SQ *15TH ST PIZZA 8005551234`) is strictly worse data than the
receipt it corresponds to. Minting from statements first would fill the ledger
with rows the receipt layer then has to de-duplicate against — which is the
`dedup` problem the project already fought once, re-created at statement scale.

The flow:

1. Statement ingests as a document and parses into `statement_lines`.
   `statement_pdf` already exists in `documentKindEnum` — but note **zero
   `statement_pdf` documents exist in production today**. #175 describes this
   path as one where statements "ingest and extract like any receipt"; that is
   true of the enum value, not of any exercised code. Treat the statement ingest
   path as unproven and smoke-test it before building the parser on top.
2. Each line is matched against existing transactions on that account.
3. A confident match **confirms** the transaction: it becomes `reconciled` and
   carries a reference to the statement line that proves it.
4. A line with **no** match after the matching window closes is surfaced to the
   user as *"we have no receipt for this charge"* — with a one-click **create
   transaction from this line**. That creates a real transaction whose only
   document is the statement, with `metadata.source = 'statement'` so it is
   distinguishable from a receipt-derived one forever.

Step 4 is what makes statements ground truth: nothing on the statement can be
silently absent from the ledger, but the user stays in the loop on the rows
where the ledger has no independent evidence.

**Rejected alternative — statement-creates-all.** Parse the statement, create a
transaction per line, then attach receipts to them. This makes reconciliation
trivial (every transaction is statement-born) but throws away the receipt's
line items whenever a receipt arrives *after* the statement, and it puts
merchant-name garbage in the payee field of every transaction the user actually
has a good receipt for. The ledger would get worse the more statements you feed
it.

### 1.2 The matching key

No single key works; matching is scored, not looked up.

| Signal | Weight | Notes |
|---|---|---|
| `account_id` | Gate | A line only matches transactions posting to its own account. Non-negotiable. |
| `amount_minor` + direction | Gate | Exact match required at the gate. Near-amount handling is a separate, later feature (tips adjusted after auth — see §1.4). |
| Date proximity | Strong | Statement `posted_date` typically lags the receipt by 1-3 days. Recommend a ±5 day window, scored by closeness. |
| Merchant/payee similarity | Strong | Statement descriptors are noisy (`SQ *`, `TST*`, `AMZN MKTP`). Needs a normalizer; the existing merchant model (#64) is the natural home. |
| Existing `document_links` | Weak | A transaction already holding a receipt for that exact amount+day is more likely the match. |

**Recommendation:** reuse the existing `reconcile_proposals` table rather than
inventing a parallel proposal store. It already has `kind`, `payload`, `score`,
`status`, was explicitly frozen for this class of work, and is **already live**
— 35 rows in production, all `kind='dedup'` (19 proposed, 15 auto_applied,
1 user_applied). So the propose/apply/reject lifecycle is proven, not
theoretical. Add `kind = 'statement_match'`.

Two caveats for the implementation PR:

- `batch_id` is `NOT NULL`. That is fine while statements ingest as batches, but
  re-running matching outside an ingest batch needs that FK nullable or a
  `statement_id` sibling column.
- #175 states reconcile has "0 rows in prod". That was true when written and is
  no longer; the dedup path filled it. Do not design around the empty-table
  assumption.

### 1.3 1:many and many:1 — use a join table, not a foreign key

This is the part that most constrains the schema, so it should be decided now.

- **One statement line ↔ many transactions.** A single card charge that the user
  split across categories, or one Amazon charge covering a 3-item order that was
  receipted separately.
- **Many statement lines ↔ one transaction.** A deposit plus a final charge; a
  split-tender purchase (part gift card, part card); an authorization followed
  by an adjusted capture.

A nullable `statement_line_id` column on `transactions` cannot express either.
**Recommendation: a `statement_line_matches` join table** carrying the amount
each side contributes:

```
statement_line_matches
  id
  workspace_id
  statement_line_id  -> statement_lines(id)
  transaction_id     -> transactions(id)
  amount_minor       -- how much of the line this transaction accounts for
  confidence         -- 'high' | 'medium' | 'low'
  status             -- 'proposed' | 'confirmed' | 'rejected'
  matched_by         -- 'auto' | 'user'
  created_at, resolved_at
```

`amount_minor` is what makes partial matches representable and lets the "is this
line fully accounted for?" question be a `SUM(...) = line.amount_minor` check
rather than a boolean guess.

### 1.4 What `reconciled` should mean

Today `reconcileTransaction` writes an empty payload — the P3 stub left behind
by #171. It should mean, precisely:

> Every posting of this transaction against a statement-bearing account is
> covered by confirmed statement-line matches summing to the transaction's own
> amount on that account.

Consequences worth stating explicitly:

- A cash transaction can **never** be `reconciled`, because no statement covers
  cash. Any UI that treats "not reconciled" as "needs attention" would nag
  forever about cash. Recommend the UI distinguish *unreconcilable* from
  *unreconciled*.
- Reconciliation is **derived**, not asserted. It should be recomputed from
  `statement_line_matches`, not set by hand. If it is stored on `transactions`
  at all, it is a cache with a defined recompute path — the same discipline the
  product-aggregate recompute already follows.
- `txnStatusEnum` currently still carries `voided` even though #170/#173 removed
  voids. Reconciliation work touches this enum; clean that up in the same PR
  rather than adding a fourth meaning around a dead value.

---

## 2. Account taxonomy — mostly already solved

### 2.1 What the issue assumed, and what is actually there

#175 says: *"Today there is a single 'Credit Card' liability account; real
money-flow needs the distinction."* The first half is true of the **data**. The
second half is already true of the **schema**:

```
accounts.type      account_type enum: asset | liability | equity | income | expense
accounts.subtype   text: 'cash' | 'checking' | 'savings' | 'credit_card' | 'opening_balance'
accounts.institution   text
accounts.last4         text
accounts.currency      char(3)
accounts.parent_id     self-FK — the chart is already a tree
```

Live chart of accounts on the mini today — 19 accounts. The money-bearing ones,
with how many live transactions post to each:

```
liability  credit_card       Credit Card      1327 txns   <- one generic account
asset      cash              Cash               23 txns
asset      checking          Checking            7 txns
asset      savings           Savings             0 txns
```

So the credit-vs-debit distinction the issue asks for is **`accounts.type`**,
and it already drives posting direction correctly through ordinary double-entry:

- **Credit card (liability).** Purchase: debit expense, credit the liability →
  liability grows. Statement payment: debit the liability, credit checking →
  liability shrinks, asset shrinks. Two transactions, no special-casing.
- **Debit card / bank (asset).** Purchase: debit expense, credit the asset →
  asset shrinks directly. No payment leg exists, correctly.

**Recommendation: do not touch `accountTypeEnum`.** Adding `credit`/`debit`
types would duplicate what `type` + `subtype` already encode and would break
every existing balance query.

### 2.2 What actually needs doing

The work is **populating instrument-level accounts**, not modelling them:

1. One account per real-world instrument, not one per category:
   `liability/credit_card` "Chase Sapphire ···4242" with `institution='Chase'`,
   `last4='4242'`; `asset/checking` "BofA Checking ···8158", and so on.
2. Add `debit_card` as a used `subtype` value (it is free-text; no migration).
3. Bind each statement to exactly one account. `(institution, last4)` is the
   natural join key and both columns already exist — this is the single reason
   `last4` was put on `accounts` and it is currently unused.
4. Backfill: **1327 of the 1356 live transactions** post to the single generic
   "Credit Card" account. Re-pointing them at instrument accounts is a data
   migration that needs the user's input on which card was actually used, and
   cannot be fully automated — the receipts mostly do not record which card,
   and where they do it is a last4 the extractor does not currently capture.
   **Recommend leaving history on the generic account and starting instrument
   accounts from a chosen cutover date.** A wrong automatic re-assignment is
   worse than a coarse-but-true one, and unwinding it later is expensive.

Step 4 is the only genuinely awkward part of this whole section, and it is a
data question, not a design question.

---

## 3. Money flow is a graph — and the ledger already is one

### 3.1 Recommendation: do not build a second data model

#175 calls this *"the genuinely complex part and likely drives the data model."*
Respectfully, the opposite: **double-entry is already the graph**, and it is the
correct one.

```
nodes = accounts
edges = postings   (each posting is one account's participation in a transaction)
a transaction     = a hyperedge joining N accounts with amounts summing to zero
```

Every flow question #175 raises is already answerable from `postings` today:

| Question | Query |
|---|---|
| Where did money go from this card? | postings on that account, joined to their sibling postings |
| Bank → card payment → merchant | two transactions sharing the liability account as a node |
| Refunds | a posting with the opposite sign against the same account |
| Transfers between my own accounts | a transaction whose postings are all asset/liability, no expense leg |

Building a parallel `flow_edges` table would create a **second source of truth
for the same facts**, which is exactly the failure mode #164 exists to fix, one
layer down. It would also have to be kept in sync with `postings` on every write,
and the balance-integrity triggers (`postings_balance_ck`) protect `postings`
only.

### 3.2 What to build instead

- **A recursive CTE / SQL view** that walks account-to-account flow over a date
  range, treating each transaction as the hop. This is a query, shipped as a
  read endpoint, with zero schema change and zero sync risk.
- **A transfer rule.** A transaction moving money between two of the user's own
  accounts is not spending, and every "how much did I spend" number must exclude
  it. A credit-card payment is exactly this shape: without the rule, paying the
  card reads as $X of spending *on top of* the purchases it settles, double-
  counting the month.

  **This is not a bug today — it is a bug the moment statements land.** Measured
  against production: all **1356** live transactions post to an `income` or
  `expense` account, and there are **zero** transfer-shaped transactions. The
  receipt-only pipeline cannot produce one, because a receipt is always a
  purchase. Statements are the first source that will carry card payments and
  inter-account transfers, so the rule must exist *before* phase 2 ingests one,
  not after someone notices the totals inflate.

  **Recommend deriving it rather than storing a flag:** a transaction whose
  postings touch no `income`/`expense` account is a transfer, by construction.
  That predicate is exactly the query above, it needs no schema change, and it
  cannot drift out of sync. Add a stored marker only if the derived rule proves
  insufficient in practice.

---

## 4. Proposed schema (sketch)

```
statements
  id, workspace_id
  account_id        -> accounts(id)     -- resolved via (institution, last4)
  document_id       -> documents(id)    -- the statement_pdf itself
  period_start, period_end   date
  opening_balance_minor, closing_balance_minor   bigint
  currency          char(3)
  metadata          jsonb
  UNIQUE (workspace_id, account_id, period_start, period_end)

statement_lines
  id, workspace_id
  statement_id      -> statements(id) ON DELETE CASCADE
  line_no           int
  posted_date       date
  transaction_date  date NULL      -- when printed separately from posted
  amount_minor      bigint         -- signed, in the account's own direction
  raw_description   text           -- verbatim, never normalized in place
  normalized_descriptor text NULL
  fingerprint       text           -- for idempotent re-ingest of the same PDF
  UNIQUE (workspace_id, statement_id, line_no)
  INDEX (workspace_id, account_id_via_statement, posted_date, amount_minor)

statement_line_matches      -- see §1.3
```

Two invariants worth encoding as checks:

- `SUM(statement_lines.amount_minor) + opening_balance = closing_balance` per
  statement. A parser that drops a line fails loudly instead of silently
  under-reporting. This is the statement-level analogue of the receipt tie check,
  and it is the single most valuable guard in this design.
- `fingerprint` makes re-uploading the same statement idempotent, which will
  happen constantly.

---

## 5. Phasing

Each phase is independently useful and independently shippable. Do not start
phase N+1 before N is deployed and verified on the mini.

| Phase | Ships | Depends on |
|---|---|---|
| 0 | Transfer derivation (§3.2) + exclude transfers from spend totals | nothing — but it is a **prerequisite of phase 2**, not optional |
| 1 | Instrument-level accounts, `(institution, last4)` populated, cutover date chosen | user input on which cards exist |
| 2 | `statements` + `statement_lines` + parser off the existing `statement_pdf` ingest path + the balance tie check | 1, **0** |
| 3 | Matching engine writing `reconcile_proposals(kind='statement_match')` + `statement_line_matches` | 2 |
| 4 | Reconcile review UI; `reconciled` becomes derived and meaningful (fills the #171 P3 stub) | 3 |
| 5 | Unmatched-line surface with "create transaction from this line" (§1.1 step 4) | 3 |
| 6 | Money-flow view (recursive CTE, read-only endpoint) | 0 |

Phase 0 is cheap and has no dependencies, but note it is a *prerequisite*, not a
free-standing win: it changes nothing about today's numbers (there are zero
transfers to exclude) and exists to be in place before the first statement
introduces them.

## 6. Cross-repo split

Per the project's tracking-issue convention, this becomes a `tracking` issue in
`receipt-assistant` (backend owns the API contract) with children:

- **Backend** — schema, parser, matching engine, endpoints, `openapi.json`.
- **Frontend** — statement upload, reconcile review, unmatched-line surface,
  flow view.

There is no macOS slice; that client was retired 2026-07-28.

---

## 7. Open questions for the user

These need a human decision and are the reason this document stops at design.

1. **Which instruments exist?** §2.2 needs the real list of cards and bank
   accounts (institution + last4) before instrument accounts can be created.
2. **Cutover vs backfill.** Leave the 466 existing transactions on the generic
   "Credit Card" account and start instrument accounts from a cutover date
   (recommended), or attempt a retroactive re-assignment?
3. **Statement sources.** PDF only, or is CSV/OFX/QFX export in scope? Most
   institutions offer CSV and it is dramatically more reliable to parse than a
   PDF. If CSV is acceptable, phase 2 gets much cheaper and more accurate.
4. **Auto-confirm threshold.** At what confidence should a match apply without
   review? Recommend starting at *never* — propose everything, learn the error
   rate on real data, then loosen. Silent auto-reconciliation that is wrong is
   very hard to notice.
5. **Phase 0 as its own issue?** The transfer rule is independent of all
   statement work and must be in place before the first statement is parsed.
   It changes no current number (production has zero transfers today), so it is
   a pure safety prerequisite. File it separately now, or keep it inside the
   statement tracking issue?
