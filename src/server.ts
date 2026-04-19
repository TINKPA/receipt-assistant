import "dotenv/config";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { askClaude } from "./claude.js";
import { getReceipt, listReceipts, getSpendingSummary, initSchema } from "./db.js";
import { submitJob, getJob, subscribeJob } from "./jobs.js";
import { buildOpenApiDocument } from "./openapi.js";
import { parseOr400 } from "./validate.js";
import { ListReceiptsQuery } from "./schemas/receipt.js";
import { SummaryQuery } from "./schemas/summary.js";
import { AskRequest } from "./schemas/ask.js";

const PORT = parseInt(process.env.PORT || "3000");
const MCP_PORT = parseInt(process.env.MCP_PORT || "3001");
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/uploads";

// ═══════════════════════════════════════════════════════════════════════
// 1. FastMCP Server — MCP-compatible tools for AI agents
// ═══════════════════════════════════════════════════════════════════════

const mcp = new FastMCP({
  name: "receipt-assistant",
  version: "1.0.0",
});

// Tool: Process a receipt image
mcp.addTool({
  name: "process_receipt",
  description: "Extract information from a receipt image and save to database. Pass the absolute path to a receipt image file.",
  parameters: z.object({
    image_path: z.string().describe("Absolute path to the receipt image file"),
    notes: z.string().optional().describe("Optional notes to attach"),
  }),
  execute: async ({ image_path, notes }) => {
    const job = await submitJob(image_path, notes);
    return JSON.stringify({ success: true, jobId: job.id, receiptId: job.receiptId, status: "processing" }, null, 2);
  },
});

// Tool: List receipts
mcp.addTool({
  name: "list_receipts",
  description: "List receipts with optional date range and category filter",
  parameters: z.object({
    from: z.string().optional().describe("Start date YYYY-MM-DD"),
    to: z.string().optional().describe("End date YYYY-MM-DD"),
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 50)"),
  }),
  execute: async (opts) => {
    const results = await listReceipts(opts);
    return JSON.stringify(results, null, 2);
  },
});

// Tool: Get spending summary
mcp.addTool({
  name: "spending_summary",
  description: "Get spending summary grouped by category, with optional date range",
  parameters: z.object({
    from: z.string().optional().describe("Start date YYYY-MM-DD"),
    to: z.string().optional().describe("End date YYYY-MM-DD"),
  }),
  execute: async ({ from, to }) => {
    const summary = await getSpendingSummary(from, to);
    return JSON.stringify(summary, null, 2);
  },
});

// Tool: Get receipt details
mcp.addTool({
  name: "get_receipt",
  description: "Get full details of a specific receipt by ID, including line items",
  parameters: z.object({
    id: z.string().describe("Receipt ID"),
  }),
  execute: async ({ id }) => {
    const receipt = await getReceipt(id);
    if (!receipt) return JSON.stringify({ error: "Receipt not found" });
    return JSON.stringify(receipt, null, 2);
  },
});

// Tool: Ask Claude about spending
mcp.addTool({
  name: "ask_about_spending",
  description: "Ask a free-form question about your receipts/spending. Claude will analyze your data.",
  parameters: z.object({
    question: z.string().describe("Your question about spending habits, budgets, etc."),
  }),
  execute: async ({ question }) => {
    // Pull recent data for context
    const recent = await listReceipts({ limit: 30 });
    const summary = await getSpendingSummary();

    const prompt = `You are a personal finance assistant. The user has the following recent receipts and spending summary.

Recent receipts (last 30):
${JSON.stringify(recent, null, 2)}

Spending summary by category:
${JSON.stringify(summary, null, 2)}

User's question: ${question}

Answer concisely and helpfully.`;

    const answer = await askClaude(prompt);
    return answer;
  },
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Express HTTP Server — REST API for direct HTTP calls
// ═══════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// API contract — served before auth so /docs is always discoverable.
// The spec is already public on GitHub; exposing it here is no extra leak.
const openApiDoc = buildOpenApiDocument();
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(openApiDoc);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDoc, {
  customSiteTitle: "Receipt Assistant API",
  swaggerOptions: { persistAuthorization: true },
}));

// Auth middleware (simple bearer token)
const AUTH_TOKEN = process.env.AUTH_TOKEN;

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next(); // no auth configured, skip
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
app.use(authMiddleware);

// File upload config — JPG only
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, _file, cb) => {
    cb(null, `${uuidv4()}.jpg`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype.toLowerCase();
    if (mime === "image/jpeg" || mime === "image/jpg") {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG images are accepted"));
    }
  },
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "receipt-assistant", version: "1.0.0" });
});

// POST /receipt — upload receipt image, submit async extraction job
app.post("/receipt", upload.single("image"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No image file uploaded. Use form field 'image'. Only JPEG accepted." });
      return;
    }

    const imagePath = req.file.path;
    const notes = req.body?.notes;

    console.log(`📸 Submitting receipt job: ${imagePath}`);
    const job = await submitJob(imagePath, notes);
    console.log(`📋 Job created: ${job.id} (receipt: ${job.receiptId})`);

    res.json({
      jobId: job.id,
      receiptId: job.receiptId,
      status: "processing",
      stream: `/jobs/${job.id}/stream`,
      poll: `/jobs/${job.id}`,
    });
  } catch (err: any) {
    console.error("❌ Receipt submission failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /jobs/:id — poll job status
app.get("/jobs/:id", (req: Request, res: Response) => {
  const job = getJob(req.params.id as string);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    jobId: job.id,
    receiptId: job.receiptId,
    status: job.status,
    error: job.error ?? null,
  });
});

// GET /jobs/:id/stream — SSE endpoint for real-time job progress
app.get("/jobs/:id/stream", (req: Request, res: Response) => {
  const job = getJob(req.params.id as string);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately (client may have missed events)
  if (job.status === "done") {
    res.write(`event: done\ndata: ${JSON.stringify({ receiptId: job.receiptId })}\n\n`);
    res.end();
    return;
  }
  if (job.status === "error") {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to future events
  const unsub = subscribeJob(job.id, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    if (event.type === "done" || event.type === "error") {
      res.end();
      unsub();
    }
  });

  // Clean up on client disconnect
  req.on("close", () => unsub());
});

// GET /receipts — list receipts
app.get("/receipts", async (req: Request, res: Response) => {
  const query = parseOr400(ListReceiptsQuery, req.query, res);
  if (!query) return;
  const results = await listReceipts(query);
  res.json(results);
});

// GET /receipt/:id — get single receipt
app.get("/receipt/:id", async (req: Request, res: Response) => {
  const receipt = await getReceipt(req.params.id as string);
  if (!receipt) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(receipt);
});

// DELETE /receipt/:id — delete a receipt
app.delete("/receipt/:id", async (req: Request, res: Response) => {
  const { deleteReceipt } = await import("./db.js");
  const deleted = await deleteReceipt(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
});

// GET /receipt/:id/image — serve the receipt image file
app.get("/receipt/:id/image", async (req: Request, res: Response) => {
  const receipt = await getReceipt(req.params.id as string);
  if (!receipt || !receipt.image_path) {
    res.status(404).json({ error: "Image not found" });
    return;
  }
  const absPath = path.resolve(receipt.image_path);
  try {
    await fs.access(absPath);
    res.sendFile(absPath);
  } catch (err) {
    console.error(`[/receipt/${req.params.id}/image] failed:`, err);
    res.status(404).json({ error: "Image file not found on disk" });
  }
});

// GET /summary — spending summary
app.get("/summary", async (req: Request, res: Response) => {
  const query = parseOr400(SummaryQuery, req.query, res);
  if (!query) return;
  const summary = await getSpendingSummary(query.from, query.to);
  res.json(summary);
});

// POST /ask — free-form question
app.post("/ask", async (req: Request, res: Response) => {
  const body = parseOr400(AskRequest, req.body, res);
  if (!body) return;
  try {
    const recent = await listReceipts({ limit: 30 });
    const summary = await getSpendingSummary();
    const prompt = `You are a personal finance assistant. Recent receipts:\n${JSON.stringify(recent)}\nSummary:\n${JSON.stringify(summary)}\nQuestion: ${body.question}`;
    const answer = await askClaude(prompt);
    res.json({ answer });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Startup
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // Ensure upload directory exists
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  // Initialize PostgreSQL schema
  await initSchema();
  console.log("🗄️  PostgreSQL schema initialized");

  // Start MCP server (for Claude Code / MCP clients)
  mcp.start({
    transportType: "httpStream",
    httpStream: { port: MCP_PORT },
  });
  console.log(`🔌 MCP server listening on http://0.0.0.0:${MCP_PORT}/mcp`);

  // Start HTTP server (for direct REST calls)
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 HTTP API listening on http://0.0.0.0:${PORT}`);
    console.log(`
📋 Available endpoints:
   POST /receipt          — upload receipt JPG (returns jobId, async)
   GET  /jobs/:id         — poll job status (queued → done/error)
   GET  /jobs/:id/stream  — SSE stream for real-time progress
   GET  /receipts         — list receipts (?from=&to=&category=&limit=)
   GET  /receipt/:id      — get receipt details
   GET  /receipt/:id/image — serve receipt image
   GET  /summary          — spending summary (?from=&to=)
   POST /ask              — ask a question about spending
   GET  /health           — health check
   GET  /openapi.json     — OpenAPI 3.1 spec
   GET  /docs             — interactive Swagger UI

🔌 MCP tools:
   process_receipt, list_receipts, spending_summary,
   get_receipt, ask_about_spending
    `);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
