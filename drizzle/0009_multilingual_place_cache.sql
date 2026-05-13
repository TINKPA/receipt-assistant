-- Multilingual place cache + photo OCR (#74).
--
-- See issue #74 for the full motivation. Three things happen here:
--
--   1. Extend `places` with typed columns for every Google Places v1
--      field we want to index/filter on, plus a `custom_name_zh`
--      column for user overrides. Everything else stays inside
--      `raw_response jsonb` so no v1 field is ever discarded.
--
--   2. New `place_photos` table — one row per Google photo, with a
--      local file copy (sha256-named under the same uploads bind
--      mount; quarantine on hard delete per #73) and an
--      `ocr_extracted` jsonb for the photo-OCR fallback that pulls
--      Chinese from storefront signage when Google's text fields
--      don't have it (see #74 comment for the Wing On Market case).
--
--   3. New `place_reviews` table — snapshot history, not deduped.
--      Each refresh inserts new rows; analytics queries
--      `LATERAL ... ORDER BY snapshot_taken_at DESC LIMIT N`.
--
-- Yelp augmentation columns are placeholder-NULL — schema is ready
-- when/if we wire a Yelp client.

-- ── places: new typed columns ────────────────────────────────────

ALTER TABLE places
  ADD COLUMN IF NOT EXISTS display_name_en          text,
  ADD COLUMN IF NOT EXISTS display_name_zh          text,
  ADD COLUMN IF NOT EXISTS display_name_zh_locale   text,
  ADD COLUMN IF NOT EXISTS display_name_zh_source   text,
  ADD COLUMN IF NOT EXISTS custom_name_zh           text,
  ADD COLUMN IF NOT EXISTS primary_type             text,
  ADD COLUMN IF NOT EXISTS primary_type_display_zh  text,
  ADD COLUMN IF NOT EXISTS maps_type_label_zh       text,
  ADD COLUMN IF NOT EXISTS types                    text[],
  ADD COLUMN IF NOT EXISTS formatted_address_en     text,
  ADD COLUMN IF NOT EXISTS formatted_address_zh     text,
  ADD COLUMN IF NOT EXISTS postal_code              text,
  ADD COLUMN IF NOT EXISTS country_code             text,
  ADD COLUMN IF NOT EXISTS business_status          text,
  ADD COLUMN IF NOT EXISTS business_hours           jsonb,
  ADD COLUMN IF NOT EXISTS time_zone                text,
  ADD COLUMN IF NOT EXISTS rating                   numeric(2,1),
  ADD COLUMN IF NOT EXISTS user_rating_count        integer,
  ADD COLUMN IF NOT EXISTS national_phone_number    text,
  ADD COLUMN IF NOT EXISTS website_uri              text,
  ADD COLUMN IF NOT EXISTS google_maps_uri          text,
  ADD COLUMN IF NOT EXISTS yelp_business_id         text,
  ADD COLUMN IF NOT EXISTS yelp_alias               text,
  ADD COLUMN IF NOT EXISTS yelp_price_level         text,
  ADD COLUMN IF NOT EXISTS yelp_categories          jsonb,
  ADD COLUMN IF NOT EXISTS yelp_raw_response        jsonb;

CREATE INDEX IF NOT EXISTS places_types_gin_idx       ON places USING GIN (types);
CREATE INDEX IF NOT EXISTS places_primary_type_idx    ON places (primary_type);
CREATE INDEX IF NOT EXISTS places_business_status_idx ON places (business_status);

-- ── place_photos ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS place_photos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id              uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  google_photo_name     text NOT NULL,
  rank                  integer NOT NULL,
  width_px              integer,
  height_px             integer,
  author_attributions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_path             text,
  mime_type             text,
  sha256                text,
  ocr_extracted         jsonb,
  fetched_at            timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT place_photos_google_name_uniq UNIQUE (place_id, google_photo_name)
);
CREATE INDEX IF NOT EXISTS place_photos_place_rank_idx ON place_photos (place_id, rank);

-- ── place_reviews ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS place_reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id                    uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  google_review_name          text NOT NULL,
  rating                      integer NOT NULL,
  text_text                   text,
  text_language               text,
  original_text_text          text,
  original_text_language      text,
  relative_publish_time       text,
  publish_time                timestamp with time zone,
  author_display_name         text,
  author_uri                  text,
  author_photo_uri            text,
  snapshot_taken_at           timestamp with time zone NOT NULL DEFAULT NOW(),
  raw                         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS place_reviews_place_taken_idx ON place_reviews (place_id, snapshot_taken_at DESC);
