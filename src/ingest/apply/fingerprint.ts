/**
 * The fingerprint of a receipt transaction (wave 1; docs/server-writer.md,
 * "A/B comparison"): the fields two writers must agree on for the same
 * document, in one canonical form, so two transactions (arm A and arm B of the A/B, or a
 * ledger row and the re-projection of the record it came from) compare
 * field by field and as one hash.
 *
 *   header      occurred_on, occurred_at, payee, brand_id, category, flow
 *   postings    {account type:name, amount_minor, currency}, sorted
 *   items       {line_no, raw_name, line_total_minor, line_type,
 *               item_class, product_key, tax, tip, discount}, by line_no
 *   evidence    identifiers, card_last4
 *   parties     {role, display_name, line_no}, sorted
 *   catalog     google_place_id, owned-instance count, ocr_text present
 *
 * Base amounts and `fx_rate` are left out on purpose: both writers leave
 * them to the same post-commit passes, and a rate fetched on another day
 * is not a disagreement about the receipt.
 *
 * Two producers: `fingerprintFromDraft` (a projection, with the record it
 * came from) and `readLedgerFingerprint` (a transaction as stored). Both
 * build a `FingerprintFields`; `fingerprint()` canonicalises and hashes
 * it, and `diffFingerprints` names the fields that differ.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { db } from "../../db/client.js";
import { IDENTIFIER_KEYS, cardLast4 } from "../../reconcile/dedup.js";
import { identifiersOf } from "../contract/validate.js";
import type { ExtractionV1 } from "../contract/v1.js";
import { paymentString } from "./metadata.js";
import type { ApplyDraft } from "./project.js";

export const FINGERPRINT_VERSION = 1;

export interface FingerprintPosting {
  /** `<type>:<name>`, e.g. `expense:Shopping`, `liability:Credit Card`. */
  account: string;
  amount_minor: number;
  currency: string;
}

export interface FingerprintItem {
  line_no: number;
  raw_name: string;
  line_total_minor: number;
  line_type: string;
  item_class: string;
  product_key: string | null;
  tax_minor: number | null;
  tip_share_minor: number | null;
  discount_share_minor: number | null;
}

export interface FingerprintParty {
  role: string;
  display_name: string;
  line_no: number | null;
}

export interface FingerprintFields {
  occurred_on: string;
  /** UTC, `toISOString()`; null when no time. */
  occurred_at: string | null;
  payee: string | null;
  brand_id: string | null;
  category: string | null;
  flow: string | null;
  postings: FingerprintPosting[];
  items: FingerprintItem[];
  identifiers: Record<string, string>;
  card_last4: string | null;
  parties: FingerprintParty[];
  google_place_id: string | null;
  owned_instance_count: number;
  ocr_text_present: boolean;
}

export interface Fingerprint {
  version: number;
  fields: FingerprintFields;
  /** The canonical JSON the hash is taken over. */
  canonical: string;
  sha256: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function utcInstant(s: string | null): string | null {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The fields in canonical order: sorted lists, normalised instants, and
 *  only the five contract identifiers. */
export function canonicalFields(f: FingerprintFields): FingerprintFields {
  const identifiers: Record<string, string> = {};
  for (const k of IDENTIFIER_KEYS) {
    const v = f.identifiers[k];
    if (typeof v === "string" && v.trim() !== "") identifiers[k] = v.trim();
  }
  return {
    occurred_on: f.occurred_on,
    occurred_at: utcInstant(f.occurred_at),
    payee: f.payee,
    brand_id: f.brand_id,
    category: f.category,
    flow: f.flow,
    postings: [...f.postings]
      .map((p) => ({ account: p.account, amount_minor: p.amount_minor, currency: p.currency }))
      .sort((a, b) => cmp(a.account, b.account) || cmp(a.currency, b.currency) || a.amount_minor - b.amount_minor),
    items: [...f.items]
      .map((i) => ({
        line_no: i.line_no,
        raw_name: i.raw_name,
        line_total_minor: i.line_total_minor,
        line_type: i.line_type,
        item_class: i.item_class,
        product_key: i.product_key,
        tax_minor: i.tax_minor,
        tip_share_minor: i.tip_share_minor,
        discount_share_minor: i.discount_share_minor,
      }))
      .sort((a, b) => a.line_no - b.line_no || cmp(a.raw_name, b.raw_name)),
    identifiers,
    card_last4: f.card_last4,
    parties: [...f.parties]
      .map((p) => ({ role: p.role, display_name: p.display_name, line_no: p.line_no }))
      .sort(
        (a, b) =>
          cmp(a.role, b.role) || cmp(a.display_name, b.display_name) || (a.line_no ?? 0) - (b.line_no ?? 0),
      ),
    google_place_id: f.google_place_id,
    owned_instance_count: f.owned_instance_count,
    ocr_text_present: f.ocr_text_present,
  };
}

export function fingerprint(fields: FingerprintFields): Fingerprint {
  const canon = canonicalFields(fields);
  const canonical = JSON.stringify({ v: FINGERPRINT_VERSION, ...canon });
  return {
    version: FINGERPRINT_VERSION,
    fields: canon,
    canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

/** The fields (`payee`, `postings`, `items`, …) where two fingerprints
 *  differ. Empty when they are equal. */
export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a.fields) as (keyof FingerprintFields)[]) {
    if (JSON.stringify(a.fields[k]) !== JSON.stringify(b.fields[k])) out.push(k);
  }
  return out;
}

/**
 * The fingerprint of a projection. `ocrTextPresent` is the document stamp
 * the writer will make (a receipt-text block, or the server-decoded
 * source), which the draft does not carry.
 */
export function fingerprintFromDraft(
  record: ExtractionV1,
  draft: ApplyDraft,
  opts: { ocrTextPresent: boolean },
): Fingerprint {
  return fingerprint({
    occurred_on: draft.header.occurredOn,
    occurred_at: draft.header.occurredAt,
    payee: draft.header.payee,
    brand_id: draft.merchant.brandId,
    category: draft.merchant.category,
    flow: draft.flow,
    postings: draft.postings.map((p) => ({
      account: `${p.account.type}:${p.account.name}`,
      amount_minor: p.amountMinor,
      currency: p.currency,
    })),
    items: draft.items.map((i) => ({
      line_no: i.line_no,
      raw_name: i.raw_name,
      line_total_minor: i.line_total_minor,
      line_type: i.line_type,
      item_class: i.item_class,
      product_key: i.product_key,
      tax_minor: i.tax_minor,
      tip_share_minor: i.tip_share_minor,
      discount_share_minor: i.discount_share_minor,
    })),
    identifiers: identifiersOf(record),
    // Read back the way the ledger side reads it: the typed last-4, else
    // the last four-digit run of the `payment` string the writer stores.
    card_last4: cardLast4({ card_last4: record.payment.card_last4, payment: paymentString(record.payment) }),
    parties: draft.parties.map((p) => ({ role: p.role, display_name: p.displayName, line_no: p.lineNo })),
    google_place_id: draft.place?.googlePlaceId ?? null,
    owned_instance_count: draft.owned.instanceCount,
    ocr_text_present: opts.ocrTextPresent,
  });
}

/**
 * The fingerprint of a stored transaction, read with SELECTs only. The
 * merchant fields come from `metadata.merchant`, falling back to the
 * merchant row; items and parties are the live run; the document is any
 * live document linked to the transaction.
 */
export async function readLedgerFingerprint(
  executor: Pick<typeof db, "execute">,
  transactionId: string,
): Promise<Fingerprint | null> {
  const head = await executor.execute(sql`
    SELECT t.occurred_on::text AS occurred_on,
           to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
           t.payee, t.metadata,
           m.brand_id AS merchant_brand_id, m.category AS merchant_category,
           pl.google_place_id,
           EXISTS (SELECT 1 FROM document_links dl JOIN documents d ON d.id = dl.document_id
                    WHERE dl.transaction_id = t.id AND d.deleted_at IS NULL
                      AND COALESCE(btrim(d.ocr_text), '') <> '') AS ocr_text_present,
           (SELECT count(*) FROM owned_items o JOIN transaction_items ti ON ti.id = o.transaction_item_id
             WHERE ti.transaction_id = t.id AND ti.retired_at IS NULL)::int AS owned_instance_count
      FROM transactions t
      LEFT JOIN merchants m ON m.id = t.merchant_id
      LEFT JOIN places pl ON pl.id = t.place_id
     WHERE t.id = ${transactionId}::uuid`);
  const h = head.rows[0] as
    | {
        occurred_on: string;
        occurred_at: string | null;
        payee: string | null;
        metadata: Record<string, unknown> | null;
        merchant_brand_id: string | null;
        merchant_category: string | null;
        google_place_id: string | null;
        ocr_text_present: boolean;
        owned_instance_count: number;
      }
    | undefined;
  if (!h) return null;
  const md = h.metadata ?? {};
  const mm = (md.merchant && typeof md.merchant === "object" ? md.merchant : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);

  const postings = await executor.execute(sql`
    SELECT a.type::text || ':' || a.name AS account, p.amount_minor, p.currency
      FROM postings p JOIN accounts a ON a.id = p.account_id
     WHERE p.transaction_id = ${transactionId}::uuid`);
  const items = await executor.execute(sql`
    SELECT line_no, raw_name, line_total_minor, line_type, item_class, product_id,
           (SELECT product_key FROM products WHERE id = ti.product_id) AS product_key,
           tax_minor, tip_share_minor, discount_share_minor
      FROM transaction_items ti
     WHERE ti.transaction_id = ${transactionId}::uuid AND ti.retired_at IS NULL`);
  const parties = await executor.execute(sql`
    SELECT tp.role, tp.display_name, ti.line_no
      FROM transaction_parties tp
      LEFT JOIN transaction_items ti ON ti.id = tp.transaction_item_id
     WHERE tp.transaction_id = ${transactionId}::uuid`);

  return fingerprint({
    occurred_on: h.occurred_on,
    occurred_at: h.occurred_at,
    payee: h.payee,
    brand_id: h.merchant_brand_id ?? str(mm.brand_id),
    category: str(mm.category) ?? h.merchant_category,
    flow: str(md.flow),
    postings: (postings.rows as { account: string; amount_minor: string | number; currency: string }[]).map((p) => ({
      account: p.account,
      amount_minor: Number(p.amount_minor),
      currency: p.currency,
    })),
    items: (
      items.rows as {
        line_no: number;
        raw_name: string;
        line_total_minor: string | number;
        line_type: string;
        item_class: string;
        product_key: string | null;
        tax_minor: string | number | null;
        tip_share_minor: string | number | null;
        discount_share_minor: string | number | null;
      }[]
    ).map((i) => ({
      line_no: i.line_no,
      raw_name: i.raw_name,
      line_total_minor: Number(i.line_total_minor),
      line_type: i.line_type,
      item_class: i.item_class,
      product_key: i.product_key,
      tax_minor: toInt(i.tax_minor),
      tip_share_minor: toInt(i.tip_share_minor),
      discount_share_minor: toInt(i.discount_share_minor),
    })),
    identifiers: Object.fromEntries(
      IDENTIFIER_KEYS.map((k) => [k, str(md[k])]).filter((e): e is [string, string] => e[1] !== null),
    ),
    card_last4: cardLast4({ card_last4: md.card_last4, payment: md.payment }),
    parties: (parties.rows as { role: string; display_name: string; line_no: number | null }[]).map((p) => ({
      role: p.role,
      display_name: p.display_name,
      line_no: p.line_no,
    })),
    google_place_id: h.google_place_id,
    owned_instance_count: h.owned_instance_count,
    ocr_text_present: h.ocr_text_present,
  });
}
