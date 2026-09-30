/**
 * Shared brand-icon acquisition + judgment phases for the extraction
 * and re-extraction prompts (#101).
 *
 * Both prompts inline Phase 2.6 and the Phase 4b/4c GATE verbatim. The
 * 4b/4c procedure itself is NOT inlined (#227): it ships in the image as
 * `brand-icon-pipeline.md` and the gate tells the agent to `cat` it only
 * when a brand actually needs icon work. That file is plain text the
 * agent reads as-is — no template escaping applies to it.
 *
 * Never point the agent at a SOURCE path (`src/ingest/prompt.ts`); it
 * will go looking and waste turns. The one file reference here is a
 * real container path that the Dockerfile puts in place.
 *
 * PLAIN template literals, never `String.raw` (#164). These strings used
 * to be `String.raw`, which passes escape sequences through verbatim —
 * so the agent's window literally read `psql "\$DATABASE_URL"` and
 * ``\`brands\``` with the backslashes still attached. When editing,
 * remember that a plain literal DOES consume `\n` and a trailing `\`
 * before a newline: shell line-continuations and literal `\n` format
 * strings must be written doubled (`\\`, `\\n`).
 */
import { existsSync } from "node:fs";

/**
 * Phase 2.6 — Brand discovery & registry upsert.
 *
 * Per merchant brand_id: ensure a `brands` row exists with a canonical
 * name and (when discoverable) an official domain. WebSearch for CJK /
 * regional names; recognize obvious English brands without searching.
 * Skip silently to `metadata.icon_resolution='discovery_failed'` when
 * no domain can be found.
 */
export const PHASE_2_6_BRAND_DISCOVERY = `── Phase 2.6 — Brand discovery & registry upsert (#101) ───────────────

Goal: ensure every brand_id you emitted has a row in the global
\`brands\` registry, with a canonical English name and (when
discoverable) an official domain. The downstream Phase 4b uses the
domain to query logo.dev; without it that tier is skipped.

BUDGET GATE (see the extractor's Priority & effort-budget preamble):
brand discovery is best-effort enrichment, not core. It is ONE cheap
registry SELECT, and for a brand that is ALREADY KNOWN it ends right
there — do not reason further, do not WebSearch, do not re-UPSERT, just
move on. Only a genuinely unseen brand (no row at all, or a row with a
NULL domain that is NOT marked 'discovery_failed') is worth any
discovery work. When unsure, prefer skipping over spending turns.

Steps (run once per unique merchant brand_id in this document):

  1. Cache check — read the registry first. ONE read covers both this
     step and the Phase 4b icon pre-check further down; do not query
     \`brands\` twice. (Ingest path: this IS result set (1) of Turn A —
     you already have it, do not run it again here.)

       psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" -c "SELECT b.brand_id, b.name, b.domain, b.user_chose_at, b.preferred_asset_id, b.metadata->>'icon_resolution' AS icon_resolution, (SELECT count(*) FROM brand_assets a WHERE a.brand_id = b.brand_id AND a.retired_at IS NULL) AS live_count FROM brands b WHERE b.brand_id = '<bid>';"

     - Row exists with non-null domain → done. Move on.
     - Row exists with null domain AND metadata.icon_resolution =
       'discovery_failed' → already tried, don't re-try. Move on.
     - Row exists with null domain → proceed to discover.
     - Row missing → proceed to discover, then INSERT.

  2. Discover canonical name + domain:
     - If the brand_id is a recognizable English token with an
       obvious domain (starbucks → starbucks.com, apple-store →
       apple.com, costco → costco.com, target → target.com), use it
       directly — no web search needed.
     - Otherwise (CJK names, ambiguous abbreviations, regional brands):
       call the WebSearch tool with a query like
         "<canonical_name> 官网"
       or, if you have an address from the receipt text:
         "<canonical_name> <city or state> official website"
       Look for an official site in the top 3 results. Prefer the
       brand's own .com / regional TLD over directories
       (Yelp/Tripadvisor/etc).
     - If the LA-region check applies (CJK merchant, US receipt
       address), the LA-region brand often differs from the
       mainland: e.g. 三喵奶茶 in LA → 3catea.com, not the
       mainland chain. Geo from receipt printed address helps
       disambiguate.

  3. UPSERT. (Ingest path: do NOT run this as its own call — it is
     statement (1) of Turn B, where it also serves as the FK parent for
     \`merchants.brand_id\`. Carry the name/domain you just discovered
     into that statement.)

       psql -v ON_ERROR_STOP=1 "\$DATABASE_URL" <<'SQL'
         INSERT INTO brands (brand_id, name, domain)
         VALUES ('<bid>', '<canonical_name>', '<domain or NULL>')
         ON CONFLICT (brand_id) DO UPDATE
           SET name   = EXCLUDED.name,
               domain = COALESCE(brands.domain, EXCLUDED.domain),
               updated_at = NOW();
       SQL

  4. Discovery failure:
     - If no usable domain can be found, INSERT/UPDATE with
       metadata = jsonb_build_object('icon_resolution', 'discovery_failed').
       Phase 4b will see this and skip mechanical acquisition for
       this brand. The frontend falls back to CategoryIcon — this
       is a first-class outcome, not an error.

Token cost: discovery dominated by WebSearch (1 call per unseen brand).
Already-cached brands cost only one SELECT. Most receipts hit cache.`;

/**
 * Where the on-demand Phase 4b/4c procedure lives INSIDE the container.
 *
 * A fixed container path rather than one resolved from `import.meta.url`,
 * so the rendered prompt — and therefore `scripts/check-prompt-budget.ts`
 * — is the same number on a laptop, in the builder stage and in the
 * runtime image. The Dockerfile copies `src/ingest/brand-icon-pipeline.md`
 * to exactly this location, next to `lessons.md`.
 */
const ICON_PIPELINE_PATH =
  process.env.PROMPT_ICON_PIPELINE_FILE ??
  "/app/dist/ingest/brand-icon-pipeline.md";

/**
 * Boot-time check for `server.ts`. If the file is absent the gate below
 * still degrades safely (the agent is told to skip icon work), but it
 * would do so silently on every ingest — so say it once, loudly, at boot.
 */
export function iconPipelineFileExists(): boolean {
  return existsSync(ICON_PIPELINE_PATH);
}

/**
 * Phase 4b/4c gate — the cache pre-check, inlined in both prompts.
 *
 * The procedure it guards (4b mechanical acquisition, 4c visual judgment)
 * used to be inlined here too: ~10 KB re-read from cache on every turn of
 * every extraction, while most runs resolve to Case A on the registry row
 * they already hold and never execute a line of it (#227). It now lives in
 * `brand-icon-pipeline.md`, shipped in the image, and the agent reads it
 * only when a brand is Case B or Case D.
 *
 * The four cases stay inline because deciding whether to load the file IS
 * the pre-check. Keep them in sync with the file's own "Case B" / "Case D"
 * references when editing either side.
 */
export const PHASE_4B_4C_ICON_GATE = `── Phase 4b/4c — Brand icons: cache gate (#101) ───────────────────────

For each unique merchant brand_id this run touched. Skip for
\`unsupported\` and statement-row aggregates with no merchant (ingest
only — those classifications do not exist on the re-extract path).

Cache pre-check (token saver — read before fetching anything). You
ALREADY have this row: Phase 2.6 step 1's registry read returns
\`preferred_asset_id\`, \`user_chose_at\`, \`domain\`, \`icon_resolution\`
and \`live_count\` for exactly this purpose. Re-read that output — do
NOT issue another \`brands\` SELECT here.

  Case A — preferred_asset_id IS NOT NULL:
    Already resolved. Skip Phase 4b AND 4c for this brand. Move on.

  Case B — preferred_asset_id IS NULL AND live_count > 0:
    Candidates exist but no winner picked yet. Skip mechanical fetch;
    go straight to Phase 4c judgment on the existing rows.

  Case C — live_count = 0 AND icon_resolution = 'discovery_failed':
    No domain to query against, no point fetching. Skip 4b and 4c.

  Case D — live_count = 0 AND domain IS NOT NULL:
    Run the mechanical fetch (Phase 4b), then Phase 4c judgment.

Every brand is Case A or Case C → icon work is done. Do NOT read the
file below; move on.

At least one brand is Case B or Case D → the procedure itself (the
fetch tiers, the visual scoring rubric, the write-back SQL) is
deliberately NOT in this prompt, because most runs never need it. Read
it ONCE, with one command, then follow it exactly:

  cat ${ICON_PIPELINE_PATH}

If that file cannot be read, skip icon work for this run. It is
enrichment and must never delay or fail the close-out.`;
