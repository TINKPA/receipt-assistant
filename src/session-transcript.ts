import path from "path";
import os from "os";

/**
 * Resolve where Claude Code writes the JSONL transcript for a given
 * `--session-id`. The CLI mangles CWD by replacing "/" and "_" with "-"
 * and writes to `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl`.
 * Stable across host mode (`$HOME=/Users/…`) and container (`/home/node`).
 *
 * This file is the only trace of a `claude -p` run: every prompt, tool
 * call, tool result and per-turn `usage` block. It survives because
 * `~/.claude` is bind-mounted to the host and the image pins
 * `cleanupPeriodDays` high in managed settings (see Dockerfile) — the
 * CLI's default would delete it after 30 days.
 */
export function getSessionJsonlPath(sessionId: string): string {
  const mangledCwd = process.cwd().replace(/[/_]/g, "-");
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    mangledCwd,
    `${sessionId}.jsonl`,
  );
}
