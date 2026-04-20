#!/bin/sh
set -e

# Claude Code OAuth credentials live in the `claude-code-config` named Docker
# volume mounted at /home/node/.claude (see docker-compose.yml). The container
# holds its own OAuth session, bootstrapped once via
# `docker exec -it receipt-assistant claude /login`. The in-container CLI
# self-refreshes on expiry and writes rotated tokens back into the volume.
# No env-var handoff or credentials synthesis — keep this entrypoint thin.

exec "$@"
