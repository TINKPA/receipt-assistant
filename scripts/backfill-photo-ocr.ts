/**
 * Photo-OCR backfill (#74 follow-up).
 *
 * For places that already have a v1 record but no `display_name_zh`
 * (Google's text data didn't include Chinese), download the top
 * storefront photos and have Claude Vision pull any CJK characters
 * from signage. Mirror of Phase 3d in src/ingest/prompt.ts but
 * applied to historical rows.
 *
 * Why prompt-driven and not pure TS: judging "is this character
 * sequence the business's name, or just a goods-tag in Chinese
 * happening to be visible?" is exactly the LLM-flexibility case the
 * project leans into. The TS side just orchestrates: query candidates,
 * spawn `claude -p` once per place, parse the JSON it returns, write
 * the result via psql. No new prompt template lives in TS — the
 * markdown is below as a string constant and matches Phase 3d's
 * conservatism rules.
 *
 * Run inside the receipt-assistant container (has DATABASE_URL,
 * GOOGLE_MAPS_API_KEY, and an authenticated `claude` CLI):
 *
 *   docker exec -i receipt-assistant npx tsx scripts/backfill-photo-ocr.ts [flags]
 *
 * Flags:
 *   --dry-run       Print decisions; touch nothing.
 *   --limit N       Process at most N places.
 *   --only-id UUID  Single-row debug.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

interface Args {
  dryRun: boolean;
  limit: number | null;
  onlyId: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, limit: null, onlyId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10) || null;
    else if (a === "--only-id") out.onlyId = argv[++i] ?? null;
  }
  return out;
}

interface Candidate {
  id: string;
  google_place_id: string;
  display_name_en: string | null;
  primary_type: string | null;
  formatted_address: string;
  photos: { name: string; widthPx?: number; heightPx?: number }[];
}

async function loadCandidates(args: Args): Promise<Candidate[]> {
  const whereOnlyId = args.onlyId
    ? sql` AND id = ${args.onlyId}::uuid`
    : sql``;
  const limit = args.limit ?? 200;
  const result = await db.execute(sql`
    SELECT
      id::text,
      google_place_id,
      display_name_en,
      primary_type,
      formatted_address,
      raw_response->'v1'->'en'->'photos' AS photos_json
    FROM places
    WHERE display_name_zh IS NULL
      AND raw_response->'v1'->'en'->'photos' IS NOT NULL
      AND jsonb_array_length(raw_response->'v1'->'en'->'photos') > 0
      ${whereOnlyId}
    ORDER BY created_at NULLS LAST, id
    LIMIT ${limit}
  `);
  return (result.rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const photos = (r.photos_json as { name: string; widthPx?: number; heightPx?: number }[] | null) ?? [];
    return {
      id: r.id as string,
      google_place_id: r.google_place_id as string,
      display_name_en: (r.display_name_en as string | null) ?? null,
      primary_type: (r.primary_type as string | null) ?? null,
      formatted_address: r.formatted_address as string,
      photos: photos.slice(0, 3),
    };
  });
}

const PROMPT_HEADER = `You are inspecting storefront photographs of a real-world business to
extract its Chinese (Han) or Japanese (Kanji) name from visible signage.

# Rules

- Return the CJK characters EXACTLY as they appear on the storefront sign.
- The characters MUST be on the building / awning / window as the
  business identity — NOT on product labels, menus, food packaging,
  posters, or pass-through translations.
- If multiple CJK strings appear, pick the one that reads as the
  business name and is the visually largest.
- If you cannot read CJK on the storefront with high confidence,
  return null. DO NOT transliterate from the English name. DO NOT
  guess. False negatives are cheap; false positives pollute the cache.

# Procedure

Bash tool gives you curl, sha256sum, mv. The photos are at the
Google v1 \`places/<id>/photos/<rid>\` resources listed below; fetch
each at maxHeightPx=1600 and read it.

# Output

Print EXACTLY one JSON object to stdout as the last thing, no fence:

  {"chinese_name": "永安" | null, "confidence": "high"|"medium"|"low", "reasoning": "<one sentence>"}

That's the only structured output. Status chatter before the JSON is fine.
`;

function buildPlacePrompt(c: Candidate): string {
  const photoLines = c.photos
    .map((p, i) => `  ${i}\t${p.name}\t${p.widthPx ?? "?"}x${p.heightPx ?? "?"}`)
    .join("\n");
  return `${PROMPT_HEADER}

# This place

  google_place_id : ${c.google_place_id}
  display_name_en : ${c.display_name_en ?? "(unknown)"}
  primary_type    : ${c.primary_type ?? "(unknown)"}
  address         : ${c.formatted_address}

# Photos to inspect (top 3)

${photoLines}

Fetch each via:

  curl -sSL "https://places.googleapis.com/v1/<NAME>/media?maxHeightPx=1600&key=$GOOGLE_MAPS_API_KEY" -o /tmp/_ocr_<RANK>.jpg

Read all three, judge, then print the single JSON object.`;
}

function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--session-id",
        randomUUID(),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err || out || `claude -p exited ${code}`));
      else resolve(out);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

interface OcrResult {
  chinese_name: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

function parseClaudeJson(raw: string): OcrResult | null {
  // Match the LAST {...} in the output — Claude often narrates before the JSON
  const matches = [...raw.matchAll(/\{[^{}]*"chinese_name"[\s\S]*?\}/g)];
  if (matches.length === 0) return null;
  const candidate = matches[matches.length - 1]![0];
  try {
    const obj = JSON.parse(candidate) as OcrResult;
    if (typeof obj !== "object" || obj === null) return null;
    if ("chinese_name" in obj && (obj.chinese_name === null || typeof obj.chinese_name === "string")) return obj;
    return null;
  } catch {
    return null;
  }
}

async function applyOcr(c: Candidate, r: OcrResult, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] would set display_name_zh=${r.chinese_name ?? "null"} for ${c.google_place_id}`);
    return;
  }
  if (r.chinese_name == null) return;
  await db.execute(sql`
    UPDATE places SET
      display_name_zh        = ${r.chinese_name},
      display_name_zh_locale = 'zh',
      display_name_zh_source = 'photo_ocr'
    WHERE id = ${c.id}::uuid
      AND display_name_zh IS NULL
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cands = await loadCandidates(args);
  console.log(`backfill-photo-ocr: ${cands.length} place${cands.length === 1 ? "" : "s"} pending`);
  if (cands.length === 0) {
    console.log("nothing to do.");
    return;
  }

  let ok = 0, miss = 0, fail = 0, hit = 0;
  const TIMEOUT = 5 * 60 * 1000;
  for (const c of cands) {
    process.stdout.write(`  ${ok + miss + fail + 1}/${cands.length} ${c.display_name_en ?? c.google_place_id}: `);
    try {
      const raw = await runClaude(buildPlacePrompt(c), TIMEOUT);
      const parsed = parseClaudeJson(raw);
      if (!parsed) {
        fail++;
        console.log("UNPARSEABLE OUTPUT");
        continue;
      }
      ok++;
      if (parsed.chinese_name) {
        hit++;
        console.log(`✓ ${parsed.chinese_name}  (${parsed.confidence})`);
      } else {
        miss++;
        console.log(`— (${parsed.confidence}: ${parsed.reasoning.slice(0, 80)})`);
      }
      await applyOcr(c, parsed, args.dryRun);
    } catch (e) {
      fail++;
      console.log(`ERROR: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`\ndone. ok=${ok} found_zh=${hit} no_zh=${miss} failed=${fail}${args.dryRun ? " (DRY RUN)" : ""}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
