/**
 * Zod → `ValidationProblem` bridge used by route handlers.
 *
 * Replaces the old `parseOr400` helper which returned `null` and wrote
 * a 400 directly. The new contract throws so the central
 * `problemHandler` serializes uniformly.
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
