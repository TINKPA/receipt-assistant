/**
 * MCP tools for documents. Thin wrappers around the service layer in
 * `src/routes/documents.service.ts` so that the HTTP and MCP surfaces
 * stay provably equivalent (same dedup rules, same DB writes).
 */
import type { FastMCP } from "fastmcp";
import { readFile } from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { SEED_WORKSPACE_ID } from "../db/seed.js";
import {
  uploadDocumentBytes,
  linkDocumentToTransaction,
  type DocumentKindValue,
} from "../routes/documents.service.js";

const KindSchema = z
  .enum([
    "receipt_image",
    "receipt_email",
    "receipt_pdf",
    "statement_pdf",
    "other",
  ])
  .optional();

/**
 * Detect MIME from the file extension. A full `file-type`
 * magic-bytes probe would be nicer, but for the MCP call path we trust
 * the operator-supplied path and only care about mapping .jpg→image/jpeg
 * for the on-disk filename.
 */
const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".eml": "message/rfc822",
  ".txt": "text/plain",
  ".html": "text/html",
};

function mimeFromPath(p: string): string | null {
  return EXT_MIME[path.extname(p).toLowerCase()] ?? null;
}

export function registerDocumentsMcpTools(mcp: FastMCP): void {
  mcp.addTool({
    name: "upload_document",
    description:
      "Upload a local file as a Document. sha256 de-duplicates: a second call " +
      "on the same bytes returns the existing row.",
    parameters: z.object({
      file_path: z.string().describe("Absolute path to the file on disk"),
      kind: KindSchema.describe(
        "Document kind; defaults to `other` when omitted.",
      ),
    }),
    async execute(args) {
      const bytes = await readFile(args.file_path);
      const mime = mimeFromPath(args.file_path);
      const { doc } = await uploadDocumentBytes({
        workspaceId: SEED_WORKSPACE_ID,
        bytes,
        mimeType: mime,
        kind: (args.kind ?? "other") as DocumentKindValue,
      });
      return JSON.stringify(doc);
    },
  });

  mcp.addTool({
    name: "link_document",
    description:
      "Link a document to a transaction. Idempotent: re-linking is a no-op.",
    parameters: z.object({
      transaction_id: z.string().uuid(),
      document_id: z.string().uuid(),
    }),
    async execute(args) {
      await linkDocumentToTransaction({
        workspaceId: SEED_WORKSPACE_ID,
        documentId: args.document_id,
        transactionId: args.transaction_id,
      });
      return JSON.stringify({ success: true });
    },
  });
}
