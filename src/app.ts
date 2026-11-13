/**
 * Express app factory — separated from `server.ts` so the listening
 * socket is owned by `server.ts` and the wiring lives here.
 *
 * Middleware stack (order matters):
 *   1. trust-proxy (for correct `req.protocol`)
 *   2. `contextMiddleware` attaches `req.ctx` { workspaceId, userId, traceId }
 *   3. JSON body parsing
 *   4. Meta routes (`/openapi.json`, `/docs`, `/health`, `/version`)
 *   5. Id checks — malformed UUIDs in the path or query → 400
 *   6. Routes — feature-scoped routers mounted under `/v1/*`
 *   7. `routeNotFoundHandler` — anything unclaimed → problem+json 404
 *   8. `problemHandler` — RFC 7807 serialization (ALWAYS last)
 *
 * The `/v1/*` routers are added by feature-specific modules and imported
 * here so the app factory stays a single source of truth for the
 * middleware order.
 */
import express, {
  type Express,
  type Request,
  type Response,
  type Router,
} from "express";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "./openapi.js";
import { contextMiddleware } from "./http/context.js";
import { requireUuidParams, rejectMalformedQueryIds } from "./http/params.js";
import { problemHandler, routeNotFoundHandler } from "./http/problem.js";
import { accountsRouter } from "./routes/accounts.js";
import { transactionsRouter } from "./routes/transactions.js";
import { itemsRouter } from "./routes/items.js";
import { productsRouter } from "./routes/products.js";
import { ownedItemsRouter } from "./routes/owned-items.js";
import { wishItemsRouter } from "./routes/wish-items.js";
import { insightsRouter } from "./routes/insights.js";
import { partiesRouter } from "./routes/parties.js";
import { brandsRouter } from "./routes/brands.js";
import { postingsRouter } from "./routes/postings.js";
import { documentsRouter } from "./routes/documents.js";
import {
  ingestRouter,
  batchesRouter,
  ingestsRouter,
} from "./routes/ingest.js";
import { reconcileRouter } from "./routes/reconcile.js";
import { reportsRouter } from "./routes/reports.js";
import { merchantsRouter } from "./routes/merchants.js";
import { placesRouter } from "./routes/places.js";
import { adminRouter } from "./routes/admin.js";
import { buildInfo } from "./generated/build-info.js";

/**
 * Path parameters that are UUIDs, per router. `requireUuidParams` turns
 * a malformed one into a 400 before the route's handler runs, so this
 * table — not each handler — is where "is this id well-formed?" is
 * decided. A router or parameter absent from it is absent on purpose:
 *
 *   - `:brandId` (brands, parties) is a kebab-case slug;
 *   - `/v1/merchants/:id` accepts a brand slug or a UUID;
 *   - `:rank` (place photos) is an integer.
 *
 * When you add a route with a new UUID path parameter name, add the
 * name here.
 */
const UUID_PATH_PARAMS: ReadonlyArray<readonly [Router, readonly string[]]> = [
  [accountsRouter, ["id"]],
  [transactionsRouter, ["id", "tid", "pid"]],
  [productsRouter, ["id", "assetId"]],
  [ownedItemsRouter, ["id"]],
  [wishItemsRouter, ["id"]],
  [insightsRouter, ["id"]],
  [partiesRouter, ["id"]],
  [brandsRouter, ["assetId"]],
  [postingsRouter, ["id"]],
  [documentsRouter, ["id", "txn_id"]],
  [reconcileRouter, ["id"]],
  [batchesRouter, ["id"]],
  [ingestsRouter, ["id"]],
  [placesRouter, ["id"]],
];

// Param callbacks live on the router objects, which are module
// singletons: register once, however many apps are built.
let uuidParamsRegistered = false;

export function buildApp(): Express {
  const app = express();
  app.set("trust proxy", true);

  // ── Per-request context ─────────────────────────────────────────────
  // First, ahead of the body parser: a request it rejects (malformed
  // JSON, oversized body) must still get a trace id in its error body
  // and in the log line.
  app.use(contextMiddleware);

  app.use(express.json({ limit: "25mb" }));

  // ── Meta: spec + docs ───────────────────────────────────────────────
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

  // ── Malformed ids → 400, before any handler (see http/params.ts) ────
  if (!uuidParamsRegistered) {
    for (const [router, names] of UUID_PATH_PARAMS) {
      requireUuidParams(router, names);
    }
    uuidParamsRegistered = true;
  }
  app.use("/v1", rejectMalformedQueryIds);

  // ── v1 resource routers ─────────────────────────────────────────────
  app.use("/v1/accounts", accountsRouter);
  app.use("/v1/transactions", transactionsRouter);
  app.use("/v1/items", itemsRouter);
  app.use("/v1/products", productsRouter);
  app.use("/v1/owned-items", ownedItemsRouter);
  app.use("/v1/wish-items", wishItemsRouter);
  app.use("/v1/insights", insightsRouter);
  app.use("/v1", partiesRouter);
  app.use("/v1/brands", brandsRouter);
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
  app.use("/v1/merchants", merchantsRouter);
  app.use("/v1/places", placesRouter);
  app.use("/v1/admin", adminRouter);

  // ── Nothing matched → problem+json 404, not Express's HTML page ─────
  app.use(routeNotFoundHandler);

  // ── Final error handler ─────────────────────────────────────────────
  app.use(problemHandler);

  return app;
}
