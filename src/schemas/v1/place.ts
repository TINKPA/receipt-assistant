import { z } from "zod";
import { Uuid } from "./common.js";

/**
 * Google Places entry. Shared resource keyed by `google_place_id` —
 * the same merchant visited across workspaces is one row.
 *
 * Multilingual columns added by #74. Most fields are nullable because
 * (a) older rows pre-#74 only have `formatted_address` / `lat` / `lng` /
 * `source`, and (b) Google itself doesn't have a Chinese name for every
 * place (Wing On Market in LA is the canonical counter-example — only
 * the storefront photo carries 永安).
 */
export const Place = z
  .object({
    id: Uuid,
    google_place_id: z.string(),
    formatted_address: z.string(),
    lat: z.number(),
    lng: z.number(),
    source: z.string(),

    // multilingual identity
    display_name_en: z.string().nullable(),
    display_name_zh: z.string().nullable(),
    display_name_zh_locale: z.string().nullable(),
    display_name_zh_source: z
      .enum(["google_text", "photo_ocr", "receipt_ocr", "user_override"])
      .nullable(),
    /** True when `display_name_zh` is the merchant's native-script
     *  name (永合豐 for Wing Hop Fung); false when it's a Google
     *  gloss for a globally-English brand. Drives whether the
     *  display selector promotes it to primary. NULL = unknown. */
    display_name_zh_is_native: z.boolean().nullable(),
    custom_name_zh: z.string().nullable(),

    // typing
    primary_type: z.string().nullable(),
    primary_type_display_zh: z.string().nullable(),
    maps_type_label_zh: z.string().nullable(),
    types: z.array(z.string()).nullable(),

    // address pair
    formatted_address_en: z.string().nullable(),
    formatted_address_zh: z.string().nullable(),
    postal_code: z.string().nullable(),
    country_code: z.string().nullable(),

    // operational
    business_status: z.string().nullable(),
    business_hours: z.unknown().nullable(),
    time_zone: z.string().nullable(),

    // ratings snapshot
    rating: z.number().nullable(),
    user_rating_count: z.number().int().nullable(),

    // contact
    national_phone_number: z.string().nullable(),
    website_uri: z.string().nullable(),
    google_maps_uri: z.string().nullable(),

    // photos (just refs in the Place response; binary fetched separately)
    photos: z
      .array(
        z.object({
          rank: z.number().int(),
          width_px: z.number().int().nullable(),
          height_px: z.number().int().nullable(),
          /** True when bytes are cached locally and binary fetch will work. */
          has_local_copy: z.boolean(),
          /** Vision-LLM result if available. */
          ocr_extracted: z.unknown().nullable(),
        }),
      )
      .nullable(),
  })
  .openapi("Place");

export type PlaceShape = z.infer<typeof Place>;

/**
 * Patch body for `PATCH /v1/places/:id`. Only the user-overridable
 * field — everything else is Google-canonical and never user-edited.
 */
export const UpdatePlaceRequest = z
  .object({
    custom_name_zh: z.string().nullable().optional(),
  })
  .openapi("UpdatePlaceRequest");

/**
 * Response from `POST /v1/places/:id/re-derive` (#89). Reports
 * what the projection rerun changed; the operator can correlate
 * `derivation_event_id` against the `derivation_events` audit log
 * for the full `before` / `after` jsonb.
 */
export const ReDerivePlaceResponse = z
  .object({
    place_id: Uuid,
    changed_keys: z.array(z.string()),
    derivation_event_id: Uuid,
  })
  .openapi("ReDerivePlaceResponse");

/**
 * Query params for `POST /v1/admin/re-derive`. Only `scope=places`
 * is implemented in Phase 2 (#89); Phase 3+ will add `merchants`,
 * `documents`, and the LLM-backed paths.
 */
export const ReDeriveQuery = z
  .object({
    scope: z.enum(["places"]).default("places"),
  })
  .openapi("ReDeriveQuery");

/**
 * Response from `POST /v1/admin/re-derive`. `updated` counts rows
 * whose UPDATE landed (including no-op runs that still get a
 * `derivation_events` row); `skipped` counts rows with no
 * `raw_response` to project from; `errors` carries per-row
 * exceptions so a partial batch is debuggable.
 */
export const ReDeriveBatchResponse = z
  .object({
    scope: z.enum(["places"]),
    total: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errors: z.array(
      z.object({
        id: z.string(),
        message: z.string(),
      }),
    ),
    ran_at: z.string(),
  })
  .openapi("ReDeriveBatchResponse");
