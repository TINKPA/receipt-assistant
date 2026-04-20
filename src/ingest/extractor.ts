/**
 * Extractor contract — the single seam between the ingest worker and
 * Claude. Kept tiny and injectable so:
 *
 *   - integration tests can plug in a deterministic `FakeExtractor` and
 *     skip the Claude CLI entirely,
 *   - production wires in `defaultClaudeExtractor` which spawns
 *     `claude -p` with the unified prompt from `./prompt.js`.
 *
 * Keep the result types aligned with issue #32's promised classification
 * set. Anything that isn't one of the four financial kinds collapses to
 * `unsupported` so the worker has a single non-success branch.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { buildExtractorPrompt } from "./prompt.js";

export type ExtractorGeoInfo = {
  /** Google Places `place_id`. */
  place_id: string;
  /** Google-formatted address (what Google returned, not what's on the receipt). */
  formatted_address: string;
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Which Google API was used. */
  source: "google_geocode" | "google_places";
};

export type ExtractorReceiptFields = {
  payee: string;
  occurred_on: string;
  total_minor: number;
  currency: string;
  category_hint:
    | "groceries"
    | "dining"
    | "retail"
    | "cafe"
    | "transport"
    | "other"
    | (string & {});
  items?: Array<{ name: string; total_price_minor?: number }>;
  raw_text?: string;
  /**
   * Optional geocode result produced by the agent during Phase 3 of the
   * extraction prompt. Null/absent when the agent couldn't confidently
   * resolve the merchant to a Google Places entry.
   */
  geo?: ExtractorGeoInfo;
};

export type ExtractorStatementRow = {
  date: string;
  payee: string;
  amount_minor: number;
};

export type ExtractorResult =
  | {
      classification: "receipt_image" | "receipt_email" | "receipt_pdf";
      extracted: ExtractorReceiptFields;
      sessionId?: string;
    }
  | {
      classification: "statement_pdf";
      extracted: { rows: ExtractorStatementRow[] };
      sessionId?: string;
    }
  | {
      classification: "unsupported";
      reason: string;
      sessionId?: string;
    };

export interface ExtractorInput {
  /** Absolute path on disk — sha256-named, written by the documents service. */
  filePath: string;
  /** MIME type from the multipart upload, if supplied. */
  mimeType: string | null;
  /** Client-provided filename at upload time. Used by stubs and logs. */
  filename: string;
}

export type Extractor = (input: ExtractorInput) => Promise<ExtractorResult>;

// ── Default impl: spawn `claude -p` ───────────────────────────────────

const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 300_000);

function extractLastJsonFence(raw: string): string | null {
  // Match ``` with optional language tag; we care about the LAST block
  // because the model may include examples mid-reasoning.
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let last: string | null = null;
  for (;;) {
    const m = re.exec(raw);
    if (!m) break;
    last = m[1]!.trim();
  }
  return last;
}

function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Same quirks as src/claude.ts — these poison nested CLI sessions.
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function runClaude(
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--session-id",
      sessionId,
    ];
    const child = spawn("claude", args, {
      env: buildClaudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err || out || `claude -p exited ${code}`));
      } else {
        resolve(out);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Coerce the agent's JSON payload to the typed `ExtractorResult`. We
 * tolerate noisy output (missing fields, wrong types) by falling back
 * to `unsupported` — the worker treats that as a terminal state without
 * failing the batch.
 */
function coerceResult(parsed: unknown, sessionId: string): ExtractorResult {
  if (!parsed || typeof parsed !== "object") {
    return {
      classification: "unsupported",
      reason: "extractor returned non-object payload",
      sessionId,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const k = obj.classification as string | undefined;

  if (k === "receipt_image" || k === "receipt_email" || k === "receipt_pdf") {
    const ex = obj.extracted as Record<string, unknown> | undefined;
    if (!ex || typeof ex !== "object") {
      return {
        classification: "unsupported",
        reason: `${k}: extracted block missing`,
        sessionId,
      };
    }
    const payee = typeof ex.payee === "string" ? ex.payee : null;
    const occurred_on =
      typeof ex.occurred_on === "string" ? ex.occurred_on : null;
    const total_minor =
      typeof ex.total_minor === "number" ? ex.total_minor : null;
    const currency =
      typeof ex.currency === "string" ? ex.currency.toUpperCase() : "USD";
    const category_hint =
      typeof ex.category_hint === "string" ? ex.category_hint : "other";
    if (!payee || !occurred_on || total_minor === null) {
      return {
        classification: "unsupported",
        reason: `${k}: missing required field (payee/occurred_on/total_minor)`,
        sessionId,
      };
    }
    // Optional geo block. Shape-check all five fields before letting
    // it through — a partial / malformed geo gets silently dropped so
    // it never lands in metadata with stringly-typed coordinates.
    let geo: ExtractorGeoInfo | undefined;
    const rawGeo = ex.geo;
    if (rawGeo && typeof rawGeo === "object" && !Array.isArray(rawGeo)) {
      const g = rawGeo as Record<string, unknown>;
      if (
        typeof g.place_id === "string" &&
        typeof g.formatted_address === "string" &&
        typeof g.lat === "number" &&
        typeof g.lng === "number" &&
        (g.source === "google_geocode" || g.source === "google_places")
      ) {
        geo = {
          place_id: g.place_id,
          formatted_address: g.formatted_address,
          lat: g.lat,
          lng: g.lng,
          source: g.source,
        };
      }
    }

    return {
      classification: k,
      extracted: {
        payee,
        occurred_on,
        total_minor,
        currency,
        category_hint,
        items: Array.isArray(ex.items)
          ? (ex.items as ExtractorReceiptFields["items"])
          : undefined,
        raw_text: typeof ex.raw_text === "string" ? ex.raw_text : undefined,
        geo,
      },
      sessionId,
    };
  }

  if (k === "statement_pdf") {
    const ex = obj.extracted as { rows?: unknown } | undefined;
    const rows = Array.isArray(ex?.rows) ? ex.rows : [];
    return {
      classification: "statement_pdf",
      extracted: { rows: rows as ExtractorStatementRow[] },
      sessionId,
    };
  }

  // Anything else — including explicit "unsupported" — lands here.
  const reason =
    typeof obj.reason === "string"
      ? obj.reason
      : k
        ? `unknown classification '${k}'`
        : "no classification provided";
  return { classification: "unsupported", reason, sessionId };
}

/**
 * Production extractor: spawns `claude -p` with a pre-allocated session
 * id (invariant from root CLAUDE.md — Langfuse's JSONL discovery relies
 * on the UUID being stable across the lifecycle of one extraction).
 */
export const defaultClaudeExtractor: Extractor = async (input) => {
  const sessionId = randomUUID();
  const prompt = buildExtractorPrompt(input.filePath);
  const raw = await runClaude(prompt, sessionId, CLAUDE_TIMEOUT_MS);
  const fence = extractLastJsonFence(raw);
  if (!fence) {
    return {
      classification: "unsupported",
      reason: "extractor returned no ```json fence",
      sessionId,
    };
  }
  try {
    return coerceResult(JSON.parse(fence), sessionId);
  } catch (e) {
    return {
      classification: "unsupported",
      reason: `JSON parse failed: ${(e as Error).message}`,
      sessionId,
    };
  }
};

// Exposed for tests.
export const __internal = { extractLastJsonFence, coerceResult };
