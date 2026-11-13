#!/usr/bin/env tsx
/**
 * check-agent-sandbox.ts — prove, on the SANDBOX stack, that the two
 * `claude -p` agents are confined the way the code says.
 *
 * Run it after any change to `src/claude.ts` (tools, flags, child
 * environment), `src/db/agent-roles.ts` (what the roles may do), the
 * pinned CLI version in the Dockerfile, or the SQL in the prompts — and
 * before that change is deployed to production.
 *
 *   # sandbox up first:
 *   #   docker compose -f docker-compose.test.yml up -d --build
 *   npx tsx scripts/check-agent-sandbox.ts
 *
 * The checks themselves live in `src/agent-sandbox-check.ts`, which is
 * compiled into the image. This launcher runs that compiled module INSIDE
 * the sandbox app container, because that is the only place the answer is
 * true: it uses the container's pinned CLI, its real environment, and the
 * very `buildClaudeArgs` / `buildClaudeEnv` the server spawns with.
 *
 * It fails (exit 1) if
 *   · a probe run is offered any tool outside its profile's allowlist, or
 *     any MCP tool or server;
 *   · `receipts_agent` can DROP, TRUNCATE, COPY … PROGRAM, DELETE, update
 *     a column it was not granted, or read a table it was not granted;
 *   · `receipts_agent` is refused any statement the prompt templates issue;
 *   · `receipts_ro` can write anything, even after switching its session
 *     to read-write;
 *   · the Ask agent manages to run a command other than ledger-query.
 *
 * Every database statement runs inside a transaction that is rolled back.
 * The agent half makes four short model calls on the subscription.
 *
 * Flags:
 *   --container=<name>   app container to run in (default receipt-assistant-test)
 *   --db-only            skip the agent half (no model calls)
 *   --local              run in this process instead of a container, against
 *                        DATABASE_URL and whatever `claude` is on PATH. For
 *                        developing the check; a pass here says nothing
 *                        about the image.
 */
import { spawnSync } from "node:child_process";

function argOf(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const passthrough = process.argv.slice(2).filter((a) => a === "--db-only" || a === "--allow-non-sandbox");

if (process.argv.includes("--local")) {
  const { runAgentSandboxCheck } = await import("../src/agent-sandbox-check.js");
  process.exit(await runAgentSandboxCheck(passthrough));
}

const container = argOf("container") ?? "receipt-assistant-test";

// The whole point is isolation. The compiled check also refuses without
// EXTRACTOR_STUB_ALLOWED=1, which production never sets; this is the same
// guard one step earlier, with a clearer message.
if (container === "receipt-assistant") {
  console.error(
    "REFUSING: 'receipt-assistant' is the production container. This check is for the sandbox stack\n" +
      "(docker-compose.test.yml). Pass --container=<sandbox app container>.",
  );
  process.exit(2);
}

const running = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
if (running.status !== 0 || !running.stdout.split("\n").includes(container)) {
  console.error(
    `sandbox container '${container}' is not running. Bring it up first:\n` +
      "  docker compose -f docker-compose.test.yml up -d --build",
  );
  process.exit(2);
}

const res = spawnSync(
  "docker",
  ["exec", container, "node", "dist/agent-sandbox-check.js", ...passthrough],
  { stdio: "inherit" },
);
process.exit(res.status ?? 2);
