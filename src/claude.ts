import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

export interface ClaudeReceiptQuickResult {
  merchant: string;
  date: string;
  total: number;
  currency?: string;
}

export interface ClaudeReceiptResult {
  merchant: string;
  date: string;
  total: number;
  currency?: string;
  category?: string;
  payment_method?: string;
  tax?: number;
  tip?: number;
  notes?: string;
  raw_text?: string;
  items?: {
    name: string;
    quantity?: number;
    unit_price?: number;
    total_price?: number;
    category?: string;
  }[];
  extraction_quality?: {
    confidence_score: number;
    missing_fields: string[];
    warnings: string[];
  };
  business_flags?: {
    is_reimbursable: boolean;
    is_tax_deductible: boolean;
    is_recurring: boolean;
    is_split_bill: boolean;
  };
}

// Minimal schema for quick extraction (phase 1: merchant, date, total only)
const RECEIPT_QUICK_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string", description: "Store/restaurant name" },
    date: { type: "string", description: "Purchase date in YYYY-MM-DD format" },
    total: { type: "number", description: "Total amount paid" },
    currency: { type: "string", description: "Currency code, e.g. USD, CNY" },
  },
  required: ["merchant", "date", "total"],
};

// JSON Schema that constrains Claude's output for receipt extraction
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string", description: "Store/restaurant name" },
    date: { type: "string", description: "Purchase date in YYYY-MM-DD format" },
    total: { type: "number", description: "Total amount paid" },
    currency: { type: "string", description: "Currency code, e.g. USD, CNY" },
    category: {
      type: "string",
      enum: ["food", "groceries", "transport", "shopping", "utilities", "entertainment", "health", "education", "travel", "other"],
      description: "Spending category",
    },
    payment_method: {
      type: "string",
      enum: ["credit_card", "debit_card", "cash", "mobile_pay", "other"],
      description: "Payment method used",
    },
    tax: { type: "number", description: "Tax amount if visible" },
    tip: { type: "number", description: "Tip amount if visible" },
    notes: { type: "string", description: "Any relevant notes" },
    raw_text: { type: "string", description: "Full text content of the receipt" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          unit_price: { type: "number" },
          total_price: { type: "number" },
          category: { type: "string" },
        },
        required: ["name"],
      },
      description: "Individual line items on the receipt",
    },
    extraction_quality: {
      type: "object",
      properties: {
        confidence_score: { type: "number", description: "0-1, overall extraction confidence" },
        missing_fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields not found or not visible on receipt",
        },
        warnings: {
          type: "array",
          items: { type: "string" },
          description: "Issues: handwritten_tip, truncated_merchant, date_guessed, blurry_area, partial_ocr, faded_text",
        },
      },
    },
    business_flags: {
      type: "object",
      properties: {
        is_reimbursable: { type: "boolean", description: "Business meal, transport, office supply, etc." },
        is_tax_deductible: { type: "boolean", description: "Donations, medical, business expense, etc." },
        is_recurring: { type: "boolean", description: "Subscription, monthly bill, etc." },
        is_split_bill: { type: "boolean", description: "Split payment indicators on receipt" },
      },
    },
  },
  required: ["merchant", "date", "total"],
};

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
 * Phase 1: Quick extraction — merchant, date, total only.
 * Uses --effort low and --max-turns 1 for fast turnaround (~3-5s).
 */
export async function extractReceiptQuick(imagePath: string): Promise<ClaudeReceiptQuickResult & { sessionId: string }> {
  const absPath = path.resolve(imagePath);
  await fs.access(absPath);

  const prompt = `Look at the receipt image at "${absPath}". Extract ONLY: merchant name, date (YYYY-MM-DD), total amount, and currency. Nothing else.`;

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(RECEIPT_QUICK_SCHEMA),
    "--dangerously-skip-permissions",
    "--max-turns", "3",
    "--effort", "low",
    "--model", process.env.CLAUDE_MODEL || "sonnet",
    // Session traces saved to $HOME/.claude/ for later analysis
  ];

  try {
    const { stdout, sessionId } = await runClaude(args, 30_000);
    const parsed = JSON.parse(stdout);

    const resultObj = Array.isArray(parsed)
      ? parsed.find((m: any) => m.type === "result")
      : (parsed.type === "result" ? parsed : null);

    if (!resultObj) throw new Error("No result found in Claude CLI output");

    if (resultObj.is_error) {
      throw new Error(resultObj.errors?.join("; ") || resultObj.result || "Claude returned an error");
    }

    const data = resultObj.structured_output ?? resultObj.result;
    const result = typeof data === "string" ? JSON.parse(data) : data;
    return { ...result, sessionId };
  } catch (err: any) {
    throw new Error(`Claude CLI quick extraction failed: ${err.message || "Unknown error"}`);
  }
}

/**
 * Phase 2: Full extraction — two-step pipeline for better OCR accuracy.
 *
 * Step 1: Plain text OCR + reasoning (no schema constraint).
 *   Allows chain-of-thought for ambiguous characters.
 * Step 2: Structure the text into JSON (with schema constraint).
 *   Uses the OCR text as input, not the image — pure formatting.
 *
 * This two-step approach produces significantly better results than
 * single-step --json-schema on the same image (tested 10 receipts,
 * 4/10 dates wrong with single-step, 0/10 with two-step).
 */
export async function extractReceipt(imagePath: string, quickResult?: ClaudeReceiptQuickResult): Promise<ClaudeReceiptResult & { sessionId: string }> {
  const absPath = path.resolve(imagePath);
  await fs.access(absPath);

  const phase1Context = quickResult
    ? `\nPhase 1 preliminary extraction (may contain errors — verify independently):
  merchant: "${quickResult.merchant}", total: ${quickResult.total}, currency: "${quickResult.currency ?? "USD"}"
  Phase 1 date "${quickResult.date}" is UNVERIFIED — read the date from the image yourself.\n`
    : "";

  // ── Step 1: Plain text OCR + reasoning ──
  const ocrPrompt = `You are a receipt parser. Look at the receipt image at "${absPath}" and extract ALL information.
${phase1Context}
Rules:
- Read every character carefully. For ambiguous digits, reason about context (e.g. date ranges, price plausibility).
- Date must be YYYY-MM-DD. If year shows 2 digits like "26", that means 2026.
- Total is the FINAL amount paid (after tax/tip).
- Pay special attention to handwritten amounts (tips, totals).
- Transcribe the full receipt text.
- List ALL line items with quantities and prices.
- Note any issues: blurry areas, handwritten text, truncated merchant name, guessed fields.

Output a detailed plain-text analysis of what you see.`;

  const ocrArgs = [
    "-p", ocrPrompt,
    "--output-format", "text",
    "--dangerously-skip-permissions",
    "--max-turns", "3",
    "--model", process.env.CLAUDE_MODEL || "sonnet",
  ];

  const { stdout: ocrText, sessionId } = await runClaude(ocrArgs, 120_000);

  // ── Step 2: Structure into JSON ──
  const structurePrompt = `Convert the following receipt analysis into structured JSON.

--- RECEIPT ANALYSIS ---
${ocrText}
--- END ---

Extract into the required JSON schema. For extraction_quality and business_flags:
- confidence_score: 0-1 based on how clear/complete the receipt was
- missing_fields: fields not found on the receipt
- warnings: any of [handwritten_tip, truncated_merchant, date_guessed, blurry_area, partial_ocr, faded_text]
- is_reimbursable: business meals, transport, office supplies
- is_tax_deductible: donations, medical, business expenses
- is_recurring: subscriptions, monthly bills
- is_split_bill: split payment indicators`;

  const structureArgs = [
    "-p", structurePrompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(RECEIPT_SCHEMA),
    "--dangerously-skip-permissions",
    "--max-turns", "3",
    "--model", process.env.CLAUDE_MODEL || "sonnet",
  ];

  try {
    const { stdout: jsonOut } = await runClaude(structureArgs, 60_000);
    const parsed = JSON.parse(jsonOut);
    const resultObj = Array.isArray(parsed)
      ? parsed.find((m: any) => m.type === "result")
      : (parsed.type === "result" ? parsed : null);

    if (!resultObj) throw new Error("No result found in Claude CLI output");
    if (resultObj.is_error) {
      throw new Error(resultObj.errors?.join("; ") || resultObj.result || "Claude returned an error");
    }

    const data = resultObj.structured_output ?? resultObj.result;
    const result = typeof data === "string" ? JSON.parse(data) : data;
    return { ...result, sessionId };
  } catch (err: any) {
    throw new Error(`Claude CLI failed: ${(err as Error).message || "Unknown error"}`);
  }
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
    // Session traces saved to $HOME/.claude/ for later analysis
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
