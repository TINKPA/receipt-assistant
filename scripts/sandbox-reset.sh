#!/usr/bin/env bash
# sandbox-reset.sh — wipe all test data without restarting the stack.
#
# Run this at the START of every frontend-test-runner session against the
# sandbox. ~1 second versus the ~30s a full `docker compose down -v && up -d`
# would take. The sandbox stack stays up between runs; only the data resets.
#
# What this clears:
#   • All rows in transactions / receipts / batches / jobs / brand_assets /
#     brands / merchants / products / documents (anything user-data-shaped)
#   • Everything under ~/Developer/receipt-assistant-data/test-uploads/
#
# What this leaves alone:
#   • The postgres schema (drizzle migrations stay applied)
#   • The container itself, its env vars, the OAuth credentials mount
#   • Brand-assets cache (icons are content-addressable, safe to keep
#     between runs — re-fetching every run wastes Anthropic API calls)
#
# Usage (from anywhere; paths are absolute):
#   ./scripts/sandbox-reset.sh                 # full reset
#   ./scripts/sandbox-reset.sh --keep-uploads  # just truncate DB, leave files

set -euo pipefail

CONTAINER="${SANDBOX_PG_CONTAINER:-receipts-test-postgres}"
UPLOADS_DIR="${SANDBOX_UPLOADS_DIR:-$HOME/Developer/receipt-assistant-data/test-uploads}"
KEEP_UPLOADS=0

for arg in "$@"; do
  case "$arg" in
    --keep-uploads) KEEP_UPLOADS=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Safety check: refuse to run against the production container even if
# someone hand-overrides SANDBOX_PG_CONTAINER. The whole point is isolation.
if [[ "$CONTAINER" == "receipts-postgres" ]]; then
  echo "REFUSING: container name 'receipts-postgres' looks like the production stack." >&2
  echo "         set SANDBOX_PG_CONTAINER to the sandbox container (default: receipts-test-postgres)." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "sandbox container '$CONTAINER' is not running." >&2
  echo "bring it up first:" >&2
  echo "  docker compose -p receipts-test -f docker-compose.test.yml up -d" >&2
  exit 1
fi

echo "[sandbox-reset] truncating tables in ${CONTAINER}…"

# TRUNCATE every user-data table. CASCADE follows FKs so order doesn't matter.
# RESTART IDENTITY resets sequences too.
docker exec "$CONTAINER" psql -U postgres -d receipts -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'transactions',
    'receipts',
    'documents',
    'batches',
    'jobs',
    'brand_assets',
    'brands',
    'merchants',
    'products'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=tbl) THEN
      EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', tbl);
      RAISE NOTICE 'truncated %', tbl;
    ELSE
      RAISE NOTICE 'skipped % (table not present)', tbl;
    END IF;
  END LOOP;
END $$;
SQL

if [[ $KEEP_UPLOADS -eq 0 ]]; then
  echo "[sandbox-reset] clearing ${UPLOADS_DIR}…"
  if [[ -d "$UPLOADS_DIR" ]]; then
    # Project rule: never `rm -rf`. Move contents to Trash so they're recoverable.
    STAMP=$(date +%Y%m%d-%H%M%S)
    TRASH_BUCKET="$HOME/.Trash/sandbox-uploads-$STAMP"
    mkdir -p "$TRASH_BUCKET"
    # Handle empty dir (no files to move) without erroring.
    if compgen -G "$UPLOADS_DIR/*" >/dev/null; then
      mv "$UPLOADS_DIR"/* "$TRASH_BUCKET/"
    fi
    if compgen -G "$UPLOADS_DIR/.*" >/dev/null 2>&1; then
      find "$UPLOADS_DIR" -mindepth 1 -maxdepth 1 -name '.*' -exec mv {} "$TRASH_BUCKET/" \; 2>/dev/null || true
    fi
    echo "[sandbox-reset] (moved old uploads to $TRASH_BUCKET)"
  else
    mkdir -p "$UPLOADS_DIR"
    echo "[sandbox-reset] (created $UPLOADS_DIR)"
  fi
else
  echo "[sandbox-reset] (skipped uploads dir per --keep-uploads)"
fi

echo "[sandbox-reset] done."
