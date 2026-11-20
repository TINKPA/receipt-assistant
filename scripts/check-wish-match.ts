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
 * It calls Google Find Place, Text Search and Place Details (address
 * components only), a few hundred requests, and writes nothing: `decidePlaceMatch` decides, and nothing is linked. Typed names
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
import {
  decidePlaceMatch,
  cityContradicted,
  localityConfirmed,
  localityKeys,
  placeKey,
  streetNumberIs,
  streetType,
  AREA_RADIUS_M,
  type MatchOptions,
  type MatchReason,
} from "../src/wish/places.js";
import type { GoogleAddressComponent } from "../src/google/text-search.js";
import { hanCitiesIn } from "../src/wish/cities.js";
import { searchLanguageFor } from "../src/wish/names.js";
import { captureMatchInput } from "../src/wish/capture.js";
import { parseWishReading } from "../src/wish/reading.js";

const LA = { lat: 34.0522, lng: -118.2437, radiusM: AREA_RADIUS_M };

type Expect =
  | { linked: string; address?: string; unverified?: boolean }
  /** Whatever the outcome, never linked to a place at any of these addresses. */
  | { notLinkedAt: string[] }
  /** Linked, or a suggestion for any other reason than this one. */
  | { notReason: MatchReason }
  | { suggested: string; reason: MatchReason; address?: string }
  | { nothing: true }
  /** Not linked: a suggestion of whatever Google answers, or nothing; and,
   *  with `notAddress`, never a place at that address. */
  | { suggestedAny: true; notAddress?: string };

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
  // r12: a street with no number and no city is in many towns (黄河路 is in Shanghai, Dalian, Changchun …): offered, not linked.
  { why: "r3: a branch in brackets becomes the address; r12: with no city it is only offered", capture: { title: "佳家汤包(黄河路店)" }, expect: { suggested: "", reason: "name_only", address: "Huang He" } },
  { why: "r8: a street branch goes in the address, beside a read city", capture: { title: "佳家汤包(黄河路店)", locality: "上海" }, expect: { linked: "", address: "Huang He" } },
  { why: "r8: a street branch read as the locality; r12: with no city it is only offered", capture: { title: "佳家汤包", locality: "黄河路店" }, expect: { suggested: "", reason: "name_only", address: "Huang He" } },
  { why: "r4: Google's address names no street; the locality and the name decide", capture: { title: "南翔馒头店", address: "豫园路85号", locality: "豫园/城隍庙，上海" }, expect: { linked: "南翔馒头店", unverified: true } },
  { why: "r4: a house number on a Han street", capture: { title: "南翔馒头店", address: "吴江路269号", locality: "上海" }, expect: { linked: "", address: "269" } },
  { why: "r4: the read city is not where Google knows the name", capture: { title: "南翔馒头店", address: "豫园路85号", locality: "北京" }, expect: { nothing: true } },
  { why: "r2: a landmark street is not an address; the city decides", capture: { title: "R&G Lounge", address: "Between Washington St & Jackson St", locality: "San Francisco" }, expect: { linked: "R & G Lounge" } },
  { why: "r8: a Han name Google has no Chinese name for, a landmark and a city: a suggestion, since any Han name finds some place in that city", capture: { title: "岭南小馆", address: "近 Commercial St", locality: "旧金山唐人街" }, expect: { suggested: "R & G Lounge", reason: "name_unverified" } },
  { why: "r4: a landmark with no city is name_only", capture: { title: "R&G Lounge", address: "near Commercial St" }, expect: { suggested: "R & G Lounge", reason: "name_only" } },
  { why: "r3: a name with no city is only a suggestion, in the person's area", capture: { title: "Joe's Pizza" }, expect: { suggested: "Joe's Pizza", reason: "name_only", address: "CA" } },
  { why: "r8: a suite number is not the house number (Ste 2610 on Santa Monica Blvd)", capture: { title: "Haidilao Hot Pot", address: "2610 Wilshire Blvd", locality: "Los Angeles" }, expect: { suggested: "Haidilao", reason: "address_mismatch" } },
  { why: "r8: the street agrees, the read city does not", capture: { title: "Katz's Delicatessen", address: "E Houston St", locality: "Chicago" }, expect: { suggested: "Katz", reason: "locality_mismatch" } },
  { why: "r8: the street agrees, the read city does not", capture: { title: "Swan Oyster Depot", address: "Polk St", locality: "Los Angeles" }, expect: { suggested: "Swan Oyster Depot", reason: "locality_mismatch" } },
  { why: "r8: the house number agrees, the read city does not", capture: { title: "Swan Oyster Depot", address: "1517 Polk St", locality: "Los Angeles" }, expect: { suggested: "Swan Oyster Depot", reason: "locality_mismatch" } },
  { why: "r8: number, street and city agree", capture: { title: "Swan Oyster Depot", address: "1517 Polk St", locality: "San Francisco" }, expect: { linked: "Swan Oyster Depot", address: "1517 Polk" } },
  { why: "r8: a Han name with a street but no number is not enough", capture: { title: "福满楼", address: "Grant Ave", locality: "旧金山" }, expect: { suggestedAny: true } },
  { why: "r12: five Starbucks on Broadway in Manhattan: the street names no branch", capture: { title: "Starbucks", address: "Broadway", locality: "Manhattan" }, expect: { suggested: "Starbucks", reason: "several_branches" } },
  // Google's first answer is on another street (street_mismatch); the Main St one (Alhambra) is name_only. Either way, not linked.
  { why: "r12: a street with no number and no city is in most towns", capture: { title: "Starbucks", address: "Main Street" }, expect: { suggestedAny: true } },
  { why: "r12: a street with no number and no city is in most towns", capture: { title: "In-N-Out Burger", address: "Sunset Blvd" }, expect: { suggested: "In-N-Out", reason: "name_only" } },
  { why: "r12: Pike Street is not Pike Place", capture: { title: "Starbucks", address: "Pike Street", locality: "Seattle" }, expect: { notLinkedAt: ["Pike Pl"] } },
  { why: "r12: Pike St is not Pike Place", capture: { title: "Starbucks", address: "Pike St", locality: "Seattle" }, expect: { notLinkedAt: ["Pike Pl"] } },
  { why: "r12: the one Starbucks branch on Pike St", capture: { title: "Starbucks Reserve Roastery", address: "Pike St", locality: "Seattle" }, expect: { linked: "Starbucks Reserve Roastery", address: "1124 Pike St" } },
  { why: "r12: a street with no number links the one branch of the name on it", capture: { title: "Joe's Pizza", address: "Broadway", locality: "New York" }, expect: { linked: "Joe's Pizza", address: "1435 Broadway" } },
  { why: "r12: Pike Pl is not Pike Street", capture: { title: "Starbucks Reserve Roastery", address: "Pike Pl", locality: "Seattle" }, expect: { notLinkedAt: ["Pike St"] } },
  // ── Captures with a city and no street ──
  { why: "r9: a compound city is not the city it ends with", capture: { title: "Swan Oyster Depot", locality: "South San Francisco, CA" }, expect: { suggested: "Swan Oyster Depot", reason: "locality_mismatch" } },
  { why: "r9: South San Francisco is not San Francisco", capture: { title: "Tartine Bakery", locality: "South San Francisco" }, expect: { notLinkedAt: ["Guerrero"] } },
  { why: "r9: South San Francisco is not San Francisco", capture: { title: "Zuni Cafe", locality: "South San Francisco" }, expect: { notLinkedAt: ["Market St"] } },
  { why: "r9: East Palo Alto is not Palo Alto", capture: { title: "Philz Coffee", locality: "East Palo Alto" }, expect: { notLinkedAt: ["Forest Ave"] } },
  { why: "r9: West New York (New Jersey) is not New York", capture: { title: "Joe's Pizza", locality: "West New York" }, expect: { notLinkedAt: ["Carmine"] } },
  { why: "r9: Pasadena is not South Pasadena", capture: { title: "Mike & Anne's", locality: "Pasadena" }, expect: { notLinkedAt: ["South Pasadena"] } },
  { why: "r9: a country confirms no branch", capture: { title: "Shake Shack", locality: "USA" }, expect: { suggestedAny: true } },
  { why: "r9: a country confirms no branch (中国)", capture: { title: "海底捞", locality: "中国" }, expect: { suggestedAny: true } },
  { why: "r9: a country confirms no branch (Taiwan)", capture: { title: "Din Tai Fung", locality: "Taiwan" }, expect: { suggestedAny: true } },
  { why: "a state confirms no branch", capture: { title: "In-N-Out Burger", locality: "California" }, expect: { suggestedAny: true } },
  { why: "r11: a county is not a city: one of Orange County's branches is not confirmed", capture: { title: "Din Tai Fung", locality: "Orange County" }, expect: { suggestedAny: true } },
  { why: "r11: King County holds Tukwila, Bellevue and Seattle", capture: { title: "Din Tai Fung", locality: "King County" }, expect: { suggestedAny: true } },
  { why: "r11: Los Angeles County is not a city", capture: { title: "In-N-Out Burger", locality: "Los Angeles County" }, expect: { suggestedAny: true } },
  { why: "r11: Santa Clara County is not a city", capture: { title: "Philz Coffee", locality: "Santa Clara County" }, expect: { suggestedAny: true } },
  { why: "r11: a bare Downtown names no city (Culver City has one)", capture: { title: "Philz Coffee", locality: "Downtown" }, expect: { suggestedAny: true } },
  { why: "r11: a bare Downtown names no city (Santa Monica has one)", capture: { title: "Din Tai Fung", locality: "Downtown" }, expect: { suggestedAny: true } },
  { why: "r11: Downtown with its city is that city's", capture: { title: "Philz Coffee", locality: "Downtown, Culver City" }, expect: { linked: "Philz", address: "Culver City" } },
  { why: "r11: a chain with several branches in the city is a suggestion", capture: { title: "Din Tai Fung", locality: "Seattle" }, expect: { notReason: "locality_mismatch" } },
  { why: "a city Google files as a region (Taipei City is administrative_area_level_1)", capture: { title: "Din Tai Fung", address: "City Hall Rd", locality: "Taipei" }, expect: { linked: "Din Tai Fung", address: "Taipei" } },
  // r12b: Taiwan's county-administered cities and Vietnam's provincial cities are administrative_area_level_2.
  { why: "r12b: 花蓮市 is a city Google files at level 2", capture: { title: "公正包子", locality: "花蓮市" }, expect: { linked: "", address: "Hualien" } },
  { why: "r12b: Hualien City at level 2, read in English", capture: { title: "Gong Zheng Bun Store", locality: "Hualien" }, expect: { linked: "Gong Zheng", address: "Hualien" } },
  { why: "r12b: Hội An is a city Google files at level 2", capture: { title: "Morning Glory", locality: "Hoi An" }, expect: { notReason: "locality_mismatch" } },
  { why: "r12b: 上城区 is Hangzhou's Shangcheng District, not the generic 上城", capture: { title: "新白鹿", locality: "上城区" }, expect: { notReason: "locality_mismatch" } },
  { why: "r12b: Center City is Philadelphia's (Google: Center City East)", capture: { title: "Reading Terminal Market", locality: "Center City" }, expect: { linked: "Reading Terminal Market" } },
  // Z & Y Peking Duck, its sister restaurant on the same block, also carries the name: several_branches either way.
  { why: "r12b: a generic word and its city with no comma", capture: { title: "Z & Y Restaurant", locality: "Chinatown San Francisco" }, expect: { suggested: "Z & Y", reason: "several_branches" } },
  { why: "r12b: the same with a comma", capture: { title: "Z & Y Restaurant", locality: "Chinatown, San Francisco" }, expect: { suggested: "Z & Y", reason: "several_branches" } },
  { why: "r12b: Koreatown LA with no comma", capture: { title: "Park's BBQ", locality: "Koreatown LA" }, expect: { linked: "Park" } },
  { why: "r9: New York is confirmed by Brooklyn", capture: { title: "Peter Luger Steak House", locality: "New York" }, expect: { linked: "Peter Luger", address: "Brooklyn" } },
  { why: "r9: NYC is confirmed by Brooklyn", capture: { title: "Di Fara Pizza", locality: "NYC" }, expect: { linked: "Di Fara", address: "Brooklyn" } },
  { why: "r9: 纽约 is confirmed by Brooklyn", capture: { title: "Peter Luger Steak House", locality: "纽约" }, expect: { linked: "Peter Luger", address: "Brooklyn" } },
  { why: "r10: NYC is not Glendale CA, whose name is a Queens neighbourhood's", capture: { title: "Raffi's Place", locality: "NYC" }, expect: { notLinkedAt: ["Glendale, CA"] } },
  { why: "r10: New York is not Glendale CA", capture: { title: "Porto's Bakery", locality: "New York" }, expect: { notLinkedAt: ["Glendale, CA"] } },
  { why: "r10: 纽约 is not Glendale CA", capture: { title: "Porto's Bakery", locality: "纽约" }, expect: { notLinkedAt: ["Glendale, CA", "格伦代尔"] } },
  { why: "r10: Queens is not Glendale CA", capture: { title: "Din Tai Fung", locality: "Queens" }, expect: { notLinkedAt: ["Glendale, CA"] } },
  { why: "r10: Queens is not Glendale CA", capture: { title: "Zankou Chicken", locality: "Queens" }, expect: { notLinkedAt: ["Glendale, CA"] } },
  { why: "r10: NYC is not Woodside CA", capture: { title: "Buck's of Woodside", locality: "NYC" }, expect: { notLinkedAt: ["Woodside, CA"] } },
  { why: "r10: a Queens neighbourhood inside New York still confirms NYC (Woodside, Queens)", capture: { title: "Sripraphai Thai Restaurant", locality: "NYC" }, expect: { linked: "Sripraphai", address: "Woodside" } },
  { why: "r10: 北京路 (Guangzhou's shopping street) is a street, not Beijing", capture: { title: "海底捞", locality: "北京路" }, expect: { notLinkedAt: ["Beijing", "北京市"] } },
  { why: "r10: 北京路 is a street: the place on it is not a mismatch", capture: { title: "陶陶居", locality: "北京路" }, expect: { notReason: "locality_mismatch" } },
  { why: "r10: 北京路 is a street: the place on it is not a mismatch", capture: { title: "太平馆", locality: "北京路" }, expect: { notReason: "locality_mismatch" } },
  { why: "r10: 南京东路 is a street in Shanghai, not Nanjing", capture: { title: "沈大成", locality: "南京东路" }, expect: { notReason: "locality_mismatch" } },
  { why: "r10: a city's street beside the city: the city decides", capture: { title: "陶陶居", locality: "北京路, 广州" }, expect: { notReason: "locality_mismatch" } },
  { why: "r8: a city named like a street is not confirmed by the street (Washington St)", capture: { title: "Golden Dragon", locality: "Washington" }, expect: { suggestedAny: true, notAddress: "Washington St" } },
  { why: "r8: Alameda the city is not N Alameda St", capture: { title: "Philippe The Original", locality: "Alameda" }, expect: { suggested: "Philippe", reason: "locality_mismatch" } },
  { why: "r8: the city it is in", capture: { title: "Philippe The Original", locality: "Los Angeles" }, expect: { linked: "Philippe", address: "Los Angeles" } },
  { why: "r8: a street as the locality confirms nothing", capture: { title: "Joe's Pizza", locality: "Broadway" }, expect: { suggestedAny: true } },
  { why: "r8: a Han name and only a city: Google's English guess is not linked", capture: { title: "张记小馆", locality: "旧金山" }, expect: { suggestedAny: true } },
  { why: "r8: a Han name and only a city", capture: { title: "王记牛肉面", locality: "旧金山" }, expect: { suggestedAny: true } },
  { why: "r8: a description, not a name", capture: { title: "小红书推荐的火锅", locality: "洛杉矶" }, expect: { suggestedAny: true } },
  // r11: Joe's Pizza has several Manhattan branches (Carmine St, Broadway, 14th St): the city alone cannot say which.
  { why: "r8: Google writes Manhattan as New York; r11: several branches there", capture: { title: "Joe's Pizza", locality: "Manhattan" }, expect: { suggested: "Joe's Pizza", reason: "several_branches", address: "New York" } },
  { why: "r8: 曼哈顿 too", capture: { title: "Joe's Pizza", locality: "曼哈顿" }, expect: { suggested: "Joe's Pizza", reason: "several_branches", address: "New York" } },
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
  if ("notLinkedAt" in e) {
    const at = e.notLinkedAt.find((a) => match.formatted_address?.toLowerCase().includes(a.toLowerCase()));
    return linkGoogleId && at ? `expected no link at ${at}` : null;
  }
  if ("notReason" in e) return !linkGoogleId && match.tentative_reason === e.reason ? `expected no ${e.reason}` : null;
  if ("nothing" in e) return linkGoogleId || match.tentative ? "expected nothing" : null;
  if ("suggestedAny" in e) {
    if (linkGoogleId) return "expected no link";
    if (e.notAddress && match.formatted_address?.toLowerCase().includes(e.notAddress.toLowerCase())) return `expected no place at ${e.notAddress}`;
    return null;
  }
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

/** Structured addresses as Google gives them, for the rules on fixed data. */
const C = (long: string, types: string, short = long): GoogleAddressComponent => ({ long, short, types: types.split(",").filter(Boolean) });
const US = [C("United States", "country,political", "US")];
const SF = [C("822", "street_number"), C("Washington Street", "route", "Washington St"), C("Chinatown", "neighborhood,political"), C("San Francisco", "locality,political"), C("San Francisco County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const SSF = [C("123", "street_number"), C("Grand Avenue", "route", "Grand Ave"), C("South San Francisco", "locality,political"), C("San Mateo County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const DC = [C("1", "street_number"), C("Main Street Northwest", "route", "Main St NW"), C("Washington", "locality,political"), C("District of Columbia", "administrative_area_level_1,political", "DC"), ...US];
const SOUTH_PASADENA = [C("1040", "street_number"), C("Mission Street", "route", "Mission St"), C("South Pasadena", "locality,political"), C("Los Angeles County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const BROOKLYN = [C("178", "street_number"), C("Broadway", "route"), C("Southside", "neighborhood,political"), C("Brooklyn", "sublocality_level_1,sublocality,political"), C("Kings County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const FLUSHING = [C("37-01", "street_number"), C("Main Street", "route", "Main St"), C("Flushing", "neighborhood,political"), C("Queens", "sublocality_level_1,sublocality,political"), C("Queens County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const GREAT_NECK = [C("255", "street_number"), C("Northern Boulevard", "route", "Northern Blvd"), C("Great Neck", "locality,political"), C("Nassau County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const CARMINE = [C("7", "street_number"), C("Carmine Street", "route", "Carmine St"), C("Manhattan", "sublocality_level_1,sublocality,political"), C("New York", "locality,political"), C("New York County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const CENTURY_CITY = [C("Ste 2610", "subpremise"), C("10250", "street_number"), C("Santa Monica Boulevard", "route", "Santa Monica Blvd"), C("Century City", "neighborhood,political"), C("Los Angeles", "locality,political"), C("California", "administrative_area_level_1,political", "CA"), C("90067", "postal_code"), ...US];
const ALAMEDA_ST = [C("1001-1003", "street_number"), C("North Alameda Street", "route", "N Alameda St"), C("Los Angeles", "locality,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const SHANGHAI_ZH = [C("269", "street_number"), C("吴江路", "route"), C("静安区", "sublocality_level_1,sublocality,political"), C("上海市", "administrative_area_level_1,political"), C("中国", "country,political", "CN")];
const SHANGHAI_PINYIN = [C("269", "street_number"), C("Wu Jiang Lu", "route"), C("Jing An Qu", "sublocality_level_1,sublocality,political"), C("Shang Hai Shi", "administrative_area_level_1,political"), C("China", "country,political", "CN")];
const TAIPEI = [C("B1", "subpremise"), C("45號", "street_number"), C("City Hall Road", "route", "City Hall Rd"), C("Xinyi District", "administrative_area_level_2,political"), C("Taipei City", "administrative_area_level_1,political"), C("Taiwan", "country,political", "TW")];

const COSTA_MESA = [C("3333", "street_number"), C("Bristol Street", "route", "Bristol St"), C("Costa Mesa", "locality,political"), C("Orange County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const CULVER_DOWNTOWN = [C("9300", "street_number"), C("Culver Boulevard", "route", "Culver Blvd"), C("Downtown", "neighborhood,political"), C("Culver City", "locality,political"), C("Los Angeles County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const GLENDALE_CA = [C("211", "street_number"), C("East Broadway", "route", "E Broadway"), C("Glendale", "locality,political"), C("Los Angeles County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const CORONA_CA = [C("Corona", "locality,political"), C("Riverside County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const WOODSIDE_CA = [C("3062", "street_number"), C("Woodside Road", "route", "Woodside Rd"), C("Woodside", "locality,political"), C("San Mateo County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];
const ELMHURST_IL = [C("Elmhurst", "locality,political"), C("DuPage County", "administrative_area_level_2,political"), C("Illinois", "administrative_area_level_1,political", "IL"), ...US];
const MANHATTAN_KS = [C("Manhattan", "locality,political"), C("Riley County", "administrative_area_level_2,political"), C("Kansas", "administrative_area_level_1,political", "KS"), ...US];
const GLENDALE_QUEENS = [C("Glendale", "neighborhood,political"), C("Queens", "sublocality_level_1,sublocality,political"), C("Queens County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const ELMHURST_QUEENS_LOCALITY = [C("Elmhurst", "locality,political"), C("Queens County", "administrative_area_level_2,political"), C("New York", "administrative_area_level_1,political", "NY"), ...US];
const BEIJING_ZH = [C("朝阳区", "sublocality_level_1,sublocality,political"), C("北京市", "administrative_area_level_1,political"), C("中国", "country,political", "CN")];
const GUANGZHOU_BEIJING_RD_ZH = [C("168号", "street_number"), C("北京路", "route"), C("越秀区", "sublocality_level_1,sublocality,political"), C("广州市", "locality,political"), C("广东省", "administrative_area_level_1,political"), C("中国", "country,political", "CN")];
const SHANGHAI_NANJING_RD_ZH = [C("636号", "street_number"), C("南京东路", "route"), C("黄浦区", "sublocality_level_1,sublocality,political"), C("上海市", "administrative_area_level_1,political"), C("中国", "country,political", "CN")];

const TW = C("Taiwan", "country,political", "TW");
const HUALIEN = [C("Ren'ai Street", "route", "Ren'ai St"), C("Zhumu Village", "administrative_area_level_3,political"), C("Hualien City", "administrative_area_level_2,political"), C("Hualien County", "administrative_area_level_1,political"), TW];
const HUALIEN_ZH = [C("仁愛街", "route"), C("主睦里", "administrative_area_level_3,political"), C("花蓮市", "administrative_area_level_2,political"), C("花蓮縣", "administrative_area_level_1,political"), C("台灣", "country,political", "TW")];
const YILAN = [C("Nanjin Village", "administrative_area_level_3,political"), C("Yilan City", "administrative_area_level_2,political"), C("Yilan County", "administrative_area_level_1,political"), TW];
const HOI_AN = [C("Nguyễn Thái Học", "route"), C("Hội An", "administrative_area_level_2,political"), C("Đà Nẵng", "administrative_area_level_1,political"), C("Vietnam", "country,political", "VN")];
const HANGZHOU_ZH = [C("上城区", "sublocality_level_1,sublocality,political"), C("杭州市", "locality,political"), C("中国", "country,political", "CN")];
const PHILLY = [C("Arch Street", "route", "Arch St"), C("Center City East", "neighborhood,political"), C("Philadelphia", "locality,political"), C("Philadelphia County", "administrative_area_level_2,political"), C("Pennsylvania", "administrative_area_level_1,political", "PA"), ...US];
const KTOWN_LA = [C("Koreatown", "neighborhood,political"), C("Los Angeles", "locality,political"), C("Los Angeles County", "administrative_area_level_2,political"), C("California", "administrative_area_level_1,political", "CA"), ...US];

/** A capture reading through the server's tidying: "address|locality". */
function tidied(k: { title: string; locality?: string; address?: string }): string {
  const parsed = parseWishReading("```json\n" + JSON.stringify({ kind: "place", title: k.title, name_local: null, locality: k.locality ?? null, address: k.address ?? null, confidence: "high" }) + "\n```");
  if (!parsed.ok) return `does not parse: ${parsed.detail}`;
  return `${parsed.reading.address}|${parsed.reading.locality}`;
}

/** The address rules on fixed data, no Google: [what, got, expected]. */
function pureChecks(): [string, unknown, unknown][] {
  return [
    ["Washington St is not Washington", localityConfirmed("Washington", [SF]), false],
    ["Washington DC is", localityConfirmed("Washington", [DC]), true],
    ["华盛顿 is not Washington St", localityConfirmed("华盛顿", [SF]), false],
    // r11: a generic neighbourhood word names no city (every big city has a Chinatown, many a Downtown).
    ["Chinatown alone confirms nothing", localityConfirmed("Chinatown", [SF]), false],
    ["Chinatown, SF", localityConfirmed("Chinatown, SF", [SF]), true],
    ["唐人街 alone confirms nothing", localityConfirmed("唐人街", [SF]), false],
    ["Downtown alone confirms nothing", localityConfirmed("Downtown", [CULVER_DOWNTOWN]), false],
    ["Downtown, Culver City", localityConfirmed("Downtown, Culver City", [CULVER_DOWNTOWN]), true],
    ["Downtown Culver City", localityConfirmed("Downtown Culver City", [CULVER_DOWNTOWN]), true],
    ["Orange County is not a city", localityConfirmed("Orange County", [COSTA_MESA]), false],
    ["Los Angeles County is not a city", localityConfirmed("Los Angeles County", [GLENDALE_CA]), false],
    ["San Francisco County is one city", localityConfirmed("San Francisco County", [SF]), true],
    ["a Taipei district at level 2", localityConfirmed("Xinyi", [TAIPEI]), true],
    ["Costa Mesa", localityConfirmed("Costa Mesa", [COSTA_MESA]), true],
    ["SF, an abbreviation", localityConfirmed("SF", [SF]), true],
    ["South San Francisco is not San Francisco", localityConfirmed("South San Francisco, CA", [SF]), false],
    ["San Francisco is not South San Francisco", localityConfirmed("San Francisco", [SSF]), false],
    ["South San Francisco is itself", localityConfirmed("South San Francisco", [SSF]), true],
    ["Pasadena is not South Pasadena", localityConfirmed("Pasadena", [SOUTH_PASADENA]), false],
    ["Pasadena contradicted by South Pasadena", cityContradicted("Pasadena", [SOUTH_PASADENA]), true],
    ["a country confirms nothing", localityConfirmed("USA", [SF]), false],
    ["a country confirms nothing (United States)", localityConfirmed("United States", [SF]), false],
    ["a state confirms nothing", localityConfirmed("California", [SF]), false],
    ["a state abbreviation confirms nothing", localityConfirmed("CA", [SF]), false],
    ["New York the state is not New York the city", localityConfirmed("New York", [GREAT_NECK]), false],
    ["中国 confirms nothing", localityConfirmed("中国", [SHANGHAI_ZH]), false],
    ["Taiwan confirms nothing", localityConfirmed("Taiwan", [TAIPEI]), false],
    ["上海, a city filed as a region", localityConfirmed("上海", [SHANGHAI_ZH]), true],
    ["上海 against pinyin", localityConfirmed("上海", [SHANGHAI_PINYIN]), true],
    ["静安 (区 cut)", localityConfirmed("静安", [SHANGHAI_ZH]), true],
    ["Taipei, a city filed as a region", localityConfirmed("Taipei", [TAIPEI]), true],
    ["New York confirmed by Brooklyn", localityConfirmed("New York", [BROOKLYN]), true],
    ["NYC confirmed by Queens", localityConfirmed("NYC", [FLUSHING]), true],
    ["纽约 confirmed by Brooklyn", localityConfirmed("纽约", [BROOKLYN]), true],
    ["New York not contradicted by Brooklyn", cityContradicted("New York", [BROOKLYN]), false],
    ["NYC not contradicted by Flushing", cityContradicted("NYC", [FLUSHING]), false],
    ["Manhattan is not Brooklyn", localityConfirmed("Manhattan", [BROOKLYN]), false],
    ["Manhattan is New York", localityConfirmed("Manhattan", [CARMINE]), true],
    ["Queens by its neighbourhood", localityConfirmed("Queens", [FLUSHING]), true],
    ["Flushing", localityConfirmed("法拉盛", [FLUSHING]), true],
    ["West New York is not New York", localityConfirmed("West New York", [CARMINE]), false],
    ["Downtown Los Angeles is Los Angeles", localityConfirmed("Downtown Los Angeles", [CENTURY_CITY]), true],
    ["Chicago contradicted by New York", cityContradicted("Chicago", [CARMINE]), true],
    ["no structured address contradicts nothing", cityContradicted("Chicago", []), false],
    ["a suite is not the house number", streetNumberIs("2610", CENTURY_CITY), false],
    ["a postcode is not the house number", streetNumberIs("90067", CENTURY_CITY), false],
    ["the house number", streetNumberIs("10250", CENTURY_CITY), true],
    ["a number in a range", streetNumberIs("1003", ALAMEDA_ST), true],
    ["a Han 号 number", streetNumberIs("269", SHANGHAI_ZH), true],
    ["a 號 number", streetNumberIs("45", TAIPEI), true],
    ["a street line Google did not split", streetNumberIs("129", [C("解放街129号", ""), C("嘉定区", "sublocality_level_1,sublocality,political")]), true],
    ...["NYC", "New York", "纽约", "Queens"].flatMap((read): [string, unknown, unknown][] =>
      Object.entries({ GLENDALE_CA, CORONA_CA, WOODSIDE_CA, ELMHURST_IL }).flatMap(([town, set]): [string, unknown, unknown][] => [
        [`${read} is not ${town}`, localityConfirmed(read, [set]), false],
        [`${read} contradicted by ${town}`, cityContradicted(read, [set]), true],
      ]),
    ),
    ["Manhattan is not Manhattan KS", localityConfirmed("Manhattan", [MANHATTAN_KS]), false],
    ["Manhattan contradicted by Manhattan KS", cityContradicted("Manhattan", [MANHATTAN_KS]), true],
    ["Glendale read is Glendale CA", localityConfirmed("Glendale", [GLENDALE_CA]), true],
    ["Elmhurst read is Elmhurst IL", localityConfirmed("Elmhurst", [ELMHURST_IL]), true],
    ["NYC confirmed by Glendale, Queens", localityConfirmed("NYC", [GLENDALE_QUEENS]), true],
    ["Queens confirmed by Glendale, Queens", localityConfirmed("Queens", [GLENDALE_QUEENS]), true],
    ["NYC confirmed by Elmhurst, Queens County", localityConfirmed("NYC", [ELMHURST_QUEENS_LOCALITY]), true],
    ["Brooklyn is not a Brooklyn outside New York", localityConfirmed("Brooklyn", [[C("Brooklyn", "locality,political"), C("Jackson County", "administrative_area_level_2,political"), C("Michigan", "administrative_area_level_1,political", "MI"), ...US]]), false],
    ["北京路 is no city", hanCitiesIn("北京路").length, 0],
    ["南京东路 is no city", hanCitiesIn("南京东路").length, 0],
    ["上海路, 香港路, 台北路, 重庆路, 西安路 are no cities", ["上海路", "香港路", "台北路", "重庆路", "西安路", "香港中路", "北京大道"].flatMap(hanCitiesIn).length, 0],
    ["旧金山唐人街 is 旧金山", hanCitiesIn("旧金山唐人街").join(), "旧金山"],
    ["北京市 is 北京", hanCitiesIn("北京市").join(), "北京"],
    ["北京路 does not confirm Beijing", localityConfirmed("北京路", [BEIJING_ZH]), false],
    ["北京路 does not contradict Guangzhou", cityContradicted("北京路", [GUANGZHOU_BEIJING_RD_ZH]), false],
    ["南京东路 does not contradict Shanghai", cityContradicted("南京东路", [SHANGHAI_NANJING_RD_ZH]), false],
    ["北京路, 广州 is Guangzhou", localityConfirmed("北京路, 广州", [GUANGZHOU_BEIJING_RD_ZH]), true],
    ["a locality that is a Han street is read as the address", tidied({ title: "陶陶居", locality: "北京路" }), "北京路|null"],
    ["南京东路 too", tidied({ title: "沈大成", locality: "南京东路" }), "南京东路|null"],
    ["唐人街 stays a locality", tidied({ title: "岭南小馆", locality: "唐人街" }), "null|唐人街"],
    ["a read address keeps the street locality", tidied({ title: "陶陶居", locality: "北京路", address: "168号" }), "168号|北京路"],
    ["Shang Hai Shi is Shanghai", placeKey("Shang Hai Shi"), "shanghai"],
    ["Pike Street is a street", streetType("1124 Pike Street"), "st"],
    ["Pike Pl is a place", streetType("Pike Pl"), "pl"],
    ["a leading St is Saint", streetType("St Marks"), null],
    ["Saint Marks Place", streetType("St Marks Place"), "pl"],
    ["Broadway has no type", streetType("Broadway"), null],
    ["Sixth Avenue", streetType("Sixth Avenue, New York"), "ave"],
    ["a Han street has no type here", streetType("黄河路"), null],
    ["上海市 is 上海", placeKey("上海市"), "上海"],
    // r12b: a level-2 component that is itself a city confirms; a county still does not.
    ["Hualien City at level 2", localityConfirmed("Hualien", [HUALIEN]), true],
    ["花蓮市 at level 2", localityConfirmed("花蓮市", [HUALIEN_ZH]), true],
    ["花蓮 at level 2", localityConfirmed("花蓮", [HUALIEN_ZH]), true],
    ["Yilan at level 2", localityConfirmed("Yilan", [YILAN]), true],
    ["Hội An at level 2 (Vietnam)", localityConfirmed("Hoi An", [HOI_AN]), true],
    ["Hualien County is a region, not the city", localityConfirmed("Hualien County", [HUALIEN]), false],
    ["Orange County still is not a city", localityConfirmed("Orange County", [COSTA_MESA]), false],
    ["King County still is not a city", localityConfirmed("King County", [[C("Tukwila", "locality,political"), C("King County", "administrative_area_level_2,political"), C("Washington", "administrative_area_level_1,political", "WA"), ...US]]), false],
    // r12b: generic words are whole words; a generic word before its city.
    ["上城区 is a district", localityConfirmed("上城区", [HANGZHOU_ZH]), true],
    ["上城 alone is generic", localityConfirmed("上城", [HANGZHOU_ZH]), false],
    ["老城区 is not generic", localityKeys("老城区, 洛阳").find((k) => k.key === "老城")?.generic, false],
    ["老城 alone is generic", localityKeys("老城").find((k) => k.key === "老城")?.generic, true],
    ["Center City keeps its City", placeKey("Center City"), "centercity"],
    ["Center City is Center City East", localityConfirmed("Center City", [PHILLY]), true],
    ["Center alone is generic", localityConfirmed("Center", [PHILLY]), false],
    ["Chinatown San Francisco", localityConfirmed("Chinatown San Francisco", [SF]), true],
    ["Koreatown LA", localityConfirmed("Koreatown LA", [KTOWN_LA]), true],
    ["Koreatown alone confirms nothing", localityConfirmed("Koreatown", [KTOWN_LA]), false],
    ["Chinatown San Francisco is not South San Francisco", localityConfirmed("Chinatown San Francisco", [SSF]), false],
    // r12b: place-search asks Google in the language typed.
    ["公正包子 → zh-CN", searchLanguageFor("公正包子"), "zh-CN"],
    ["鼎泰豐 → zh-TW", searchLanguageFor("鼎泰豐"), "zh-TW"],
    ["海底捞 → zh-CN", searchLanguageFor("海底捞"), "zh-CN"],
    ["一蘭ラーメン → ja", searchLanguageFor("一蘭ラーメン"), "ja"],
    ["북촌손만두 → ko", searchLanguageFor("북촌손만두"), "ko"],
    ["Bestia → Google's default", searchLanguageFor("Bestia"), undefined],
  ];
}

async function main() {
  let pureFailed = 0;
  for (const [what, got, want] of pureChecks()) {
    if (got !== want) {
      pureFailed++;
      console.log(`FAIL ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
  if (pureFailed) console.log(`${pureFailed} address rule(s) failed\n`);
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
  process.exit(failed + pureFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
