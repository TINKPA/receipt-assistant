/**
 * #159 — seed Apple product hero images into `product_assets`.
 *
 * Mirrors the #101 brand-asset seeding idea, but for the product
 * catalog. For each filename → canonical_name predicate (mapping `D`
 * in the impl brief), this script:
 *   1. SELECTs every live (`retired_from_catalog_at IS NULL`) product
 *      row under `brand_id='apple'` in the target workspace matching
 *      the predicate.
 *   2. sha256s the source PNG, copies it to
 *      `<root>/<product_id>/manual_seed/<sha8>.png`, and INSERTs a
 *      `product_assets` row (tier=manual_seed) with
 *      `ON CONFLICT (product_id, content_hash) DO UPDATE last_seen_at`.
 *   3. UPDATEs `products.preferred_asset_id` + `preferred_asset_chosen_at`
 *      only WHERE `preferred_asset_chosen_at IS NULL` (Layer-3 lock:
 *      never clobbers a user/agent choice).
 *
 * Idempotent — re-running only bumps `last_seen_at` and leaves chosen
 * rows alone. Prints a matched / unmatched / multi reconciliation
 * report at the end.
 *
 * Resolution is by PREDICATE at run time — product UUIDs are
 * `gen_random_uuid()` and are never hard-coded.
 *
 * Run (host, against a reachable DB):
 *   DATABASE_URL=... npx tsx scripts/seed-apple-product-images.ts [workspace_id]
 *
 * Env:
 *   SEED_WORKSPACE_ID    target workspace (else first positional arg,
 *                        else the single existing workspace).
 *   PRODUCT_IMAGE_DIR    source PNG dir (default ~/Desktop/apple_product_imgs).
 *   PRODUCT_ASSETS_ROOT  bind-mount root (default
 *                        ~/Developer/receipt-assistant-data/product-assets).
 *   --dry-run            resolve + report; write nothing.
 */
import "dotenv/config";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";

const HOME = homedir();
const IMAGE_DIR = process.env.PRODUCT_IMAGE_DIR || join(HOME, "Desktop", "apple_product_imgs");
const ASSETS_ROOT =
  process.env.PRODUCT_ASSETS_ROOT ||
  join(HOME, "Developer", "receipt-assistant-data", "product-assets");
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * filename (under IMAGE_DIR, `<name>.png`) → SQL predicate fragment
 * (applied with `canonical_name ILIKE`, ANDed with `brand_id='apple'`
 * and `retired_from_catalog_at IS NULL`). Each `pred` is a function
 * returning a drizzle `sql` fragment so multi-clause matches compose.
 *
 * Files explicitly skipped per the brief: `*_norm.png` (stale white-bg),
 * `_GRID_*`, `_flagged_*`, `iPhone_17_Pro.png` (no DB product). Those
 * are simply not listed here.
 */
const MAPPING: Array<{ file: string; pred: () => ReturnType<typeof sql> }> = [
  { file: "AirPods_Max.png", pred: () => sql`canonical_name ILIKE '%airpods max%'` },
  { file: "AirPods_Pro_3.png", pred: () => sql`canonical_name ILIKE '%airpods pro%'` },
  { file: "Apple_Pencil_2.png", pred: () => sql`canonical_name ILIKE '%apple pencil%'` },
  {
    file: "Apple_Watch_S11.png",
    pred: () =>
      sql`canonical_name ILIKE '%apple watch%' AND (canonical_name ILIKE '%series 11%' OR canonical_name ILIKE '%s11%')`,
  },
  {
    file: "Apple_Watch_Series_7.png",
    pred: () => sql`canonical_name ILIKE '%apple watch%series 7%'`,
  },
  { file: "HomePod_mini.png", pred: () => sql`canonical_name ILIKE '%homepod mini%'` },
  {
    file: "HomePod.png",
    pred: () =>
      sql`canonical_name ILIKE '%homepod%' AND canonical_name NOT ILIKE '%mini%'`,
  },
  { file: "iPad_mini.png", pred: () => sql`canonical_name ILIKE '%ipad mini%'` },
  { file: "iPad_Pro.png", pred: () => sql`canonical_name ILIKE '%ipad pro%'` },
  { file: "iPhone_12.png", pred: () => sql`canonical_name ILIKE '%iphone 12%'` },
  {
    file: "iPhone_13.png",
    pred: () =>
      sql`canonical_name ILIKE '%iphone 13%' AND canonical_name NOT ILIKE '%pro%'`,
  },
  {
    file: "iPhone_14_Pro.png",
    pred: () =>
      sql`canonical_name ILIKE '%iphone 14 pro%' AND canonical_name NOT ILIKE '%max%'`,
  },
  {
    file: "iPhone_16_Pro_Max.png",
    pred: () => sql`canonical_name ILIKE '%iphone 16 pro max%'`,
  },
  {
    file: "iPhone_17.png",
    pred: () =>
      sql`canonical_name ILIKE '%iphone 17%' AND canonical_name NOT ILIKE '%pro%'`,
  },
  {
    file: "iPhone_17_Pro_Max.png",
    pred: () => sql`canonical_name ILIKE '%iphone 17 pro max%'`,
  },
  { file: "MacBook_Pro_14.png", pred: () => sql`canonical_name ILIKE '%macbook pro 14%'` },
  { file: "Pro_Display_XDR.png", pred: () => sql`canonical_name ILIKE '%pro display xdr%'` },
];

async function resolveWorkspaceId(): Promise<string> {
  const explicit =
    process.env.SEED_WORKSPACE_ID ||
    process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (explicit) return explicit;
  const rows = await db.execute(sql`SELECT id FROM workspaces ORDER BY created_at ASC`);
  const list = rows.rows as Array<{ id: string }>;
  if (list.length === 0) {
    throw new Error("No workspaces exist; pass SEED_WORKSPACE_ID or an arg.");
  }
  if (list.length > 1) {
    console.warn(
      `⚠️  ${list.length} workspaces exist; defaulting to the oldest (${list[0]!.id}). ` +
        `Pass SEED_WORKSPACE_ID to target a specific one.`,
    );
  }
  return list[0]!.id;
}

interface RowResult {
  file: string;
  matched: string[]; // product ids
  status: "matched" | "unmatched" | "multi";
  attached: number; // new asset rows inserted
  refreshed: number; // existing asset rows touched
  pointed: number; // products whose preferred_asset_id we set
}

async function main() {
  const workspaceId = await resolveWorkspaceId();
  console.log(`Workspace : ${workspaceId}`);
  console.log(`Image dir : ${IMAGE_DIR}`);
  console.log(`Asset root: ${ASSETS_ROOT}`);
  console.log(DRY_RUN ? "Mode      : DRY RUN (no writes)\n" : "Mode      : LIVE\n");

  const results: RowResult[] = [];

  for (const { file, pred } of MAPPING) {
    const srcPath = join(IMAGE_DIR, file);
    let bytes: Buffer;
    try {
      bytes = await readFile(srcPath);
    } catch {
      console.warn(`✗ ${file}: source PNG missing at ${srcPath} — skipped`);
      results.push({
        file,
        matched: [],
        status: "unmatched",
        attached: 0,
        refreshed: 0,
        pointed: 0,
      });
      continue;
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    const sha8 = sha.slice(0, 8);
    const relPath = `__pid__/manual_seed/${sha8}.png`; // placeholder, per-product below

    // Resolve product ids by predicate (workspace + apple + live).
    const matchRows = await db.execute(
      sql`SELECT id FROM products
          WHERE workspace_id = ${workspaceId}::uuid
            AND brand_id = 'apple'
            AND retired_from_catalog_at IS NULL
            AND (${pred()})`,
    );
    const ids = (matchRows.rows as Array<{ id: string }>).map((r) => r.id);

    const status: RowResult["status"] =
      ids.length === 0 ? "unmatched" : ids.length > 1 ? "multi" : "matched";

    let attached = 0;
    let refreshed = 0;
    let pointed = 0;

    if (!DRY_RUN) {
      for (const productId of ids) {
        const productRel = `${productId}/manual_seed/${sha8}.png`;
        const absPath = join(ASSETS_ROOT, productRel);
        // Write the file (idempotent for identical bytes).
        let alreadyOnDisk = false;
        try {
          await stat(absPath);
          alreadyOnDisk = true;
        } catch {
          /* not present */
        }
        if (!alreadyOnDisk) {
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, bytes);
        }

        // INSERT ... ON CONFLICT (product_id, content_hash) DO UPDATE.
        const ins = await db.execute(
          sql`INSERT INTO product_assets
                (product_id, tier, source_url, local_path, content_hash,
                 content_type, bytes, metadata)
              VALUES
                (${productId}::uuid, 'manual_seed', NULL, ${productRel},
                 ${sha}, 'image/png', ${bytes.length},
                 ${sql.raw(`'${JSON.stringify({ seed_source: file })}'::jsonb`)})
              ON CONFLICT (product_id, content_hash)
                DO UPDATE SET last_seen_at = NOW()
              RETURNING id, (xmax = 0) AS inserted`,
        );
        const row = ins.rows[0] as { id: string; inserted: boolean };
        if (row.inserted) attached++;
        else refreshed++;
        const assetId = row.id;

        // Point preferred at it only if the user/agent hasn't chosen.
        const upd = await db.execute(
          sql`UPDATE products
              SET preferred_asset_id = ${assetId}::uuid,
                  preferred_asset_chosen_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${productId}::uuid
                AND workspace_id = ${workspaceId}::uuid
                AND preferred_asset_chosen_at IS NULL
              RETURNING id`,
        );
        if (upd.rows.length > 0) pointed++;
      }
    }

    void relPath;
    results.push({ file, matched: ids, status, attached, refreshed, pointed });
    const tag =
      status === "matched" ? "✓" : status === "multi" ? "≡" : "·";
    console.log(
      `${tag} ${file.padEnd(26)} → ${ids.length} product(s)` +
        (DRY_RUN
          ? ""
          : ` | +${attached} new, ~${refreshed} refreshed, →${pointed} preferred`),
    );
  }

  // ── Reconciliation report ────────────────────────────────────────────
  const matched = results.filter((r) => r.status === "matched");
  const multi = results.filter((r) => r.status === "multi");
  const unmatched = results.filter((r) => r.status === "unmatched");
  const totalAttached = results.reduce((s, r) => s + r.attached, 0);
  const totalRefreshed = results.reduce((s, r) => s + r.refreshed, 0);
  const totalPointed = results.reduce((s, r) => s + r.pointed, 0);

  console.log("\n──────────── Reconciliation ────────────");
  console.log(`Mappings           : ${results.length}`);
  console.log(`  matched (1 prod) : ${matched.length}`);
  console.log(`  multi (>1 prod)  : ${multi.length}` + (multi.length ? `  [${multi.map((m) => m.file).join(", ")}]` : ""));
  console.log(`  unmatched (0)    : ${unmatched.length}` + (unmatched.length ? `  [${unmatched.map((m) => m.file).join(", ")}]` : ""));
  if (!DRY_RUN) {
    console.log(`Asset rows inserted: ${totalAttached}`);
    console.log(`Asset rows refresh : ${totalRefreshed}`);
    console.log(`Products pointed   : ${totalPointed}`);
  }
  console.log("────────────────────────────────────────");
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    pool.end().finally(() => process.exit(1));
  });
