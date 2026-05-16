-- Phase 4b of the 3-layer data model (#80) — #91, schema prep for re-extract.
--
-- `documents.ocr_model_version` records which model produced the
-- current `ocr_text`. Distinct from `transactions.metadata.extraction.model`
-- (#88) because OCR text and transaction-structure extraction can in
-- principle run under different models. NULL on legacy rows — backfill
-- isn't worth it because we'd have to guess.
ALTER TABLE "documents" ADD COLUMN "ocr_model_version" text;
