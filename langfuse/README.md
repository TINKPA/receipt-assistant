# Langfuse Session Monitor

Self-hosted Langfuse + post-processing pipeline for monitoring
Claude Code `claude -p` sessions.

## Quick Start

```bash
cd langfuse/

# 1. Start Langfuse stack
docker compose up -d

# 2. Wait for ready (~30s)
curl http://localhost:3333/api/public/health

# 3. Ingest session JSONL files
uv run --with httpx ingest_sessions.py --dir ~/.claude/projects/<project-path>/

# 4. Open dashboard
open http://localhost:3333
```

## Credentials

| Service | URL | Login |
|---------|-----|-------|
| Langfuse Dashboard | http://localhost:3333 | admin@local.dev / admin123 |
| Langfuse API | http://localhost:3333/api/public | pk-receipt-local / sk-receipt-local |
| MinIO Console | http://localhost:9090 | minio / miniosecret |

## Architecture

```
~/.claude/projects/<project>/*.jsonl
        |
        v
  ingest_sessions.py     (post-processing, not real-time)
        |
        v
  Langfuse API (localhost:3333)
        |
        v
  ┌─────────────────────────────────────┐
  │  docker compose                     │
  │  ├── langfuse-web    (:3333)        │
  │  ├── langfuse-worker               │
  │  ├── postgres                      │
  │  ├── redis                         │
  │  ├── clickhouse                    │
  │  └── minio           (:9090)       │
  └─────────────────────────────────────┘
```

## What Gets Ingested

Each Claude Code session JSONL becomes a **trace** in Langfuse.
Each user→assistant turn becomes a **generation** with:

- Model name (e.g. `claude-opus-4-6`)
- Input/output text (truncated to 5000 chars)
- Token usage (input + cache_read, output)
- Latency (from session timestamps)
- Tool calls (Read, Edit, Bash, etc.)
- Cost (auto-calculated by Langfuse)

## Limitations

- **Not real-time**: sessions are ingested after the fact
- **Timestamps**: reflect when messages were recorded in the session,
  not API call start/end times
- **System prompt**: not stored in JSONL (injected at API call time)
- **Token counts**: cache_read_input_tokens are combined with
  input_tokens for the "input" usage field

## Shutdown

```bash
docker compose down        # stop containers, keep data
docker compose down -v     # stop and delete all data
```
