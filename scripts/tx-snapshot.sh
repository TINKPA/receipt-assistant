#!/usr/bin/env bash
# tx-snapshot.sh — capture EVERYTHING that hangs off one transaction as a
# single jsonb blob, so a re-extract can be undone.
#
# A re-extract rewrites production rows in place and there is no undo. Take
# a snapshot before touching any production transaction, and dry-run the
# restore (`tx-restore.sh <TX> dryrun`) at least once BEFORE the campaign
# begins — not after something has already gone wrong.
#
# Usage (from the repo, targeting the mini):
#   ssh mini 'bash -s' < scripts/tx-snapshot.sh <TX_UUID>
#   scp mini:'~/receipt-snapshots/<TX_UUID>.json' ./snapshots/
#
# The mini's ~/receipt-snapshots is NOT backed up. Copy the file off the
# box before you rely on it.
#
# Requires: docker (OrbStack) on PATH — an ssh command must
# `source ~/.zprofile` first or docker is not found.
set -euo pipefail

TX="${1:?usage: tx-snapshot.sh <TX_UUID>}"
OUT_DIR="${SNAPSHOT_DIR:-$HOME/receipt-snapshots}"
PG_CONTAINER="${PG_CONTAINER:-receipts-postgres}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-receipts}"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$TX.json"

read -r -d '' SQL <<SQL || true
SELECT jsonb_pretty(jsonb_build_object(
  'transaction_id', '$TX'::text,
  'captured_at',    NOW()::text,
  'transactions',        (SELECT jsonb_agg(to_jsonb(t))  FROM transactions t        WHERE t.id = '$TX'),
  'postings',            (SELECT jsonb_agg(to_jsonb(p))  FROM postings p            WHERE p.transaction_id = '$TX'),
  'transaction_items',   (SELECT jsonb_agg(to_jsonb(ti)) FROM transaction_items ti  WHERE ti.transaction_id = '$TX'),
  'document_links',      (SELECT jsonb_agg(to_jsonb(dl)) FROM document_links dl     WHERE dl.transaction_id = '$TX'),
  'transaction_events',  (SELECT jsonb_agg(to_jsonb(te)) FROM transaction_events te WHERE te.transaction_id = '$TX'),
  'transaction_parties', (SELECT jsonb_agg(to_jsonb(tp)) FROM transaction_parties tp WHERE tp.transaction_id = '$TX'),
  'wish_items',          (SELECT jsonb_agg(to_jsonb(w))  FROM wish_items w
                            WHERE w.transaction_item_id IN (SELECT id FROM transaction_items WHERE transaction_id = '$TX')),
  'owned_items',         (SELECT jsonb_agg(to_jsonb(o))  FROM owned_items o
                            WHERE o.transaction_item_id IN (SELECT id FROM transaction_items WHERE transaction_id = '$TX')),
  'documents',           (SELECT jsonb_agg(to_jsonb(d))  FROM documents d
                            WHERE d.id IN (SELECT document_id FROM document_links WHERE transaction_id = '$TX')),
  'products',            (SELECT jsonb_agg(to_jsonb(pr)) FROM products pr
                            WHERE pr.id IN (SELECT DISTINCT product_id FROM transaction_items
                                             WHERE transaction_id = '$TX' AND product_id IS NOT NULL))
));
SQL

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -tA -c "$SQL" > "$OUT"

if [ ! -s "$OUT" ] || ! grep -q '"transactions"' "$OUT"; then
  echo "tx-snapshot: EMPTY or malformed snapshot for $TX — refusing to claim success" >&2
  exit 1
fi

echo "tx-snapshot: wrote $OUT ($(wc -c < "$OUT") bytes)"
echo "tx-snapshot: copy it OFF the box — $OUT_DIR is not backed up."
