/**
 * Zod schemas for `/v1/documents` and its `links` sub-resource.
 */
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.js";

export const DocumentKind = z.enum([
  "receipt_image",
  "receipt_email",
  "receipt_pdf",
  "statement_pdf",
  "other",
]);

export const Document = z
  .object({
    id: Uuid,
    workspace_id: Uuid,
    kind: DocumentKind,
    file_path: z.string().nullable(),
    mime_type: z.string().nullable(),
    sha256: z.string(),
    ocr_text: z.string().nullable(),
    /** Model identifier under which `ocr_text` was produced. NULL on
     *  legacy rows (pre-#91 Phase 4b). Independent of
     *  `transactions.metadata.extraction.model` — see schema header. */
    ocr_model_version: z.string().nullable().openapi({
      description:
        "Model identifier under which ocr_text was produced. NULL on legacy rows.",
    }),
    extraction_meta: z.record(z.string(), z.unknown()).nullable(),
    source_ingest_id: Uuid.nullable(),
    deleted_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Document");

export const CreateDocumentLinkRequest = z
  .object({ transaction_id: Uuid })
  .openapi("CreateDocumentLinkRequest");

/**
 * Response from `POST /v1/documents/:id/re-extract` (Phase 4c of #80 / #91).
 * The agent has re-OCR'd the receipt and UPDATEd the linked transaction
 * + document. `changed_keys` reflects what actually moved (Layer-3
 * shielding may have suppressed some changes the agent attempted).
 * `derivation_event_id` lets the caller correlate against the audit log.
 */
export const ReExtractDocumentResponse = z
  .object({
    document_id: Uuid,
    transaction_id: Uuid,
    derivation_event_id: Uuid,
    changed_keys: z.array(z.string()),
    ocr_text_changed: z.boolean(),
    session_id: Uuid,
  })
  .openapi("ReExtractDocumentResponse");

// Multipart form is described inline in the route registration;
// Zod can't fully model multipart, but we register the field shape
// so the OpenAPI docs reflect the expected client contract.
export const UploadDocumentForm = z
  .object({
    file: z.any().openapi({ type: "string", format: "binary" }),
    kind: DocumentKind.optional(),
  })
  .openapi("UploadDocumentForm");
