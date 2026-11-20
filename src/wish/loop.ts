/**
 * Visiting closes the loop: a purchase booked at the place of an active
 * place wish converts the wish (`status = 'converted'`,
 * `converted_by = 'receipt'`), with the transaction as its proof.
 *
 * A transaction converts a wish when all of these hold:
 *   - the wish is `active` (a declined or converted wish is never touched);
 *   - the transaction is live (`ledger_live_transactions`);
 *   - it is money going out: its profit-and-loss legs are expenses with a
 *     positive total (`directionLateral`, the reconcile definition), and
 *     it is not marked a refund (`metadata.flow`, `metadata.refund_of`);
 *   - it happened on or after the day the wish was made, or set back to
 *     active (`reactivated_at`): wanting to go after having been is still
 *     a wish. "The day" is the local date in the wish place's time zone,
 *     else the transaction place's, else the workspace's most common one.
 *     On that same day it must also not be known to be earlier: its
 *     `occurred_at` when printed, else when it was booked (a receipt
 *     booked before the wish was made is a visit before it);
 *   - it is not one the user dismissed ("Want again" puts the converting
 *     transaction in `dismissed_transaction_ids`);
 *   - for a place wish: `transactions.place_id` is the wish's place, or the
 *     transaction's merchant's place (`merchants.place_id`, a Google id)
 *     is the wish place's `google_place_id`;
 *     for a thing wish with a `product_id`: a live line item of the
 *     transaction has that product.
 * The earliest qualifying transaction wins.
 *
 * Run it after anything that books or links such a transaction (both
 * ingest writers, POST /v1/transactions and its items, a restore, a
 * merchant's place found by enrichment) with the transactions as scope,
 * and when a wish gets a place or a product with the wish as scope. It
 * reads, then updates each wish under `status = 'active'`, so running it
 * twice changes nothing. `convertWishesSafely` never throws.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { liveTransactions } from "../db/live.js";
import { directionLateral } from "../reconcile/dedup.js";

export type WishLoopScope =
  | { transactionIds: string[] }
  | { wishIds: string[] }
  | { merchantId: string };

export interface WishConversion {
  wishId: string;
  transactionId: string;
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

function scopeSql(scope: WishLoopScope): SQL | null {
  if ("transactionIds" in scope) {
    const ids = [...new Set(scope.transactionIds)];
    if (ids.length === 0) return null;
    return sql`t.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
  }
  if ("wishIds" in scope) {
    const ids = [...new Set(scope.wishIds)];
    if (ids.length === 0) return null;
    return sql`w.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
  }
  return sql`t.merchant_id = ${scope.merchantId}::uuid`;
}

export async function convertWishes(scope: WishLoopScope): Promise<WishConversion[]> {
  const where = scopeSql(scope);
  if (!where) return [];
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
     WHERE ${where}
       AND w.status = 'active'
       AND NOT (t.id = ANY (w.dismissed_transaction_ids))
       -- Any zone's local day of 'since' is at most a day before its UTC day;
       -- the exact day is checked below.
       AND t.occurred_on >= ((greatest(w.created_at, w.reactivated_at) AT TIME ZONE 'UTC')::date - 1)
       AND d.pl_class IN ('expense', 'mixed') AND d.total > 0
       AND coalesce(t.metadata->>'flow', 'purchase') NOT IN ('refund', 'income')
       AND nullif(btrim(t.metadata->>'refund_of'), '') IS NULL
       AND (
             (w.kind = 'place' AND w.place_id IS NOT NULL
               AND (t.place_id = w.place_id OR (m.place_id IS NOT NULL AND m.place_id = wp.google_place_id)))
          OR (w.kind = 'thing' AND w.product_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM transaction_items ti
                            WHERE ti.transaction_id = t.id AND ti.product_id = w.product_id AND ti.retired_at IS NULL))
           )
     ORDER BY w.id, t.occurred_on, t.occurred_at NULLS LAST, t.created_at, t.id`);
  const rows = res.rows as unknown as CandidateRow[];
  if (rows.length === 0) return [];

  const chosen = new Map<string, { row: CandidateRow; tz: string }>();
  for (const row of rows) {
    if (chosen.has(row.wish_id)) continue;
    const tz = validTimeZone(row.wish_tz) ?? validTimeZone(row.txn_tz) ?? (await workspaceTimeZone(row.workspace_id));
    const since = new Date(row.since);
    const sinceDay = localDate(since, tz);
    if (row.occurred_on < sinceDay) continue; // bought or visited before it was wished for
    if (row.occurred_on === sinceDay && new Date(row.occurred_at ?? row.booked_at) < since) continue; // earlier that day
    chosen.set(row.wish_id, { row, tz });
  }

  const out: WishConversion[] = [];
  for (const [wishId, { row, tz }] of chosen) {
    const at = row.occurred_at ? new Date(row.occurred_at) : startOfLocalDay(row.occurred_on, tz);
    const upd = await db.execute(sql`
      UPDATE wish_items
         SET status = 'converted',
             converted_transaction_id = ${row.txn_id}::uuid,
             converted_at = ${at.toISOString()}::timestamptz,
             converted_by = 'receipt',
             updated_at = now()
       WHERE id = ${wishId}::uuid AND status = 'active'
         AND NOT (${row.txn_id}::uuid = ANY (dismissed_transaction_ids))
      RETURNING id`);
    if (upd.rows.length > 0) {
      console.log(`[wish] converted wish=${wishId} by transaction=${row.txn_id}`);
      out.push({ wishId, transactionId: row.txn_id });
    }
  }
  return out;
}

/** `convertWishes`, logged instead of thrown: a wish never fails a booking. */
export async function convertWishesSafely(scope: WishLoopScope): Promise<WishConversion[]> {
  try {
    return await convertWishes(scope);
  } catch (err) {
    console.error(`[wish] loop check failed for ${JSON.stringify(scope).slice(0, 200)}:`, err);
    return [];
  }
}
