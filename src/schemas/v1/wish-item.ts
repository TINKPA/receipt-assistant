/**
 * `wish_items` zod schema (v2 redesign P3, tracking #149). The wishlist
 * mirror of `owned_items`: target price + planned lifespan project a
 * $/day before any money moves. Optional catalog link via `product_id`;
 * free-text wishes stand on `title` alone.
 */
import { z } from "zod";
import { IsoDate, IsoDateTime, Metadata, Uuid } from "./common.js";

export const WishUrgency = z.enum(["now", "soon", "someday"]);
export const WishStatus = z.enum(["active", "converted", "declined"]);
/** `thing`: to buy. `place`: to go to (a restaurant someone recommended);
 *  it has no price or lifespan, and "converted" means visited. */
export const WishKind = z.enum(["thing", "place"]);
export const WishCaptureStatus = z.enum(["reading", "done", "failed"]);
/** Who converted a wish: the user, or a receipt booked at its place. */
export const WishConvertedBy = z.enum(["user", "receipt"]);

/** A Google place id as Google issues it. */
export const GooglePlaceId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{10,300}$/, "not a Google place id")
  .openapi({ description: "A Google place id (`ChIJ…`), as place search returns it.", example: "ChIJN1t_tDeuEmsRUsoyG83frY4" });

/** The transaction that converted a wish, as much as a card needs. */
export const WishConvertedTransaction = z
  .object({
    id: Uuid,
    occurred_on: IsoDate,
    payee: z.string().nullable(),
    /** What it cost: the sum of its expense legs, in the workspace base
     *  currency, minor units. */
    total_minor: z.number().int(),
    /** The workspace base currency. */
    currency: z.string(),
  })
  .openapi("WishConvertedTransaction");

/** A place found for the wish's name that is only a guess: Google's best
 *  answer for a name with no city, a reading the model was unsure of, or a
 *  name that differs from the one asked for. Not linked, so it converts
 *  nothing. Confirm it with PATCH `google_place_id`, reject it with PATCH
 *  `place_id: null`. */
export const WishPlaceSuggestion = z
  .object({
    google_place_id: z.string(),
    name: z.string().nullable(),
    formatted_address: z.string().nullable(),
    /** `name_only` (no city or address to go on), `low_confidence` (the
     *  reading was a guess), `name_mismatch` (Google's place has another
     *  name), `name_unverified` (a typed name in another script than
     *  Google's, so the two cannot be compared). */
    reason: z.string().nullable(),
  })
  .openapi("WishPlaceSuggestion");

/** http(s) links only: anything else (javascript:, data:) is refused. */
export const HttpUrl = z
  .string()
  .max(2000)
  .url()
  .refine((s) => /^https?:\/\//i.test(s), { message: "only http and https links" });

/** An ISO 4217 code, as the rest of the API spells currencies. */
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "a three-letter ISO 4217 code, upper case");

const Title = z.string().trim().min(1).max(300);
const Notes = z.string().max(5000);

/** The matched place of a place wish, as much as a card needs. */
export const WishPlace = z
  .object({
    id: Uuid,
    google_place_id: z.string(),
    name: z.string().nullable(),
    name_zh: z.string().nullable(),
    formatted_address: z.string().nullable(),
    /** City, from Google's address components. Null on places stored
     *  before those were kept. */
    locality: z.string().nullable(),
    neighborhood: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    google_maps_uri: z.string().nullable(),
    primary_type: z.string().nullable(),
    rating: z.number().nullable(),
  })
  .openapi("WishPlace");

export const WishItem = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    /** NULL for free-text wishes (a course, a used chair). */
    product_id: Uuid.nullable(),
    kind: WishKind,
    /** The matched place of a place wish; null until matched, or after
     *  the user removed a wrong match. */
    place_id: Uuid.nullable(),
    place: WishPlace.nullable(),
    /** A guessed place waiting for the person to confirm or reject it;
     *  null when the wish has a place or nothing was guessed. */
    place_suggestion: WishPlaceSuggestion.nullable(),
    /** Other wishes in the workspace at the same place (any status): the
     *  same restaurant saved twice, from two screenshots or typed again. */
    same_place_wish_ids: z.array(Uuid),
    title: z.string(),
    notes: z.string().nullable(),
    /** What you'd pay, in minor units. Drives the projected $/day. */
    target_price_minor: z.number().int().nullable(),
    currency: z.string(),
    /** Planned ownership horizon in days (1825 = 5 years). */
    planned_days: z.number().int().nullable(),
    urgency: WishUrgency,
    /** Parked until this date; an active snooze renders as its own pill. */
    snoozed_until: IsoDate.nullable(),
    status: WishStatus,
    /** Set when status=converted: the transaction that realized the wish. */
    converted_transaction_id: Uuid.nullable(),
    /** When it was bought or visited: the converting transaction's time
     *  (or the start of its day), or when the user marked it. Null unless
     *  converted. */
    converted_at: IsoDateTime.nullable(),
    /** `receipt`: a purchase booked at the wish's place (or with its
     *  product) converted it. `user`: the user marked it. Null unless
     *  converted. */
    converted_by: WishConvertedBy.nullable(),
    /** The converting transaction while it is live, or null (none, or it
     *  was deleted: a receipt conversion whose transaction is deleted goes
     *  back to active, or to another purchase there). */
    converted_transaction: WishConvertedTransaction.nullable(),
    /** An http(s) link, or null. */
    source_url: z.string().nullable(),
    /** True when the wish was captured from an image:
     *  `GET /v1/wish-items/{id}/image` serves it. */
    has_image: z.boolean(),
    /** Null for a wish typed in by hand. `reading`: the image is being
     *  read and the title is a placeholder; poll until it changes. */
    capture_status: WishCaptureStatus.nullable(),
    /** What the reading found (`reading`: highlights, category,
     *  recommended_by, …), how the place was matched (`place_match`, also
     *  on a typed place wish), or why it failed (`error`, `detail`; kept
     *  after the user fixed the wish by hand, with `resolved_by: "user"`).
     *  `user_set` lists what the person set by hand (`title`, `kind`,
     *  `place`), which a reading never overwrites. `sibling_of` names the
     *  wish whose image listed this place too; that wish lists them in
     *  `siblings`. `converted_from` names a HEIC / AVIF upload stored as
     *  JPEG. Written by the server only. */
    capture: z.record(z.string(), z.unknown()).nullable(),
    metadata: Metadata,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("WishItem");

export const CreateWishItemRequest = z
  .object({
    title: Title,
    kind: WishKind.optional(),
    /** A place the ledger already has. */
    place_id: Uuid.optional(),
    /** A place picked from place search: the server fetches and stores it
     *  and sets `place_id`. A place wish sent with neither is matched by
     *  its title (Google Find Place); `capture.place_match` says how. */
    google_place_id: GooglePlaceId.optional(),
    source_url: HttpUrl.optional(),
    product_id: Uuid.optional(),
    notes: Notes.optional(),
    target_price_minor: z.number().int().positive().optional(),
    currency: CurrencyCode.optional(),
    planned_days: z.number().int().positive().optional(),
    urgency: WishUrgency.optional(),
    snoozed_until: IsoDate.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("CreateWishItemRequest");

export const UpdateWishItemRequest = z
  .object({
    title: Title.optional(),
    kind: WishKind.optional(),
    /** Null removes a wrong match, or rejects a `place_suggestion`. */
    place_id: Uuid.nullable().optional(),
    /** A place picked from place search: stored and linked as `place_id`.
     *  Not together with `place_id`. */
    google_place_id: GooglePlaceId.optional(),
    source_url: HttpUrl.nullable().optional(),
    product_id: Uuid.nullable().optional(),
    notes: Notes.nullable().optional(),
    target_price_minor: z.number().int().positive().nullable().optional(),
    planned_days: z.number().int().positive().nullable().optional(),
    urgency: WishUrgency.optional(),
    snoozed_until: IsoDate.nullable().optional(),
    /** active → converted | declined; converting may carry the realizing
     *  transaction id and when (`converted_at`, default now), and is
     *  recorded as `converted_by: "user"`. Leaving converted (to active
     *  or declined) means its transaction did not settle it: that
     *  transaction never converts it again. Setting it to active from
     *  either ("Want again", un-decline) starts the wish over: only a
     *  purchase from then on converts it, checked at once. */
    status: WishStatus.optional(),
    /** A live transaction of the workspace. Changing it (or
     *  `converted_at`) on a wish a receipt converted makes the conversion
     *  the user's (`converted_by: "user"`). */
    converted_transaction_id: Uuid.nullable().optional(),
    /** Only with a conversion (status converted, sent or current); not
     *  before the wish was made (a day's grace for time zones) nor more
     *  than a day ahead. */
    converted_at: IsoDateTime.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("UpdateWishItemRequest");

export const ListWishItemsQuery = z.object({
  status: WishStatus.optional(),
  urgency: WishUrgency.optional(),
  kind: WishKind.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** `POST /v1/wish-items/capture`: multipart, one image in `file`. */
export const CaptureWishForm = z
  .object({
    file: z.string().openapi({
      type: "string",
      format: "binary",
      description: "A JPEG, PNG, WebP, GIF, HEIC or AVIF image: a screenshot or a photo. HEIC and AVIF are stored (and read) as JPEG.",
    }),
    note: z.string().max(2000).optional().openapi({ description: "What you want to remember about it. Stored as the wish's notes and shown to the reader." }),
  })
  .openapi("CaptureWishForm");

/** `GET /v1/wish-items/place-search` */
export const WishPlaceSearchQuery = z.object({
  q: z.string().trim().min(1).max(300).openapi({ description: "What to look for: a name, with a city if you know it." }),
  near: Uuid.optional().openapi({
    description: "A wish whose reading names a locality: the query is biased to it (a place wish captured from a post about Los Angeles searches Los Angeles).",
  }),
});

export const WishPlaceCandidate = z
  .object({
    google_place_id: z.string(),
    name: z.string().nullable(),
    formatted_address: z.string().nullable(),
    rating: z.number().nullable(),
    user_rating_count: z.number().int().nullable(),
    primary_type: z.string().nullable(),
  })
  .openapi("WishPlaceCandidate");

export const WishPlaceSearchResponse = z
  .object({
    /** The text sent to Google, after the `near` bias. */
    query: z.string(),
    /** True when the search preferred the workspace's usual area (the
     *  places of its purchases); false with `near` and a locality, or a
     *  workspace with too few places to tell. */
    location_biased: z.boolean(),
    /** Up to five, best first (with `location_biased`, those within 50 km
     *  of the workspace's area first). Empty when Google has none, or when none
     *  of them shares a word with `q` (Google answers nonsense with
     *  whatever it has). */
    candidates: z.array(WishPlaceCandidate),
  })
  .openapi("WishPlaceSearchResponse");
