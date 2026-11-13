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
#   scripts/check-sandbox-reset.sh proves the list against a fresh boot;
#   run it after adding a migration.
#
# What it does not do
#   - It does not put the scaffolding tables back to what a boot wrote.
#     Seeded rows carry no marker, so the script cannot tell them from
#     later ones. What survives a reset besides the seed:
#       accounts, points_valuations   rows added to the seed workspace, and
#           any edit to a seeded row. The extraction agent adds a points
#           account the first time it sees a programme; a frontend test
#           may add, rename or close accounts.
#       points_programmes   every row. The table is global (it has no
#           workspace column), so programmes a test inserted stay too;
#           scripts/smoke-points.ts adds two.
#       users, workspaces   edits to the seed user and the seed workspace
#           row (its name, its base currency).
#     The summary line prints the counts (at migration 0039 a fresh boot
#     gives accounts=19 points_valuations=1 points_programmes=1). For a
#     factory-fresh database, rebuild it; boot migrates and seeds:
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
# Running it while the stack is busy
#   Meant for a quiet stack, but safe on a busy one and never half done:
#   the tables are cleared in one transaction or not at all. Two resets
#   started together run one after the other. A reset waits for a request
#   that holds a table it needs, and tries again when Postgres calls the
#   two a deadlock; if it still does not hold every table after 30 s it
#   gives up with exit 3 and nothing cleared.
#   The requests are the ones that lose. One that is mid-flight when its
#   rows vanish fails: a 404, a foreign-key error, now and then a deadlock
#   error of its own. Uploads made during a reset are not worth keeping.
#
# Safety
#   Refuses to run against production: by container name, by compose
#   project, and by what the container and the data directory actually
#   are on disk. The data directory must also be NAMED `test-*`, the rule
#   every mount in docker-compose.test.yml follows. See the guards below.
#
# Usage (from anywhere; paths are absolute):
#   ./scripts/sandbox-reset.sh                 # database + files
#   ./scripts/sandbox-reset.sh --keep-uploads  # database only, leave files
#
# Exit status: 0 done; 1 refused, or the container is not running;
# 2 bad argument; 3 the database step failed (nothing was cleared);
# 4 the file step failed (the database is already cleared).
#
# Environment:
#   SANDBOX_PG_CONTAINER   postgres container   (default receipts-test-postgres)
#   SANDBOX_UPLOADS_DIR    host dir behind /data (default ~/Developer/receipt-assistant-data/test-uploads)
#                          must be a directory named test-*

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

# ── What counts as production on disk ──────────────────────────────────
# A host path is production's when it is inside ~/Documents (the iCloud
# project notebook, where production's uploads live) or inside
# ~/Developer/receipt-assistant-data/ and not under a `test-*` directory.
# That prefix is the naming rule docker-compose.test.yml follows for every
# mount. A directory that CONTAINS either of those (~, ~/Developer, /)
# counts too: clearing it would sweep production along.
DATA_ROOT="$HOME/Developer/receipt-assistant-data"
DOCS_ROOT="$HOME/Documents"
HOME_REAL="$(cd "$HOME" && pwd -P)"

# Judges one spelling of a path. Takes an absolute path; the directory
# need not exist. Callers want is_production below, which also judges the
# path with its symlinks resolved.
is_production_path() {
  local p="$1" a child home data_root root
  # The root contains everything. A relative path, or one with `.` or `..`
  # in it, cannot be judged by walking up its spelling, so it is refused
  # too: callers pass absolute, cleaned paths.
  [[ "$p" == "/" || "$p" != /* ]] && return 0
  p="${p%/}"
  case "$p/" in */../*|*/./*) return 0 ;; esac

  # 1. By spelling. The only check that can speak for a directory that
  #    does not exist yet.
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

  # 2. By identity. `-ef` compares device and inode, so no spelling gets
  #    past it: on the case-insensitive volume a Mac boots from,
  #    ~/developer/receipt-assistant-data/claude IS production's Claude
  #    directory, and `pwd -P` hands the path back in the case it was
  #    typed. Symlinks and firmlinks land on the same inode as well.
  #    Walk up from the path; the component just below the data root has
  #    to be a `test-*` name.
  a="$p"; child=""
  while :; do
    if [[ -e "$a" ]]; then
      [[ "$a" -ef "$DOCS_ROOT" ]] && return 0
      if [[ "$a" -ef "$DATA_ROOT" ]]; then
        case "$child" in test-*) ;; *) return 0 ;; esac
      fi
    fi
    [[ "$a" == "/" ]] && break
    child="${a##*/}"
    a="${a%/*}"; a="${a:-/}"
  done

  # 3. A directory production lives somewhere inside.
  if [[ -e "$p" ]]; then
    for root in "$DATA_ROOT" "$DOCS_ROOT"; do
      a="$root"
      while :; do
        [[ "$p" -ef "$a" ]] && return 0
        [[ "$a" == "/" ]] && break
        a="${a%/*}"; a="${a:-/}"
      done
    done
  fi
  return 1
}

# The physical path of a directory that may not exist yet: its deepest
# existing ancestor with symlinks resolved, then the rest as given. Takes
# an absolute path without `..` (a missing component followed by `..`
# cannot be resolved before it is created).
physical_path() {
  local p="$1" rest="" real
  [[ "$p" == /* ]] || return 1
  while [[ ! -d "$p" ]]; do
    rest="/${p##*/}$rest"
    p="${p%/*}"; p="${p:-/}"
  done
  real="$(cd "$p" 2>/dev/null && pwd -P)" || return 1
  real="${real%/}$rest"
  printf '%s\n' "${real:-/}"
}

# A path is judged twice: as given, and with its symlinks resolved. A
# symlink can land in the MIDDLE of a production tree
# (~/Developer/2026_Dev_ReceiptAssistant points into the iCloud notebook
# that holds production's uploads), and walking up the given spelling from
# there never passes ~/Documents. The resolved path has no such shortcut.
# A path that cannot be resolved is treated as production.
is_production() {
  local p="$1" real
  is_production_path "$p" && return 0
  real="$(physical_path "$p")" || return 0
  is_production_path "$real"
}

# Deny, then allow. The deny rule is what keeps production safe; the name
# rule covers every directory the deny rule has never heard of
# (~/Desktop/RECEIPT, the repo checkout, a home directory). Takes a
# physical path.
check_uploads_dir() {
  local p="$1"
  if is_production "$p"; then
    refuse "'$UPLOADS_DIR' is '$p': a production data directory, or a parent of one."
  fi
  case "${p##*/}" in
    test-*) ;;
    *) refuse "'$UPLOADS_DIR' is '$p', which is not named test-*. Everything in the data directory is moved to the Trash, so it has to be a directory made for the sandbox." ;;
  esac
}

# ── Guard 1: the production container name ─────────────────────────────
# Refuse even if someone hand-overrides SANDBOX_PG_CONTAINER.
if [[ "$CONTAINER" == "receipts-postgres" ]]; then
  refuse "container name 'receipts-postgres' is the production database."
fi

# ── Guard 2: the data directory ────────────────────────────────────────
# Judged before anything is touched, and once more after `mkdir` in the
# file step below.
if [[ $KEEP_UPLOADS -eq 0 ]]; then
  [[ "$UPLOADS_DIR" == /* ]] || UPLOADS_DIR="$PWD/$UPLOADS_DIR"
  # Tidy the spelling: `//`, `/./` and a trailing `/.` or `/` mean nothing.
  while [[ "$UPLOADS_DIR" == *//* ]]; do UPLOADS_DIR="${UPLOADS_DIR//\/\//\/}"; done
  while [[ "$UPLOADS_DIR" == */./* ]]; do UPLOADS_DIR="${UPLOADS_DIR//\/.\//\/}"; done
  while [[ "$UPLOADS_DIR" == */. ]]; do UPLOADS_DIR="${UPLOADS_DIR%/.}"; done
  [[ "$UPLOADS_DIR" == "/" ]] || UPLOADS_DIR="${UPLOADS_DIR%/}"
  [[ -n "$UPLOADS_DIR" ]] || UPLOADS_DIR="/"
  case "$UPLOADS_DIR/" in
    */../*) refuse "'$UPLOADS_DIR' has '..' in it. Give the directory's own path." ;;
  esac
  if is_production "$UPLOADS_DIR"; then
    refuse "'$UPLOADS_DIR' is a production data directory, or a parent of one."
  fi
  UPLOADS_PHYSICAL="$(physical_path "$UPLOADS_DIR")" \
    || refuse "'$UPLOADS_DIR' cannot be resolved."
  check_uploads_dir "$UPLOADS_PHYSICAL"
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
  if is_production "$src"; then
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
  -- Seconds to wait for the tables before giving up.
  patience  constant int := 30;
  busy_hint constant text :=
    'An extraction or a request is mid-transaction. Let it finish and run the reset again.';
  deadline  timestamptz;
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

  SELECT string_agg(format('%I.%I', ns.nspname, c.relname), ', ' ORDER BY c.relname), count(*)
    INTO targets, n_targets
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relkind IN ('r', 'p')      -- tables and partitioned tables
     AND NOT c.relispartition         -- partitions go with their parent
     AND c.relname <> ALL (keep);

  IF targets IS NOT NULL THEN
    -- Take every table lock before reading or writing any user table.
    -- Nothing above this line may touch one. Counting in-flight ingests
    -- first, as this script once did, leaves two resets started together
    -- each holding `ingests` and waiting for a table the other has, and
    -- Postgres ends that by killing one of them as a deadlock.
    --
    -- A request can still hold a later table in the list and want an
    -- earlier one. That deadlock costs the reset one attempt, not the
    -- run: leaving the inner block gives back every lock it took, the
    -- request finishes, and the reset tries again until `patience` is up.
    deadline := clock_timestamp() + make_interval(secs => patience);
    LOOP
      BEGIN
        -- Fail instead of hanging behind an agent's open psql session.
        PERFORM set_config(
          'lock_timeout',
          greatest(1, ceil(extract(epoch FROM deadline - clock_timestamp()) * 1000))::bigint || 'ms',
          true);
        EXECUTE 'LOCK TABLE ' || targets || ' IN ACCESS EXCLUSIVE MODE';
        EXIT;
      EXCEPTION
        WHEN deadlock_detected THEN
          IF clock_timestamp() >= deadline THEN
            RAISE EXCEPTION 'cannot clear user data: still deadlocking with other sessions after %s', patience
              USING HINT = busy_hint;
          END IF;
          PERFORM pg_sleep(0.05 + random() * 0.1);
        WHEN lock_not_available THEN
          RAISE EXCEPTION 'cannot clear user data: a table stayed locked for %s', patience
            USING HINT = busy_hint;
      END;
    END LOOP;

    -- Read under the locks just taken: no request can be mid-write, so
    -- this is exactly what the reset is about to erase.
    IF to_regclass('public.ingests') IS NOT NULL THEN
      EXECUTE $q$SELECT count(*) FROM public.ingests WHERE status::text IN ('queued', 'processing')$q$ INTO n;
      IF n > 0 THEN
        RAISE WARNING '% ingest(s) were queued or processing. An extraction still running will write rows after this reset; let it finish and reset again.', n;
      END IF;
    END IF;
  END IF;

  -- The tables are held now; what is left can only wait on a row of a
  -- scaffolding table.
  PERFORM set_config('lock_timeout', patience || 's', true);
  BEGIN
    IF targets IS NOT NULL THEN
      -- One statement, no CASCADE: every foreign key between cleared
      -- tables is satisfied because both ends are in the list, and a key
      -- from a KEPT table into a cleared one is an error rather than a
      -- silent wipe of the scaffolding.
      EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY';
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
  EXCEPTION
    WHEN feature_not_supported THEN
      GET STACKED DIAGNOSTICS detail = PG_EXCEPTION_DETAIL;
      RAISE EXCEPTION 'cannot clear user data: % (%)', SQLERRM, detail
        USING HINT = 'A table that is not being cleared (scaffolding, or one outside `public`) '
                     'references a user-data table. Decide which side it belongs on and '
                     'update `keep` in scripts/sandbox-reset.sh.';
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'cannot clear user data: a scaffolding row stayed locked for %s', patience
        USING HINT = busy_hint;
    WHEN deadlock_detected THEN
      RAISE EXCEPTION 'cannot clear user data: deadlocked with another session (%)', SQLERRM
        USING HINT = busy_hint;
  END;

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
  # Judge the directory that is really there now. Everything below works on
  # this path and no other.
  UPLOADS_REAL="$(cd "$UPLOADS_DIR" && pwd -P)"
  check_uploads_dir "$UPLOADS_REAL"

  # Anything besides empty directories (what the previous reset left) counts
  # as content; without this every run would file four empty dirs in Trash.
  if [[ -n "$(find "$UPLOADS_REAL" -mindepth 1 -maxdepth 1 ! \( -type d -empty \) -print -quit)" ]]; then
    # Project rule: never `rm -rf`. Move contents to Trash so they're
    # recoverable. The bucket is this run's alone (two resets in the same
    # second used to share one, and the second `mv uploads` failed on the
    # first one's directory).
    mkdir -p "$HOME/.Trash"
    TRASH_BUCKET="$(mktemp -d "$HOME/.Trash/sandbox-uploads-$(date +%Y%m%d-%H%M%S).XXXXXX")"
    # One `mv` per entry, each one checked: `find -exec mv {} dir \;` hid
    # failures and the script printed "done" with files still in place. An
    # entry another reset moved first is not a failure.
    while IFS= read -r -d '' entry; do
      if ! mv "$entry" "$TRASH_BUCKET/"; then
        if [[ -e "$entry" || -L "$entry" ]]; then
          echo "[sandbox-reset] FAILED to move '$entry' to the Trash. The database is cleared; the data directory is not." >&2
          exit 4
        fi
      fi
    done < <(find "$UPLOADS_REAL" -mindepth 1 -maxdepth 1 -print0)
    if rmdir "$TRASH_BUCKET" 2>/dev/null; then
      echo "[sandbox-reset] (nothing left to move)"
    else
      echo "[sandbox-reset] (moved old files to $TRASH_BUCKET)"
    fi
  fi
  # The layout production gets from four separate mounts. The sandbox's
  # /data is this one directory, so the reset is what puts them back.
  # prompt-lessons/ has to exist: the agent appends its lesson proposal
  # with `2>/dev/null || true`, so a missing directory loses it silently.
  mkdir -p "$UPLOADS_REAL/uploads" "$UPLOADS_REAL/brand-assets" \
           "$UPLOADS_REAL/product-assets" "$UPLOADS_REAL/prompt-lessons"
else
  echo "[sandbox-reset] (left ${UPLOADS_DIR} alone per --keep-uploads)"
fi

echo "[sandbox-reset] done."
