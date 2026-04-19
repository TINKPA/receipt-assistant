#!/bin/sh
set -e

# Claude Code OAuth credentials arrive via a volume-mounted .credentials.json
# (see docker-compose.yml). The CLI inside the container self-refreshes on
# expiry and writes the rotated tokens back to the mounted file. No env-var
# handoff or credentials synthesis here — keep this entrypoint thin.

exec "$@"
