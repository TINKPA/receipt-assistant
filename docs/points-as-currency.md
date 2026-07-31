# Loyalty points as a currency (#206)

> 積分房一定要算，積分也是另外一種貨幣。
> — the owner, 2026-07-30

An award stay is real spend. It is simply denominated in a unit that is
not dollars. Flattening it to `total_minor = 0` — the rule that used to
live at `src/ingest/prompt.ts:149` — made a 40,500-point hotel night
invisible in every report. This document records what replaced it, the
decisions taken along the way, and the two things that still need the
owner.

**Read this first if you are about to change a valuation number, migrate
old zero-total rows, or touch `src/fx/`.**

---

## 1. What a points transaction looks like now

A 40,500-point stay at a Hyatt, written by the extraction agent and then
valued by the worker:

```
postings
  debit   Travel (expense)             40500  HYATT_PT   fx_rate 1.7   base  68850
  credit  World of Hyatt points (asset) -40500  HYATT_PT   fx_rate 1.7   base -68850
```

It balances natively — `postings_balance_ck` is untouched and was never
modified for this feature — and it shows up as $688.50 of Travel spend
rather than as nothing at all.

A folio that charges points *and* cash (a resort fee) gets two posting
pairs, one per currency; each balances within itself.

---

## 2. Decision: per-programme currency codes, `<ISSUER>_PT`

`HYATT_PT`, `BONVOY_PT`, `AA_PT`. Cash stays ISO 4217. The two namespaces
are disjoint **by shape** — `^[A-Z]{3}$` versus
`^[A-Z][A-Z0-9]{1,12}_PT$` — and enforced by CHECK constraints on
`postings.currency` and `accounts.currency`
(`drizzle/0038_points_as_currency.sql`).

*Why not a single generic `POINTS` discriminated by account?* A currency
code asserts fungibility: any two units of it may be added together.
40,500 Hyatt points and 12,000 AA miles cannot, and a shared code would
let every per-currency sum silently add them.

*Why not squat on the ISO X- range (`XHY`)?* It is not free. `XCD`,
`XOF`, `XAF`, `XPF` are circulating currencies; `XAU`, `XAG`, `XDR` are
real ISO allocations. It would need a hand-maintained deny-list, and it
reads as noise.

*Why a suffix rather than a prefix?* Either works; the suffix keeps the
issuer at the front where it is readable. What matters is the
underscore, which ISO 4217 cannot produce, so no present or future ISO
code can ever collide.

`workspaces.base_currency` and `fx_rates.base` / `.quote` were
deliberately **left** at `char(3)`. That makes "base currency is points"
and "a points rate in the FX cache" unrepresentable rather than merely
discouraged.

---

## 3. Decision: points asset accounts, redemption-only

One asset account per programme per workspace: `type='asset'`,
`subtype='points'`, `currency='HYATT_PT'`, created on first sight by the
extraction agent's upsert against the partial unique index
`accounts_points_uq`.

This is forced, not optional: the credit leg of a points redemption has
to land in an account denominated in points, and crediting the USD
Credit Card account would be incoherent.

**Only redemption is recorded. Earning is not.** Award nights, card
spend, promotions and expiry are a separate data source (programme
statements) that the system does not ingest. So a points account's
balance is a *tally of points spent*, not a holdings balance —
consequently **net worth excludes points accounts**, and says so in the
`points.policy` field of its response. Including them would drag net
worth down by the value of every award ever redeemed.

Flipping this to full asset tracking later means ingesting earning
events; the account and the currency code are already in place for it.

---

## 4. Valuation: how `amount_base_minor` is derived

`points_valuations` is workspace-scoped and versioned by
`effective_from`. The resolver takes the newest row with
`effective_from <= transactions.occurred_on`, so re-valuing *going
forward* leaves history at the number it was booked with.

`minor_per_point` is base-currency **minor units per one point** — 1.7
US cents per Hyatt point is `1.7`. Points have no subunit, so one point
is one minor unit of its own currency and the conversion is the same
plain minor→minor multiply that `postings.fx_rate` already means. That
is why the valuation is written straight into `fx_rate`:

```
amount_base_minor = round(amount_minor × minor_per_point)
```

`src/points/valuation.ts` runs from the ingest worker, immediately
before the FX pass, and stamps provenance on
`transactions.metadata.points` (which valuation, which effective date,
what source, and whether it is confirmed).

### This does not touch the `fx_rate IS NULL` path

Four independent reasons, in decreasing order of how hard they are to
break by accident:

1. **`getRate()` throws on a points code.** `src/fx/rates.ts` refuses
   outright rather than filtering, so any future caller that forgets to
   partition fails loudly instead of pricing an award stay off a
   currency-market feed.
2. **`fx_rates.base` / `.quote` are `char(3)`.** A points code
   physically cannot be stored in the FX cache.
3. **`normalizeTransactionFx` excludes points legs before it ever reads
   `fx_rate`.** The marker is consulted only for cash legs, so in the
   cash domain it still means exactly one thing: "needs conversion at a
   published rate".
4. **`scripts/backfill-fx.ts` excludes them from its candidate query**
   for the same reason.

Within the *points* domain `fx_rate` carries its own three-state marker,
which is separate because the currency shape is: `NULL` = the valuation
pass has not run (the points backfill marker), `0` = ran and found no
valuation configured, `> 0` = valued. Zero is always re-tried, so
configuring a valuation later picks up the stranded rows without
`force`.

Regression coverage for all of this, including a live CNY→USD conversion
against the ECB feed, is `scripts/smoke-points.ts`.

---

## 5. ⚠ Numbers the owner must confirm

Exactly one number is currently in the ledger's valuation table, and it
is **not confirmed**:

| Programme | Value | Source | Status |
|---|---|---|---|
| `HYATT_PT` | **1.7 US cents per point** | the example cited in issue #206 itself | `confirmed_at IS NULL` — awaiting the owner |

Nothing else was invented. Any other programme (`BONVOY_PT`, `AA_PT`, …)
has no valuation row, so its stays are recorded in points, valued at
zero base, and counted in every report's
`points.unvalued_transaction_count` — a visible gap, never a silent $0
of spend.

**What the owner needs to decide:**

1. **Is 1.7 ¢ the right number for Hyatt points?** Every award stay's
   dollar figure scales linearly with it. Until confirmed, each report
   states how much of its total depends on it
   (`points.unconfirmed_base_minor`).
2. **Which other programmes should be valued, and at what?** Only the
   ones actually redeemed need a number.
3. **One valuation for all time, or a schedule?** The table supports
   dated versions; the seed uses a single row effective from
   2000-01-01.

To confirm the seeded number as-is:

```sql
UPDATE points_valuations SET confirmed_at = NOW()
 WHERE currency = 'HYATT_PT' AND source = 'issue-206-example';
```

To replace it going forward (history keeps the old number):

```sql
INSERT INTO points_valuations
  (workspace_id, currency, quote, effective_from, minor_per_point, source, confirmed_at)
SELECT id, 'HYATT_PT', 'USD', DATE '2026-08-01', 2.1, 'owner', NOW() FROM workspaces;
```

To re-value existing transactions after changing a number, run
`valueTransactionPoints(txId, wsId, { force: true })` over the affected
ids. Without `force` only unvalued (`fx_rate = 0`) legs are picked up.

---

## 6. Existing data — decision record

The issue reports, measured on prod 2026-07-29: **36** transactions
carrying points/award metadata and **213** zero-total transactions, 18 of
them hotel-branded. *(Those counts are from the issue. They have not been
re-verified here — this branch has no production access.)*

### Decision: nothing is migrated automatically. Neither migration file
### touches a single existing transaction, posting, or account.

`0038` is DDL only; `0039` inserts into `points_programmes` and
`points_valuations` and nothing else.

**Why not a bulk UPDATE.** The 213 zero-total rows are not one class:

- genuinely $0 cash events (fully gift-card-funded orders, comped items)
  — correct as they stand, under both the old rule and the new one;
- award/points stays wrongly flattened to $0 — wrong, and in scope;
- documents that should never have become transactions at all.

Only the middle group should change, and **the ledger does not contain
the information needed to fix it**. The points count lives on the source
document, not in any column. A SQL migration would have to invent the
number, which is precisely the failure mode #206 exists to prevent.

**The catch, worth knowing before anyone plans the cleanup.** Re-extract
will not fix these on its own: it deliberately does not rewrite
`postings` (see the backend `CLAUDE.md`, "Postings rewrite"). So the
money stays wrong even after a re-extraction produces the right points
figure.

**Recommended operation, to be run and reviewed as its own task:**

1. Shortlist candidates — zero-total, hotel-branded or with
   award/points/redemption wording in `metadata` / `documents.ocr_text`.
   Expect roughly the 18 hotel-branded rows plus some of the 36
   metadata-flagged ones; the sets overlap.
2. Review each one by eye against its source document. Classify as
   *award stay*, *legitimately $0*, or *should not exist*.
3. For each confirmed award stay, either soft-delete the $0 transaction
   and re-upload the document (the new prompt then writes it in points),
   or correct the postings by hand through the postings endpoints. A
   soft-deleted row is excluded from the near-dup candidate query
   (`deleted_at IS NULL`), so the re-upload will not be caught as a
   duplicate of the row it replaces.
4. Leave the other two classes alone.

This is deliberately manual. The owner has said existing zero-total data
must not be merged or rewritten without review, and step 2 is the review.

---

## 7. What reports say

Every `/v1/reports/*` response carries a `points` block
(`PointsDisclosure` in the OpenAPI spec) with a `policy` sentence stating
the rule in words, plus the numbers behind it:

| Report | Points treatment |
|---|---|
| summary, trends, cashflow | **included** in the base-currency totals; `base_minor` says how much of the total that is, `unconfirmed_base_minor` how much of *that* rests on an unconfirmed valuation, `unvalued_transaction_count` how many contributed nothing |
| net worth | **excluded** (§3); the block reports the excluded balances so the exclusion is auditable rather than asserted |

---

## 8. Follow-ups not in this change

- **Frontend rendering.** `receipt-assistant-frontend` formats amounts
  with a currency assumption that predates points codes; a `HYATT_PT`
  posting needs a display treatment ("40,500 pts ≈ $688.50") and the
  `points` disclosure block wants surfacing. Separate repo, separate
  issue.
- **Points earning.** Turning the redemption-only accounts into real
  holdings balances (§3).
- **The existing-data cleanup** of §6.
- **End-to-end verification on the mini.** Not done here: this branch is
  local-only by instruction. Everything above is verified against a
  throwaway Postgres with the real migrations, real constraints and the
  real ECB feed (`scripts/smoke-points.ts`), which is not the same thing
  as a real receipt through the real worker.
