#!/usr/bin/env bash
# smoke-tx-snapshot.sh — round-trip check for tx-snapshot.sh / tx-restore.sh.
#
# Both scripts name tables and columns by hand, so a schema change (or a
# column that was never right, #242) breaks them silently until the day the
# undo is needed. This seeds one transaction with a row in EVERY table the
# snapshot claims to capture, snapshots it, damages it the way a re-extract
# does, restores, and asserts a second snapshot equals the first.
#
# Point it at a THROWAWAY database with the migrations applied. It writes
# into a fixed test workspace and does not clean up.
#
#   docker run -d --rm --name ra-snap-test -e POSTGRES_PASSWORD=postgres \
#     -e POSTGRES_DB=receipts -p 55432:5432 docker.io/postgres:17
#   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/receipts \
#     npx tsx scripts/migrate.ts
#   PG_CONTAINER=ra-snap-test scripts/smoke-tx-snapshot.sh
#
# Requires: docker, jq, uuidgen on the host.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:?set PG_CONTAINER to a throwaway postgres container}"
if [ "$PG_CONTAINER" = "receipts-postgres" ]; then
  echo "smoke-tx-snapshot: refusing to seed test rows into the production database" >&2
  exit 2
fi
export PG_CONTAINER
export PG_USER="${PG_USER:-postgres}"
export PG_DB="${PG_DB:-receipts}"
export SNAPSHOT_DIR="$(mktemp -d)"

HERE="$(cd "$(dirname "$0")" && pwd)"
lower() { tr '[:upper:]' '[:lower:]'; }
TX="$(uuidgen | lower)"
ITEM1="$(uuidgen | lower)"
ITEM2="$(uuidgen | lower)"
DOC="$(uuidgen | lower)"
PRODUCT="$(uuidgen | lower)"
WS="00000000-0000-0000-0000-0000000000a2"
USR="00000000-0000-0000-0000-0000000000a1"
EXPENSE="00000000-0000-0000-0000-00000000a201"
CARD="00000000-0000-0000-0000-00000000a202"

psql_q() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -qtA "$@"; }
fail() { echo "smoke-tx-snapshot: FAIL — $*" >&2; exit 1; }
# Snapshot body with the capture timestamp dropped and every array sorted,
# so two snapshots of identical rows compare equal.
canon() { jq -S 'del(.captured_at) | map_values(if type == "array" then sort_by(tostring) else . end)' "$1"; }

psql_q <<SQL
INSERT INTO users (id, email, name) VALUES ('$USR', 'snapshot@test.local', 'Snapshot Test') ON CONFLICT DO NOTHING;
INSERT INTO workspaces (id, name, base_currency, owner_id) VALUES ('$WS', 'Snapshot Test WS', 'USD', '$USR') ON CONFLICT DO NOTHING;
INSERT INTO accounts (id, workspace_id, name, type, currency) VALUES
  ('$EXPENSE', '$WS', 'Shopping', 'expense', 'USD'),
  ('$CARD',    '$WS', 'Credit Card', 'liability', 'USD') ON CONFLICT DO NOTHING;
BEGIN;
INSERT INTO products (id, workspace_id, product_key, canonical_name, item_class)
  VALUES ('$PRODUCT', '$WS', 'smoke-$TX', 'Smoke Test Widget', 'durable');
INSERT INTO documents (id, workspace_id, kind, sha256, ocr_text)
  VALUES ('$DOC', '$WS', 'receipt_image', 'smoke-$TX', 'WIDGET 12.34');
INSERT INTO transactions (id, workspace_id, occurred_on, payee, status, created_by, metadata)
  VALUES ('$TX', '$WS', DATE '2026-01-02', 'Smoke Store', 'posted', '$USR', '{"smoke": true}');
INSERT INTO postings (id, workspace_id, transaction_id, account_id, amount_minor, currency, amount_base_minor) VALUES
  (gen_random_uuid(), '$WS', '$TX', '$EXPENSE',  1334, 'USD',  1334),
  (gen_random_uuid(), '$WS', '$TX', '$CARD',    -1334, 'USD', -1334);
INSERT INTO transaction_items (id, workspace_id, transaction_id, line_no, raw_name, line_total_minor,
                               currency, item_class, confidence, product_id, metadata, source) VALUES
  ('$ITEM1', '$WS', '$TX', 1, 'WIDGET', 1234, 'USD', 'durable', 'high', '$PRODUCT', '{"note": "kept"}', 'manual'),
  ('$ITEM2', '$WS', '$TX', 2, 'TAX',     100, 'USD', 'other',   'high', NULL,       '{}',               'extraction');
INSERT INTO document_links (document_id, transaction_id) VALUES ('$DOC', '$TX');
INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
  VALUES (gen_random_uuid(), '$WS', '$TX', 'created', '$USR', '{}');
INSERT INTO transaction_parties (workspace_id, transaction_id, transaction_item_id, role, display_name)
  VALUES ('$WS', '$TX', NULL, 'merchant', 'Smoke Store');
INSERT INTO owned_items (workspace_id, product_id, transaction_item_id, notes)
  VALUES ('$WS', '$PRODUCT', '$ITEM1', 'original');
INSERT INTO wish_items (workspace_id, product_id, title, status, converted_transaction_id)
  VALUES ('$WS', '$PRODUCT', 'Smoke wish', 'converted', '$TX');
COMMIT;
SQL

# 1. Snapshot captures every table it claims to.
bash "$HERE/tx-snapshot.sh" "$TX" >/dev/null || fail "tx-snapshot.sh exited non-zero"
BEFORE="$SNAPSHOT_DIR/before.json"
cp "$SNAPSHOT_DIR/$TX.json" "$BEFORE"
for key in transactions postings transaction_items document_links transaction_events \
           transaction_parties wish_items owned_items documents products; do
  jq -e --arg k "$key" '.[$k] | type == "array" and length > 0' "$BEFORE" >/dev/null \
    || fail "snapshot key '$key' is empty — the seeded row was not captured"
done

# 2. Damage it the way a re-extract does (plus the rows a re-extract leaves
#    alone, so the restore of those is exercised too).
psql_q <<SQL
BEGIN;
UPDATE transactions SET payee = 'DAMAGED' WHERE id = '$TX';
UPDATE transaction_items SET retired_at = NOW() WHERE transaction_id = '$TX';
INSERT INTO transaction_items (id, workspace_id, transaction_id, line_no, raw_name, line_total_minor,
                               currency, item_class, confidence, extraction_run)
  VALUES (gen_random_uuid(), '$WS', '$TX', 1, 'DAMAGED', 1334, 'USD', 'other', 'low', 2);
DELETE FROM transaction_parties WHERE transaction_id = '$TX';
UPDATE owned_items SET notes = 'DAMAGED' WHERE transaction_item_id = '$ITEM1';
UPDATE wish_items SET title = 'DAMAGED' WHERE converted_transaction_id = '$TX';
INSERT INTO transaction_events (id, workspace_id, transaction_id, event_type, actor_id, payload)
  VALUES (gen_random_uuid(), '$WS', '$TX', 're_extracted', '$USR', '{}');
COMMIT;
SQL

# 3. A dry run completes and changes nothing.
bash "$HERE/tx-restore.sh" "$TX" dryrun >/dev/null || fail "tx-restore.sh dryrun exited non-zero"
[ "$(psql_q -c "SELECT payee FROM transactions WHERE id = '$TX'")" = "DAMAGED" ] \
  || fail "dryrun modified the transaction"

# 4. A committed restore puts back exactly what the snapshot captured.
bash "$HERE/tx-restore.sh" "$TX" commit >/dev/null || fail "tx-restore.sh commit exited non-zero"
bash "$HERE/tx-snapshot.sh" "$TX" >/dev/null || fail "post-restore tx-snapshot.sh exited non-zero"
diff <(canon "$BEFORE") <(canon "$SNAPSHOT_DIR/$TX.json") \
  || fail "restored state differs from the snapshot (diff above: < before, > after)"

# 5. A failed snapshot leaves no file behind.
GHOST="$(uuidgen | lower)"
if PG_DB="no_such_database" bash "$HERE/tx-snapshot.sh" "$GHOST" >/dev/null 2>&1; then
  fail "tx-snapshot.sh claimed success against a database that does not exist"
fi
[ -z "$(find "$SNAPSHOT_DIR" -name "*$GHOST*")" ] \
  || fail "a failed snapshot left a file behind: $(find "$SNAPSHOT_DIR" -name "*$GHOST*")"

echo "smoke-tx-snapshot: PASS (tx $TX, snapshots in $SNAPSHOT_DIR)"
