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
    extraction_meta: z.record(z.string(), z.unknown()).nullable(),
    source_ingest_id: Uuid.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Document");

export const CreateDocumentLinkRequest = z
  .object({ transaction_id: Uuid })
  .openapi("CreateDocumentLinkRequest");

// Multipart form is described inline in the route registration;
// Zod can't fully model multipart, but we register the field shape
// so the OpenAPI docs reflect the expected client contract.
export const UploadDocumentForm = z
  .object({
    file: z.any().openapi({ type: "string", format: "binary" }),
    kind: DocumentKind.optional(),
  })
  .openapi("UploadDocumentForm");
