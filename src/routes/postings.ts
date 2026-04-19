/**
 * Read-only `/v1/postings` endpoints.
 *
 * Postings are created/mutated through the nested routes on
 * `/v1/transactions/:id/postings*`; this router exists so clients can
 * query postings flat (by account, date range, or transaction id)
 * without round-tripping through their parent transactions.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { parseOrThrow } from "../http/validate.js";
import { emitNextLink } from "../http/pagination.js";
import {
  ListPostingsQuery,
  Posting as PostingSchema,
} from "../schemas/v1/transaction.js";
import { listPostings, getPosting } from "./transactions.service.js";
import { ProblemDetails, paginated, Uuid } from "../schemas/v1/common.js";

export const postingsRouter: Router = Router();

postingsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListPostingsQuery, req.query);
      const result = await listPostings(req.ctx.workspaceId, query);
      emitNextLink(req, res, result.next_cursor);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

postingsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = parseOrThrow(z.object({ id: Uuid }), req.params);
      const result = await getPosting(req.ctx.workspaceId, params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export function registerPostingsOpenApi(registry: OpenAPIRegistry): void {
  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/postings",
    summary: "List postings",
    tags: ["postings"],
    request: { query: ListPostingsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(PostingSchema) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/postings/{id}",
    summary: "Get a posting",
    tags: ["postings"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: PostingSchema } },
      },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
