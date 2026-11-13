/**
 * Shared v1 Zod schemas: primitives, error envelope, pagination.
 *
 * All schemas call `.openapi(...)` so `@asteasolutions/zod-to-openapi`
 * registers them under `components/schemas`.
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// ── Primitives ─────────────────────────────────────────────────────────

export const Uuid = z.string().uuid().openapi({ format: "uuid", example: "01HXY9F0ABCDEFGHJKMNPQRSTV" });

export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "ISO 4217 3-letter code, uppercase")
  .openapi({ example: "USD" });

/**
 * A currency a posting or account may be denominated in: ISO 4217 cash,
 * or a loyalty-programme unit (#206).
 *
 * The two namespaces are disjoint by shape — ISO codes are three letters
 * and cannot contain an underscore — which is what lets the FX path and
 * the points-valuation path select disjoint sets of postings with a
 * regex instead of a lookup table. See `src/points/codes.ts`.
 *
 * `CurrencyCode` (above) stays cash-only on purpose: a workspace base
 * currency, and therefore a report's reporting currency, must be cash.
 */
export const LedgerCurrencyCode = z
  .string()
  .regex(
    /^([A-Z]{3}|[A-Z][A-Z0-9]{1,12}_PT)$/,
    "ISO 4217 3-letter code, or a points-programme code like HYATT_PT",
  )
  .openapi({ example: "USD" });

export const AmountMinor = z
  .number()
  .int()
  .openapi({
    description:
      "Signed integer in the currency's minor unit (cents for USD, 1 for JPY, satoshi for BTC). " +
      "Never store money as float.",
    example: 14723,
  });

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ format: "date", example: "2026-04-19" });

export const IsoDateTime = z.string().datetime().openapi({ format: "date-time" });

export const Metadata = z
  .record(z.string(), z.unknown())
  .default({})
  .openapi({ description: "User-defined JSON object; not schema-validated." });

// ── Path + query primitives ────────────────────────────────────────────

export const IdParam = z.object({ id: Uuid }).openapi({ title: "IdParam" });

/**
 * A boolean in the query string. Use this, never `z.coerce.boolean()`:
 * that is `Boolean(value)`, and every non-empty string is truthy —
 * `"false"` and `"0"` included — so `?include_retired=false` returned
 * exactly the rows it asked to leave out.
 *
 * Accepts `true` / `1` and `false` / `0` in any case; an empty value is
 * false, as it always was. Anything else is a 422 instead of a silent
 * `true`.
 */
export const QueryBoolean = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0" || v === "") return false;
    return value;
  }, z.boolean())
  .openapi({ type: "boolean" });

// ── Error envelope (RFC 7807) ──────────────────────────────────────────

export const Violation = z
  .object({
    path: z.string(),
    code: z.string(),
    message: z.string().optional(),
  })
  .passthrough()
  .openapi("Violation");

export const ProblemDetails = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    trace_id: z.string().optional(),
    violations: z.array(Violation).optional(),
  })
  .passthrough()
  .openapi("ProblemDetails");

// ── List envelope ──────────────────────────────────────────────────────

/**
 * Wrap a list of items with `next_cursor` (mirror of the Link header,
 * for clients that can't read response headers — looking at you, some
 * fetch polyfills).
 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
