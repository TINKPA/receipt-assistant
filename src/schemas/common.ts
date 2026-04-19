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

export const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
  .refine((s) => {
    // Reject impossible calendar values like 2026-13-99 by round-tripping
    // through Date and confirming no auto-correction occurred.
    const d = new Date(s + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a valid calendar date")
  .openapi({ example: "2026-04-19", description: "ISO date YYYY-MM-DD" });

export const IdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "abc123" }),
});
