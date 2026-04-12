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
  content?: string | ContentBlock[];
  tool_use_id?: string;
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
    const parts: string[] = [];
    for (const b of content) {
      if (b.type === "text" && b.text) {
        parts.push(b.text);
      } else if (b.type === "tool_result") {
        // Tool results are the user-side responses to assistant tool_use calls
        if (typeof b.content === "string") {
          parts.push(`[tool_result] ${b.content}`);
        } else if (Array.isArray(b.content)) {
          const inner = b.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join(" ");
          if (inner) parts.push(`[tool_result] ${inner}`);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function getAssistantText(msg: JsonlMessage): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b.type === "text" && b.text) {
        parts.push(b.text);
      } else if (b.type === "thinking" && b.thinking) {
        parts.push(`[thinking] ${b.thinking}`);
      } else if (b.type === "tool_use" && (b as any).input) {
        parts.push(`[tool_use:${b.name}] ${JSON.stringify((b as any).input)}`);
      }
    }
    return parts.join("\n");
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

    for (const msg of messages) {
      if (msg.type === "user" && !firstUser) {
        firstUser = getUserText(msg).slice(0, 200);
        firstTs = msg.timestamp;
      }
      if (msg.type === "assistant") {
        const m = msg.message?.model;
        if (!model && m && m !== "<synthetic>") model = m;
        if (!slug) slug = (msg as any).slug;
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

    // Generations — one per real LLM API call.
    //
    // Claude Code's JSONL splits a single assistant response across multiple
    // messages (one per content block: thinking, text, tool_use). All of them
    // share the same `usage` object. We group them together by `usage` identity
    // so one API call = one generation, not N.
    //
    // Agent loop pattern: user prompt → [assistant response] → tool_result →
    // [assistant response] → tool_result → ... → final [assistant response].
    // Each bracketed group is one API call.
    type TurnGroup = {
      timestamp: string;
      model: string;
      usage: TokenUsage;
      texts: string[];
      tools: string[];
      stopReason: string | undefined;
      input: string;
      inputTs: string | undefined;
    };

    const groups: TurnGroup[] = [];
    let currentGroup: TurnGroup | null = null;
    let pendingInput = "";
    let pendingInputTs: string | undefined;

    for (const msg of messages) {
      if (msg.type === "user" && msg.message?.role === "user") {
        // Flush current assistant group — a user message always ends a group
        if (currentGroup) {
          groups.push(currentGroup);
          currentGroup = null;
        }
        const text = getUserText(msg);
        if (text) {
          pendingInput = text;
          pendingInputTs = msg.timestamp;
        }
        continue;
      }

      if (msg.type !== "assistant") continue;

      const aUsage = msg.message?.usage;
      const aModel = msg.message?.model ?? model ?? "unknown";
      if (aModel === "<synthetic>") continue;

      // Decide whether this message starts a new group or extends the current one.
      // Same usage object → same API call → extend. Different usage → new call.
      const sameUsageAsCurrent =
        currentGroup &&
        aUsage &&
        currentGroup.usage.input_tokens === aUsage.input_tokens &&
        currentGroup.usage.output_tokens === aUsage.output_tokens &&
        currentGroup.usage.cache_read_input_tokens === aUsage.cache_read_input_tokens;

      if (!sameUsageAsCurrent) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = {
          timestamp: msg.timestamp ?? new Date().toISOString(),
          model: aModel,
          usage: aUsage ?? {},
          texts: [],
          tools: [],
          stopReason: msg.message?.stop_reason,
          input: pendingInput,
          inputTs: pendingInputTs,
        };
      }

      const text = getAssistantText(msg);
      if (text) currentGroup!.texts.push(text);
      currentGroup!.tools.push(...getToolNames(msg));
      if (msg.message?.stop_reason) currentGroup!.stopReason = msg.message.stop_reason;
      // Keep the latest timestamp as end time
      if (msg.timestamp) currentGroup!.timestamp = msg.timestamp;
    }
    if (currentGroup) groups.push(currentGroup);

    // Compute correct totals from grouped (deduped) usage
    let totalInput = 0;
    let totalOutput = 0;
    for (const g of groups) {
      totalInput += (g.usage.input_tokens ?? 0) + (g.usage.cache_read_input_tokens ?? 0);
      totalOutput += g.usage.output_tokens ?? 0;
    }

    // Trace (created after grouping so totals are accurate)
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

    // Emit one generation per group. Skip groups with no real usage (synthetic).
    let turn = 0;
    for (const g of groups) {
      if (
        !g.usage ||
        (g.usage.input_tokens == null && g.usage.output_tokens == null)
      ) {
        continue;
      }
      turn++;
      const uniqueTools = [...new Set(g.tools)];
      let genName = `turn-${turn}`;
      if (uniqueTools.length > 0) genName += ` (${uniqueTools.slice(0, 3).join(", ")})`;

      events.push({
        id: randomUUID(),
        type: "generation-create",
        timestamp: g.timestamp,
        body: {
          id: randomUUID(),
          traceId: sessionId,
          name: genName,
          model: g.model,
          input: g.input.slice(0, 5000),
          output: g.texts.join("\n").slice(0, 5000) || undefined,
          startTime: g.inputTs ?? g.timestamp,
          endTime: g.timestamp,
          usageDetails: {
            input: (g.usage.input_tokens ?? 0) + (g.usage.cache_read_input_tokens ?? 0),
            output: g.usage.output_tokens ?? 0,
          },
          metadata: {
            tool_calls: uniqueTools,
            stop_reason: g.stopReason,
            cache_read: g.usage.cache_read_input_tokens ?? 0,
            cache_create: g.usage.cache_creation_input_tokens ?? 0,
          },
        },
      });
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
