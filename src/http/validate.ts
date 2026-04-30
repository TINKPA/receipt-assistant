/**
 * Zod → `ValidationProblem` bridge used by route handlers.
 *
 * Throws on validation failure so the central `problemHandler`
 * serializes the error uniformly.
 */
import type { ZodTypeAny, infer as zInfer } from "zod";
import { ValidationProblem } from "./problem.js";

export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
): zInfer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw ValidationProblem.fromZod(result.error);
  }
  return result.data;
}
