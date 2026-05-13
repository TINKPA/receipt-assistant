-- Backfill metadata.merchant.category for rows that pre-date the
-- Phase 2.5 / #64 merchant block. PR #64 promised "backfill populates
-- this on every existing row" but in practice only ~10% of rows ever
-- got it; the rest still rely on the legacy metadata.category_hint
-- (groceries / dining / cafe / retail / transport / other), which is
-- the fallback path PR-1 of this cleanup just removed from the prompt.
--
-- This migration fixes the data so PR-3 can drop the legacy fallback
-- in the frontend without rendering 89% of rows as gray Uncategorized.
--
-- Strategy:
--   Step 1 (~104 rows): copy the spending posting's account.name into
--     metadata.merchant.category. The 7 expense account names are
--     already canonical (#68 / 0007), so this is loss-free.
--   Step 2 (~4 rows): for transactions with no spending leg to a
--     canonical expense account (VOIDs, refunds, the odd Credit-Card-
--     only entry), derive from metadata.category_hint via the legacy
--     mapping the prompt used to ship inline.
--   Step 3: assertion. Any row left with NULL merchant.category after
--     the two steps means a malformed legacy row we didn't predict;
--     RAISE so the migration aborts rather than silently leaving holes.
--
-- Implementation note — jsonb_set vs ||:
--   89% of legacy rows have NO `merchant` key at all in metadata.
--   jsonb_set(metadata, '{merchant,category}', ..., true) is a no-op
--   when the intermediate path is missing — create_missing only
--   instantiates the LEAF, not parent objects. So we use the ||
--   concat operator on top-level keys, building the merchant object
--   via COALESCE so existing keys (canonical_name, brand_id) on the
--   13 already-populated rows are preserved.
--
-- Drizzle wraps the file in a single transaction, so the migration
-- is atomic.

-- Step 1: backfill from canonical spending account name.
WITH spending_account AS (
  SELECT DISTINCT ON (p.transaction_id)
    p.transaction_id,
    a.name AS account_name
  FROM postings p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.amount_minor > 0
    AND a.type = 'expense'
    AND a.name IN (
      'Food & Drinks', 'Shopping', 'Transportation',
      'Travel', 'Entertainment', 'Health', 'Services'
    )
  ORDER BY p.transaction_id, p.amount_minor DESC
)
UPDATE transactions t
   SET metadata = t.metadata || jsonb_build_object(
         'merchant',
         COALESCE(t.metadata->'merchant', '{}'::jsonb)
           || jsonb_build_object('category', sa.account_name)
       )
  FROM spending_account sa
 WHERE t.id = sa.transaction_id
   AND (t.metadata->'merchant'->>'category') IS NULL;

-- Step 2: backfill the residual rows (VOIDs / refunds / no expense leg)
-- from the legacy category_hint. Mapping mirrors the inline crib that
-- used to live in src/ingest/prompt.ts before PR-1 of this cleanup.
UPDATE transactions t
   SET metadata = t.metadata || jsonb_build_object(
         'merchant',
         COALESCE(t.metadata->'merchant', '{}'::jsonb)
           || jsonb_build_object(
                'category',
                CASE t.metadata->>'category_hint'
                  WHEN 'groceries'      THEN 'Food & Drinks'
                  WHEN 'dining'         THEN 'Food & Drinks'
                  WHEN 'cafe'           THEN 'Food & Drinks'
                  WHEN 'restaurants'    THEN 'Food & Drinks'
                  WHEN 'food'           THEN 'Food & Drinks'
                  WHEN 'retail'         THEN 'Shopping'
                  WHEN 'shopping'       THEN 'Shopping'
                  WHEN 'transport'      THEN 'Transportation'
                  WHEN 'travel'         THEN 'Travel'
                  WHEN 'entertainment'  THEN 'Entertainment'
                  WHEN 'fun'            THEN 'Entertainment'
                  WHEN 'health'         THEN 'Health'
                  WHEN 'utilities'      THEN 'Services'
                  WHEN 'housing'        THEN 'Services'
                  WHEN 'education'      THEN 'Services'
                  ELSE 'Services'  -- 'other' / unknown → Services
                END
              )
       )
 WHERE (t.metadata->'merchant'->>'category') IS NULL
   AND (t.metadata->>'category_hint') IS NOT NULL;

-- Step 3: assert no holes remain. If the local DB has rows with
-- neither a canonical-account spending posting nor a category_hint,
-- the migration aborts and the offending IDs surface in the error.
DO $$
DECLARE
  hole_count int;
  sample_ids text;
BEGIN
  SELECT COUNT(*), string_agg(id::text, ', ')
    INTO hole_count, sample_ids
    FROM (
      SELECT id FROM transactions
       WHERE (metadata->'merchant'->>'category') IS NULL
       LIMIT 5
    ) s;
  IF hole_count > 0 THEN
    RAISE EXCEPTION
      'backfill_canonical_merchant_category: % rows still NULL after backfill (sample: %)',
      hole_count, sample_ids;
  END IF;
END $$;
