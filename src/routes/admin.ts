/**
 * `/v1/admin/*` — operator-facing batch endpoints (#89).
 *
 * Phase 2 ships one route: `POST /v1/admin/re-derive?scope=places`,
 * which walks every `places` row and re-runs Layer 2 projection
 * over its cached `raw_response`. See `places.service.ts ::
 * reDeriveAllPlaces` for behavior + skipping rules and
 * `derivation_events` for the per-row audit trail.
 *
 * Auth: none yet. The endpoint reads `req.ctx.workspaceId` from
 * the seeded single-workspace context — when the auth epic lands,
 * this router will gate on admin role.
 *
 * Future scopes (out of Phase 2 / #89):
 *   - `scope=merchants`   — re-aggregate brand info (#91)
 *   - `scope=documents`   — re-OCR with newer model
 *   - `scope=transactions`— full re-extract (#91)
 */
import { type Request, type Response, type NextFunction, Router } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { parseOrThrow } from "../http/validate.js";
import { reDeriveAllPlaces } from "./places.service.js";
import {
  ReDeriveQuery,
  ReDeriveBatchResponse,
} from "../schemas/v1/place.js";
import { ProblemDetails } from "../schemas/v1/common.js";

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export const adminRouter = Router({ mergeParams: true });

adminRouter.post(
  "/re-derive",
  ah(async (req, res) => {
    const { scope } = parseOrThrow(ReDeriveQuery, req.query);
    // Phase 2 only knows about `places`. The schema enum already
    // narrows the type, so this switch is here for the structural
    // slot when more scopes land.
    switch (scope) {
      case "places": {
        const out = await reDeriveAllPlaces(req.ctx.workspaceId);
        res.json(out);
        return;
      }
    }
  }),
);

export function registerAdminOpenApi(registry: OpenAPIRegistry): void {
  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "post",
    path: "/v1/admin/re-derive",
    summary: "Re-run Layer 2 projection across every row in scope.",
    description:
      "Phase 2 (#89): scope=places walks every `places` row and " +
      "re-runs the projection over its cached `raw_response`. Rows " +
      "with `raw_response IS NULL` are counted as `skipped` (not " +
      "errored). Each updated row produces a `derivation_events` " +
      "entry — including no-op runs that match the current state, " +
      "so a version bump is auditable even when nothing visibly " +
      "changes. Sync execution at current corpus scale (<1 s for " +
      "tens to low hundreds of places).",
    tags: ["admin"],
    request: { query: ReDeriveQuery },
    responses: {
      200: {
        description: "Batch summary",
        content: { "application/json": { schema: ReDeriveBatchResponse } },
      },
      422: {
        description: "Invalid scope",
        content: problemContent,
      },
    },
  });
}
