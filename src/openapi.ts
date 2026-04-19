/**
 * OpenAPI 3.1 document builder.
 *
 * Post-refactor state: the old single-entry `/receipt*` surface has been
 * removed. The new `/v1/*` surface (transactions, accounts, postings,
 * documents) is being built out under issues #35 and #36.
 *
 * For now only meta routes (`/health`, `/openapi.json`, `/docs`) are
 * registered so the spec regeneration stays green while the new resources
 * come online. Each resource registers its own paths in later PRs.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

import {
  ErrorResponse,
  ValidationErrorResponse,
} from "./schemas/common.js";
import { HealthResponse } from "./schemas/health.js";
import { ProblemDetails } from "./schemas/v1/common.js";
import { registerAccountsOpenApi } from "./routes/accounts.js";
import { registerTransactionsOpenApi } from "./routes/transactions.js";
import { registerPostingsOpenApi } from "./routes/postings.js";
import { registerDocumentsOpenApi } from "./routes/documents.js";
import { registerIngestOpenApi } from "./routes/ingest.js";

export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.register("ErrorResponse", ErrorResponse);
  registry.register("ValidationErrorResponse", ValidationErrorResponse);
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

  // v1 resource routers register their own paths + response schemas.
  registerAccountsOpenApi(registry);
  registerTransactionsOpenApi(registry);
  registerPostingsOpenApi(registry);
  registerDocumentsOpenApi(registry);
  registerIngestOpenApi(registry);

  return registry;
}

export function buildOpenApiDocument() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Receipt Assistant API",
      version: "2.0.0-alpha",
      description:
        "Double-entry ledger backend. The v1 resources (transactions, " +
        "postings, accounts, documents) are under active construction — see " +
        "issues #33 (schema), #35 (transactions API), #36 (accounts API).",
    },
    servers: [{ url: "http://localhost:3000", description: "Local dev" }],
  });
}
