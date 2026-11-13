#!/usr/bin/env bash
# sandbox-reset.sh: return the sandbox stack (docker-compose.test.yml) to an
# empty ledger without restarting it.
#
# Run it at the START of every eval, harness or frontend-test session. It
# takes about a second; the stack stays up and keeps serving afterwards.
#
# What it clears
#   - Every table in the `public` schema except the scaffolding below. The
#     list is read from the catalog at run time, so a table added by a
#     later migration is cleared without anyone editing this file.
#   - Scaffolding rows that belong to any workspace or user other than the
#     seeded ones.
#   - Everything under the sandbox's /data directory
#     (~/Developer/receipt-assistant-data/test-uploads/): uploads, static
#     maps, brand and product icons, lesson proposals. Moved to the Trash,
#     not deleted. The four directories the app expects are recreated empty.
#
# What it keeps (scaffolding)
#   What a boot leaves in an empty database, and nothing else. The app only
#   creates these at boot, so clearing them would break it until a restart:
#     users, workspaces, workspace_members, accounts, points_valuations
#         written by src/db/seed.ts, which src/server.ts calls at boot and
#         which does nothing once the seed workspace exists
#     points_programmes
#         reference rows inserted by drizzle/0039_points_seed.sql; a
#         migration never runs twice, so nothing would put them back
#   The migration ledger lives in the `drizzle` schema and is never touched.
#   A migration that seeds reference rows into a NEW table must add that
#   table to `keep` below, or this script will empty it.
#
# What it does not do
#   - It cannot tell a seeded account from one a test or an agent added to
#     the seed workspace, because seeded rows carry no marker. Accounts,
#     valuations and programmes in the seed workspace survive as they are,
#     edits included. The summary line prints their counts (at migration
#     0039 a fresh boot gives accounts=19 points_valuations=1
#     points_programmes=1). For a factory-fresh database, rebuild it; boot
#     migrates and seeds:
#       docker compose -f docker-compose.test.yml down
#       mv ~/Developer/receipt-assistant-data/test-postgres ~/.Trash/test-postgres-$(date +%Y%m%d-%H%M%S)
#       mkdir -p ~/Developer/receipt-assistant-data/test-postgres
#       docker compose -f docker-compose.test.yml up -d --build
#   - It does not wait for running extractions. An agent still in flight
#     writes its rows after the reset. The script warns when it sees queued
#     or processing ingests; let them finish and run it again.
#   - It leaves the sandbox's Claude state alone
#     (~/Developer/receipt-assistant-data/test-claude/): the transcripts of
#     the runs you just made are usually what you want to read next.
#   - It leaves per-ingest scratch directories in the app container's /tmp.
#     They are keyed by ingest id, never reused, and go with the container.
#
# Safety
#   Refuses to run against production: by container name, by compose
#   project, and by what the container and the data directory actually
#   are on disk. See the guards below.
#
# Usage (from anywhere; paths are absolute):
#   ./scripts/sandbox-reset.sh                 # database + files
#   ./scripts/sandbox-reset.sh --keep-uploads  # database only, leave files
#
# Environment:
#   SANDBOX_PG_CONTAINER   postgres container   (default receipts-test-postgres)
#   SANDBOX_UPLOADS_DIR    host dir behind /data (default ~/Developer/receipt-assistant-data/test-uploads)

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

refuse() {
  echo "REFUSING: $1" >&2
  echo "         this script only ever resets the sandbox (docker-compose.test.yml)." >&2
  exit 1
}

# A host path is production's when it is inside ~/Documents (the iCloud
# project notebook, where production's uploads live) or inside
# ~/Developer/receipt-assistant-data/ and not a `test-*` directory. That
# prefix is the naming rule docker-compose.test.yml follows for every mount.
# A directory that CONTAINS either of those (~, ~/Developer, /) counts too:
# clearing it would sweep production along.
HOME_REAL="$(cd "$HOME" && pwd -P)"
is_production_path() {
  local p="${1%/}" home data_root
  for home in "$HOME" "$HOME_REAL"; do
    data_root="$home/Developer/receipt-assistant-data"
    case "$p" in
      "$home/Documents"|"$home/Documents"/*) return 0 ;;
      "$data_root") return 0 ;;
      "$data_root"/test-*) ;;
      "$data_root"/*) return 0 ;;
    esac
    case "$data_root/" in "$p"/*) return 0 ;; esac
    case "$home/Documents/" in "$p"/*) return 0 ;; esac
  done
  return 1
}

# ── Guard 1: the production container name ─────────────────────────────
# Refuse even if someone hand-overrides SANDBOX_PG_CONTAINER.
if [[ "$CONTAINER" == "receipts-postgres" ]]; then
  refuse "container name 'receipts-postgres' is the production database."
fi

# ── Guard 2: the data directory ────────────────────────────────────────
# Checked as given and with symlinks resolved: ~/Developer/2026_Dev_ReceiptAssistant
# is a symlink into the iCloud notebook that holds production's uploads.
if [[ $KEEP_UPLOADS -eq 0 ]]; then
  if is_production_path "$UPLOADS_DIR"; then
    refuse "'$UPLOADS_DIR' is a production data directory."
  fi
  if [[ -d "$UPLOADS_DIR" ]]; then
    RESOLVED_UPLOADS_DIR="$(cd "$UPLOADS_DIR" && pwd -P)"
    if is_production_path "$RESOLVED_UPLOADS_DIR"; then
      refuse "'$UPLOADS_DIR' resolves to '$RESOLVED_UPLOADS_DIR', a production data directory."
    fi
  fi
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "sandbox container '$CONTAINER' is not running." >&2
  echo "bring it up first:" >&2
  echo "  docker compose -f docker-compose.test.yml up -d" >&2
  exit 1
fi

# ── Guard 3: what the container really is ──────────────────────────────
# A renamed or re-created production database would get past guard 1. Its
# compose project and the directory it stores data in would not.
PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$CONTAINER" 2>/dev/null || true)"
if [[ "$PROJECT" == "receipt-assistant" ]]; then
  refuse "container '$CONTAINER' belongs to compose project 'receipt-assistant' (production)."
fi
while IFS= read -r src; do
  [[ -z "$src" ]] && continue
  if is_production_path "$src"; then
    refuse "container '$CONTAINER' stores data in '$src', a production directory."
  fi
done < <(docker inspect -f '{{ range .Mounts }}{{ println .Source }}{{ end }}' "$CONTAINER")

echo "[sandbox-reset] clearing user data in ${CONTAINER}…"

# -i is load-bearing: without it the heredoc never reaches psql, which
# exits 0 having cleared NOTHING, and the script silently no-ops while
# printing "done" (bit us 2026-06-11; the "clean" sandboxes that round
# were clean only because the test pipeline ran its own TRUNCATE).
#
# The DO block is one statement, so one transaction: either every table is
# cleared or none is.
docker exec -i "$CONTAINER" psql -U postgres -d receipts -v ON_ERROR_STOP=1 -q <<'SQL'
DO $reset$
DECLARE
  -- Scaffolding tables. See the header for why each one is here.
  keep constant text[] := ARRAY[
    'users', 'workspaces', 'workspace_members', 'accounts',
    'points_valuations', 'points_programmes'
  ];
  -- SEED_WORKSPACE_ID / SEED_USER_ID in src/db/seed.ts. Every request runs
  -- as this pair (src/http/context.ts), so they are the only tenant the
  -- app needs.
  seed_workspace constant uuid := '00000000-0000-7000-8000-000000000002';
  seed_user      constant uuid := '00000000-0000-7000-8000-000000000001';
  missing   text;
  detail    text;
  targets   text;
  n_targets int;
  n         bigint;
  kept      text := '';
  tbl       text;
BEGIN
  -- A scaffolding name that does not exist means this list no longer
  -- matches the schema (a rename would leave the new table unprotected).
  SELECT string_agg(k, ', ') INTO missing
    FROM unnest(keep) AS k
   WHERE to_regclass(format('public.%I', k)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'scaffolding table(s) not found: %', missing
      USING HINT = 'Has the app booted against this database (boot runs the migrations)? '
                   'If a migration renamed the table, update `keep` in scripts/sandbox-reset.sh.';
  END IF;

  IF to_regclass('public.ingests') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM public.ingests WHERE status::text IN ('queued', 'processing')$q$ INTO n;
    IF n > 0 THEN
      RAISE WARNING '% ingest(s) were queued or processing. An extraction still running will write rows after this reset; let it finish and reset again.', n;
    END IF;
  END IF;

  SELECT string_agg(format('%I.%I', ns.nspname, c.relname), ', ' ORDER BY c.relname), count(*)
    INTO targets, n_targets
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relkind IN ('r', 'p')      -- tables and partitioned tables
     AND NOT c.relispartition         -- partitions go with their parent
     AND c.relname <> ALL (keep);

  IF targets IS NOT NULL THEN
    -- Fail instead of hanging behind an agent's open psql session.
    PERFORM set_config('lock_timeout', '30s', true);
    BEGIN
      -- One statement, no CASCADE: every foreign key between cleared
      -- tables is satisfied because both ends are in the list, and a key
      -- from a KEPT table into a cleared one is an error rather than a
      -- silent wipe of the scaffolding.
      EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY';
    EXCEPTION
      WHEN feature_not_supported THEN
        GET STACKED DIAGNOSTICS detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION 'cannot clear user data: % (%)', SQLERRM, detail
          USING HINT = 'A table that is not being cleared (scaffolding, or one outside `public`) '
                       'references a user-data table. Decide which side it belongs on and '
                       'update `keep` in scripts/sandbox-reset.sh.';
      WHEN lock_not_available THEN
        RAISE EXCEPTION 'cannot clear user data: a table stayed locked for 30s'
          USING HINT = 'An extraction or a request is mid-transaction. Let it finish and run the reset again.';
    END;
  END IF;

  -- Scaffolding is kept, but only the seeded tenant's. Deleting a
  -- workspace cascades to its accounts, memberships and valuations.
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = seed_workspace) THEN
    DELETE FROM public.workspaces WHERE id <> seed_workspace;
    DELETE FROM public.users
     WHERE id <> seed_user
       AND id NOT IN (SELECT owner_id FROM public.workspaces);
  ELSE
    RAISE WARNING 'seed workspace % not found; scaffolding left as it is. The app seeds it at boot: restart the sandbox app container.', seed_workspace;
  END IF;

  FOREACH tbl IN ARRAY keep LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
    kept := kept || format(' %s=%s', tbl, n);
  END LOOP;
  RAISE NOTICE 'cleared % table(s): %', n_targets, coalesce(targets, '(none)');
  RAISE NOTICE 'kept%', kept;
END
$reset$;
SQL

if [[ $KEEP_UPLOADS -eq 0 ]]; then
  echo "[sandbox-reset] clearing ${UPLOADS_DIR}…"
  mkdir -p "$UPLOADS_DIR"
  # Anything besides empty directories (what the previous reset left) counts
  # as content; without this every run would file four empty dirs in Trash.
  if [[ -n "$(find "$UPLOADS_DIR" -mindepth 1 -maxdepth 1 ! \( -type d -empty \) -print -quit)" ]]; then
    # Project rule: never `rm -rf`. Move contents to Trash so they're recoverable.
    STAMP=$(date +%Y%m%d-%H%M%S)
    TRASH_BUCKET="$HOME/.Trash/sandbox-uploads-$STAMP"
    mkdir -p "$TRASH_BUCKET"
    find "$UPLOADS_DIR" -mindepth 1 -maxdepth 1 -exec mv {} "$TRASH_BUCKET/" \;
    echo "[sandbox-reset] (moved old files to $TRASH_BUCKET)"
  fi
  # The layout production gets from four separate mounts. The sandbox's
  # /data is this one directory, so the reset is what puts them back.
  # prompt-lessons/ has to exist: the agent appends its lesson proposal
  # with `2>/dev/null || true`, so a missing directory loses it silently.
  mkdir -p "$UPLOADS_DIR/uploads" "$UPLOADS_DIR/brand-assets" \
           "$UPLOADS_DIR/product-assets" "$UPLOADS_DIR/prompt-lessons"
else
  echo "[sandbox-reset] (left ${UPLOADS_DIR} alone per --keep-uploads)"
fi

echo "[sandbox-reset] done."
