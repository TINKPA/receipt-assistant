# syntax=docker/dockerfile:1.6
#
# Multi-stage build for receipt-assistant.
#
#   builder  — installs full deps (incl. devDependencies), compiles TypeScript,
#              then prunes to production deps.
#   runtime  — minimal image that only contains dist/ + production node_modules
#              + the claude CLI.
#
# Both stages use node:22-bookworm so that native modules compiled in the
# builder stage are ABI-compatible with the runtime stage (same glibc, same
# node ABI).

# ---- Stage 1: builder ----
FROM node:22-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Install full deps first (cached layer as long as package*.json is unchanged)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and build
COPY .git ./.git
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY drizzle/ ./drizzle/
RUN npm run build

# Drop devDependencies so the runtime stage can copy a lean node_modules
RUN npm prune --production

# ---- Stage 2: runtime ----
FROM node:22-bookworm AS runtime

# Build tools kept for any on-demand native rebuilds; postgresql-client is
# handy for debugging (psql) and curl is used by healthchecks / entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        curl \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — invoked by src/claude.ts as a subprocess.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy compiled output and production node_modules from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Drizzle migrations (SQL files + journal) ship with the image — the
# migrate runner resolves `<app>/drizzle/` at boot to apply any pending
# schema changes. Committing these into the image is deliberate: it means
# the running container and the repo state at build time agree on schema.
COPY --from=builder /app/drizzle ./drizzle
COPY package.json CLAUDE.md ./
COPY docker/entrypoint.sh /app/docker/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV MCP_PORT=3001
ENV DB_PATH=/data/receipts.db
ENV UPLOAD_DIR=/data/uploads
ENV HOME=/home/node

RUN mkdir -p /data/uploads /home/node/.claude && \
    chown -R node:node /data /home/node /app

USER node

EXPOSE 3000 3001
VOLUME ["/data"]

# depends_on: service_healthy in docker-compose.yml relies on this.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "dist/server.js"]
