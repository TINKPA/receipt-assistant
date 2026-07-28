#!/usr/bin/env bash
# tx-restore.sh — put a transaction back the way `tx-snapshot.sh` found it.
#
# Usage:
#   ssh mini 'bash -s' -- <TX_UUID> dryrun < scripts/tx-restore.sh
#   ssh mini 'bash -s' -- <TX_UUID> commit < scripts/tx-restore.sh
#
# `dryrun` runs the whole restore inside a transaction and ROLLBACKs. Run
# it on one transaction BEFORE the campaign begins, not after a failure.
#
# Four things this has to get right, each learned the hard way:
#
#   1. `SET LOCAL session_replication_role = replica` suppresses the
#      `transactions_version_bump` and `transactions_updated_at` triggers,
#      so `version` / `updated_at` restore byte-exactly instead of drifting
#      forward on every restore.
#   2. Replica mode ALSO disables FK cascades, so children must be deleted
#      EXPLICITLY, in FK order. Skipping this is what produced a
#      `postings_pkey` duplicate on the first attempt at this script.
#   3. `transaction_items.effective_total_minor` is GENERATED — it cannot
#      appear in an INSERT column list, so the item insert names its
#      columns explicitly rather than using `jsonb_populate_record`'s
#      full row shape.
#   4. `SET CONSTRAINTS ALL IMMEDIATE` fires before COMMIT/ROLLBACK, so a
#      dry run actually exercises `postings_balance_ck`. Without it a plain
#      ROLLBACK gives false confidence — the deferred trigger never ran.
#
# Scope: restores the transaction and the rows that belong to it. It does
# NOT restore `products` aggregate columns (they are derived; re-run the
# recompute) and it does NOT restore `documents.ocr_text` unless
# RESTORE_DOCS=1, because ocr_text is usually what you WANT to keep.
set -euo pipefail

TX="${1:?usage: tx-restore.sh <TX_UUID> dryrun|commit}"
MODE="${2:?usage: tx-restore.sh <TX_UUID> dryrun|commit}"
case "$MODE" in
  dryrun) FINAL="ROLLBACK;" ;;
  commit) FINAL="COMMIT;"   ;;
  *) echo "tx-restore: mode must be dryrun or commit" >&2; exit 2 ;;
esac

SNAP="${SNAPSHOT_DIR:-$HOME/receipt-snapshots}/$TX.json"
PG_CONTAINER="${PG_CONTAINER:-receipts-postgres}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-receipts}"
RESTORE_DOCS="${RESTORE_DOCS:-0}"

[ -s "$SNAP" ] || { echo "tx-restore: no snapshot at $SNAP" >&2; exit 1; }

DOC_RESTORE=""
if [ "$RESTORE_DOCS" = "1" ]; then
  DOC_RESTORE=$(cat <<'DOCSQL'
  UPDATE documents d SET
    ocr_text          = s.ocr_text,
    ocr_model_version = s.ocr_model_version,
    updated_at        = s.updated_at
  FROM (
    SELECT * FROM jsonb_to_recordset((SELECT snap->'documents' FROM snapshot))
      AS x(id uuid, ocr_text text, ocr_model_version text, updated_at timestamptz)
  ) s
  WHERE d.id = s.id;
DOCSQL
)
fi

# The snapshot travels as a psql variable so no shell quoting touches the
# JSON body; :'snap' expands to a correctly-quoted SQL literal.
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" \
  -v "snap=$(cat "$SNAP")" -v "tx=$TX" <<SQL
BEGIN;
SET LOCAL session_replication_role = replica;

CREATE TEMP TABLE snapshot ON COMMIT DROP AS SELECT :'snap'::jsonb AS snap;

-- (2) explicit deletes, in FK order — replica mode disables cascades.
DELETE FROM owned_items         WHERE transaction_item_id IN (SELECT id FROM transaction_items WHERE transaction_id = :'tx');
DELETE FROM wish_items          WHERE transaction_item_id IN (SELECT id FROM transaction_items WHERE transaction_id = :'tx');
DELETE FROM transaction_parties WHERE transaction_id = :'tx';
DELETE FROM transaction_items   WHERE transaction_id = :'tx';
DELETE FROM transaction_events  WHERE transaction_id = :'tx';
DELETE FROM document_links      WHERE transaction_id = :'tx';
DELETE FROM postings            WHERE transaction_id = :'tx';
DELETE FROM transactions        WHERE id = :'tx';

INSERT INTO transactions
SELECT * FROM jsonb_populate_recordset(NULL::transactions, (SELECT snap->'transactions' FROM snapshot));

INSERT INTO postings
SELECT * FROM jsonb_populate_recordset(NULL::postings, (SELECT snap->'postings' FROM snapshot));

-- (3) effective_total_minor is GENERATED — explicit column list only.
INSERT INTO transaction_items (
  id, workspace_id, transaction_id, line_no, parent_line_no,
  raw_name, normalized_name, product_variant, quantity, unit,
  unit_price_minor, line_total_minor, currency,
  item_class, durability_tier, food_kind, tags, confidence,
  line_type, product_id, tax_minor, tip_share_minor, discount_share_minor,
  extraction_run, extraction_version, retired_at, created_at, updated_at
)
SELECT id, workspace_id, transaction_id, line_no, parent_line_no,
       raw_name, normalized_name, product_variant, quantity, unit,
       unit_price_minor, line_total_minor, currency,
       item_class, durability_tier, food_kind, tags, confidence,
       line_type, product_id, tax_minor, tip_share_minor, discount_share_minor,
       extraction_run, extraction_version, retired_at, created_at, updated_at
  FROM jsonb_to_recordset(COALESCE((SELECT snap->'transaction_items' FROM snapshot), '[]'::jsonb))
    AS x(id uuid, workspace_id uuid, transaction_id uuid, line_no int, parent_line_no int,
         raw_name text, normalized_name text, product_variant text, quantity numeric, unit text,
         unit_price_minor bigint, line_total_minor bigint, currency text,
         item_class text, durability_tier text, food_kind text, tags text[], confidence text,
         line_type text, product_id uuid, tax_minor bigint, tip_share_minor bigint,
         discount_share_minor bigint, extraction_run int, extraction_version text,
         retired_at timestamptz, created_at timestamptz, updated_at timestamptz);

INSERT INTO document_links
SELECT * FROM jsonb_populate_recordset(NULL::document_links, COALESCE((SELECT snap->'document_links' FROM snapshot), '[]'::jsonb));

INSERT INTO transaction_events
SELECT * FROM jsonb_populate_recordset(NULL::transaction_events, COALESCE((SELECT snap->'transaction_events' FROM snapshot), '[]'::jsonb));

INSERT INTO transaction_parties
SELECT * FROM jsonb_populate_recordset(NULL::transaction_parties, COALESCE((SELECT snap->'transaction_parties' FROM snapshot), '[]'::jsonb));

INSERT INTO owned_items
SELECT * FROM jsonb_populate_recordset(NULL::owned_items, COALESCE((SELECT snap->'owned_items' FROM snapshot), '[]'::jsonb));

INSERT INTO wish_items
SELECT * FROM jsonb_populate_recordset(NULL::wish_items, COALESCE((SELECT snap->'wish_items' FROM snapshot), '[]'::jsonb));

$DOC_RESTORE

-- (4) force the DEFERRABLE balance triggers so a dry run means something.
SET CONSTRAINTS ALL IMMEDIATE;

SELECT (SELECT count(*) FROM postings WHERE transaction_id = :'tx')          AS postings,
       (SELECT sum(amount_base_minor) FROM postings WHERE transaction_id = :'tx') AS base_sum,
       (SELECT count(*) FROM transaction_items WHERE transaction_id = :'tx') AS items;

$FINAL
SQL

echo "tx-restore: $MODE complete for $TX"
if [ "$MODE" = "commit" ]; then
  echo "tx-restore: products aggregates are DERIVED and were not restored —"
  echo "            re-run the product recompute if any stat matters."
fi
