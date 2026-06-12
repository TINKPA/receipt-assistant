/**
 * `insights` zod schema (v2 redesign P5, #149) — discovered cards +
 * the natural-language ask contract.
 */
import { z } from "zod";
import { IsoDateTime, Metadata, Uuid } from "./common.js";

export const InsightKind = z.enum(["anomaly", "trend", "milestone", "opportunity"]);

export const Insight = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    kind: InsightKind,
    title: z.string(),
    body: z.string(),
    dedupe_key: z.string(),
    /** Presentation payload: { deep_link?, figures?, bars? } — rendered verbatim. */
    payload: Metadata,
    dismissed_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Insight");

export const RefreshInsightsResponse = z
  .object({
    /** Cards produced or refreshed by this run. */
    generated: z.number().int(),
  })
  .openapi("RefreshInsightsResponse");

export const AskRequest = z
  .object({
    question: z.string().min(3).max(500),
  })
  .openapi("AskRequest");

export const AskResponse = z
  .object({
    answer: z.string(),
    /** Claude session id — the Langfuse trace key for this answer. */
    session_id: z.string(),
    elapsed_ms: z.number().int(),
  })
  .openapi("AskResponse");
