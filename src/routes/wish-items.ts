/**
 * `/v1/wish-items` — wishlist CRUD (v2 redesign P3, tracking #149).
 *
 * The mirror of owned-items, run forward: target price + planned days
 * project a $/day before purchase. Lifecycle via PATCH `status`:
 * active → converted (optionally carrying the realizing transaction)
 * | declined; snoozing is a date, not a status, so a parked wish keeps
 * its urgency.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import multer from "multer";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishItems, products, places } from "../schema/index.js";
import { startCapture, retryCapture, wishImageRoot, removeWishImageIfUnused } from "../wish/capture.js";
import { distanceM, linkGooglePlace, matchPlaceByText, workspaceArea, type PlaceLink, type PlaceMatch } from "../wish/places.js";
import { settleWishesSafely } from "../wish/loop.js";
import { nameTokens } from "../wish/names.js";
import { safeHttpUrl } from "../wish/reading.js";
import { liveTransactions } from "../db/live.js";
import {
  searchPlacesByText,
  TextSearchError,
  TextSearchKeyMissing,
} from "../google/text-search.js";
import { resolveStoredFile, sendStoredFile, setStoredImageHeaders, storedImageEtag } from "../http/files.js";
import { metadataPatchSet } from "../projection/metadata-patch.js";
import { parseOrThrow } from "../http/validate.js";
import {
  WishItem,
  CreateWishItemRequest,
  UpdateWishItemRequest,
  ListWishItemsQuery,
  CaptureWishForm,
  WishPlaceSearchQuery,
  WishPlaceSearchResponse,
} from "../schemas/v1/wish-item.js";
import { ProblemDetails, paginated, Uuid } from "../schemas/v1/common.js";
import { HttpProblem, NotFoundProblem, ValidationProblem } from "../http/problem.js";
import {
  clampLimit,
  encodeCursor,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  emitNextLink,
} from "../http/pagination.js";

export const wishItemsRouter: Router = Router();

// `application/merge-patch+json` (RFC 7396) — see owned-items.ts for why.
wishItemsRouter.use(
  express.json({ type: "application/merge-patch+json", limit: "1mb" }),
);

interface WishItemsCursor {
  updated_at: string;
  id: string;
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  // A raw `db.execute` row carries Postgres' text form
  // ("2026-11-20 10:04:36.006057+00"), which is not ISO 8601 and which
  // some browsers' Date cannot parse.
  const s = String(v);
  const d = new Date(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function toIsoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  return String(v);
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** `SELECT … FROM wish_items w` with the matched place beside it. Every
 *  read goes through this so a row looks the same from every route. */
const WISH_SELECT = sql`
  SELECT w.*,
         pl.google_place_id AS pl_google_place_id,
         coalesce(pl.custom_name, pl.display_name_en) AS pl_name,
         pl.display_name_zh AS pl_name_zh,
         coalesce(pl.formatted_address_en, pl.formatted_address) AS pl_formatted_address,
         pl.lat AS pl_lat, pl.lng AS pl_lng,
         pl.google_maps_uri AS pl_google_maps_uri,
         pl.primary_type AS pl_primary_type,
         pl.rating AS pl_rating,
         comp.locality AS pl_locality,
         comp.neighborhood AS pl_neighborhood,
         ct.occurred_on::text AS ct_occurred_on,
         ct.payee AS ct_payee,
         ct_total.total AS ct_total_minor,
         ws.base_currency AS ct_currency,
         ARRAY(SELECT o.id FROM wish_items o
                WHERE o.workspace_id = w.workspace_id AND o.place_id = w.place_id AND o.id <> w.id
                  -- Places only: visiting a place settles no thing to buy
                  -- that happens to name it.
                  AND w.kind = 'place' AND o.kind = 'place'
                ORDER BY o.created_at, o.id) AS same_place_ids
    FROM wish_items w
    JOIN workspaces ws ON ws.id = w.workspace_id
    -- Live only: a deleted proof is no proof (src/wish/loop.ts un-converts).
    LEFT JOIN ${liveTransactions} ct ON ct.id = w.converted_transaction_id AND ct.workspace_id = w.workspace_id
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(p.amount_base_minor) FILTER (WHERE a.type = 'expense'), 0) AS total
        FROM postings p JOIN accounts a ON a.id = p.account_id
       WHERE p.transaction_id = ct.id
    ) ct_total ON ct.id IS NOT NULL
    LEFT JOIN places pl ON pl.id = w.place_id
    LEFT JOIN LATERAL (
      SELECT max(c->>'longText') FILTER (WHERE c->'types' ? 'locality') AS locality,
             max(c->>'longText') FILTER (WHERE c->'types' ? 'neighborhood' OR c->'types' ? 'sublocality_level_1') AS neighborhood
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(pl.raw_response->'v1'->'en'->'addressComponents') = 'array'
                    THEN pl.raw_response->'v1'->'en'->'addressComponents' ELSE '[]'::jsonb END) c
    ) comp ON TRUE`;

async function loadWish(workspaceId: string, id: string) {
  const res = await db.execute(
    sql`${WISH_SELECT} WHERE w.id = ${id}::uuid AND w.workspace_id = ${workspaceId}::uuid`,
  );
  if (res.rows.length === 0) throw new NotFoundProblem("WishItem", id);
  return rowToDto(res.rows[0]);
}

/** A guessed place still waiting for the person: tentative, not linked,
 *  and not answered (`capture.user_set.place`). */
function placeSuggestion(placeId: string | null, capture: any) {
  const m = capture?.place_match;
  if (placeId || !m || m.tentative !== true || !m.google_place_id || capture?.user_set?.place) return null;
  return {
    google_place_id: String(m.google_place_id),
    name: m.name ?? null,
    formatted_address: m.formatted_address ?? null,
    reason: m.tentative_reason ?? null,
  };
}

function uuidList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  // node-postgres leaves a uuid[] it has no parser for as "{a,b}".
  if (typeof v === "string" && v.startsWith("{")) return v.slice(1, -1).split(",").filter(Boolean);
  return [];
}

function rowToDto(row: any) {
  const placeId = row.placeId ?? row.place_id ?? null;
  return {
    id: row.id,
    kind: row.kind ?? "thing",
    place_id: placeId,
    place:
      placeId && row.pl_google_place_id
        ? {
            id: placeId,
            google_place_id: row.pl_google_place_id,
            name: row.pl_name ?? null,
            name_zh: row.pl_name_zh ?? null,
            formatted_address: row.pl_formatted_address ?? null,
            locality: row.pl_locality ?? null,
            neighborhood: row.pl_neighborhood ?? null,
            lat: numOrNull(row.pl_lat),
            lng: numOrNull(row.pl_lng),
            google_maps_uri: row.pl_google_maps_uri ?? null,
            primary_type: row.pl_primary_type ?? null,
            rating: numOrNull(row.pl_rating),
          }
        : null,
    place_suggestion: placeSuggestion(placeId, row.capture ?? null),
    same_place_wish_ids: placeId ? uuidList(row.same_place_ids) : [],
    // Only http(s) leaves the server, whatever an older row holds.
    source_url: safeHttpUrl(row.sourceUrl ?? row.source_url ?? null),
    has_image: Boolean(row.imagePath ?? row.image_path),
    capture_status: row.captureStatus ?? row.capture_status ?? null,
    capture: row.capture ?? null,
    workspace_id: row.workspaceId ?? row.workspace_id,
    product_id: row.productId ?? row.product_id ?? null,
    title: row.title,
    notes: row.notes ?? null,
    target_price_minor:
      (row.targetPriceMinor ?? row.target_price_minor) === null ||
      (row.targetPriceMinor ?? row.target_price_minor) === undefined
        ? null
        : Number(row.targetPriceMinor ?? row.target_price_minor),
    currency: row.currency ?? "USD",
    planned_days:
      (row.plannedDays ?? row.planned_days) === null ||
      (row.plannedDays ?? row.planned_days) === undefined
        ? null
        : Number(row.plannedDays ?? row.planned_days),
    urgency: row.urgency ?? "someday",
    snoozed_until: toIsoDateOrNull(row.snoozedUntil ?? row.snoozed_until),
    status: row.status ?? "active",
    converted_transaction_id:
      row.convertedTransactionId ?? row.converted_transaction_id ?? null,
    converted_at: row.converted_at ? toIsoString(row.converted_at) : null,
    converted_by: row.converted_by ?? null,
    converted_transaction:
      row.converted_transaction_id && row.ct_occurred_on
        ? {
            id: row.converted_transaction_id,
            occurred_on: String(row.ct_occurred_on).slice(0, 10),
            payee: row.ct_payee ?? null,
            total_minor: Number(row.ct_total_minor ?? 0),
            currency: row.ct_currency,
          }
        : null,
    metadata: row.metadata ?? {},
    created_at: toIsoString(row.createdAt ?? row.created_at),
    updated_at: toIsoString(row.updatedAt ?? row.updated_at),
  };
}

async function assertPlaceExists(placeId: string): Promise<void> {
  const rows = await db.select({ id: places.id }).from(places).where(eq(places.id, placeId));
  if (rows.length === 0) {
    throw new ValidationProblem([{ path: "place_id", code: "not_found", message: `Place ${placeId} does not exist` }]);
  }
}

async function assertTransactionInWorkspace(workspaceId: string, txnId: string): Promise<void> {
  const res = await db.execute(sql`SELECT 1 FROM ${liveTransactions} WHERE id = ${txnId}::uuid AND workspace_id = ${workspaceId}::uuid`);
  if (res.rows.length === 0) {
    throw new ValidationProblem([
      { path: "converted_transaction_id", code: "not_found", message: `Transaction ${txnId} is not a live transaction of this workspace` },
    ]);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A conversion time the person sent: not before the wish was made (a
 *  day's grace, since the client may send the start of a local day) and
 *  not in the future (a day's grace for clocks). */
function assertConvertedAt(at: Date, createdAt: Date): void {
  if (Number.isNaN(at.getTime())) {
    throw new ValidationProblem([{ path: "converted_at", code: "invalid_date", message: "converted_at is not a real date and time" }]);
  }
  if (at.getTime() < createdAt.getTime() - DAY_MS || at.getTime() > Date.now() + DAY_MS) {
    throw new ValidationProblem([
      {
        path: "converted_at",
        code: "out_of_range",
        message: `converted_at must be between the day the wish was made (${createdAt.toISOString()}) and now`,
      },
    ]);
  }
}

/** Does any candidate share a word with what was searched for? Google
 *  answers a query it cannot make sense of with whatever it has; that is
 *  no answer. */
function anyRelevant(query: string, candidates: { name: string | null; formatted_address: string | null; primary_type: string | null }[]): boolean {
  const q = new Set(nameTokens(query).filter((t) => t.length >= 2 || /\p{Script=Han}/u.test(t)));
  if (q.size === 0) return true;
  return candidates.some((c) =>
    nameTokens(`${c.name ?? ""} ${c.formatted_address ?? ""} ${(c.primary_type ?? "").replace(/_/g, " ")}`).some((t) => q.has(t)),
  );
}

/** A Google place id the person picked, stored and linked, or the HTTP
 *  answer for why not. */
async function placeFromGoogleId(googlePlaceId: string): Promise<string> {
  const link: PlaceLink = await linkGooglePlace(googlePlaceId, null);
  if (link.placeId) return link.placeId;
  switch (link.errorKind) {
    case "key_missing":
      throw new HttpProblem(503, "google-places-unavailable", "Place lookup is not configured", "The server has no Google Maps key.");
    case "not_found":
      throw new ValidationProblem([{ path: "google_place_id", code: "not_found", message: `Google has no place ${googlePlaceId}` }]);
    case "not_projectable":
      throw new ValidationProblem([{ path: "google_place_id", code: "not_projectable", message: "Google's record of this place has no address or location" }]);
    default:
      throw new HttpProblem(502, "google-places-upstream", "Google place fetch failed", "Fetching the place from Google failed; try again.");
  }
}

// ── GET /v1/wish-items/place-search ────────────────────────────────────
//
// Candidates for a person to pick from when the automatic match was wrong
// or missing. Registered before `/:id` so the path is not read as an id.

wishItemsRouter.get(
  "/place-search",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(WishPlaceSearchQuery, req.query);
      let text = query.q;
      let biasedToLocality = false;
      if (query.near) {
        const near = await db.execute(sql`
          SELECT capture->'reading'->>'locality' AS locality FROM wish_items
           WHERE id = ${query.near}::uuid AND workspace_id = ${req.ctx.workspaceId}::uuid`);
        if (near.rows.length === 0) throw new NotFoundProblem("WishItem", query.near);
        const locality = (near.rows[0] as { locality: string | null }).locality?.trim();
        if (locality && !text.toLowerCase().includes(locality.toLowerCase())) {
          text = `${text} ${locality}`;
          biasedToLocality = true;
        }
      }
      // Without a locality from the image, prefer the person's own area.
      const area = biasedToLocality ? null : await workspaceArea(req.ctx.workspaceId);
      try {
        const found = await searchPlacesByText(text, { maxResults: 5, locationBias: area });
        // The bias is only a preference to Google; a text match far away
        // ("SUGARFISH Little Italy", San Diego, for "Sugarfish Little
        // Tokyo") can still come first. Places inside the area go first,
        // each group in Google's order.
        const inside = (c: { lat: number | null; lng: number | null }) =>
          area && c.lat !== null && c.lng !== null && distanceM(area, { lat: c.lat, lng: c.lng }) <= area.radiusM ? 0 : 1;
        const ranked = area ? found.map((c, i) => ({ c, i, k: inside(c) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.c) : found;
        const candidates = anyRelevant(query.q, ranked) ? ranked : [];
        res.json(WishPlaceSearchResponse.parse({ query: text, location_biased: area !== null, candidates }));
      } catch (err) {
        if (err instanceof TextSearchKeyMissing) {
          throw new HttpProblem(503, "google-places-unavailable", "Place search is not configured", "The server has no Google Maps key.");
        }
        if (err instanceof TextSearchError) {
          throw new HttpProblem(502, "google-places-upstream", "Google place search failed", `Google answered: ${err.reason}.`);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/wish-items/capture ────────────────────────────────────────
//
// One image in, one wish out, at once: the row comes back with
// `capture_status: "reading"` and a placeholder title, and fills in when
// the reading ends (src/wish/capture.ts). Clients poll the row.

const captureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

wishItemsRouter.post(
  "/capture",
  captureUpload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new ValidationProblem([{ path: "file", code: "required", message: "Send one image in the multipart field `file`" }]);
      }
      const note = typeof req.body?.note === "string" && req.body.note.trim() !== "" ? req.body.note.trim().slice(0, 2000) : null;
      const started = await startCapture({ workspaceId: req.ctx.workspaceId, bytes: req.file.buffer, note });
      // The same image again is the wish it already made: 200, not read again.
      res.status(started.existing ? 200 : 202).json(await loadWish(req.ctx.workspaceId, started.id));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/wish-items/:id/capture/retry ──────────────────────────────

wishItemsRouter.post(
  "/:id/capture/retry",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      await loadWish(req.ctx.workspaceId, id); // 404 before 409
      await retryCapture(req.ctx.workspaceId, id);
      res.status(202).json(await loadWish(req.ctx.workspaceId, id));
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/wish-items/:id/image ───────────────────────────────────────

wishItemsRouter.get(
  "/:id/image",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const rows = await db
        .select({ path: wishItems.imagePath, sha: wishItems.imageSha256, mime: wishItems.imageMimeType })
        .from(wishItems)
        .where(and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)));
      const abs = await resolveStoredFile(wishImageRoot(), rows[0]?.path);
      if (!abs || !rows[0]?.sha) throw new NotFoundProblem("WishItem image", id);
      const etag = storedImageEtag(rows[0].sha);
      setStoredImageHeaders(res, rows[0].mime);
      res.setHeader("ETag", etag);
      // The bytes behind a sha never change; private because it is the
      // person's own screenshot.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      await sendStoredFile(res, abs);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/wish-items ─────────────────────────────────────────────────

wishItemsRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseOrThrow(ListWishItemsQuery, req.query);
      const limit = clampLimit(query.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = decodeCursor<WishItemsCursor>(query.cursor ?? undefined, [
        "updated_at",
        "id",
      ]);

      const conditions: ReturnType<typeof sql>[] = [];
      conditions.push(sql`w.workspace_id = ${req.ctx.workspaceId}::uuid`);
      if (query.status) conditions.push(sql`w.status = ${query.status}`);
      if (query.urgency) conditions.push(sql`w.urgency = ${query.urgency}`);
      if (query.kind) conditions.push(sql`w.kind = ${query.kind}`);
      if (cursor) {
        conditions.push(
          sql`(w.updated_at, w.id) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const where = sql.join(conditions, sql` AND `);
      const rowsRes = await db.execute(
        sql`${WISH_SELECT} WHERE ${where} ORDER BY w.updated_at DESC, w.id DESC LIMIT ${limit + 1}`,
      );
      const rows = rowsRes.rows as any[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map(rowToDto);
      const nextCursor = hasMore
        ? encodeCursor({
            // The database's own text, microseconds kept: an ISO string
            // cut to milliseconds would skip rows inside that millisecond.
            updated_at: page[page.length - 1]!.updated_at instanceof Date
              ? (page[page.length - 1]!.updated_at as Date).toISOString()
              : String(page[page.length - 1]!.updated_at),
            id: page[page.length - 1]!.id,
          })
        : null;

      emitNextLink(req, res, nextCursor);
      res.json({ items, next_cursor: nextCursor });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /v1/wish-items/:id ─────────────────────────────────────────────

wishItemsRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await loadWish(req.ctx.workspaceId, String(req.params.id)));
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /v1/wish-items ────────────────────────────────────────────────

wishItemsRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOrThrow(CreateWishItemRequest, req.body);
      if (body.product_id) {
        const prodRows = await db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.id, body.product_id),
              eq(products.workspaceId, req.ctx.workspaceId),
            ),
          );
        if (prodRows.length === 0) {
          throw new ValidationProblem([
            {
              path: "product_id",
              code: "not_found",
              message: `Product ${body.product_id} not in workspace`,
            },
          ]);
        }
      }
      if (body.place_id && body.google_place_id) {
        throw new ValidationProblem([{ path: "google_place_id", code: "conflict", message: "Send place_id or google_place_id, not both" }]);
      }
      if (body.place_id) await assertPlaceExists(body.place_id);
      // A place sent without a kind is a place wish: as a thing wish its
      // place would never be matched by a visit.
      const kind = body.kind ?? (body.place_id || body.google_place_id ? "place" : "thing");
      // A picked place is stored before the row, so a failure leaves no row.
      const placeId = body.place_id ?? (body.google_place_id ? await placeFromGoogleId(body.google_place_id) : null);
      // A place wish typed in with only a name: match it now, as a capture
      // would. A miss leaves it unmatched with the reason on the row.
      // A name Google answers with another place is only a suggestion.
      let placeMatch: PlaceMatch | null = null;
      if (kind === "place" && !placeId) {
        // A bare name says nothing about where: only a place in the
        // workspace's own area is linked, anything else is a suggestion.
        const area = await workspaceArea(req.ctx.workspaceId);
        placeMatch = await matchPlaceByText(body.title, "title", null, {
          names: [body.title],
          locationBias: area,
          requireInArea: area,
        });
        if (placeMatch.error) console.warn(`[wish] typed place "${body.title.slice(0, 80)}" not linked: ${placeMatch.error}`);
        else if (placeMatch.tentative) console.log(`[wish] typed place "${body.title.slice(0, 80)}" suggested, not linked: ${placeMatch.name ?? "?"}`);
      }
      const inserted = await db
        .insert(wishItems)
        .values({
          workspaceId: req.ctx.workspaceId,
          productId: body.product_id ?? null,
          kind,
          placeId: placeId ?? placeMatch?.place_id ?? null,
          sourceUrl: body.source_url ?? null,
          title: body.title,
          notes: body.notes ?? null,
          targetPriceMinor: body.target_price_minor ?? null,
          currency: body.currency ?? "USD",
          plannedDays: body.planned_days ?? null,
          urgency: body.urgency ?? "someday",
          snoozedUntil: body.snoozed_until ?? null,
          capture: placeMatch ? { place_match: placeMatch } : null,
          metadata: body.metadata ?? {},
        })
        .returning({ id: wishItems.id, placeId: wishItems.placeId, productId: wishItems.productId });
      const row = inserted[0]!;
      if (row.placeId || row.productId) await settleWishesSafely({ wishIds: [row.id] });
      res.status(201).json(await loadWish(req.ctx.workspaceId, row.id));
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /v1/wish-items/:id ───────────────────────────────────────────

wishItemsRouter.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const body = parseOrThrow(UpdateWishItemRequest, req.body);
      if (body.place_id !== undefined && body.google_place_id !== undefined) {
        throw new ValidationProblem([{ path: "google_place_id", code: "conflict", message: "Send place_id or google_place_id, not both" }]);
      }
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates["title"] = body.title;
      if (body.kind !== undefined) updates["kind"] = body.kind;
      if (body.place_id !== undefined) {
        if (body.place_id) await assertPlaceExists(body.place_id);
        updates["placeId"] = body.place_id;
      }
      if (body.source_url !== undefined) updates["sourceUrl"] = body.source_url;
      if (body.product_id !== undefined) updates["productId"] = body.product_id;
      if (body.notes !== undefined) updates["notes"] = body.notes;
      if (body.target_price_minor !== undefined)
        updates["targetPriceMinor"] = body.target_price_minor;
      if (body.currency !== undefined) updates["currency"] = body.currency;
      if (body.planned_days !== undefined) updates["plannedDays"] = body.planned_days;
      if (body.urgency !== undefined) updates["urgency"] = body.urgency;
      if (body.snoozed_until !== undefined) updates["snoozedUntil"] = body.snoozed_until;
      if (
        Object.keys(updates).length === 0 &&
        body.metadata === undefined &&
        body.google_place_id === undefined &&
        body.status === undefined &&
        body.converted_transaction_id === undefined &&
        body.converted_at === undefined
      ) {
        throw new HttpProblem(
          400,
          "no-fields",
          "No editable fields supplied",
          "PATCH /v1/wish-items/:id needs at least one field to update.",
        );
      }
      if (body.converted_transaction_id) {
        await assertTransactionInWorkspace(req.ctx.workspaceId, body.converted_transaction_id);
      }
      const where = and(
        eq(wishItems.id, id),
        eq(wishItems.workspaceId, req.ctx.workspaceId),
      );
      // 404 before a Google call for a wish that is not there.
      const exists = await db.select({ id: wishItems.id }).from(wishItems).where(where);
      if (exists.length === 0) throw new NotFoundProblem("WishItem", id);
      if (body.google_place_id !== undefined) {
        updates["placeId"] = await placeFromGoogleId(body.google_place_id);
      }
      // A place wish with no place, named now (a failed capture the
      // person names, an unmatched one renamed): looked up as a typed
      // place wish is, outside the transaction (a Google call). Not when
      // the person removed a place by hand, or sends one now.
      let namedMatch: PlaceMatch | null = null;
      if (body.title !== undefined && body.place_id === undefined && body.google_place_id === undefined) {
        const [w] = await db
          .select({ kind: wishItems.kind, placeId: wishItems.placeId, title: wishItems.title, capture: wishItems.capture })
          .from(wishItems)
          .where(where);
        const userSetPlace = Boolean((w?.capture as { user_set?: { place?: unknown } } | null)?.user_set?.place);
        if (w && (body.kind ?? w.kind) === "place" && !w.placeId && !userSetPlace && body.title.trim() !== w.title.trim()) {
          const area = await workspaceArea(req.ctx.workspaceId);
          namedMatch = await matchPlaceByText(body.title, "title", null, { names: [body.title], locationBias: area, requireInArea: area });
          if (namedMatch.error) console.warn(`[wish] named place "${body.title.slice(0, 80)}" not linked: ${namedMatch.error}`);
          else if (namedMatch.tentative) console.log(`[wish] named place "${body.title.slice(0, 80)}" suggested, not linked: ${namedMatch.name ?? "?"}`);
          if (namedMatch.place_id) updates["placeId"] = namedMatch.place_id;
        }
      }
      await db.transaction(async (tx) => {
        const current = await tx.select().from(wishItems).where(where).for("update");
        if (current.length === 0) throw new NotFoundProblem("WishItem", id);
        const cur = current[0]!;
        // `metadata` is a JSON Merge Patch over the stored object, never a
        // replacement for it (src/projection/metadata-patch.ts): `{}`
        // changes nothing, `null` removes a key.
        if (body.metadata !== undefined) {
          const set = metadataPatchSet(
            wishItems.metadata,
            cur.metadata,
            body.metadata,
          );
          if (set !== undefined) updates["metadata"] = set;
        }

        // ── status and the conversion fields ──
        const status = body.status ?? cur.status;
        if (status !== "converted" && (body.converted_transaction_id || body.converted_at !== undefined)) {
          throw new ValidationProblem([
            { path: body.converted_at !== undefined ? "converted_at" : "converted_transaction_id", code: "not_converted", message: "Only a converted wish has a converting transaction or time" },
          ]);
        }
        const sentAt = body.converted_at !== undefined ? new Date(body.converted_at) : null;
        if (sentAt) assertConvertedAt(sentAt, cur.createdAt);
        if (status === "converted") {
          if (cur.status !== "converted") {
            // The user says it is done: theirs, now unless they say when.
            updates["status"] = "converted";
            updates["convertedBy"] = "user";
            updates["convertedAt"] = sentAt ?? new Date();
            updates["convertedTransactionId"] = body.converted_transaction_id ?? null;
          } else {
            // An edit of a conversion makes it the user's: the loop then
            // leaves it alone.
            let edited = false;
            if (body.converted_transaction_id !== undefined && body.converted_transaction_id !== cur.convertedTransactionId) {
              updates["convertedTransactionId"] = body.converted_transaction_id;
              edited = true;
            }
            if (sentAt && sentAt.getTime() !== cur.convertedAt?.getTime()) {
              updates["convertedAt"] = sentAt;
              edited = true;
            }
            if (edited) updates["convertedBy"] = "user";
          }
        } else if (body.status !== undefined && body.status !== cur.status) {
          updates["status"] = status;
          updates["convertedBy"] = null;
          updates["convertedAt"] = null;
          updates["convertedTransactionId"] = null;
          // Leaving converted, whichever way: that purchase did not settle
          // it, and must never settle it again (declined → active included).
          if (cur.status === "converted" && cur.convertedTransactionId && !cur.dismissedTransactionIds.includes(cur.convertedTransactionId)) {
            updates["dismissedTransactionIds"] = [...cur.dismissedTransactionIds, cur.convertedTransactionId];
          }
          // Wanted again (from converted) or again (from declined): the
          // wish starts over, and only a purchase from now on fulfils it.
          if (status === "active") updates["reactivatedAt"] = new Date();
        }

        // What the person set by hand on a captured or matched wish is
        // theirs: a reading (now or a later "read again") leaves it alone,
        // and a failed capture it fixes is resolved, its error kept.
        const setByHand = {
          ...(body.title !== undefined ? { title: true } : {}),
          ...(body.kind !== undefined ? { kind: true } : {}),
          ...(body.place_id !== undefined || body.google_place_id !== undefined ? { place: true } : {}),
        };
        // Only while the wish still has no place: a place set meanwhile wins.
        if (namedMatch && cur.placeId) {
          namedMatch = null;
          delete updates["placeId"];
        }
        if (namedMatch || (Object.keys(setByHand).length > 0 && (cur.capture !== null || cur.captureStatus !== null))) {
          const capture = { ...((cur.capture as Record<string, unknown> | null) ?? {}) };
          if (namedMatch) capture["place_match"] = namedMatch;
          capture["user_set"] = { ...((capture["user_set"] as Record<string, unknown> | undefined) ?? {}), ...setByHand };
          if (cur.captureStatus === "failed") {
            updates["captureStatus"] = "done";
            capture["resolved_by"] = "user";
            capture["resolved_at"] = new Date().toISOString();
          }
          updates["capture"] = capture;
        }
        if (Object.keys(updates).length === 0) return cur;
        updates["updatedAt"] = new Date();
        const updated = await tx
          .update(wishItems)
          .set(updates)
          .where(where)
          .returning();
        return updated[0]!;
      });
      // A new place, product or kind: maybe it was bought or visited
      // already, or a receipt conversion no longer holds. Set back to
      // active: a purchase since then may already be on the books.
      if (
        updates["placeId"] !== undefined ||
        updates["productId"] !== undefined ||
        updates["kind"] !== undefined ||
        updates["status"] === "active"
      ) {
        await settleWishesSafely({ wishIds: [id] });
      }
      res.json(await loadWish(req.ctx.workspaceId, id));
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /v1/wish-items/:id ──────────────────────────────────────────

wishItemsRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const deleted = await db
        .delete(wishItems)
        .where(
          and(eq(wishItems.id, id), eq(wishItems.workspaceId, req.ctx.workspaceId)),
        )
        .returning({ id: wishItems.id, imagePath: wishItems.imagePath });
      if (deleted.length === 0) throw new NotFoundProblem("WishItem", id);
      // The screenshot goes with the last wish that shows it.
      await removeWishImageIfUnused(deleted[0]!.imagePath);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ── OpenAPI registration ───────────────────────────────────────────────

export function registerWishItemsOpenApi(registry: OpenAPIRegistry): void {
  registry.register("WishItem", WishItem);
  registry.register("CreateWishItemRequest", CreateWishItemRequest);
  registry.register("UpdateWishItemRequest", UpdateWishItemRequest);
  registry.register("CaptureWishForm", CaptureWishForm);
  registry.register("WishPlaceSearchResponse", WishPlaceSearchResponse);

  const problemContent = {
    "application/problem+json": { schema: ProblemDetails },
  };

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items",
    summary: "List wishlist items",
    tags: ["wish-items"],
    request: { query: ListWishItemsQuery },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: paginated(WishItem) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items/{id}",
    summary: "Fetch one wish",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WishItem } } },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wish-items",
    summary: "Add a wish",
    tags: ["wish-items"],
    description:
      "A wish sent with `place_id` or `google_place_id` and no `kind` is a place wish. " +
      "A place wish can name its place by `place_id` (a place the ledger has) or `google_place_id` (one picked from " +
      "`GET /v1/wish-items/place-search`, stored by the server). A place wish sent with neither is matched by its title " +
      "with Google Find Place before the answer, biased to the workspace's usual area; a miss leaves it unmatched, with the reason in " +
      "`capture.place_match.error`. Only a found place inside the workspace's usual area (50 km around its purchases) whose name carries " +
      "the title is linked; anything else (another name, another region, or a workspace with too few purchases to have an area) is offered " +
      "as `place_suggestion`. A found place outside the area whose name does not carry the whole title is offered only when it shares the title's words and the rest of the title is in its address " +
      "(`El Farolito Mission District` → Taquería El Farolito, Mission St), after any branch inside the area that carries the title's first word; one named for somewhere else " +
      "(`Sugarfish Little Tokyo` → SUGARFISH Little Italy, San Diego, with no branch in the area) or whose name shares nothing with the title is not offered at all. " +
      "A wish that gets a place or a product is checked against the ledger at once: a live purchase there on or after the day the wish was made converts it.",
    request: {
      body: { content: { "application/json": { schema: CreateWishItemRequest } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: WishItem } } },
      422: { description: "Validation failed (also: Google has no such `google_place_id`)", content: problemContent },
      502: { description: "Google failed while fetching the picked place", content: problemContent },
      503: { description: "`google_place_id` sent, and the server has no Google Maps key", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items/place-search",
    summary: "Search Google for a wish's place (up to five candidates)",
    description:
      "Google Places Text Search with the server's key. With `near`, the locality the wish's image reading found is added to the " +
      "query; otherwise the search prefers the workspace's usual area (`location_biased`). Candidates that share no word with `q` " +
      "are not returned. Pick a candidate by sending its `google_place_id` in `PATCH /v1/wish-items/{id}`.",
    tags: ["wish-items"],
    request: { query: WishPlaceSearchQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WishPlaceSearchResponse } } },
      400: { description: "`near` is not a UUID", content: problemContent },
      404: { description: "No wish `near`", content: problemContent },
      422: { description: "`q` missing or empty", content: problemContent },
      502: { description: "Google answered with an error", content: problemContent },
      503: { description: "The server has no Google Maps key", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wish-items/capture",
    summary: "Save a wish from an image (a screenshot of a post, a chat, a map; a photo)",
    description:
      "Stores the image and answers at once with a wish whose `capture_status` is `reading` and whose title is a placeholder. " +
      "The image is then read in the background: the title, kind, notes, source link and, for a place, the matched `place` are filled in and " +
      "`capture_status` becomes `done`, or `failed` with `capture.error` (`nothing_to_save` titles it with what the image showed and makes it a `thing`). " +
      "Poll `GET /v1/wish-items/{id}`. Nothing the reading fills overwrites a note sent with the upload, or a title, kind or place " +
      "the person set while it was being read. A place with no city or address in the image is offered as `place_suggestion`, not linked. " +
      "An image that lists several places with equal weight makes one wish for each (`capture.sibling_of` / `capture.siblings`), " +
      "except for places already wished for; a capture whose own place is already wished for keeps its wish and names the earlier one " +
      "in `capture.duplicate_of`. A place is linked only when its name agrees and the location the image names is confirmed by Google's " +
      "structured address (its address components) in English or the name's own script: the house number is its street number on the read " +
      "street, else the street (numbered ones such as `6th Ave` included) is its route, else the city or neighbourhood is a whole city-level part " +
      "of it (`South San Francisco` is not `San Francisco`; a state or a country such as `USA` or `Taiwan` confirms nothing; `New York` and `NYC` " +
      "are confirmed by the five boroughs). A place that fails it is offered as `place_suggestion` with the reason; one whose name shares nothing is not offered. " +
      "For a shop's listing (Amazon and the like) with no person recommending it, `capture.reading.highlights` is empty: the listing's own words are not highlights. " +
      "HEIC and AVIF are converted to JPEG first. A file that does not decode as an image is a 422 `unreadable_image`, and one over 50 million pixels a 422 `image_too_large` (checked from its header, before any pixel is decoded); nothing is stored or read. " +
      "The same bytes uploaded again answer 200 with the wish they made " +
      "the first time, whatever its state, and are not read again; a note sent with them is added to its notes.",
    tags: ["wish-items"],
    request: { body: { content: { "multipart/form-data": { schema: CaptureWishForm } } } },
    responses: {
      200: { description: "This image was captured before: the existing wish", content: { "application/json": { schema: WishItem } } },
      202: { description: "Accepted; reading", content: { "application/json": { schema: WishItem } } },
      422: { description: "Not an image this endpoint reads (`unsupported_image`), one that does not decode (`unreadable_image`), or one over 50 million pixels (`image_too_large`)", content: problemContent },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/wish-items/{id}/capture/retry",
    summary: "Read a captured image again",
    description:
      "Fields the person set by hand (`capture.user_set`) are kept; if the new reading fails, a wish they had named or placed stays `done`. " +
      "A wish split from another capture (`capture.sibling_of`) is not read on its own while that capture exists: 409, read the original. " +
      "Once the original is deleted it is read on its own, for its own entry of the image (no further split). " +
      "An image file that is no longer on disk fails the capture with `capture.error: image_missing` before anything is read, and the wish keeps its kind.",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      202: { description: "Accepted; reading", content: { "application/json": { schema: WishItem } } },
      404: { description: "Not Found", content: problemContent },
      409: { description: "No image, it is being read now, or it was split from a capture that still exists", content: problemContent },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/wish-items/{id}/image",
    summary: "The image a wish was captured from",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      200: { description: "The image bytes" },
      404: { description: "Not Found", content: problemContent },
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/wish-items/{id}",
    summary: "Patch a wish (fields, urgency, snooze, convert / decline)",
    description:
      "JSON Merge Patch (RFC 7396). `metadata` merges into the stored object rather than " +
      "replacing it (`null` removes a key, `{}` changes nothing). " +
      "`status: converted` from the user sets `converted_by: user` and `converted_at` (now unless sent; not before the wish was made; " +
      "`Z` or a UTC offset). `currency` changes the currency of `target_price_minor` (the amount is not converted). " +
      "Changing `converted_transaction_id` (a live transaction) or `converted_at` on a receipt conversion makes it `converted_by: user`. " +
      "Leaving `converted` (to active or declined) dismisses its transaction for good; `status: active` from converted or declined " +
      "starts the wish over: only a purchase from then on converts it, and that is checked at once. " +
      "`google_place_id` stores the picked place and links it (confirming a `place_suggestion`); `place_id: null` removes a place " +
      "or rejects the suggestion. Setting `title`, `kind` or the place on a captured wish records it in `capture.user_set`, which " +
      "no reading overwrites; on a wish whose capture failed it also marks the capture `done` (`capture.resolved_by: user`, the error kept). " +
      "A new `title` on a place wish with no place (a failed capture being named) is matched as a typed place wish is (`capture.place_match`, " +
      "`place_suggestion`), unless the person removed a place by hand. " +
      "A new place, product or kind is checked against the ledger at once.",
    tags: ["wish-items"],
    request: {
      params: z.object({ id: Uuid }),
      body: {
        content: {
          "application/merge-patch+json": { schema: UpdateWishItemRequest },
          "application/json": { schema: UpdateWishItemRequest },
        },
      },
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: WishItem } } },
      400: { description: "No field to change", content: problemContent },
      404: { description: "Not Found", content: problemContent },
      422: { description: "Validation failed (also: Google has no such `google_place_id`)", content: problemContent },
      502: { description: "Google failed while fetching the picked place", content: problemContent },
      503: { description: "`google_place_id` sent, and the server has no Google Maps key", content: problemContent },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/wish-items/{id}",
    summary: "Hard-delete a wish",
    description: "Its captured image is deleted too, unless another wish (one split from the same capture) still shows it.",
    tags: ["wish-items"],
    request: { params: z.object({ id: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not Found", content: problemContent },
    },
  });
}
