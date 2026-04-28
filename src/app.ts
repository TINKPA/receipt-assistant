/**
 * Express app factory — separated from `server.ts` so integration tests
 * can `supertest(buildApp())` without opening a listening socket.
 *
 * Middleware stack (order matters):
 *   1. JSON body parsing + trust-proxy (for correct `req.protocol`)
 *   2. `contextMiddleware` attaches `req.ctx` { workspaceId, userId, traceId }
 *   3. Routes — feature-scoped routers mounted under `/v1/*`
 *   4. `problemHandler` — RFC 7807 serialization (ALWAYS last)
 *
 * The `/v1/*` routers are added by feature-specific modules and imported
 * here so the app factory stays a single source of truth for the
 * middleware order.
 */
import express, { type Express, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "./openapi.js";
import { contextMiddleware } from "./http/context.js";
import { problemHandler } from "./http/problem.js";
import { accountsRouter } from "./routes/accounts.js";
import { transactionsRouter } from "./routes/transactions.js";
import { postingsRouter } from "./routes/postings.js";
import { documentsRouter } from "./routes/documents.js";
import {
  ingestRouter,
  batchesRouter,
  ingestsRouter,
} from "./routes/ingest.js";
import { reconcileRouter } from "./routes/reconcile.js";
import { reportsRouter } from "./routes/reports.js";
import { buildInfo } from "./generated/build-info.js";

export function buildApp(): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "25mb" }));

  // ── Meta: spec + docs (registered before context to keep them cheap) ──
  const openApiDoc = buildOpenApiDocument();
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openApiDoc);
  });
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDoc, {
      customSiteTitle: "Receipt Assistant API",
      swaggerOptions: { persistAuthorization: true },
    }),
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "receipt-assistant",
      version: buildInfo.version,
      build: buildInfo,
    });
  });

  app.get("/version", (_req: Request, res: Response) => {
    res.json(buildInfo);
  });

  // ── Per-request context ─────────────────────────────────────────────
  app.use(contextMiddleware);

  // ── v1 resource routers ─────────────────────────────────────────────
  app.use("/v1/accounts", accountsRouter);
  app.use("/v1/transactions", transactionsRouter);
  app.use("/v1/postings", postingsRouter);
  app.use("/v1/documents", documentsRouter);
  app.use("/v1/ingest", ingestRouter);
  // `reconcileRouter` owns `/v1/batches/:id/reconcile*`; mount it first
  // so Express matches its more-specific paths before falling through to
  // the generic `batchesRouter` (which handles `/` and `/:id`).
  app.use("/v1/batches", reconcileRouter);
  app.use("/v1/batches", batchesRouter);
  app.use("/v1/ingests", ingestsRouter);
  app.use("/v1/reports", reportsRouter);

  // ── Final error handler ─────────────────────────────────────────────
  app.use(problemHandler);

  return app;
}
