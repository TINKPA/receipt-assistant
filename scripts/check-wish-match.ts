/**
 * check-wish-match: every case the wish place matcher has been tested on,
 * run against live Google, with the outcome each must have.
 *
 * The matcher (`decidePlaceMatch` in src/wish/places.ts) links a place only
 * when the name agrees and the read location is confirmed by Google's
 * address; anything weaker is a suggestion with a reason, and a place whose
 * name shares nothing is dropped. Each fix to it used to be checked by hand
 * against the case that prompted it, and broke an earlier one. Run this
 * after any change to src/wish/places.ts, src/wish/names.ts or the capture's
 * query (`captureMatchInput` in src/wish/capture.ts); every case must pass.
 *
 * It calls Google Find Place and Text Search (about 80 requests) and writes
 * nothing: `decidePlaceMatch` decides, and nothing is linked. Typed names
 * are judged against, and name-only captures biased to, a fixed area (50
 * km around downtown Los Angeles), not a workspace's.
 *
 * Usage, inside the sandbox container (it has GOOGLE_MAPS_API_KEY):
 *   docker exec receipt-assistant-test npx tsx scripts/check-wish-match.ts [--only=<substring>] [--verbose]
 *
 * Google's answers drift. A failure names the case, what was expected and
 * what Google answered; when Google's data changed rather than the code,
 * update the case and say so in the commit.
 *
 * Exit code: 0 all pass, 1 a case failed, 2 no key.
 */
import { decidePlaceMatch, AREA_RADIUS_M, type MatchOptions, type MatchReason } from "../src/wish/places.js";
import { captureMatchInput } from "../src/wish/capture.js";
import { parseWishReading } from "../src/wish/reading.js";

const LA = { lat: 34.0522, lng: -118.2437, radiusM: AREA_RADIUS_M };

type Expect =
  | { linked: string; address?: string; unverified?: boolean }
  | { suggested: string; reason: MatchReason; address?: string }
  | { nothing: true };

interface Case {
  why: string;
  /** A capture's reading (run through the reading's own tidying), or a
   *  name typed into the app. */
  capture?: { title: string; name_local?: string; address?: string; locality?: string; confidence?: "high" | "medium" | "low" };
  typed?: string;
  expect: Expect;
}

const CASES: Case[] = [
  // ── Captures with a street ──
  { why: "r5: a numbered street confirms the branch", capture: { title: "Kang Ho Dong Baekjeong", address: "6th St", locality: "Koreatown" }, expect: { linked: "Kang Ho Dong", address: "6th St" } },
  { why: "r7: no Shake Shack on 6th Ave; the first answer is on 8th", capture: { title: "Shake Shack", address: "6th Ave", locality: "New York" }, expect: { suggested: "Shake Shack", reason: "street_mismatch" } },
  { why: "r7: \"Sixth Ave\" is the same street", capture: { title: "Shake Shack", address: "Sixth Ave", locality: "New York" }, expect: { suggested: "Shake Shack", reason: "street_mismatch" } },
  { why: "r7: no Din Tai Fung on 3rd St", capture: { title: "Din Tai Fung", address: "3rd St", locality: "Los Angeles" }, expect: { suggested: "Din Tai Fung", reason: "street_mismatch" } },
  { why: "r3: a house number confirms the branch", capture: { title: "Joe's Pizza", address: "7 Carmine St", locality: "New York" }, expect: { linked: "Joe's Pizza", address: "7 Carmine" } },
  { why: "r3: another branch by its house number", capture: { title: "Joe's Pizza", address: "1435 Broadway", locality: "New York" }, expect: { linked: "Joe's Pizza", address: "1435 Broadway" } },
  { why: "r3: a Han street against Google's address in Chinese", capture: { title: "佳家汤包", address: "黄河路", locality: "上海" }, expect: { linked: "", address: "Huang He" } },
  { why: "r3: a branch in brackets becomes the locality", capture: { title: "佳家汤包(黄河路店)" }, expect: { linked: "", address: "Huang He" } },
  { why: "r4: Google's address names no street; the locality and the name decide", capture: { title: "南翔馒头店", address: "豫园路85号", locality: "豫园/城隍庙，上海" }, expect: { linked: "南翔馒头店", unverified: true } },
  { why: "r4: a house number on a Han street", capture: { title: "南翔馒头店", address: "吴江路269号", locality: "上海" }, expect: { linked: "", address: "269" } },
  { why: "r4: the read city is not where Google knows the name", capture: { title: "南翔馒头店", address: "豫园路85号", locality: "北京" }, expect: { nothing: true } },
  { why: "r2: a landmark street is not an address; the city decides", capture: { title: "R&G Lounge", address: "Between Washington St & Jackson St", locality: "San Francisco" }, expect: { linked: "R & G Lounge" } },
  { why: "r4: a Han name, a landmark, and a Han city Google writes in English", capture: { title: "岭南小馆", address: "近 Commercial St", locality: "旧金山唐人街" }, expect: { linked: "R & G Lounge" } },
  { why: "r4: a landmark with no city is name_only", capture: { title: "R&G Lounge", address: "near Commercial St" }, expect: { suggested: "R & G Lounge", reason: "name_only" } },
  { why: "r3: a name with no city is only a suggestion, in the person's area", capture: { title: "Joe's Pizza" }, expect: { suggested: "Joe's Pizza", reason: "name_only", address: "CA" } },
  // ── Captures with a city and no street ──
  { why: "r2: a branch by its city", capture: { title: "Din Tai Fung", locality: "Glendale" }, expect: { linked: "Din Tai Fung", address: "Glendale" } },
  { why: "r7: a namesake in another city is not linked", capture: { title: "Swan Oyster Depot", locality: "Los Angeles" }, expect: { suggested: "Swan Oyster Depot", reason: "locality_mismatch" } },
  { why: "r7: Katz's is in New York, not Chicago", capture: { title: "Katz's Delicatessen", locality: "Chicago" }, expect: { suggested: "Katz", reason: "locality_mismatch" } },
  { why: "r7: 驻马店 is a city, kept whole; Google's 胡辣汤 is in Zhengzhou", capture: { title: "胡辣汤", locality: "驻马店" }, expect: { suggested: "", reason: "locality_mismatch" } },
  { why: "r7: a city abbreviation", capture: { title: "Rubirosa", locality: "Nolita, NYC" }, expect: { linked: "Rubirosa" } },
  { why: "a reading the model was unsure of is never linked", capture: { title: "Bestia", locality: "Los Angeles", confidence: "low" }, expect: { suggested: "Bestia", reason: "low_confidence" } },
  { why: "r5: a name Google does not know answers with another place: dropped", capture: { title: "Supercalifragilistic Noodle House", locality: "Los Angeles" }, expect: { nothing: true } },
  // ── Typed names (area: Los Angeles) ──
  { why: "r4: a typed name inside the area", typed: "Bestia", expect: { linked: "Bestia" } },
  { why: "r5: a typed short name inside the area", typed: "Tsujita Annex", expect: { linked: "Tsujita" } },
  { why: "r6: the far answer is another branch; an LA one carrying the brand is offered", typed: "Sugarfish Little Tokyo", expect: { suggested: "SUGARFISH", reason: "name_mismatch", address: "Los Angeles" } },
  { why: "r6: the name agrees, the place is far", typed: "La Taqueria Mission", expect: { suggested: "La Taqueria", reason: "outside_area", address: "San Francisco" } },
  { why: "r6: the name agrees, the place is far", typed: "Le Bernardin Midtown", expect: { suggested: "Le Bernardin", reason: "outside_area", address: "New York" } },
  { why: "r7: Google's name adds a word; the rest of the title is in its address", typed: "El Farolito Mission District", expect: { suggested: "El Farolito", reason: "outside_area", address: "Mission St" } },
  { why: "r7: Google's name adds words; the city is in its address", typed: "The Kitchen Boulder", expect: { suggested: "The Kitchen", reason: "outside_area", address: "Boulder" } },
];

function describe(m: Awaited<ReturnType<typeof decidePlaceMatch>>): string {
  const { match, linkGoogleId } = m;
  if (linkGoogleId) return `linked ${match.name} | ${match.formatted_address}${match.address_unverified ? " (address_unverified)" : ""}`;
  if (match.tentative) return `suggested ${match.name} | ${match.formatted_address} (${match.tentative_reason})`;
  return `nothing (${match.error}${match.rejected ? `; rejected ${match.rejected.name} | ${match.rejected.formatted_address}` : ""})`;
}

function verdict(c: Case, m: Awaited<ReturnType<typeof decidePlaceMatch>>): string | null {
  const { match, linkGoogleId } = m;
  const e = c.expect;
  const has = (hay: string | null, needle: string | undefined) => !needle || (hay ?? "").toLowerCase().includes(needle.toLowerCase());
  if ("nothing" in e) return linkGoogleId || match.tentative ? "expected nothing" : null;
  if ("linked" in e) {
    if (!linkGoogleId) return "expected a link";
    if (!has(match.name, e.linked) || !has(match.formatted_address, e.address)) return `expected a link to ${e.linked} | ${e.address ?? ""}`;
    if (e.unverified !== undefined && Boolean(match.address_unverified) !== e.unverified) return `expected address_unverified ${e.unverified}`;
    return null;
  }
  if (linkGoogleId || !match.tentative) return "expected a suggestion";
  if (match.tentative_reason !== e.reason) return `expected reason ${e.reason}`;
  if (!has(match.name, e.suggested) || !has(match.formatted_address, e.address)) return `expected a suggestion of ${e.suggested} | ${e.address ?? ""}`;
  return null;
}

async function main() {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("GOOGLE_MAPS_API_KEY is not set: run this inside the sandbox container");
    process.exit(2);
  }
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const verbose = process.argv.includes("--verbose");
  let failed = 0;
  let ran = 0;
  for (const c of CASES) {
    const label = c.typed ? `typed "${c.typed}"` : `capture ${JSON.stringify(c.capture)}`;
    if (only && !label.includes(only)) continue;
    ran++;
    let query: string, basis: string, opts: MatchOptions;
    if (c.typed) {
      query = c.typed;
      basis = "title";
      opts = { names: [c.typed], locationBias: LA, requireInArea: LA };
    } else {
      const k = c.capture!;
      // Through the reading's own tidying, as a capture is.
      const raw = { kind: "place", title: k.title, name_local: k.name_local ?? null, locality: k.locality ?? null, address: k.address ?? null, confidence: k.confidence ?? "high" };
      const parsed = parseWishReading("```json\n" + JSON.stringify(raw) + "\n```");
      if (!parsed.ok) throw new Error(`case reading does not parse: ${parsed.detail}`);
      const input = captureMatchInput(parsed.reading, parsed.reading.confidence);
      ({ query, basis } = input);
      // A name-only capture is biased to the workspace's area, as here.
      opts = { ...input.opts, locationBias: basis === "name_only" ? LA : null };
    }
    const m = await decidePlaceMatch(query, basis, opts);
    const bad = verdict(c, m);
    if (bad) failed++;
    if (bad || verbose) {
      console.log(`${bad ? "FAIL" : "ok  "} ${label}\n     ${c.why}\n     got: ${describe(m)}${bad ? `\n     ${bad}` : ""}`);
    } else console.log(`ok   ${label} → ${describe(m)}`);
  }
  console.log(`\n${ran - failed}/${ran} cases pass`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
