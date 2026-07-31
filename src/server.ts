/**
 * HTTP entrypoint.
 *
 * Boot sequence:
 *   1. Run pending Drizzle migrations. Fail fast on any migration error.
 *   2. Idempotent seed (default workspace + chart of accounts).
 *   3. Start the in-process ingest worker.
 *   4. Start Express HTTP server built from `buildApp()`.
 */
import "dotenv/config";
import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { start as startIngestWorker } from "./ingest/worker.js";
import { startMerchantEnrichmentLoop } from "./enrichment/merchants.js";
import { buildInfo } from "./generated/build-info.js";
import { buildExtractorPrompt } from "./ingest/prompt.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/**
 * Stamp the rendered extractor-prompt size into the boot log (#197).
 *
 * The build-time gate (`scripts/check-prompt-budget.ts`) cannot see this
 * number completely, because `renderActiveLessons()` reads `lessons.md` from
 * disk at RUNTIME — so prompt size is partly a property of the deploy, not
 * only of the commit. A lessons file that grows under a running container is
 * invisible to any check that runs at build time.
 *
 * It also means every deploy leaves a size record in `docker logs`, which is
 * what was missing when the prompt crossed the argv ceiling in #194: the
 * number existed, nothing ever printed it.
 *
 * Deliberately non-fatal. Refusing to boot over a prompt-size reading would
 * turn an observability feature into an outage, which is the opposite of the
 * point.
 */
function logPromptSize(): void {
  try {
    const empty = {
      filePath: "",
      ingestId: "",
      workspaceId: "",
      documentId: "",
      userId: "",
      phashNeighbors: [],
    } as Parameters<typeof buildExtractorPrompt>[0];
    const size = Buffer.byteLength(buildExtractorPrompt(empty), "utf8");
    console.log(`📏 Extractor prompt ${size.toLocaleString()} B rendered (empty context)`);
  } catch (err) {
    console.warn("📏 Could not measure extractor prompt size:", (err as Error).message);
  }
}

async function main(): Promise<void> {
  console.log("🗄️  Running Drizzle migrations…");
  await runMigrations();
  console.log("✅ Migrations complete");

  logPromptSize();

  if (process.env.SEED_ON_BOOT !== "false") {
    const r = await seed();
    console.log(
      r.created
        ? `🌱 Seeded workspace=${r.workspaceId}`
        : `🌱 Workspace ${r.workspaceId} already present`,
    );
  }

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.warn(
      "⚠️  GOOGLE_MAPS_API_KEY not set — receipt geocoding will be skipped. " +
        "Set the env var in .env to enable Google Maps Geocoding + Places API calls during Phase 3 of extraction.",
    );
  }

  // Ingest worker: recovers any stale batches from a prior crash and
  // then sits idle until /v1/ingest/batch enqueues files. Same process
  // as HTTP so the DB pool + v1 services are shared.
  await startIngestWorker();
  console.log(`⚙️  Ingest worker ready (concurrency ${process.env.MAX_CLAUDE_CONCURRENCY ?? 3})`);

  // Background poller that fills place_id / address / lat / lng on
  // newly-canonicalized merchant rows. No-ops when GOOGLE_MAPS_API_KEY
  // is unset, so dev environments without a key boot cleanly.
  startMerchantEnrichmentLoop();

  const app = buildApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 HTTP API listening on http://0.0.0.0:${PORT}`);
    console.log(`🏷️  Build ${buildInfo.version} (${buildInfo.gitShortSha}) built ${buildInfo.builtAt}`);
    console.log(`
📋 Endpoints:
   GET  /health · /version · /openapi.json · /docs
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
