/**
 * Centralized zod → HTTP 400 mapping for Express handlers.
 *
 * Use `parseOr400(schema, data, res)` in handlers; on validation failure
 * it writes a 400 response and returns null. On success it returns the
 * typed parsed value. Caller should `if (!parsed) return;` and use it.
 */
import type { Response } from "express";
import { ZodError, type ZodTypeAny, type infer as zInfer } from "zod";

export function parseOr400<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  res: Response
): zInfer<S> | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  res.status(400).json({
    error: "Invalid request",
    issues: formatZodIssues(result.error),
  });
  return null;
}

function formatZodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}
