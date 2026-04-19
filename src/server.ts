/**
 * HTTP + MCP entrypoint.
 *
 * Boot sequence:
 *   1. Run pending Drizzle migrations. Fail fast on any migration error.
 *   2. Idempotent seed (default workspace + chart of accounts).
 *   3. Start MCP server with registered v1 tools.
 *   4. Start Express HTTP server built from `buildApp()`.
 */
import "dotenv/config";
import { FastMCP } from "fastmcp";
import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { registerAccountsMcpTools } from "./mcp/accounts.js";
import { registerTransactionsMcpTools } from "./mcp/transactions.js";
import { registerDocumentsMcpTools } from "./mcp/documents.js";
import { registerReconcileMcpTools } from "./mcp/reconcile.js";
import { registerReportsMcpTools } from "./mcp/reports.js";
import { start as startIngestWorker } from "./ingest/worker.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);

const mcp = new FastMCP({
  name: "receipt-assistant",
  version: "2.0.0",
});

registerAccountsMcpTools(mcp);
registerTransactionsMcpTools(mcp);
registerDocumentsMcpTools(mcp);
registerReconcileMcpTools(mcp);
registerReportsMcpTools(mcp);

async function main(): Promise<void> {
  console.log("🗄️  Running Drizzle migrations…");
  await runMigrations();
  console.log("✅ Migrations complete");

  if (process.env.SEED_ON_BOOT !== "false") {
    const r = await seed();
    console.log(
      r.created
        ? `🌱 Seeded workspace=${r.workspaceId}`
        : `🌱 Workspace ${r.workspaceId} already present`,
    );
  }

  mcp.start({
    transportType: "httpStream",
    httpStream: { port: MCP_PORT },
  });
  console.log(`🔌 MCP server listening on http://0.0.0.0:${MCP_PORT}/mcp`);

  // Ingest worker: recovers any stale batches from a prior crash and
  // then sits idle until /v1/ingest/batch enqueues files. Same process
  // as HTTP so the DB pool + v1 services are shared.
  await startIngestWorker();
  console.log(`⚙️  Ingest worker ready (concurrency ${process.env.MAX_CLAUDE_CONCURRENCY ?? 3})`);

  const app = buildApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 HTTP API listening on http://0.0.0.0:${PORT}`);
    console.log(`
📋 Endpoints:
   GET  /health · /openapi.json · /docs
   /v1/accounts        — chart of accounts + balance + register
   /v1/transactions    — double-entry ledger CRUD + postings + void
   /v1/postings        — read-only posting search
   /v1/documents       — multipart upload + link to transactions
    `);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
