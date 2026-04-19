import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { ErrorResponse, IdParam, ValidationErrorResponse } from "./schemas/common.js";
import { HealthResponse } from "./schemas/health.js";
import {
  Receipt,
  ReceiptWithItems,
  ListReceiptsQuery,
  UploadReceiptForm,
  DeleteReceiptResponse,
} from "./schemas/receipt.js";
import { JobUploadResponse, JobStatusResponse } from "./schemas/job.js";
import { SummaryQuery, SpendingSummary } from "./schemas/summary.js";
import { AskRequest, AskResponse } from "./schemas/ask.js";

export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // Register named schemas so they appear under components/schemas
  registry.register("ErrorResponse", ErrorResponse);
  registry.register("ValidationErrorResponse", ValidationErrorResponse);
  registry.register("HealthResponse", HealthResponse);
  registry.register("Receipt", Receipt);
  registry.register("ReceiptWithItems", ReceiptWithItems);
  registry.register("JobUploadResponse", JobUploadResponse);
  registry.register("JobStatusResponse", JobStatusResponse);
  registry.register("SpendingSummary", SpendingSummary);
  registry.register("AskRequest", AskRequest);
  registry.register("AskResponse", AskResponse);

  // Optional bearer-token auth (only enforced when AUTH_TOKEN env is set)
  const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
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
    method: "post",
    path: "/receipt",
    summary: "Upload a receipt JPG and start async extraction",
    tags: ["receipts"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
      body: {
        content: {
          "multipart/form-data": { schema: UploadReceiptForm },
        },
      },
    },
    responses: {
      200: {
        description: "Job submitted",
        content: { "application/json": { schema: JobUploadResponse } },
      },
      400: {
        description: "Missing or invalid image",
        content: { "application/json": { schema: ErrorResponse } },
      },
      500: {
        description: "Server error",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/jobs/{id}",
    summary: "Poll job status",
    tags: ["jobs"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "Current job status",
        content: { "application/json": { schema: JobStatusResponse } },
      },
      404: {
        description: "Job not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/jobs/{id}/stream",
    summary: "Server-Sent Events stream for job progress",
    description: "Emits `processing`, `done`, or `error` events. Connection closes after terminal event.",
    tags: ["jobs"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "SSE stream",
        content: { "text/event-stream": { schema: z.string() } },
      },
      404: {
        description: "Job not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/receipts",
    summary: "List receipts with optional filters",
    tags: ["receipts"],
    request: { query: ListReceiptsQuery },
    responses: {
      200: {
        description: "Receipts ordered by date desc",
        content: { "application/json": { schema: z.array(Receipt) } },
      },
      400: {
        description: "Invalid query parameter (e.g. malformed date, non-numeric limit)",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/receipt/{id}",
    summary: "Get one receipt with line items",
    tags: ["receipts"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "Receipt detail",
        content: { "application/json": { schema: ReceiptWithItems } },
      },
      404: {
        description: "Receipt not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/receipt/{id}",
    summary: "Delete a receipt (cascades to line items)",
    tags: ["receipts"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: DeleteReceiptResponse } },
      },
      404: {
        description: "Receipt not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/receipt/{id}/image",
    summary: "Serve the original receipt image file",
    tags: ["receipts"],
    request: { params: IdParam },
    responses: {
      200: {
        description: "JPEG image bytes",
        content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } },
      },
      404: {
        description: "Image not found on disk or in DB",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/summary",
    summary: "Spending summary grouped by category",
    tags: ["analytics"],
    request: { query: SummaryQuery },
    responses: {
      200: {
        description: "One row per category, ordered by total_spent desc",
        content: { "application/json": { schema: SpendingSummary } },
      },
      400: {
        description: "Invalid query parameter (e.g. malformed date)",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/ask",
    summary: "Free-form question answered by Claude over your receipts",
    tags: ["analytics"],
    request: {
      body: { content: { "application/json": { schema: AskRequest } } },
    },
    responses: {
      200: {
        description: "Claude's answer",
        content: { "application/json": { schema: AskResponse } },
      },
      400: {
        description: "Missing or invalid `question` field",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
      500: {
        description: "Server error",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

  return registry;
}

export function buildOpenApiDocument() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Receipt Assistant API",
      version: "1.0.0",
      description:
        "REST API for uploading receipts, polling extraction jobs, and querying spending. " +
        "All endpoints accept an optional Bearer token (configured via AUTH_TOKEN env).",
    },
    servers: [{ url: "http://localhost:3000", description: "Local dev" }],
  });
}
