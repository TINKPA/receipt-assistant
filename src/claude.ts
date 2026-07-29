import { spawn } from "child_process";
import { randomUUID } from "crypto";

/**
 * Build a clean env for spawning claude CLI subprocesses.
 * - Removes CLAUDECODE to avoid "nested session" errors
 * - Removes ANTHROPIC_API_KEY to force subscription auth
 */
function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Linux caps a SINGLE `execve` argument at 32 pages, independent of the
 * much larger total `ARG_MAX`. A prompt passed as argv silently works
 * until it crosses this line, then every spawn dies with an opaque
 * `spawn E2BIG`. See `assertArgvSafe` below.
 */
export const MAX_ARG_STRLEN = 32 * 4096;

/**
 * Turn the kernel's unactionable `spawn E2BIG` into a message that names
 * the offending argument and its size. Prompts must go over stdin, so
 * tripping this means someone put payload back on the command line.
 */
export function assertArgvSafe(args: string[]): void {
  for (const [i, arg] of args.entries()) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (bytes >= MAX_ARG_STRLEN) {
      throw new Error(
        `claude CLI argv[${i}] is ${bytes} bytes, over the ${MAX_ARG_STRLEN}-byte ` +
          `per-argument kernel limit (would fail as "spawn E2BIG"). ` +
          `Large payloads must be passed on stdin, not argv. ` +
          `Offending arg starts: ${arg.slice(0, 120)}…`,
      );
    }
  }
}

/**
 * Run `claude` CLI and return stdout + sessionId.
 * Automatically assigns a session ID for traceability.
 *
 * The prompt is written to the child's **stdin**, never argv — argv has a
 * hard 128 KiB per-argument ceiling that the extractor prompt already
 * exceeds (see `assertArgvSafe`). Callers pass only flags in `args`.
 */
export function runClaude(
  prompt: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; sessionId: string }> {
  const sessionId = randomUUID();
  const fullArgs = ["-p", ...args, "--session-id", sessionId];
  assertArgvSafe(fullArgs);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", fullArgs, {
      env: buildClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // The child may exit before draining stdin (bad flag, auth failure).
    // Without this the EPIPE surfaces as an unhandled 'error' on the
    // stream and crashes the process instead of rejecting the promise.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Claude CLI exited with code ${code}`));
      } else {
        resolve({ stdout, sessionId });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Detect the right psql command for the current environment.
 * In Docker: psql is available directly.
 * Local dev: use docker exec to reach the postgres container.
 *
 * The returned string is interpolated into a prompt, so it must emit the
 * **unexpanded** `"$DATABASE_URL"` literal and let the agent's shell
 * expand it — matching `PSQL_DISCIPLINE` in `src/ingest/prompt-contract.ts`
 * and every other prompt. Interpolating the resolved URL would write the
 * DB password into the prompt, and from there verbatim into the session
 * JSONL and the Langfuse trace.
 */
export async function detectPsqlCommand(): Promise<string> {
  // Check if psql is available locally
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("which", ["psql"], { stdio: "ignore" });
      child.on("close", (code) => code === 0 ? resolve() : reject());
      child.on("error", reject);
    });
    return `psql "$DATABASE_URL" -c`;
  } catch {
    // Fallback: use docker exec (local dev). The app DB has lived in
    // `receipts-postgres` since ccc80e2 decoupled it from Langfuse —
    // `langfuse-postgres-1` no longer holds these tables.
    return `docker exec receipts-postgres psql -U postgres -d receipts -c`;
  }
}
