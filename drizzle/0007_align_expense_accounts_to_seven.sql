-- Align expense chart-of-accounts with the seven spending categories
-- defined in the frontend (issue #68).
--
-- Before this migration the seeded chart had six expense accounts
-- (Dining, Groceries, Transport, Utilities, Entertainment, Other). The
-- frontend uses seven (Food & Drinks, Transportation, Shopping, Travel,
-- Entertainment, Health, Services). The mismatch leaked through
-- /v1/reports/summary, which groups by account name — Dashboard saw an
-- "Other" bucket that was actually mixed retail + unknown.
--
-- Migration plan:
--   1. Rename existing accounts to canonical names (Dining → Food &
--      Drinks, Transport → Transportation, Utilities → Services,
--      Other → Shopping). Postings keep their account_id, so the
--      historical ledger is preserved.
--   2. Merge Groceries into Food & Drinks: move every Groceries
--      posting to the (now-renamed) Food & Drinks account, then drop
--      the Groceries account row.
--   3. Insert Travel and Health under each workspace's Expenses
--      parent. Idempotent — NOT EXISTS guards against re-runs.
--
-- Drizzle wraps the file in a transaction, so the migration is atomic.

UPDATE accounts SET name = 'Food & Drinks', updated_at = NOW()
 WHERE type = 'expense' AND name = 'Dining';

UPDATE accounts SET name = 'Transportation', updated_at = NOW()
 WHERE type = 'expense' AND name = 'Transport';

UPDATE accounts SET name = 'Services', updated_at = NOW()
 WHERE type = 'expense' AND name = 'Utilities';

UPDATE accounts SET name = 'Shopping', updated_at = NOW()
 WHERE type = 'expense' AND name = 'Other';

WITH pairs AS (
  SELECT g.id AS src, fd.id AS dst
    FROM accounts g
    JOIN accounts fd
      ON fd.workspace_id = g.workspace_id
     AND fd.type = 'expense'
     AND fd.name = 'Food & Drinks'
   WHERE g.type = 'expense' AND g.name = 'Groceries'
)
UPDATE postings p
   SET account_id = pairs.dst
  FROM pairs
 WHERE p.account_id = pairs.src;

DELETE FROM accounts
 WHERE type = 'expense' AND name = 'Groceries';

INSERT INTO accounts (id, workspace_id, parent_id, name, type, currency, created_at, updated_at)
SELECT gen_random_uuid(),
       parent.workspace_id,
       parent.id,
       n.name,
       'expense',
       parent.currency,
       NOW(),
       NOW()
  FROM accounts parent
 CROSS JOIN (VALUES ('Travel'), ('Health')) AS n(name)
 WHERE parent.type = 'expense'
   AND parent.name = 'Expenses'
   AND parent.parent_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM accounts a
          WHERE a.workspace_id = parent.workspace_id
            AND a.type = 'expense'
            AND a.name = n.name
       );
