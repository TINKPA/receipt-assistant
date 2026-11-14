/**
 * `transactions.metadata` as the server applier writes it (wave 1, plan
 * §6.4): a FIXED key set, built by code from the validated record and the
 * run's own context. Nothing the model wrote reaches metadata except
 * through a named field of the contract, so the open-ended spread of keys
 * the agent used to invent ends here; the printed facts that fit no field
 * travel in the two bounded bags, `receipt_facts` and `other_references`.
 *
 *   source, source_ingest_id, classification, flow, refund_of?, category_hint?
 *   merchant { canonical_name, brand_id, category }           the frontend reads it
 *   extraction { prompt_version, prompt_git_sha, model, model_requested,
 *                source, ran_at, run_id, session_id, extraction_id,
 *                contract_version, applier_version, writer }
 *   order_number? confirmation_number? invoice_number? payment_id?
 *   approval_code?                                             top level, as every reader expects
 *   other_references?, card_last4?, payment?                   `payment`: the legacy dedup reader's string
 *   payment_method?, mirror_account
 *   tax_minor?, printed_totals?
 *   ocr_audit { …audit, payee_as_printed, payee_source }
 *   allocation_audit?                                          only when the lines miss the total
 *   near_dup_check?                                            from `decide()`
 *   receipt_facts?
 *   owned_items_note?                                          income: why no sold item was retired
 *
 * `metadata.items` is not written: `transaction_items` is canonical and
 * `itemsFromMetadataFallback` serves legacy rows only. The FX and points
 * passes add `fx` / `points` after commit, as they do today.
 *
 * Choices the plan leaves open, made here:
 *   - `payment` is `<network> ****<last4>` when the last four digits are
 *     known (`****<last4>` without a network), else the tender line as
 *     printed, else absent. `cardLast4` in `src/reconcile/dedup.ts` reads
 *     the typed `card_last4` first and this string second.
 *   - `payment_method` is what the frontend's Payment cell prints, verbatim
 *     (`toReceiptView` in the frontend's `src/lib/api/core.ts`): the
 *     `payment` string when there is one, else a label for the method
 *     ("Cash", "Bank transfer", …), and absent when the method is
 *     `unknown` and nothing was printed. The method itself stays in the
 *     stored record, and its consequence in `mirror_account`.
 *   - `allocation_audit` describes the main currency; a points-and-cash
 *     record whose cash lines also miss adds `other_currencies`.
 *   - `extraction.model` is the model the transcript reports, else the
 *     one requested; never `cli-default`.
 */
import { identifiersOf, itemsResidual, type ItemsResidual } from "../contract/validate.js";
import { EXTRACTION_CONTRACT_VERSION, type ExtractionV1, type PaymentMethod } from "../contract/v1.js";
import { RECORD_PROMPT_VERSION } from "../prompt-contract.js";
import type { NearDupCheck } from "./decide.js";
import type { ApplyDraft } from "./project.js";
import { APPLIER_VERSION } from "./version.js";

/** Every key the applier may write at the top level of `metadata`. */
export const APPLIER_METADATA_KEYS = [
  "source",
  "source_ingest_id",
  "classification",
  "flow",
  "refund_of",
  "category_hint",
  "merchant",
  "extraction",
  "order_number",
  "confirmation_number",
  "invoice_number",
  "payment_id",
  "approval_code",
  "other_references",
  "card_last4",
  "payment",
  "payment_method",
  "mirror_account",
  "tax_minor",
  "printed_totals",
  "ocr_audit",
  "allocation_audit",
  "near_dup_check",
  "receipt_facts",
  "owned_items_note",
] as const;
export type ApplierMetadataKey = (typeof APPLIER_METADATA_KEYS)[number];

/** The keys of `metadata.extraction`, in the order they are written. */
export const EXTRACTION_STAMP_KEYS = [
  "prompt_version",
  "prompt_git_sha",
  "model",
  "model_requested",
  "source",
  "ran_at",
  "run_id",
  "session_id",
  "extraction_id",
  "contract_version",
  "applier_version",
  "writer",
] as const;

/** What the run knows that the record does not. Ids are the server's own. */
export interface MetadataRunContext {
  ingestId: string;
  runId: string;
  /** The session id the worker minted for the run. */
  sessionId: string | null;
  /** The `document_extractions` row being applied. */
  extractionId: string;
  promptGitSha: string;
  /** `agent_runs.model_observed`. */
  modelObserved: string | null;
  /** `agent_runs.model_requested`. */
  modelRequested: string | null;
  /** When the apply ran, ISO-8601. */
  ranAt: string;
}

/** `metadata.payment`: `<network> ****<last4>`, `****<last4>`, or the
 *  tender line as printed; null when the record has none of them. */
export function paymentString(p: ExtractionV1["payment"]): string | null {
  if (p.card_last4) return p.card_network ? `${p.card_network} ****${p.card_last4}` : `****${p.card_last4}`;
  return p.as_printed ?? null;
}

/** The Payment cell's text for a method when nothing was printed. */
const METHOD_LABELS: Readonly<Record<PaymentMethod, string | null>> = {
  card: "Card",
  cash: "Cash",
  check: "Check",
  bank_transfer: "Bank transfer",
  points: "Points",
  gift_card: "Gift card",
  mixed: "Mixed",
  other: "Other",
  unknown: null,
};

function residualOut(r: ItemsResidual) {
  return {
    currency: r.currency,
    items_effective_sum_minor: r.items_effective_sum_minor,
    total_minor: r.total_minor,
    residual_minor: r.residual_minor,
  };
}

/** `allocation_audit`, or null when every currency's lines meet its total. */
export function allocationAudit(record: ExtractionV1): Record<string, unknown> | null {
  const off = itemsResidual(record).filter((r) => r.residual_minor !== 0);
  if (off.length === 0) return null;
  const main = off.find((r) => r.currency === record.facts?.currency) ?? off[0]!;
  const others = off.filter((r) => r !== main);
  return others.length > 0 ? { ...residualOut(main), other_currencies: others.map(residualOut) } : residualOut(main);
}

/**
 * The metadata object for the transaction a receipt record inserts. Keys
 * whose value would be absent are left out, never written as null.
 * `dedup` is what `decide()` found; `ownedItemsNote` is the writer's
 * account of a sold item it could not retire (§6.3 l), the key the legacy
 * prompt used for it.
 */
export function buildTransactionMetadata(
  record: ExtractionV1,
  draft: ApplyDraft,
  ctx: MetadataRunContext,
  dedup: { refundOf: string | null; nearDupCheck: NearDupCheck | null; ownedItemsNote?: string | null } = {
    refundOf: null,
    nearDupCheck: null,
  },
): Record<string, unknown> {
  const { facts, merchant, audit } = record;
  if (!facts || !merchant) throw new Error("buildTransactionMetadata: only a receipt record has transaction metadata");
  const m: Record<string, unknown> = {
    source: "ingest",
    source_ingest_id: ctx.ingestId,
    classification: record.classification,
    flow: facts.flow,
  };
  if (dedup.refundOf) m.refund_of = dedup.refundOf;
  if (merchant.category_hint) m.category_hint = merchant.category_hint;
  m.merchant = {
    canonical_name: merchant.canonical_name,
    brand_id: merchant.brand_id,
    category: merchant.category,
  };
  m.extraction = {
    prompt_version: RECORD_PROMPT_VERSION,
    prompt_git_sha: ctx.promptGitSha,
    model: (ctx.modelObserved && ctx.modelObserved !== "cli-default" ? ctx.modelObserved : null) ??
      (ctx.modelRequested && ctx.modelRequested !== "cli-default" ? ctx.modelRequested : null),
    model_requested: ctx.modelRequested,
    source: "ingest",
    ran_at: ctx.ranAt,
    run_id: ctx.runId,
    session_id: ctx.sessionId,
    extraction_id: ctx.extractionId,
    contract_version: EXTRACTION_CONTRACT_VERSION,
    applier_version: APPLIER_VERSION,
    writer: "server_apply",
  };
  Object.assign(m, identifiersOf(record));
  if (record.other_references && Object.keys(record.other_references).length > 0) {
    m.other_references = record.other_references;
  }
  if (record.payment.card_last4) m.card_last4 = record.payment.card_last4;
  const payment = paymentString(record.payment);
  if (payment) m.payment = payment;
  const paymentMethod = payment ?? METHOD_LABELS[record.payment.method];
  if (paymentMethod) m.payment_method = paymentMethod;
  m.mirror_account = draft.mirror.accountName;

  const printed = record.printed_totals
    ? Object.fromEntries(Object.entries(record.printed_totals).filter(([, v]) => v !== null && v !== undefined))
    : {};
  if (typeof printed.tax_minor === "number") m.tax_minor = printed.tax_minor;
  if (Object.keys(printed).length > 0) m.printed_totals = printed;

  if (audit) {
    const ocrAudit: Record<string, unknown> = { ...audit };
    for (const k of Object.keys(ocrAudit)) if (ocrAudit[k] === undefined) delete ocrAudit[k];
    ocrAudit.payee_as_printed = facts.payee_as_printed ?? null;
    ocrAudit.payee_source = facts.payee_source ?? null;
    m.ocr_audit = ocrAudit;
  }
  const allocation = allocationAudit(record);
  if (allocation) m.allocation_audit = allocation;
  if (dedup.nearDupCheck) m.near_dup_check = dedup.nearDupCheck;
  if (record.receipt_facts && Object.keys(record.receipt_facts).length > 0) m.receipt_facts = record.receipt_facts;
  if (dedup.ownedItemsNote) m.owned_items_note = dedup.ownedItemsNote;
  return m;
}
