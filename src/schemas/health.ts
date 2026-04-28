import { z } from "zod";
import "./common.js";

export const BuildInfoResponse = z
  .object({
    service: z.string().openapi({ example: "receipt-assistant" }),
    version: z.string().openapi({ example: "1.0.0" }),
    gitSha: z.string().openapi({ example: "a02db01234567890abcdef1234567890abcdef12" }),
    gitShortSha: z.string().openapi({ example: "a02db01" }),
    gitBranch: z.string().openapi({ example: "main" }),
    builtAt: z.string().datetime().openapi({ example: "2026-04-27T22:00:35.000Z" }),
  })
  .openapi("BuildInfoResponse");

export const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.string().openapi({ example: "receipt-assistant" }),
    version: z.string().openapi({ example: "1.0.0" }),
    build: BuildInfoResponse,
  })
  .openapi("HealthResponse");
