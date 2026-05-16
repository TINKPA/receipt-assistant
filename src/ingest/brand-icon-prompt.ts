/**
 * Shared brand-icon acquisition + judgment phases for the extraction
 * and re-extraction prompts (#101).
 *
 * Both prompts inline these phases verbatim so the agent — which runs
 * inside a container that doesn't have the source files — gets the
 * full instructions in its prompt window. Don't reference these phases
 * by source-file path from the prompt; the agent will go looking for
 * `src/ingest/prompt.ts` and waste turns when it can't find it.
 */

/**
 * Phase 2.6 — Brand discovery & registry upsert.
 *
 * Per merchant brand_id: ensure a `brands` row exists with a canonical
 * name and (when discoverable) an official domain. WebSearch for CJK /
 * regional names; recognize obvious English brands without searching.
 * Skip silently to `metadata.icon_resolution='discovery_failed'` when
 * no domain can be found.
 */
export const PHASE_2_6_BRAND_DISCOVERY = String.raw`── Phase 2.6 — Brand discovery & registry upsert (#101) ───────────────

Goal: ensure every brand_id you emitted has a row in the global
\`brands\` registry, with a canonical English name and (when
discoverable) an official domain. The downstream Phase 4b uses the
domain to query logo.dev; without it that tier is skipped.

Steps (run once per unique merchant brand_id in this document):

  1. Cache check — read the registry first:
       psql "\$DATABASE_URL" -c "SELECT brand_id, name, domain, metadata->>'icon_resolution' AS icon_resolution FROM brands WHERE brand_id = '<bid>';"

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

  3. UPSERT:
       psql "\$DATABASE_URL" <<'SQL'
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
 * Phase 4b — Mechanical icon acquisition (4 tiers, retain all).
 * Phase 4c — Agent visual judgment (Read tool, pick winner).
 *
 * Both inlined as one block because they share the same per-brand
 * loop and the cache pre-check naturally flows from 4b's classification
 * into 4c's input set.
 */
export const PHASE_4B_4C_ICON_PIPELINE = String.raw`── Phase 4b — Mechanical icon acquisition (#101) ──────────────────────

For each unique merchant brand_id this run touched. Skip for
\`unsupported\` and statement-row aggregates with no merchant.

This phase saves every icon candidate it finds. It does NOT pick a
winner — that's Phase 4c. The goal here is mechanical retention:
"every external source that has a plausible match for this brand,
saved to disk, recorded in \`brand_assets\`". Tier is provenance, not
priority.

Cache pre-check (token saver — read before fetching anything):

  psql "\$DATABASE_URL" -c "SELECT b.preferred_asset_id, b.user_chose_at, b.domain, b.metadata->>'icon_resolution' AS icon_resolution, (SELECT count(*) FROM brand_assets WHERE brand_id = '<bid>' AND retired_at IS NULL) AS live_count FROM brands b WHERE brand_id = '<bid>';"

  Case A — preferred_asset_id IS NOT NULL:
    Already resolved. Skip Phase 4b AND 4c for this brand. Move on.

  Case B — preferred_asset_id IS NULL AND live_count > 0:
    Candidates exist but no winner picked yet. Skip mechanical fetch;
    go straight to Phase 4c judgment on the existing rows.

  Case C — live_count = 0 AND icon_resolution = 'discovery_failed':
    No domain to query against, no point fetching. Skip 4b and 4c.

  Case D — live_count = 0 AND domain IS NOT NULL:
    Run the mechanical fetch below.

Mechanical fetch (Case D only). Run each tier independently — partial
failure of one tier doesn't block others. Cap at 3 candidates per
tier to bound the cost. All four tiers can be fetched in parallel
via separate Bash tool calls if you want.

  Tier itunes — Apple iTunes Search API (always free, no auth):

    curl -sS "https://itunes.apple.com/search?term=<urlencoded canonical_name>&entity=software&country=us&limit=3" | jq -r '.results[] | [.trackName, .bundleId, .artworkUrl512] | @tsv'

    For each row (cap 3): download the artwork512 URL with curl,
    save to /data/brand-assets/<bid>/itunes/<bundleId>_512.jpg
    (mkdir -p the parent first). Compute the sha256 of the bytes —
    that's content_hash. Detect image dimensions if you can
    (\`identify -format "%wx%h" <file>\` if ImageMagick is available;
    skip if not — width/height are optional). Then:

      psql "\$DATABASE_URL" <<SQL
        INSERT INTO brand_assets (brand_id, tier, source_url, local_path,
          content_hash, content_type, width, height, bytes)
        VALUES ('<bid>', 'itunes', '<artworkUrl512>',
          '<bid>/itunes/<bundleId>_512.jpg',
          '<sha256>', 'image/jpeg', <w or NULL>, <h or NULL>, <bytes>)
        ON CONFLICT (brand_id, content_hash) DO UPDATE
          SET last_seen_at = NOW();
      SQL

    Do not filter by trackName here — keep all 3 results.
    Phase 4c will judge them visually.

  Tier svgl — clean colored SVGs:

    curl -sS "https://api.svgl.app/?search=<urlencoded canonical_name>" | jq -c '.'

    The response is a JSON array OR an error object. Skip on error.
    Iterate: accept results where \`title\` equals the brand name or
    its parent walked up via \`brands.parent_id\` (max 2 hops). For
    each, download the light variant (\`.route\` is typically the
    light URL). Save to /data/brand-assets/<bid>/svgl/<id>_light.svg
    and INSERT with tier='svgl', content_type='image/svg+xml'.

  Tier logo_dev — search-first, never blind GET:

    Two-step. Step 1 verifies the brand is in the registry (avoids
    the "any unknown domain returns a generated first-letter PNG"
    bug). Step 2 follows the response's pre-signed logo_url.

    Skip this tier entirely if LOGODEV_SECRET_KEY is unset.

    curl -sS -H "Authorization: Bearer \$LOGODEV_SECRET_KEY" \
      "https://api.logo.dev/search?q=<urlencoded canonical_name>" | jq -c '.'

    Iterate matches with plausible name/domain (cap 3). For each:
    follow its \`logo_url\` field (already includes pk_… key). Save
    to /data/brand-assets/<bid>/logo-dev/<domain>.png. INSERT with
    tier='logo_dev'. If the search response is an empty array OR a
    401/403, skip this tier silently — do NOT fall back to a blind
    img.logo.dev/<domain> GET.

  Tier simple_icons — monochrome SVGs (often inferior, but free):

    Compute the slug: lowercase, drop non-alphanumeric. E.g.
    "Best Buy" → "bestbuy".

    curl -sS -o /tmp/si.svg -w '%{http_code} %{content_type}\n' \
      "https://cdn.simpleicons.org/<slug>"

    Only save if HTTP 200 AND content_type starts with "image/svg".
    Save to /data/brand-assets/<bid>/simple-icons/<slug>.svg.
    INSERT with tier='simple_icons'.

  Tier google_play — Android app artwork, scrape og:image (NO auth):

    Cover for the well-documented Apple iTunes Search API indexing lag
    on freshly-launched bundleIds — CHAGEE USA (id=6737460668, launched
    2025-01) returned 0 results from /lookup and /search across 7
    countries for months after launch. Google Play indexes new apps
    almost immediately and exposes a clean artwork URL in the page's
    structured data, with no auth and no Cloudflare wall.

    Guess the Android bundleId from the iOS one or the brand context.
    Common patterns: com.<slug>.application / com.<slug>.us.application
    / com.<slug>.app / com.<seller>.<slug>. If you have the iOS
    bundleId, the Android one usually shares the same reverse-domain
    structure (CHAGEE was com.chagee.application.zh on iOS, but
    com.chagee.us.application on Android — the US-region variant). You
    can also reach the page from a WebSearch "<brand> google play".

    curl -sSL "https://play.google.com/store/apps/details?id=<bundleId>&hl=en_US" \
      -A "Mozilla/5.0" -o /tmp/gp.html

    The icon URL is exposed two ways — pick either:
      (a) <meta property="og:image" content="https://play-lh.googleusercontent.com/...">
      (b) JSON-LD <script type="application/ld+json"> { "@type": "SoftwareApplication",
            "image": "https://play-lh.googleusercontent.com/..." }

    Append =s512 to get a 512x512 PNG (Google Play resizes via URL param):
      curl -sS "<url>=s512" -o /data/brand-assets/<bid>/google-play/<bundleId>_512.png

    INSERT with tier='google_play', content_type='image/png'.
    source_url should be the play.google.com/store/apps/details URL
    (not the play-lh CDN URL — that lets future re-extracts trace
    the asset back to its discoverable page).

After mechanical fetch, brand_assets now has 0..N rows for this brand
with agent_relevance and agent_notes still NULL. Proceed to Phase 4c.

── Phase 4c — Agent visual judgment (#101) ────────────────────────────

For every brand_id that went through Phase 4b — including Case B
where you skipped mechanical fetch but still need to score existing
candidates. Skip for Case A (already-resolved) and Case C
(discovery_failed) brands.

Step 1: list the live candidates:

  psql "\$DATABASE_URL" -c "SELECT id, tier, local_path FROM brand_assets WHERE brand_id = '<bid>' AND retired_at IS NULL ORDER BY acquired_at;"

Step 2: for each row, use the Read tool to open the file at
\`/data/brand-assets/<local_path>\`. Form a one-line visual judgment
and score on 0..100. The judgment is visual — don't rely on tier,
source URL, or filename. Score axes:

  - Brand mark vs. auxiliary app icon. iTunes returns the App Store
    shopping bag for "Apple", a purple Dashboard tile for "Stripe".
    Those are the App Store app's icon and Stripe's Dashboard
    product's icon, not the brand mark. agent_relevance ≤ 20.

    **CRITICAL trap that has burned every prior agent run on this
    project: when merchant brand_id is 'apple' OR 'apple-store',
    the iTunes "com.apple.store.Jolly" shopping-bag icon is NOT
    the Apple Store retail brand mark — it is the icon of the App
    Store iOS app (a separate Apple product). The proper visual
    identity for the entire Apple family of brands (apple,
    apple-store, app-store, applecare) is the Apple silhouette
    logo. SVGL provides this as a clean monochrome vector — Apple
    IS monochrome by design, so DO NOT penalize the svgl Apple
    result for being monochrome; it should score 90+. Any iTunes
    bundleId matching com.apple.store.* OR any image that looks
    like a shopping/download bag with a logo inside MUST score
    ≤ 15 and be retired regardless of merchant brand_id.**
  - Generated letter-fallback placeholder. Single capital letter,
    generic sans-serif, white background → 0; also retire the asset
    so future re-acquisition skips it.
  - Monochrome vs. brand-color logo. Simple Icons SVGs are
    monochrome; unless the brand IS monochrome (Apple, NYT) prefer
    a colored variant. Penalize monochrome ~15.
  - Regional or limited variant. CHAGEE HK&MO badge on a US receipt
    → mild penalty vs. a clean variant.
  - Wordmark-on-square vs. symbol. Both acceptable — neutral.
  - Quality: dimensions (bigger is better for raster), padding
    (over-cropped is bad), transparency present, color accuracy.

Step 3: write the judgment back per candidate:

  psql "\$DATABASE_URL" <<SQL
    UPDATE brand_assets
       SET agent_relevance    = <0..100>,
           agent_notes        = '<one-line judgment>',
           extraction_version = extraction_version + 1
           <, retired_at = NOW() if letter-fallback or otherwise unusable>
     WHERE id = '<candidate_id>';
  SQL

Step 4: pick the winner (Layer-3-safe):

  psql "\$DATABASE_URL" <<SQL
    UPDATE brands
       SET preferred_asset_id = (
             SELECT id FROM brand_assets
              WHERE brand_id = '<bid>'
                AND retired_at IS NULL
                AND agent_relevance >= 30
              ORDER BY agent_relevance DESC, acquired_at ASC
              LIMIT 1
           ),
           updated_at = NOW()
     WHERE brand_id = '<bid>'
       AND user_chose_at IS NULL;
  SQL

The \`user_chose_at IS NULL\` clause is the Layer-3 lock — if the
user has manually picked an icon via PATCH /v1/brands/:id, never
overwrite it.

Step 5: if no candidate scored ≥ 30, the agent rejected every
candidate. Record that:

  psql "\$DATABASE_URL" <<SQL
    UPDATE brands
       SET preferred_asset_id = NULL,
           metadata = metadata || jsonb_build_object(
             'icon_resolution', 'all_candidates_rejected'
           ),
           updated_at = NOW()
     WHERE brand_id = '<bid>'
       AND user_chose_at IS NULL;
  SQL

The frontend falls back to CategoryIcon in this case — a first-class
outcome. Layer-1 retention is preserved (the candidates stay in
brand_assets so re-extract can revisit them later).`;
