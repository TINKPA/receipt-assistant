/**
 * Visiting closes the loop: a purchase booked at the place of an active
 * place wish converts the wish (`status = 'converted'`,
 * `converted_by = 'receipt'`), with the transaction as its proof; and a
 * proof that stops being one (deleted, merged away as a duplicate, its
 * date moved before the wish, the wish's place changed) un-converts it.
 *
 * A transaction QUALIFIES for a wish when all of these hold:
 *   - the transaction is live (`ledger_live_transactions`);
 *   - it is money going out: its profit-and-loss legs are expenses with a
 *     positive total (`directionLateral`, the reconcile definition), and
 *     it is not marked a refund (`metadata.flow`, `metadata.refund_of`);
 *   - it happened on or after the day the wish was made, or last set back
 *     to active (`reactivated_at`): wanting to go after having been is
 *     still a wish. "The day" is the local date in the wish place's time
 *     zone, else the transaction place's, else the workspace's most
 *     common one. On that same day it must also not be known to be
 *     earlier: its `occurred_at` when printed, else when it was booked;
 *   - it was booked after the wish was made (or set back to active): a
 *     receipt is booked after the visit it records, so one booked before
 *     the wish is a visit before it, whatever date it now carries (a
 *     misread future date, a date edited later);
 *   - it is not dated after today (local day, as above), nor printed with
 *     a time still to come: a date ahead of the clock is a misreading, not
 *     a visit, and would make `converted_at` a future time;
 *   - it is not one the user dismissed (leaving `converted` by hand puts
 *     the converting transaction in `dismissed_transaction_ids`);
 *   - for a place wish: `transactions.place_id` is the wish's place, or the
 *     transaction has no place of its own and its merchant's place
 *     (`merchants.place_id`, a Google id) is the wish place's
 *     `google_place_id`. A merchant is per brand and its place is one
 *     branch, so a purchase placed at another branch never matches through
 *     it;
 *     for a thing wish with a `product_id`: a live line item of the
 *     transaction has that product.
 *
 * `settleWishes` then, per wish in scope:
 *   - active: the earliest qualifying transaction converts it;
 *   - converted by a receipt: kept while its transaction still qualifies
 *     (`converted_at` following an edit of its date or time);
 *     otherwise moved to the earliest one that does (a dedup apply folds
 *     the converting row into a survivor at the same place), else set back
 *     to active with the conversion cleared. Every receipt conversion
 *     whose transaction is not live (soft-deleted, or hard-deleted, which
 *     the FK turns into a NULL `converted_transaction_id`) is in scope of
 *     every run, whatever removed it;
 *   - declined, or converted by the user: never touched.
 * `converted_at` is the purchase's time, or the start of its local day,
 * and never before the wish was made.
 *
 * Run it after anything that books, edits, deletes, restores or merges a
 * transaction (both ingest writers, the transaction routes, the document
 * cascade, re-extract, dedup apply and undo, merchant enrichment finding a
 * place) and after a wish's place, product or kind changes or it is set
 * back to active. Every write is guarded by the state it read, so running
 * it twice changes nothing. `settleWishesSafely` never throws.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import { directionLateral } from "../reconcile/dedup.js";

export type WishLoopScope =
  | { transactionIds: string[] }
  | { wishIds: string[] }
  | { merchantId: string }
  | { workspaceId: string };

export interface WishSettlement {
  wishId: string;
  /** `converted`: an active wish converted. `moved`: a receipt conversion
   *  now rests on another transaction. `unconverted`: its proof is gone
   *  and nothing else qualifies, so it is active again. */
  change: "converted" | "moved" | "unconverted";
  transactionId: string | null;
  previousTransactionId: string | null;
}

interface CandidateRow {
  wish_id: string;
  workspace_id: string;
  since: Date | string;
  txn_id: string;
  occurred_on: string;
  occurred_at: Date | string | null;
  booked_at: Date | string;
  wish_tz: string | null;
  txn_tz: string | null;
}

function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The instant a local calendar day starts in a time zone. */
export function startOfLocalDay(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  // The zone's offset at (about) that instant; twice, for a DST edge.
  const offsetAt = (ms: number): number => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m2 = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m2) return 0;
    const mins = Number(m2[2]) * 60 + Number(m2[3] ?? 0);
    return (m2[1] === "-" ? -1 : 1) * mins * 60_000;
  };
  let guess = utcMidnight - offsetAt(utcMidnight);
  guess = utcMidnight - offsetAt(guess);
  return new Date(guess);
}

const workspaceZoneCache = new Map<string, string>();

/** The time zone most of the workspace's places are in, else UTC. */
async function workspaceTimeZone(workspaceId: string): Promise<string> {
  const cached = workspaceZoneCache.get(workspaceId);
  if (cached) return cached;
  const res = await db.execute(sql`
    SELECT p.time_zone
      FROM transactions t JOIN places p ON p.id = t.place_id
     WHERE t.workspace_id = ${workspaceId}::uuid AND p.time_zone IS NOT NULL
     GROUP BY p.time_zone ORDER BY count(*) DESC LIMIT 1`);
  const tz = validTimeZone((res.rows[0] as { time_zone?: string } | undefined)?.time_zone) ?? "UTC";
  workspaceZoneCache.set(workspaceId, tz);
  return tz;
}

/** Transaction `t` (merchant `m`) happened at place wish `w` (place `wp`).
 *  The merchant's place counts only for a transaction with no place of its
 *  own: a merchant is per brand, and its place is one of its branches. */
const atWishPlace = sql`(w.kind = 'place' AND w.place_id IS NOT NULL
           AND (t.place_id = w.place_id
                OR (t.place_id IS NULL AND m.place_id IS NOT NULL AND m.place_id = wp.google_place_id)))`;

/** The wish ids a run looks at: active ones and receipt conversions the
 *  scope can touch, plus every receipt conversion that lost its proof. */
async function wishesInScope(scope: WishLoopScope): Promise<string[]> {
  const open = sql`(w.status = 'active' OR (w.status = 'converted' AND w.converted_by = 'receipt'))`;
  const matches = sql`(${atWishPlace} OR (w.kind = 'thing' AND w.product_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id AND ti.product_id = w.product_id)))`;
  let scoped: SQL | null = null;
  if ("transactionIds" in scope) {
    const ids = [...new Set(scope.transactionIds)];
    if (ids.length > 0) {
      const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
      // `transactions`, not the live view: a deleted row's wishes are the
      // ones to look at again.
      scoped = sql`
        SELECT w.id FROM wish_items w
          JOIN transactions t ON t.workspace_id = w.workspace_id AND t.id IN (${list})
          LEFT JOIN places wp ON wp.id = w.place_id
          LEFT JOIN merchants m ON m.id = t.merchant_id
         WHERE ${open} AND (w.converted_transaction_id = t.id OR ${matches})
        UNION
        SELECT w.id FROM wish_items w WHERE ${open} AND w.converted_transaction_id IN (${list})`;
    }
  } else if ("wishIds" in scope) {
    const ids = [...new Set(scope.wishIds)];
    if (ids.length > 0) {
      scoped = sql`SELECT w.id FROM wish_items w WHERE ${open} AND w.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
    }
  } else if ("merchantId" in scope) {
    scoped = sql`
      SELECT w.id FROM wish_items w
        JOIN transactions t ON t.workspace_id = w.workspace_id AND t.merchant_id = ${scope.merchantId}::uuid
        LEFT JOIN places wp ON wp.id = w.place_id
        LEFT JOIN merchants m ON m.id = t.merchant_id
       WHERE ${open} AND ${matches}`;
  } else {
    scoped = sql`SELECT w.id FROM wish_items w WHERE ${open} AND w.workspace_id = ${scope.workspaceId}::uuid`;
  }
  // Proofs that are gone, whatever removed them: hard-deleted (the FK
  // nulled the column) or no longer live. There are few converted wishes,
  // so this is checked on every run.
  const orphans = sql`
    SELECT w.id FROM wish_items w
     WHERE w.status = 'converted' AND w.converted_by = 'receipt'
       AND (w.converted_transaction_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM ${liveTransactions} lt WHERE lt.id = w.converted_transaction_id))`;
  const res = await db.execute(scoped ? sql`${scoped} UNION ${orphans}` : orphans);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

interface WishState {
  id: string;
  status: string;
  converted_transaction_id: string | null;
}

/** A printed time this far ahead of the server's clock still counts. */
const CLOCK_GRACE_MS = 10 * 60 * 1000;

/** Qualifying transactions of these wishes, earliest first per wish. */
async function qualifying(wishIds: string[]): Promise<Map<string, { row: CandidateRow; tz: string }[]>> {
  const out = new Map<string, { row: CandidateRow; tz: string }[]>();
  if (wishIds.length === 0) return out;
  const res = await db.execute(sql`
    SELECT w.id AS wish_id, w.workspace_id,
           greatest(w.created_at, w.reactivated_at) AS since,
           t.id AS txn_id, t.occurred_on::text AS occurred_on, t.occurred_at, t.created_at AS booked_at,
           wp.time_zone AS wish_tz, tp.time_zone AS txn_tz
      FROM wish_items w
      JOIN ${liveTransactions} t ON t.workspace_id = w.workspace_id
      LEFT JOIN places wp ON wp.id = w.place_id
      LEFT JOIN places tp ON tp.id = t.place_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
      CROSS JOIN LATERAL (${directionLateral("t")}) d
     WHERE w.id IN (${sql.join(wishIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND NOT (t.id = ANY (w.dismissed_transaction_ids))
       -- Any zone's local day of 'since' is at most a day before its UTC day;
       -- the exact day is checked below.
       AND t.occurred_on >= ((greatest(w.created_at, w.reactivated_at) AT TIME ZONE 'UTC')::date - 1)
       -- Booked after the wish: a receipt booked before it records a visit
       -- before it, whatever date it carries now.
       AND t.created_at >= greatest(w.created_at, w.reactivated_at)
       -- Any zone's local today is at most a day after the UTC one; the
       -- exact day is checked below.
       AND t.occurred_on <= (now() AT TIME ZONE 'UTC')::date + 1
       AND d.pl_class IN ('expense', 'mixed') AND d.total > 0
       AND coalesce(t.metadata->>'flow', 'purchase') NOT IN ('refund', 'income')
       AND nullif(btrim(t.metadata->>'refund_of'), '') IS NULL
       AND (
             ${atWishPlace}
          OR (w.kind = 'thing' AND w.product_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM transaction_items ti
                            WHERE ti.transaction_id = t.id AND ti.product_id = w.product_id AND ti.retired_at IS NULL))
           )
     ORDER BY w.id, t.occurred_on, t.occurred_at NULLS LAST, t.created_at, t.id`);
  const now = new Date();
  for (const row of res.rows as unknown as CandidateRow[]) {
    const tz = validTimeZone(row.wish_tz) ?? validTimeZone(row.txn_tz) ?? (await workspaceTimeZone(row.workspace_id));
    const since = new Date(row.since);
    const sinceDay = localDate(since, tz);
    if (row.occurred_on < sinceDay) continue; // bought or visited before it was wished for
    if (row.occurred_on === sinceDay && new Date(row.occurred_at ?? row.booked_at) < since) continue; // earlier that day
    if (new Date(row.booked_at) < since) continue; // booked before the wish: a visit before it
    if (row.occurred_on > localDate(now, tz)) continue; // dated after today: a misreading, not a visit
    if (row.occurred_at && new Date(row.occurred_at).getTime() > now.getTime() + CLOCK_GRACE_MS) continue; // a time still to come
    const list = out.get(row.wish_id) ?? [];
    list.push({ row, tz });
    out.set(row.wish_id, list);
  }
  return out;
}

/** When the purchase happened: its printed time, else the start of its
 *  local day, and never before the wish was made (a same-day receipt with
 *  no time was, by the rule above, after it). */
function convertedAt(row: CandidateRow, tz: string): Date {
  const at = row.occurred_at ? new Date(row.occurred_at) : startOfLocalDay(row.occurred_on, tz);
  const since = new Date(row.since);
  return at < since ? since : at;
}

export async function settleWishes(scope: WishLoopScope): Promise<WishSettlement[]> {
  const ids = await wishesInScope(scope);
  if (ids.length === 0) return [];
  const stateRes = await db.execute(sql`
    SELECT id, status, converted_transaction_id FROM wish_items
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const states = stateRes.rows as unknown as WishState[];
  const quals = await qualifying(ids);

  const out: WishSettlement[] = [];
  for (const w of states) {
    const list = quals.get(w.id) ?? [];
    const first = list[0] ?? null;
    if (w.status === "active") {
      if (!first) continue;
      const upd = await db.execute(sql`
        UPDATE wish_items
           SET status = 'converted',
               converted_transaction_id = ${first.row.txn_id}::uuid,
               converted_at = ${convertedAt(first.row, first.tz).toISOString()}::timestamptz,
               converted_by = 'receipt',
               updated_at = now()
         WHERE id = ${w.id}::uuid AND status = 'active'
           AND NOT (${first.row.txn_id}::uuid = ANY (dismissed_transaction_ids))
        RETURNING id`);
      if (upd.rows.length > 0) {
        console.log(`[wish] converted wish=${w.id} by transaction=${first.row.txn_id}`);
        out.push({ wishId: w.id, change: "converted", transactionId: first.row.txn_id, previousTransactionId: null });
      }
      continue;
    }
    // Converted by a receipt: does its proof still stand?
    const guard = sql`id = ${w.id}::uuid AND status = 'converted' AND converted_by = 'receipt'
           AND converted_transaction_id IS NOT DISTINCT FROM ${w.converted_transaction_id}::uuid`;
    const proof = w.converted_transaction_id ? list.find((q) => q.row.txn_id === w.converted_transaction_id) : undefined;
    if (proof) {
      // It still stands; its date or time may have been edited since, and
      // the visit time follows the receipt.
      const at = convertedAt(proof.row, proof.tz).toISOString();
      const upd = await db.execute(sql`
        UPDATE wish_items SET converted_at = ${at}::timestamptz, updated_at = now()
         WHERE ${guard} AND converted_at IS DISTINCT FROM ${at}::timestamptz
        RETURNING id`);
      if (upd.rows.length > 0) console.log(`[wish] wish=${w.id} converted_at follows transaction=${proof.row.txn_id}: ${at}`);
      continue;
    }
    if (first) {
      const upd = await db.execute(sql`
        UPDATE wish_items
           SET converted_transaction_id = ${first.row.txn_id}::uuid,
               converted_at = ${convertedAt(first.row, first.tz).toISOString()}::timestamptz,
               updated_at = now()
         WHERE ${guard}
        RETURNING id`);
      if (upd.rows.length > 0) {
        console.log(`[wish] converted wish=${w.id} by transaction=${first.row.txn_id} (was ${w.converted_transaction_id ?? "a deleted transaction"})`);
        out.push({ wishId: w.id, change: "moved", transactionId: first.row.txn_id, previousTransactionId: w.converted_transaction_id });
      }
    } else {
      const upd = await db.execute(sql`
        UPDATE wish_items
           SET status = 'active', converted_transaction_id = NULL, converted_at = NULL, converted_by = NULL,
               updated_at = now()
         WHERE ${guard}
        RETURNING id`);
      if (upd.rows.length > 0) {
        console.log(`[wish] unconverted wish=${w.id}: transaction=${w.converted_transaction_id ?? "(deleted)"} no longer converts it`);
        out.push({ wishId: w.id, change: "unconverted", transactionId: null, previousTransactionId: w.converted_transaction_id });
      }
    }
  }
  return out;
}

/** `settleWishes`, logged instead of thrown: a wish never fails a booking. */
export async function settleWishesSafely(scope: WishLoopScope): Promise<WishSettlement[]> {
  try {
    return await settleWishes(scope);
  } catch (err) {
    console.error(`[wish] loop check failed for ${JSON.stringify(scope).slice(0, 200)}:`, err);
    return [];
  }
}
