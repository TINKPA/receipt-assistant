/**
 * `/v1/places/*` — shared multilingual place cache (#74).
 *
 * Routes:
 *   GET    /v1/places/:id                       — full place record
 *   PATCH  /v1/places/:id                       — set custom_name
 *   GET    /v1/places/:id/photos/:rank/content  — binary stream of a
 *                                                 cached Google photo
 *
 * Writes for the multilingual / photo fields happen agent-side during
 * ingest (see `src/ingest/prompt.ts` Phase 3); the only writer-facing
 * endpoint here is the `custom_name` patch — the user override that
 * wins over `display_name_zh` in the UI fallback chain.
 */
import { type Request, type Response, type NextFunction, Router } from "express";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { parseOrThrow } from "../http/validate.js";
import { NotFoundProblem } from "../http/problem.js";
import {
  loadPlaceById,
  updatePlace,
  loadPlacePhotoForStream,
  reDerivePlace,
  refreshPlace,
} from "./places.service.js";
import {
  GooglePlacesApiKeyMissing,
  GooglePlacesError,
} from "../google/places-fetch.js";
import {
  GooglePlacesUnavailableProblem,
  GooglePlacesUpstreamProblem,
} from "../http/problem.js";
import {
  Place,
  UpdatePlaceRequest,
  ReDerivePlaceResponse,
  RefreshPlaceResponse,
} from "../schemas/v1/place.js";
import { ProblemDetails, Uuid } from "../schemas/v1/common.js";
import { z } from "zod";

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

export const placesRouter = Router({ mergeParams: true });

placesRouter.get(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const place = await loadPlaceById(id);
    if (!place) throw new NotFoundProblem("Place", id);
    res.json(place);
  }),
);

placesRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const patch = parseOrThrow(UpdatePlaceRequest, req.body ?? {});
    const place = await updatePlace(id, patch);
    if (!place) throw new NotFoundProblem("Place", id);
    res.json(place);
  }),
);

placesRouter.post(
  "/:id/re-derive",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const result = await reDerivePlace(req.ctx.workspaceId, id);
    if (!result) throw new NotFoundProblem("Place", id);
    res.json(result);
  }),
);

placesRouter.post(
  "/:id/refresh",
  ah(async (req, res) => {
    const id = String(req.params.id);
    let result;
    try {
      result = await refreshPlace(req.ctx.workspaceId, id);
    } catch (err) {
      if (err instanceof GooglePlacesApiKeyMissing) {
        throw new GooglePlacesUnavailableProblem();
      }
      if (err instanceof GooglePlacesError) {
        throw new GooglePlacesUpstreamProblem(
          err.status,
          err.googlePlaceId,
          err.languageCode,
        );
      }
      throw err;
    }
    if (!result) throw new NotFoundProblem("Place", id);
    res.json(result);
  }),
);

placesRouter.get(
  "/:id/photos/:rank/content",
  ah(async (req, res) => {
    const id = String(req.params.id);
    const rank = Number.parseInt(String(req.params.rank), 10);
    if (!Number.isFinite(rank) || rank < 0) {
      throw new NotFoundProblem("PlacePhoto", `${id}/${req.params.rank}`);
    }
    const photo = await loadPlacePhotoForStream(id, rank);
    if (!photo) throw new NotFoundProblem("PlacePhoto", `${id}/${rank}`);

    // Sanity: ensure the file is still on disk. Hard delete moves files
    // into .trash/ rather than unlinking (#73), but the place row may
    // outlive a manual cleanup.
    try {
      const st = await stat(photo.file_path);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      throw new NotFoundProblem("PlacePhoto", `${id}/${rank}`);
    }

    res.setHeader("Content-Type", photo.mime_type ?? "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    createReadStream(photo.file_path).pipe(res);
  }),
);

const RankPath = z.object({
  id: Uuid,
  rank: z.string().regex(/^\d+$/),
});

export function registerPlacesOpenApi(registry: OpenAPIRegistry): void {
  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/places/{id}",
    summary: "Get a place by id (full multilingual record).",
    description:
      "Returns the place row with all multilingual columns plus refs to any cached photos. " +
      "Photo bytes are streamed separately via /v1/places/{id}/photos/{rank}/content.",
    tags: ["places"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "Place", content: { "application/json": { schema: Place } } },
      404: { description: "Not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/places/{id}",
    summary: "Update user-overridable place fields.",
    description:
      "Currently exposes only `custom_name` — the user override that wins over " +
      "`display_name_zh` in the UI fallback chain. Pass null to clear.",
    tags: ["places"],
    request: {
      params: z.object({ id: Uuid }),
      body: { content: { "application/json": { schema: UpdatePlaceRequest } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Place } } },
      404: { description: "Not found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/places/{id}/re-derive",
    summary: "Re-run Layer 2 projection over cached raw_response.",
    description:
      "Re-applies the current projection logic to the cached Google " +
      "Places response, overwriting derived columns. Layer 3 user-truth " +
      "(`custom_name`) is never touched. OCR-sourced zh fields " +
      "(`display_name_zh_source IN ('photo_ocr','receipt_ocr')`) are " +
      "preserved verbatim. Every run inserts a `derivation_events` row " +
      "with a `before`/`after` jsonb diff; the returned " +
      "`derivation_event_id` lets you correlate. Returns 422 when " +
      "`raw_response` is NULL.",
    tags: ["places"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Re-derive committed",
        content: { "application/json": { schema: ReDerivePlaceResponse } },
      },
      404: { description: "Place not found", content: problemContent },
      422: {
        description: "Place has no raw_response — nothing to project from",
        content: problemContent,
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/places/{id}/refresh",
    summary: "Re-fetch Google v1 + re-derive Layer 2 in one step.",
    description:
      "Calls Google Places v1 (dual-language, FieldMask=*), appends a " +
      "`place_snapshots` row, overwrites `places.raw_response`, then " +
      "delegates to `/v1/places/{id}/re-derive` so Layer 2 columns " +
      "reflect the new body. Layer 3 (`custom_name`) and OCR-sourced " +
      "zh fields are shielded by the re-derive step. Yelp re-fetch is " +
      "deferred until a Yelp client lands (separate epic). Returns " +
      "503 when `GOOGLE_MAPS_API_KEY` is unset and 502 on upstream errors.",
    tags: ["places"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "Refresh committed",
        content: { "application/json": { schema: RefreshPlaceResponse } },
      },
      404: { description: "Place not found", content: problemContent },
      502: { description: "Google v1 upstream error", content: problemContent },
      503: {
        description: "GOOGLE_MAPS_API_KEY not configured",
        content: problemContent,
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/places/{id}/photos/{rank}/content",
    summary: "Stream the binary of a cached Google Places photo.",
    description:
      "0-based rank within the place's photos[] (as returned by the v1 Places API at " +
      "first fetch). 404 if the rank is out of range or the local file copy is missing.",
    tags: ["places"],
    request: { params: RankPath },
    responses: {
      200: {
        description: "Image bytes",
        content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
      },
      404: { description: "Not found", content: problemContent },
    },
  });
}
