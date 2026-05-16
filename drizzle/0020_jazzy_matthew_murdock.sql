-- #79 Phase C — brand-level user-editable name. Layer-3 user override
-- that propagates across every place row sharing the same brand_id
-- within the workspace. One rename instead of N renames for "Costco"
-- branches. Never touched by re-extract; the Layer-3 contract matches
-- places.custom_name (#79 Phase B) and products.custom_name (#84).
ALTER TABLE "merchants" ADD COLUMN "custom_name" text;

COMMENT ON COLUMN "merchants"."custom_name" IS
  'Layer-3 user override (#79 Phase C). When set, displayName() prefers this brand-level rename over Google/OCR-derived names if no per-place override is set. Workspace-scoped via the merchants table itself.';
