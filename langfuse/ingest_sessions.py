"""Ingest Claude Code session JSONL files into Langfuse as traces.

Usage:
    uv run --with httpx ingest_sessions.py <session.jsonl> [<session2.jsonl> ...]
    uv run --with httpx ingest_sessions.py --dir <sessions_directory>

Env vars (defaults for local docker-compose):
    LANGFUSE_PUBLIC_KEY  (default: pk-receipt-local)
    LANGFUSE_SECRET_KEY  (default: sk-receipt-local)
    LANGFUSE_HOST        (default: http://localhost:3333)
"""
import json
import os
import sys
import glob
import uuid
from datetime import datetime, timezone

import httpx

PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY", "pk-receipt-local")
SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY", "sk-receipt-local")
HOST = os.environ.get("LANGFUSE_HOST", "http://localhost:3333")


def parse_ts(ts) -> str:
    """Normalize timestamp to ISO 8601 string."""
    if isinstance(ts, str):
        return ts
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def get_user_text(msg: dict) -> str:
    content = msg.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if b.get("type") == "text")
    return ""


def get_assistant_text(msg: dict) -> str:
    content = msg.get("message", {}).get("content", [])
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if b.get("type") == "text")


def get_tool_names(msg: dict) -> list:
    content = msg.get("message", {}).get("content", [])
    if isinstance(content, str):
        return []
    return [b.get("name", "") for b in content if b.get("type") == "tool_use"]


def send_batch(events: list):
    """Send a batch of ingestion events to Langfuse."""
    resp = httpx.post(
        f"{HOST}/api/public/ingestion",
        json={"batch": events},
        auth=(PUBLIC_KEY, SECRET_KEY),
        timeout=30,
    )
    data = resp.json()
    if data.get("errors"):
        for err in data["errors"]:
            print(f"    Langfuse error: {err}")


def ingest_session(filepath: str):
    """Ingest a single session JSONL into Langfuse."""
    messages = []
    session_id = None

    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            messages.append(msg)
            if not session_id and msg.get("sessionId"):
                session_id = msg["sessionId"]

    if not session_id:
        session_id = os.path.basename(filepath).replace(".jsonl", "")

    # Extract project from path
    project = None
    parts = filepath.split("/projects/")
    if len(parts) > 1:
        project = parts[1].rsplit("/", 1)[0]

    # Gather metadata
    first_user = ""
    first_ts = None
    model = None
    slug = None
    total_input = 0
    total_output = 0

    for msg in messages:
        if msg.get("type") == "user" and not first_user:
            first_user = get_user_text(msg)[:200]
            first_ts = msg.get("timestamp")
        if msg.get("type") == "assistant":
            m = msg.get("message", {}).get("model")
            if not model and m and m != "<synthetic>":
                model = m
            if not slug:
                slug = msg.get("slug")
            usage = msg.get("message", {}).get("usage", {})
            total_input += usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
            total_output += usage.get("output_tokens", 0)

    trace_name = slug or first_user[:80] or session_id[:12]

    # Find last assistant output
    last_output = ""
    for msg in reversed(messages):
        if msg.get("type") == "assistant":
            last_output = get_assistant_text(msg)
            if last_output:
                break

    # Build batch events
    events = []

    # 1. Create trace
    events.append({
        "id": str(uuid.uuid4()),
        "type": "trace-create",
        "timestamp": parse_ts(first_ts) if first_ts else datetime.now(timezone.utc).isoformat(),
        "body": {
            "id": session_id,
            "name": trace_name,
            "sessionId": session_id,
            "input": first_user,
            "output": last_output[:2000] if last_output else None,
            "tags": ["claude-code", project or "unknown"],
            "metadata": {
                "project": project,
                "model": model,
                "source": "claude-code-session",
                "total_input_tokens": total_input,
                "total_output_tokens": total_output,
            },
        },
    })

    # 2. Create generations for each user→assistant turn
    turn = 0
    for i, msg in enumerate(messages):
        if msg.get("type") != "user" or msg.get("message", {}).get("role") != "user":
            continue
        user_text = get_user_text(msg)
        if not user_text:
            continue

        user_ts = msg.get("timestamp")
        turn += 1

        # Collect assistant responses for this turn
        for j in range(i + 1, len(messages)):
            a_msg = messages[j]
            if a_msg.get("type") == "user" and a_msg.get("message", {}).get("role") == "user":
                break
            if a_msg.get("type") != "assistant":
                continue

            a_usage = a_msg.get("message", {}).get("usage", {})
            a_model = a_msg.get("message", {}).get("model", model or "unknown")
            a_text = get_assistant_text(a_msg)
            tools = get_tool_names(a_msg)

            gen_name = f"turn-{turn}"
            if tools:
                gen_name += f" ({', '.join(tools[:3])})"

            events.append({
                "id": str(uuid.uuid4()),
                "type": "generation-create",
                "timestamp": parse_ts(a_msg.get("timestamp")),
                "body": {
                    "id": str(uuid.uuid4()),
                    "traceId": session_id,
                    "name": gen_name,
                    "model": a_model if a_model != "<synthetic>" else "unknown",
                    "input": user_text[:5000],
                    "output": a_text[:5000] if a_text else None,
                    "startTime": parse_ts(user_ts),
                    "endTime": parse_ts(a_msg.get("timestamp")),
                    "usageDetails": {
                        "input": a_usage.get("input_tokens", 0) + a_usage.get("cache_read_input_tokens", 0),
                        "output": a_usage.get("output_tokens", 0),
                    },
                    "metadata": {
                        "tool_calls": tools,
                        "stop_reason": a_msg.get("message", {}).get("stop_reason"),
                        "cache_read": a_usage.get("cache_read_input_tokens", 0),
                        "cache_create": a_usage.get("cache_creation_input_tokens", 0),
                    },
                },
            })

    # Send in batches of 50
    for start in range(0, len(events), 50):
        send_batch(events[start:start + 50])

    print(f"  {trace_name}: {turn} turns, {total_input}+{total_output} tokens, model={model}")


def main():
    files = []
    if "--dir" in sys.argv:
        idx = sys.argv.index("--dir")
        if idx + 1 < len(sys.argv):
            pattern = os.path.join(sys.argv[idx + 1], "*.jsonl")
            files = sorted(glob.glob(pattern))
    else:
        files = [f for f in sys.argv[1:] if f.endswith(".jsonl")]

    if not files:
        print(__doc__)
        sys.exit(1)

    print(f"Langfuse: {HOST}")
    print(f"Ingesting {len(files)} session(s)...\n")
    for f in files:
        try:
            ingest_session(f)
        except Exception as e:
            print(f"  ERROR {os.path.basename(f)}: {e}")
    print("\nDone.")


if __name__ == "__main__":
    main()
