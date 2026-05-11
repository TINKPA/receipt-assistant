#!/bin/sh
set -e

# Claude Code OAuth credentials live in a host bind-mount at
# ~/Developer/receipt-assistant-data/claude/, mounted into the container at
# /home/node/.claude (see docker-compose.yml). The container holds its own
# OAuth session, bootstrapped once via
# `docker exec -it receipt-assistant claude /login`. The in-container CLI
# self-refreshes on expiry and writes rotated tokens back into the bind path.
# No env-var handoff or credentials synthesis — keep this entrypoint thin.

exec "$@"
