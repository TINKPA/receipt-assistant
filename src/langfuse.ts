/**
 * Langfuse ingestion for Claude Code session JSONL files.
 *
 * Reads a session JSONL, extracts traces and generations,
 * and pushes them to Langfuse via the public ingestion API.
 *
 * Config via environment variables (Twelve-Factor principle III):
 *   LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

const LANGFUSE_HOST = process.env.LANGFUSE_HOST || "http://localhost:3333";
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "pk-receipt-local";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "sk-receipt-local";

// ── JSONL message helpers ──────────────────────────────────────────

interface JsonlMessage {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  slug?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: TokenUsage;
    stop_reason?: string;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  thinking?: string;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function getUserText(msg: JsonlMessage): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join(" ");
  }
  return "";
}

function getAssistantText(msg: JsonlMessage): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Prefer text blocks; fall back to JSON-stringified tool_use inputs
    const texts = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!);
    if (texts.length > 0) return texts.join("\n");
    // For --json-schema mode: Claude may only emit tool_use blocks
    const toolInputs = content
      .filter((b) => b.type === "tool_use" && (b as any).input)
      .map((b) => JSON.stringify((b as any).input));
    if (toolInputs.length > 0) return toolInputs.join("\n");
  }
  return "";
}

function getToolNames(msg: JsonlMessage): string[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => b.name!);
}

// ── Langfuse API ───────────────────────────────────────────────────

interface IngestionEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

async function sendBatch(events: IngestionEvent[]): Promise<void> {
  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString("base64");

  const resp = await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ batch: events }),
  });

  const data = (await resp.json()) as { errors?: unknown[] };
  if (data.errors?.length) {
    console.error("[langfuse] ingestion errors:", JSON.stringify(data.errors));
  }
}

// ── Main ingestion function ────────────────────────────────────────

/**
 * Ingest a Claude Code session JSONL file into Langfuse.
 * Fire-and-forget: logs errors but never throws.
 */
export async function ingestSession(jsonlPath: string, tags?: string[]): Promise<void> {
  try {
    const raw = await fs.readFile(jsonlPath, "utf-8");
    const messages: JsonlMessage[] = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    if (messages.length === 0) return;

    // Extract session metadata
    const sessionId =
      messages.find((m) => m.sessionId)?.sessionId ??
      path.basename(jsonlPath, ".jsonl");

    let project: string | undefined;
    const projMatch = jsonlPath.split("/projects/");
    if (projMatch.length > 1) {
      const parts = projMatch[1].split("/");
      parts.pop(); // remove filename
      project = parts.join("/");
    }

    let firstUser = "";
    let firstTs: string | undefined;
    let model: string | undefined;
    let slug: string | undefined;
    let totalInput = 0;
    let totalOutput = 0;

    for (const msg of messages) {
      if (msg.type === "user" && !firstUser) {
        firstUser = getUserText(msg).slice(0, 200);
        firstTs = msg.timestamp;
      }
      if (msg.type === "assistant") {
        const m = msg.message?.model;
        if (!model && m && m !== "<synthetic>") model = m;
        if (!slug) slug = (msg as any).slug;
        const usage = msg.message?.usage;
        if (usage) {
          totalInput += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          totalOutput += usage.output_tokens ?? 0;
        }
      }
    }

    const traceName = slug || firstUser.slice(0, 80) || sessionId.slice(0, 12);

    // Find last assistant output
    let lastOutput = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "assistant") {
        lastOutput = getAssistantText(messages[i]);
        if (lastOutput) break;
      }
    }

    // Build ingestion events
    const events: IngestionEvent[] = [];

    // Trace
    events.push({
      id: randomUUID(),
      type: "trace-create",
      timestamp: firstTs ?? new Date().toISOString(),
      body: {
        id: sessionId,
        name: traceName,
        sessionId,
        input: firstUser,
        output: lastOutput.slice(0, 2000) || undefined,
        tags: ["claude-code", project ?? "unknown", ...(tags ?? [])],
        metadata: {
          project,
          model,
          source: "claude-code-session",
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
        },
      },
    });

    // Generations — one per user→assistant turn
    let turn = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type !== "user" || msg.message?.role !== "user") continue;
      const userText = getUserText(msg);
      if (!userText) continue;

      const userTs = msg.timestamp;
      turn++;

      for (let j = i + 1; j < messages.length; j++) {
        const aMsg = messages[j];
        if (aMsg.type === "user" && aMsg.message?.role === "user") break;
        if (aMsg.type !== "assistant") continue;

        const aUsage = aMsg.message?.usage;
        const aModel = aMsg.message?.model ?? model ?? "unknown";
        const aText = getAssistantText(aMsg);
        const tools = getToolNames(aMsg);

        let genName = `turn-${turn}`;
        if (tools.length > 0) genName += ` (${tools.slice(0, 3).join(", ")})`;

        events.push({
          id: randomUUID(),
          type: "generation-create",
          timestamp: aMsg.timestamp ?? new Date().toISOString(),
          body: {
            id: randomUUID(),
            traceId: sessionId,
            name: genName,
            model: aModel !== "<synthetic>" ? aModel : "unknown",
            input: userText.slice(0, 5000),
            output: aText.slice(0, 5000) || undefined,
            startTime: userTs,
            endTime: aMsg.timestamp,
            usageDetails: {
              input: (aUsage?.input_tokens ?? 0) + (aUsage?.cache_read_input_tokens ?? 0),
              output: aUsage?.output_tokens ?? 0,
            },
            metadata: {
              tool_calls: tools,
              stop_reason: aMsg.message?.stop_reason,
              cache_read: aUsage?.cache_read_input_tokens ?? 0,
              cache_create: aUsage?.cache_creation_input_tokens ?? 0,
            },
          },
        });
      }
    }

    // Send in batches of 50
    for (let start = 0; start < events.length; start += 50) {
      await sendBatch(events.slice(start, start + 50));
    }

    console.log(`[langfuse] Ingested ${traceName}: ${turn} turns, ${totalInput}+${totalOutput} tokens`);
  } catch (err) {
    console.error("[langfuse] Ingestion failed:", (err as Error).message);
  }
}
