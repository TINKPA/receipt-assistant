#!/usr/bin/env bash
# check-sandbox-reset.sh: prove that sandbox-reset.sh keeps exactly what a
# boot writes.
#
# The reset finds the tables to clear in the catalog, but the tables to
# KEEP are a list written by hand (`keep` in sandbox-reset.sh). Nothing in
# the reset can tell when that list has fallen behind: a migration that
# seeds reference rows into a new table gets them truncated on the next
# reset, and nothing puts them back until the database is rebuilt.
#
# This boots an empty throwaway Postgres the way src/server.ts does
# (migrations, then seed), fingerprints every table, runs the real reset
# against it and fingerprints again. On a freshly booted database a reset
# must change nothing:
#   - a table that lost rows was filled by a migration or by the seed. It
#     is scaffolding: add it to `keep`.
#   - a kept table that a fresh boot leaves empty holds no scaffolding.
#     Keeping it only lets user data survive a reset: take it out of `keep`.
#
# Run it after adding a migration, and after touching src/db/seed.ts or
# the reset:
#   ./scripts/check-sandbox-reset.sh
#
# It starts its own postgres:17 container (random name, loopback port
# only) and removes it on exit. It touches no other container, and neither
# stack needs to be up. Takes well under a minute.
#
# Requires: docker, and the dev dependencies (`npm ci`) for tsx.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd -P)"
cd "$SCRIPTS/.."

NAME="receipts-reset-check-$$-$RANDOM"
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

say()  { echo "[check-sandbox-reset] $*"; }
fail() { echo "[check-sandbox-reset] FAIL: $*" >&2; exit 1; }

docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=receipts \
  -p 127.0.0.1::5432 docker.io/postgres:17 >/dev/null
PORT="$(docker port "$NAME" 5432 | head -1 | sed 's/.*://')"

# -h makes pg_isready ask over TCP. The image's first-run setup serves the
# unix socket only and then restarts, so the socket answers too early.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d receipts 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ $ready -eq 1 ]] || fail "postgres did not come up in 60s."

# What src/server.ts does at boot. dotenv never overrides a variable that
# is already set, so a DATABASE_URL in .env cannot redirect this.
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$PORT/receipts"
say "booting an empty database (migrations, then seed)…"
NODE_NO_WARNINGS=1 npx tsx scripts/migrate.ts >/dev/null
NODE_NO_WARNINGS=1 npx tsx scripts/seed.ts >/dev/null

# One line per table in `public`: name, row count, md5 over its rows.
fingerprint() {
  docker exec -i "$NAME" psql -U postgres -d receipts -At -F ' ' -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
         'SELECT %L, count(*), coalesce(md5(string_agg(t::text, chr(10) ORDER BY t::text)), ''-'') FROM public.%I t',
         c.relname, c.relname)
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
 WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
 ORDER BY c.relname
\gexec
SQL
}

BEFORE="$(fingerprint)"
SEEDED="$(echo "$BEFORE" | awk '$2 > 0 { printf " %s=%s", $1, $2 }')"
say "a fresh boot leaves rows in:${SEEDED:- (no table)}"

if ! RESET_OUT="$(SANDBOX_PG_CONTAINER="$NAME" "$SCRIPTS/sandbox-reset.sh" --keep-uploads 2>&1)"; then
  echo "$RESET_OUT" >&2
  fail "the reset refused or failed on a freshly booted database."
fi
AFTER="$(fingerprint)"

status=0

if [[ "$BEFORE" != "$AFTER" ]]; then
  status=1
  echo "[check-sandbox-reset] FAIL: the reset changed a freshly booted database." >&2
  echo "  table: rows before -> rows after" >&2
  awk 'NR == FNR { rows[$1] = $2; sum[$1] = $3; next }
       rows[$1] != $2 || sum[$1] != $3 {
         printf "  %s: %s -> %s%s\n", $1, rows[$1], $2, (rows[$1] == $2 ? " (different rows)" : "")
       }' <(echo "$BEFORE") <(echo "$AFTER") >&2
  echo "  Rows that a boot writes and a reset removes never come back while the" >&2
  echo "  stack runs. Add the table to \`keep\` in scripts/sandbox-reset.sh and to" >&2
  echo "  the scaffolding table in CLAUDE.md (\"Sandbox stack\")." >&2
fi

# The reset prints `kept name=count name=count …` for every table in `keep`.
KEPT="$(echo "$RESET_OUT" | sed -n 's/^NOTICE:  kept //p')"
[[ -n "$KEPT" ]] || fail "could not find the reset's 'kept' line in its output:
$RESET_OUT"
EMPTY_KEPT="$(echo "$KEPT" | tr ' ' '\n' | awk -F= '$2 == 0 { printf " %s", $1 }')"
if [[ -n "$EMPTY_KEPT" ]]; then
  status=1
  echo "[check-sandbox-reset] FAIL: kept, but empty after a fresh boot:$EMPTY_KEPT" >&2
  echo "  A table no boot writes to is user data. While it is in \`keep\`, whatever a" >&2
  echo "  test or an agent puts there survives every reset. Take it out." >&2
fi

[[ $status -eq 0 ]] || exit 1
say "kept: $KEPT"
say "PASS: a reset of a freshly booted database changes nothing."
