/**
 * OpenAPI 3.1 document builder.
 *
 * Post-refactor state: the old single-entry `/receipt*` surface has been
 * removed; the `/v1/*` surface replaced it (issues #35 and #36).
 *
 * This module owns only the shared components (error / health / problem
 * schemas, the bearer security scheme) and the two meta paths `/health`
 * and `/version`. Every `/v1` resource registers its own paths and
 * response schemas through the `registerXOpenApi(registry)` calls in
 * `buildRegistry()` below, so a new endpoint is added next to its route
 * handler rather than here. (`/openapi.json` and `/docs` are served by
 * `src/app.ts` and are deliberately absent from the spec itself.)
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

import {
  ErrorResponse,
  ValidationErrorResponse,
} from "./schemas/common.js";
import { BuildInfoResponse, HealthResponse } from "./schemas/health.js";
import { ProblemDetails } from "./schemas/v1/common.js";
import { registerAccountsOpenApi } from "./routes/accounts.js";
import { registerTransactionsOpenApi } from "./routes/transactions.js";
import { registerItemsOpenApi } from "./routes/items.js";
import { registerProductsOpenApi } from "./routes/products.js";
import { registerOwnedItemsOpenApi } from "./routes/owned-items.js";
import { registerWishItemsOpenApi } from "./routes/wish-items.js";
import { registerInsightsOpenApi } from "./routes/insights.js";
import { registerPartiesOpenApi } from "./routes/parties.js";
import { registerBrandsOpenApi } from "./routes/brands.js";
import { registerPostingsOpenApi } from "./routes/postings.js";
import { registerDocumentsOpenApi } from "./routes/documents.js";
import { registerIngestOpenApi } from "./routes/ingest.js";
import { registerReconcileOpenApi } from "./routes/reconcile.js";
import { registerReportsOpenApi } from "./routes/reports.js";
import { registerMerchantsOpenApi } from "./routes/merchants.js";
import { registerPlacesOpenApi } from "./routes/places.js";
import { registerAdminOpenApi } from "./routes/admin.js";

export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.register("ErrorResponse", ErrorResponse);
  registry.register("ValidationErrorResponse", ValidationErrorResponse);
  registry.register("BuildInfoResponse", BuildInfoResponse);
  registry.register("HealthResponse", HealthResponse);
  registry.register("ProblemDetails", ProblemDetails);

  // Bearer-token scheme reserved for the upcoming /v1 auth epic.
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Health check",
    tags: ["meta"],
    responses: {
      200: {
        description: "Service is up",
        content: { "application/json": { schema: HealthResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/version",
    summary: "Build metadata",
    tags: ["meta"],
    responses: {
      200: {
        description: "Deployed build metadata",
        content: { "application/json": { schema: BuildInfoResponse } },
      },
    },
  });

  // v1 resource routers register their own paths + response schemas.
  registerAccountsOpenApi(registry);
  registerTransactionsOpenApi(registry);
  registerItemsOpenApi(registry);
  registerProductsOpenApi(registry);
  registerOwnedItemsOpenApi(registry);
  registerWishItemsOpenApi(registry);
  registerInsightsOpenApi(registry);
  registerPartiesOpenApi(registry);
  registerBrandsOpenApi(registry);
  registerPostingsOpenApi(registry);
  registerDocumentsOpenApi(registry);
  registerIngestOpenApi(registry);
  registerReconcileOpenApi(registry);
  registerReportsOpenApi(registry);
  registerMerchantsOpenApi(registry);
  registerPlacesOpenApi(registry);
  registerAdminOpenApi(registry);

  return registry;
}

/**
 * Responses every `/v1` operation can produce without its handler ever
 * running, because they come from the shared layer in `src/http/`
 * (`params.ts`, `problem.ts`). They are declared once here and attached
 * to each operation below, so the spec says what the server does
 * without 100 route registrations repeating it.
 */
const SHARED_RESPONSES = {
  BadRequest: {
    status: "400",
    description:
      "Malformed request: an id in the path or query string is not a UUID " +
      "(`errors/invalid-id`), the body is not valid JSON " +
      "(`errors/malformed-body`), the cursor is not one this endpoint " +
      "issued (`errors/invalid-cursor`), a value cannot be read as its " +
      "type (`errors/invalid-parameter`), or the `Idempotency-Key` is too " +
      "long (`errors/invalid-idempotency-key`).",
  },
} as const;

export function buildOpenApiDocument() {
  const registry = buildRegistry();

  for (const [name, r] of Object.entries(SHARED_RESPONSES)) {
    registry.registerComponent("responses", name, {
      description: r.description,
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/ProblemDetails" },
        },
      },
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);

  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Receipt Assistant API",
      version: "2.0.0-alpha",
      description:
        "Double-entry ledger backend. The v1 resources (transactions, " +
        "postings, accounts, documents) are under active construction — see " +
        "issues #33 (schema), #35 (transactions API), #36 (accounts API).\n\n" +
        "Every error is an RFC 7807 `application/problem+json` document " +
        "with a `trace_id`; branch on `type`, not on `title` or `detail`. " +
        "A URL or method no route claims is a 404 `errors/route-not-found`. " +
        "Database constraint failures surface as 409 (`errors/conflict`, " +
        "`errors/still-referenced`) or 422 (`errors/invalid-reference`, " +
        "`errors/constraint-violation`). An unexpected failure is a 500 " +
        "`errors/internal` whose body is a fixed sentence plus the " +
        "`trace_id`; the cause is only in the server log, under that id.",
    },
    servers: [{ url: "http://localhost:3000", description: "Local dev" }],
  });

  // A route that documents its own 400 keeps it.
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith("/v1/")) continue;
    for (const op of Object.values(item as Record<string, unknown>)) {
      const responses = (op as { responses?: Record<string, unknown> } | null)
        ?.responses;
      if (!responses) continue;
      for (const [name, r] of Object.entries(SHARED_RESPONSES)) {
        responses[r.status] ??= { $ref: `#/components/responses/${name}` };
      }
    }
  }

  return doc;
}
