import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const ErrorResponse = z
  .object({
    error: z.string().openapi({ example: "Not found" }),
  })
  .openapi("ErrorResponse");

export const ValidationErrorResponse = z
  .object({
    error: z.literal("Invalid request"),
    issues: z.array(
      z.object({
        path: z.string().openapi({ example: "limit" }),
        message: z.string().openapi({ example: "Expected number, received string" }),
      })
    ),
  })
  .openapi("ValidationErrorResponse");
