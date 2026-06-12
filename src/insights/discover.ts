/**
 * Insight discovery rules (v2 redesign P5, #149) — plain SQL over the
 * ledger, no LLM. Each family emits zero or more cards with a stable
 * `dedupe_key`; refresh upserts so cards update in place and dismissed
 * cards stay dismissed.
 *
 * Families (v1):
 *  - category-spike  (anomaly): this month's category ≥30% and ≥$50
 *    over the same-days pace of last month.
 *  - merchant-trend  (trend): a payee visited ≥3× whose monthly visit
 *    count moved ≥40% vs the prior month.
 *  - owned-milestone (milestone): an owned item crossing a round
 *    days-held mark (1000/1500/2000/2500) within the last 30 days, or
 *    whose $/day dropped under its achievement-plan target.
 *
 * Money note: spending postings are negative in the ledger; rules use
 * ABS() and compare magnitudes.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

interface CardSeed {
  kind: "anomaly" | "trend" | "milestone" | "opportunity";
  title: string;
  body: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function discoverInsights(workspaceId: string): Promise<number> {
  const now = new Date();
  const thisYm = ym(now);
  const prevYm = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const dayOfMonth = now.getDate();
  const seeds: CardSeed[] = [];

  // ── category-spike ────────────────────────────────────────────────
  // Category = the expense account's name, same source as
  // /v1/reports/summary (postings joined to expense accounts with a
  // positive base amount). Spending postings are positive on the
  // expense side, so no ABS gymnastics here.
  const spikes = await db.execute(sql`
    WITH cur AS (
      SELECT a.name AS cat, SUM(p.amount_base_minor) AS minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE p.workspace_id = ${workspaceId}::uuid
        AND t.status <> 'voided' AND a.type = 'expense' AND p.amount_base_minor > 0
        AND to_char(t.occurred_on, 'YYYY-MM') = ${thisYm}
      GROUP BY 1
    ), prev AS (
      SELECT a.name AS cat, SUM(p.amount_base_minor) AS minor
      FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE p.workspace_id = ${workspaceId}::uuid
        AND t.status <> 'voided' AND a.type = 'expense' AND p.amount_base_minor > 0
        AND to_char(t.occurred_on, 'YYYY-MM') = ${prevYm}
        AND EXTRACT(DAY FROM t.occurred_on) <= ${dayOfMonth}
      GROUP BY 1
    )
    SELECT cur.cat, cur.minor AS cur_minor, COALESCE(prev.minor, 0) AS prev_minor
    FROM cur LEFT JOIN prev ON prev.cat = cur.cat
    WHERE cur.cat IS NOT NULL
      AND COALESCE(prev.minor, 0) > 0
      AND cur.minor >= COALESCE(prev.minor, 0) * 1.3
      AND cur.minor - COALESCE(prev.minor, 0) >= 5000
    ORDER BY cur.minor - COALESCE(prev.minor, 0) DESC
    LIMIT 3
  `);
  for (const r of spikes.rows as any[]) {
    const cur = Number(r.cur_minor) / 100;
    const prev = Number(r.prev_minor) / 100;
    const pct = Math.round(((cur - prev) / prev) * 100);
    seeds.push({
      kind: "anomaly",
      title: `${r.cat} spend up ${pct}% this month.`,
      body: `$${cur.toFixed(0)} so far vs $${prev.toFixed(0)} by this day last month.`,
      dedupeKey: `category-spike:${r.cat}:${thisYm}`,
      payload: {
        deep_link: `/transactions?categories=%5B%22${encodeURIComponent(String(r.cat))}%22%5D`,
        figures: { current: cur, previous: prev, pct },
      },
    });
  }

  // ── merchant-trend ────────────────────────────────────────────────
  const trends = await db.execute(sql`
    WITH cur AS (
      SELECT t.payee, COUNT(*) AS n
      FROM transactions t
      WHERE t.workspace_id = ${workspaceId}::uuid
        AND t.status <> 'voided' AND t.payee IS NOT NULL
        AND to_char(t.occurred_on, 'YYYY-MM') = ${thisYm}
      GROUP BY 1
    ), prev AS (
      SELECT t.payee, COUNT(*) AS n
      FROM transactions t
      WHERE t.workspace_id = ${workspaceId}::uuid
        AND t.status <> 'voided' AND t.payee IS NOT NULL
        AND to_char(t.occurred_on, 'YYYY-MM') = ${prevYm}
      GROUP BY 1
    )
    SELECT COALESCE(cur.payee, prev.payee) AS payee,
           COALESCE(cur.n, 0) AS cur_n, COALESCE(prev.n, 0) AS prev_n
    FROM cur FULL OUTER JOIN prev ON prev.payee = cur.payee
    WHERE GREATEST(COALESCE(cur.n,0), COALESCE(prev.n,0)) >= 3
      AND (COALESCE(cur.n,0) >= COALESCE(prev.n,0) * 1.4
           OR COALESCE(cur.n,0) * 1.4 <= COALESCE(prev.n,0))
    ORDER BY ABS(COALESCE(cur.n,0) - COALESCE(prev.n,0)) DESC
    LIMIT 2
  `);
  for (const r of trends.rows as any[]) {
    const up = Number(r.cur_n) >= Number(r.prev_n);
    seeds.push({
      kind: "trend",
      title: `${r.payee} visits ${up ? "up" : "down"}: ${r.prev_n} → ${r.cur_n}.`,
      body: `${r.cur_n} this month vs ${r.prev_n} last month.`,
      dedupeKey: `merchant-trend:${r.payee}:${thisYm}`,
      payload: {
        deep_link: `/transactions?q=${encodeURIComponent(String(r.payee))}`,
        figures: { current: Number(r.cur_n), previous: Number(r.prev_n) },
      },
    });
  }

  // ── owned-milestone ───────────────────────────────────────────────
  const milestones = await db.execute(sql`
    SELECT o.id, COALESCE(p.custom_name, p.canonical_name) AS name,
           (CURRENT_DATE - o.acquired_on) AS days_held,
           o.target_days,
           COALESCE(ti.effective_total_minor, ti.line_total_minor) AS paid_minor
    FROM owned_items o
    LEFT JOIN products p ON p.id = o.product_id
    LEFT JOIN transaction_items ti ON ti.id = o.transaction_item_id
    WHERE o.workspace_id = ${workspaceId}::uuid
      AND o.retired_at IS NULL AND o.acquired_on IS NOT NULL
  `);
  const MARKS = [1000, 1500, 2000, 2500, 3000];
  for (const r of milestones.rows as any[]) {
    const days = Number(r.days_held);
    const mark = MARKS.find((m) => days >= m && days < m + 30);
    if (mark) {
      const perDay =
        r.paid_minor != null ? (Number(r.paid_minor) / 100 / days).toFixed(2) : null;
      seeds.push({
        kind: "milestone",
        title: `${r.name ?? "An item"} hit ${mark.toLocaleString()} days held.`,
        body: perDay
          ? `$/day now $${perDay} and still falling.`
          : `${days.toLocaleString()} days in service.`,
        dedupeKey: `owned-milestone:${r.id}:${mark}`,
        payload: { deep_link: `/owned/${r.id}`, figures: { days, mark } },
      });
    }
    if (
      r.target_days &&
      r.paid_minor != null &&
      days >= Number(r.target_days)
    ) {
      seeds.push({
        kind: "milestone",
        title: `${r.name ?? "An item"} completed its plan.`,
        body: `${days.toLocaleString()} days — past its ${Number(r.target_days).toLocaleString()}-day target. Everything from here is free.`,
        dedupeKey: `owned-target:${r.id}`,
        payload: { deep_link: `/owned/${r.id}`, figures: { days, target: Number(r.target_days) } },
      });
    }
  }

  // ── upsert ────────────────────────────────────────────────────────
  for (const s of seeds) {
    await db.execute(sql`
      INSERT INTO insights (workspace_id, kind, title, body, dedupe_key, payload)
      VALUES (${workspaceId}::uuid, ${s.kind}, ${s.title}, ${s.body}, ${s.dedupeKey}, ${JSON.stringify(s.payload)}::jsonb)
      ON CONFLICT (workspace_id, dedupe_key)
      DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
                    payload = EXCLUDED.payload, updated_at = NOW()
    `);
  }
  return seeds.length;
}
