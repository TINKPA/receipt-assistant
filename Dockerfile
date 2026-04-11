FROM node:22-bookworm

# Install build tools for native modules (better-sqlite3) + claude CLI
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Copy compiled output (build happens outside Docker)
COPY dist/ ./dist/
COPY CLAUDE.md ./
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

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "dist/server.js"]
