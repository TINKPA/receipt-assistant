/**
 * pHash backfill + threshold calibration (#134, L2 dedup evidence).
 *
 * Computes `documents.phash` for existing image documents (new uploads
 * get it inline in `uploadDocumentBytes`). Then, with `--calibrate`,
 * prints the all-pairs hamming-distance histogram plus every pair at
 * d ≤ 8 so the strong-evidence threshold can be re-verified against
 * THIS implementation's hashes (cross-implementation hash values
 * drift a few bits vs the python `imagehash` run that produced the
 * original 2026-06-10 calibration; pairwise distances only hold when
 * both sides use the same implementation).
 *
 * Run inside the receipt-assistant container (has DATABASE_URL and the
 * /data uploads mount):
 *
 *   docker exec -i receipt-assistant npx tsx scripts/backfill-phash.ts [flags]
 *
 * Flags:
 *   --dry-run     Compute and report; write nothing.
 *   --limit N     Process at most N documents.
 *   --calibrate   After backfill, print distance histogram + low-d pairs.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { computePhash, phashDistance, isHashableImageMime } from "../src/images/phash.js";
import { resolveUploadPath } from "../src/routes/documents.service.js";

interface Args {
  dryRun: boolean;
  limit: number | null;
  calibrate: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: null, calibrate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10) || null;
    else if (a === "--calibrate") out.calibrate = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rows = (
    await db.execute(
      sql`SELECT id, file_path, mime_type FROM documents
           WHERE phash IS NULL AND file_path IS NOT NULL
             AND mime_type LIKE 'image/%'
           ORDER BY created_at`,
    )
  ).rows as { id: string; file_path: string; mime_type: string }[];

  const todo = args.limit ? rows.slice(0, args.limit) : rows;
  console.log(`[backfill-phash] ${todo.length} image documents without phash`);

  let ok = 0,
    skipped = 0,
    failed = 0;
  for (const r of todo) {
    if (!isHashableImageMime(r.mime_type)) {
      skipped++;
      continue;
    }
    let hash: string | null = null;
    try {
      hash = await computePhash(await readFile(resolveUploadPath(r.file_path)));
    } catch {
      /* unreadable file → leave NULL */
    }
    if (!hash) {
      failed++;
      console.log(`  FAIL ${r.id} (${r.file_path})`);
      continue;
    }
    if (!args.dryRun) {
      await db.execute(
        sql`UPDATE documents SET phash = ${hash} WHERE id = ${r.id}::uuid`,
      );
    }
    ok++;
  }
  console.log(
    `[backfill-phash] done: ${ok} hashed, ${skipped} skipped (mime), ${failed} failed${args.dryRun ? " (dry-run, nothing written)" : ""}`,
  );

  if (args.calibrate) {
    const hashed = (
      await db.execute(
        sql`SELECT id, phash FROM documents WHERE phash IS NOT NULL`,
      )
    ).rows as { id: string; phash: string }[];
    console.log(`\n[calibrate] all-pairs over ${hashed.length} hashes`);
    const hist = new Map<number, number>();
    const close: [number, string, string][] = [];
    for (let i = 0; i < hashed.length; i++) {
      for (let j = i + 1; j < hashed.length; j++) {
        const d = phashDistance(hashed[i]!.phash, hashed[j]!.phash);
        hist.set(d, (hist.get(d) ?? 0) + 1);
        if (d <= 8) close.push([d, hashed[i]!.id, hashed[j]!.id]);
      }
    }
    console.log("  d  pairs");
    for (const d of [...hist.keys()].sort((a, b) => a - b)) {
      if (d <= 24) console.log(`  ${String(d).padStart(2)}  ${hist.get(d)}`);
    }
    close.sort((a, b) => a[0] - b[0]);
    console.log(
      `\n[calibrate] pairs at d ≤ 8 (true dups ≤2; FPs from d=4, and same-app-template screenshots can FP at d=2 — fields decide, see #134):`,
    );
    for (const [d, a, b] of close) console.log(`  d=${d}  ${a}  ${b}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-phash] fatal:", err);
  process.exit(1);
});
