/**
 * Backfill `transaction_parties` channel rows from the existing
 * merchants linkage (v2 redesign P4, #149).
 *
 * Cheap and deterministic: every transaction that already resolves to a
 * merchant/brand gets one tx-level `channel` row — no re-extraction.
 * Seller/maker rows accumulate from prompt v2.16 ingests and on-demand
 * re-extracts; this script only seeds the spine.
 *
 * Idempotent via the table's UNIQUE NULLS NOT DISTINCT identity.
 *
 * Usage (container): docker exec -i receipt-assistant npx tsx scripts/backfill-channel-parties.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

async function main() {
  const res = await db.execute(sql`
    INSERT INTO transaction_parties
      (workspace_id, transaction_id, transaction_item_id, role, display_name, brand_id, metadata)
    SELECT t.workspace_id, t.id, NULL, 'channel',
           COALESCE(m.canonical_name, t.payee), m.brand_id,
           jsonb_build_object('source', 'backfill-channel-parties')
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.status <> 'voided'
    ON CONFLICT ON CONSTRAINT transaction_parties_identity_uq DO NOTHING
  `);
  console.log(`channel rows inserted: ${res.rowCount}`);

  const total = await db.execute(
    sql`SELECT role, COUNT(*) AS n FROM transaction_parties GROUP BY role`,
  );
  for (const r of total.rows as any[]) console.log(`  ${r.role}: ${r.n}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
