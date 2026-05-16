-- #79: rename `places.custom_name_zh` → `places.custom_name`.
--
-- The field is "the user's name for this place", not Chinese
-- specifically. Renaming the column (not drop+add) preserves every
-- existing user override row in place.
--
-- The PATCH body keeps accepting `custom_name_zh` as a deprecated
-- alias for one release — the service-layer code translates it to
-- the new column on write. New clients should use `custom_name`.
ALTER TABLE "places" RENAME COLUMN "custom_name_zh" TO "custom_name";
