# Verify Docker-first dev stack

Tracking checklist for end-to-end verification of the Docker-first dev
environment introduced in commit `9ba17c4` on branch
`claude/docker-testing-setup-V040p`.

The change unified the dev stack into a single root `docker-compose.yml`
+ multi-stage `Dockerfile` + `include: langfuse/docker-compose.yml`. So
far only `docker compose config --quiet` syntax validation has been run
— this document tracks the actual end-to-end verification.

## Verification checklist

### Startup

- [ ] `./scripts/refresh-token.sh` successfully extracts a token from
      the macOS Keychain and writes it into `.env`
- [ ] `.env` permissions are `600`
- [ ] `docker compose up -d --build` brings up all 7 services in one
      command (clickhouse, langfuse-web, langfuse-worker, minio,
      postgres, receipt-assistant, redis)
- [ ] `docker compose ps` shows every service as `healthy` / `running`
- [ ] With `CLAUDE_CODE_OAUTH_TOKEN` unset, `docker compose up` fails
      *immediately* (the `${VAR:?}` guard) rather than starting and
      crashing later

### Dockerfile multi-stage

- [ ] Builder stage: `npm ci` + `tsc` succeed
- [ ] Runtime stage contains only `dist/` + production `node_modules`,
      no tsc / `@types`
- [ ] Final image is smaller than the previous host-build version
      (`docker images receipt-assistant`)
- [ ] Editing one `.ts` file and rebuilding hits the `npm ci` layer
      cache and only re-runs `tsc`

### Service connectivity

- [ ] `curl http://localhost:3000/health` returns 200
- [ ] http://localhost:3333 (Langfuse) accepts login
      `admin@local.dev` / `admin123`
- [ ] receipt-assistant container resolves the `postgres` hostname
      (provided by the included langfuse compose)
- [ ] receipt-assistant container resolves `langfuse-web:3000`

### End-to-end

- [ ] `curl -X POST http://localhost:3000/receipt -F "image=@<sample>.jpeg"`
      returns a `jobId`
- [ ] `curl http://localhost:3000/jobs/<jobId>` reaches `status: done`
- [ ] `curl http://localhost:3000/receipt/<receiptId>` returns a
      structured result (merchant, date, total, items)
- [ ] A matching trace appears in Langfuse with both `phase-1/quick`
      and `phase-2/full` generations

### Restart & persistence

- [ ] `docker compose down && docker compose up -d` preserves data
      (the `receipt-data` named volume)
- [ ] `docker compose down -v` actually wipes the data

## Known risk points

1. **Shared postgres**: receipt-assistant connects to
   `postgresql://postgres:postgres@postgres:5432/receipts`, but the
   langfuse stack only auto-creates the `postgres` database. If the
   `receipts` database doesn't exist on first boot, the app will fail
   to connect. Mitigation: create it from `docker/entrypoint.sh` (e.g.
   `psql ... -c 'CREATE DATABASE receipts'` guarded by `IF NOT EXISTS`
   logic) or via a `postgres-init` sidecar.

2. **Native modules**: builder and runtime are both `node:22-bookworm`,
   so glibc and node ABI match. Still worth confirming `heic-convert`
   loads cleanly inside the runtime image — it depends on a WASM build
   of libheif which should be platform-independent, but verify.

3. **First-time image pull is heavy**: clickhouse + minio + langfuse
   together are roughly 2–3 GB. The first `up --build` will be slow;
   this is expected, not a regression.

## Rollback

```bash
git revert 9ba17c4
```

Drops back to the previous three-window workflow
(`cd langfuse && docker compose up` + hand-rolled `docker run`).
