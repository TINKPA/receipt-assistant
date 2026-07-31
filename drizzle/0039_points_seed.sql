-- ═══════════════════════════════════════════════════════════════════════
-- #206 — seed data. DML ONLY, and it sorts AFTER every DDL statement in
-- 0038 for the PG 55006 reason documented at the top of that file.
--
-- ⚠ Scope of this file, stated so nobody has to infer it from the SQL:
-- it inserts into `points_programmes` and `points_valuations` and NOTHING
-- ELSE. It does not read, update, delete, or re-classify any existing
-- transaction, posting, or account. The 36 transactions carrying
-- points/award metadata and the 213 zero-total transactions are left
-- exactly as they are — see `docs/points-as-currency.md` § "Existing
-- data" for what should happen to them and why that is a separate,
-- reviewed operation rather than part of this deploy.
--
-- ⚠ THE NUMBER BELOW IS NOT CONFIRMED.
-- 1.7 US cents per Hyatt point is the single example cited in issue #206
-- itself. It is seeded so the valuation mechanism is exercised end to end
-- rather than shipped untested, and it is deliberately marked
-- `confirmed_at = NULL` / `source = 'issue-206-example'` so that:
--   * every report that includes it discloses how much of its total rests
--     on an unconfirmed valuation, and
--   * confirming it is one UPDATE, and changing it is one INSERT with a
--     later `effective_from` plus a `force` re-run of the valuation pass.
-- No other programme is seeded. A programme with no valuation row values
-- its postings at zero base and is counted as `unvalued` in the reports —
-- a visible gap, never a silent $0 expense.
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO "points_programmes" ("code", "name", "issuer_brand_id", "notes")
VALUES (
  'HYATT_PT',
  'World of Hyatt points',
  'hyatt',
  'Seeded by #206. The 1.7 cents/point valuation is the example given in the issue and has NOT been confirmed by the owner.'
)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- effective_from is deliberately the epoch-ish 2000-01-01 rather than the
-- deploy date: the resolver picks the newest row with
-- `effective_from <= occurred_on`, so an early date means the seed also
-- covers any award stay re-ingested from the past. A later re-valuation
-- is an INSERT with a newer effective_from, which leaves already-valued
-- history untouched.
INSERT INTO "points_valuations" (
  "workspace_id", "currency", "quote", "effective_from",
  "minor_per_point", "source", "confirmed_at", "note"
)
SELECT w."id", 'HYATT_PT', w."base_currency", DATE '2000-01-01',
       1.7, 'issue-206-example', NULL,
       'UNCONFIRMED. 1.7 US cents per point, the example cited in #206. Confirm or replace before trusting any total that includes a Hyatt award stay.'
  FROM "workspaces" w
 WHERE w."base_currency" = 'USD'
ON CONFLICT ("workspace_id", "currency", "effective_from") DO NOTHING;
