import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

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
 * Compute the session JSONL path for a given session ID.
 * Claude Code mangles the CWD: replaces "/" and "_" with "-".
 * E.g. /Users/foo/my_project → -Users-foo-my-project
 */
export function getSessionJsonlPath(sessionId: string): string {
  const mangledCwd = process.cwd().replace(/[/_]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", mangledCwd, `${sessionId}.jsonl`);
}

/**
 * Run `claude` CLI and return stdout + sessionId.
 * Automatically assigns a session ID for traceability.
 * stdin is closed immediately to avoid "no stdin data" warnings.
 */
function runClaude(args: string[], timeoutMs: number): Promise<{ stdout: string; sessionId: string }> {
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
async function detectPsqlCommand(): Promise<string> {
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

/**
 * Single-call agent pipeline: read receipt image and write to PostgreSQL.
 *
 * Claude reads the image, reasons in plain text (no --json-schema for
 * better OCR accuracy), then directly UPDATEs the receipt row and
 * INSERTs line items via psql.
 *
 * A placeholder row must already exist in the receipts table with the
 * given receiptId and status='processing'.
 *
 * Returns { sessionId } for Langfuse trace ingestion.
 */
export async function processReceipt(imagePath: string, receiptId: string): Promise<{ sessionId: string }> {
  const absPath = path.resolve(imagePath);
  await fs.access(absPath);

  const psqlCmd = await detectPsqlCommand();

  const prompt = `You are a receipt parser agent. Read the receipt image at "${absPath}" and save extracted data to PostgreSQL.

RULES:
- merchant: Store/restaurant name from the receipt header/logo
- date: YYYY-MM-DD format. Read from the receipt. NEVER use today's date as fallback.
- total: FINAL amount paid (after tax, after tip). If there is a handwritten total, use that.
- currency: USD/CNY/EUR/JPY etc. Detect from symbols ($ = USD, ¥ = context-dependent, € = EUR)
- category: MUST be one of: food|groceries|transport|shopping|utilities|entertainment|health|education|travel|other
- payment_method: MUST be one of: credit_card|debit_card|cash|mobile_pay|other
- tax: tax amount if visible
- tip: tip amount if visible (watch for handwritten tips)
- address: full printed street address of the merchant if visible on the receipt (e.g. "11727 Olympic Blvd, Los Angeles, CA 90064"). Combine street, city, state, zip into one string. Use NULL if not visible — do NOT guess.
- raw_text: full transcription of the receipt text
- For each line item: name, quantity (default 1), unit_price, total_price

DATABASE — run SQL via:
${psqlCmd} "<SQL>"

UPDATE the existing receipt row:
UPDATE receipts SET merchant='...', date='...', total=<num>, currency='...', category='...', payment_method='...', tax=<num_or_null>, tip=<num_or_null>, address=<'...'_or_NULL>, raw_text='...', status='done', updated_at=NOW() WHERE id='${receiptId}';

For each line item:
INSERT INTO receipt_items (receipt_id, name, quantity, unit_price, total_price) VALUES ('${receiptId}', '...', <qty>, <price>, <total>);

IMPORTANT: Escape single quotes in SQL values by doubling them ('').
If you cannot confidently read a field, use NULL rather than guessing.`;

  const args = [
    "-p", prompt,
    "--output-format", "text",
    "--dangerously-skip-permissions",
    "--model", process.env.CLAUDE_MODEL || "sonnet",
  ];

  const { sessionId } = await runClaude(args, 300_000);
  return { sessionId };
}

/**
 * Ask Claude a free-form question about receipts (e.g. spending analysis).
 * Returns plain text response.
 */
export async function askClaude(prompt: string): Promise<string> {
  const args = [
    "-p", prompt,
    "--output-format", "text",
    "--tools", "",
    "--max-turns", "3",
    "--model", process.env.CLAUDE_MODEL || "sonnet",
  ];

  const { stdout } = await runClaude(args, 60_000);

  // Extract result from JSON output (single object or array)
  try {
    const parsed = JSON.parse(stdout);
    const resultObj = Array.isArray(parsed)
      ? parsed.find((m: any) => m.type === "result")
      : (parsed.type === "result" ? parsed : null);
    if (resultObj) {
      return resultObj.result ?? "";
    }
  } catch {
    // Fallback: return raw output
  }

  return stdout.trim();
}
