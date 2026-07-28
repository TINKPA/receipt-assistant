import { spawn } from "child_process";
import { randomUUID } from "crypto";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/receipts";

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
 * Run `claude` CLI and return stdout + sessionId.
 * Automatically assigns a session ID for traceability.
 * stdin is closed immediately to avoid "no stdin data" warnings.
 */
export function runClaude(args: string[], timeoutMs: number): Promise<{ stdout: string; sessionId: string }> {
  const sessionId = randomUUID();
  const fullArgs = [...args, "--session-id", sessionId];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", fullArgs, {
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

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
 */
export async function detectPsqlCommand(): Promise<string> {
  // Check if psql is available locally
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("which", ["psql"], { stdio: "ignore" });
      child.on("close", (code) => code === 0 ? resolve() : reject());
      child.on("error", reject);
    });
    return `psql "${DATABASE_URL}" -c`;
  } catch {
    // Fallback: use docker exec (local dev)
    return `docker exec langfuse-postgres-1 psql -U postgres -d receipts -c`;
  }
}
