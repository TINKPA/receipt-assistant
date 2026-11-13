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
    file_path: z.string().nullable().openapi({
      description:
        "Server-side storage path, relative to the server's uploads dir (#128). Opaque to clients — fetch bytes via /content or /rendered.",
    }),
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
    message_id: z.string().nullable().openapi({
      description:
        "RFC822 Message-ID for email-sourced documents (kind=receipt_email); NULL otherwise.",
    }),
    source_meta: z.record(z.string(), z.unknown()).nullable().openapi({
      description:
        "Channel provenance for non-image sources. For email: {channel,sender,subject,received_at,message_id}.",
    }),
    source_ingest_id: Uuid.nullable(),
    deleted_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .openapi("Document");

export const CreateDocumentLinkRequest = z
  .object({ transaction_id: Uuid })
  .strict()
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
    outcome: z.enum(["written", "no_change", "agent_error"]).openapi({
      description:
        "What the run actually did (#167). `written` = the agent's psql " +
        "block moved something. `no_change` = it demonstrably wrote " +
        "NOTHING (the metadata UPDATE always rewrites `extraction.ran_at`, " +
        "so empty `changed_keys` means no write happened, NOT that the " +
        "output was identical). `agent_error` is part of the vocabulary " +
        "but never appears on a 200 — the agent's `ERROR` line surfaces " +
        "as a 422 `re-extract-agent-error`. Batch tooling MUST key on " +
        "this field, never on whether `re_extracted_at` advanced.",
    }),
  })
  .openapi("ReExtractDocumentResponse");

/**
 * Response from `DELETE /v1/documents/:id?cascade=true`: what the call
 * did to each transaction the document was linked to. Every linked
 * transaction appears in exactly one of the four lists.
 *
 * It exists because a cascade may delete less than its name suggests: a
 * transaction another live document still supports is kept, and without
 * this body a client could not tell "deleted" from "kept".
 */
export const CascadeDeleteReport = z
  .object({
    document_id: Uuid,
    hard: z.boolean().openapi({
      description:
        "true: the document row was removed (`?hard=true`). false: it was soft-deleted.",
    }),
    transactions_kept: z.array(Uuid).openapi({
      description:
        "Linked transactions left in the ledger because another non-deleted " +
        "document still supports them. Non-empty means the receipt is NOT gone: " +
        "delete the remaining document(s) with cascade, or the transaction itself, to remove it.",
    }),
    transactions_soft_deleted: z.array(Uuid).openapi({
      description: "Posted transactions this call soft-deleted (restorable).",
    }),
    transactions_hard_deleted: z.array(Uuid).openapi({
      description:
        "Transactions this call removed for good: every non-kept one under `?hard=true`, " +
        "and draft/error ones in soft mode.",
    }),
    transactions_skipped: z.array(Uuid).openapi({
      description:
        "Soft mode only: transactions that were already soft-deleted and were left as they were.",
    }),
  })
  .openapi("CascadeDeleteReport");

// Multipart form is described inline in the route registration;
// Zod can't fully model multipart, but we register the field shape
// so the OpenAPI docs reflect the expected client contract.
export const UploadDocumentForm = z
  .object({
    file: z.any().openapi({ type: "string", format: "binary" }),
    kind: DocumentKind.optional(),
  })
  .openapi("UploadDocumentForm");
