/**
 * Cities as a post writes them and as Google's address writes them. Used
 * to confirm a read locality against Google's address (src/wish/places.ts)
 * and to tell a list entry's own city from a neighbourhood
 * (src/wish/reading.ts). Not a gazetteer: the cities this app's posts are
 * about, and the abbreviations and Han names people use for them. A city
 * missing here only means a Han name of it is not confirmed against an
 * English address (the match is then a suggestion).
 */

/** A spelling a post uses → the city's name in Google's English address. */
export const CITY_ALIASES: Record<string, string> = {
  nyc: "new york", "new york city": "new york", la: "los angeles", dtla: "los angeles", sf: "san francisco",
  旧金山: "san francisco", 舊金山: "san francisco", 三藩市: "san francisco", 纽约: "new york", 紐約: "new york",
  洛杉矶: "los angeles", 洛杉磯: "los angeles", 芝加哥: "chicago", 西雅图: "seattle", 西雅圖: "seattle",
  波士顿: "boston", 波士頓: "boston", 费城: "philadelphia", 費城: "philadelphia", 华盛顿: "washington", 華盛頓: "washington",
  拉斯维加斯: "las vegas", 拉斯維加斯: "las vegas", 圣地亚哥: "san diego", 聖地牙哥: "san diego", 尔湾: "irvine", 爾灣: "irvine",
  温哥华: "vancouver", 溫哥華: "vancouver", 多伦多: "toronto", 多倫多: "toronto", 伦敦: "london", 倫敦: "london",
  巴黎: "paris", 东京: "tokyo", 東京: "tokyo", 大阪: "osaka", 京都: "kyoto", 首尔: "seoul", 首爾: "seoul",
  新加坡: "singapore", 香港: "hong kong", 台北: "taipei", 臺北: "taipei", 上海: "shanghai", 北京: "beijing",
  广州: "guangzhou", 廣州: "guangzhou", 深圳: "shenzhen", 成都: "chengdu", 杭州: "hangzhou", 南京: "nanjing",
  重庆: "chongqing", 重慶: "chongqing", 西安: "xian", 武汉: "wuhan", 武漢: "wuhan", 郑州: "zhengzhou", 鄭州: "zhengzhou",
  // New York's boroughs as Google writes them: Manhattan is "New York, NY";
  // Brooklyn, the Bronx and Staten Island are themselves; Queens is its
  // neighbourhood ("Flushing, NY"), listed in BOROUGH_TOWNS.
  manhattan: "new york", 曼哈顿: "new york", 曼哈頓: "new york", 布鲁克林: "brooklyn", 布魯克林: "brooklyn",
  "the bronx": "bronx", 布朗克斯: "bronx", 皇后区: "queens", 皇后區: "queens", 法拉盛: "flushing",
};

/** A borough whose addresses name the neighbourhood instead: any of these
 *  in Google's address confirms it. */
export const BOROUGH_TOWNS: Record<string, string[]> = {
  queens: [
    "queens", "flushing", "astoria", "long island city", "jackson heights", "elmhurst", "east elmhurst", "forest hills",
    "jamaica", "woodside", "sunnyside", "corona", "bayside", "ridgewood", "rego park", "fresh meadows", "kew gardens",
    "ozone park", "south ozone park", "richmond hill", "whitestone", "college point", "maspeth", "middle village",
    "little neck", "douglaston", "glendale", "howard beach", "far rockaway", "rockaway park", "hollis", "queens village",
    "springfield gardens", "saint albans", "cambria heights", "woodhaven", "oakland gardens", "bellerose", "floral park",
  ],
};

/** The five boroughs: a post's "New York", "NYC" or 纽约 is the whole city,
 *  and Google files a Brooklyn, Bronx, Staten Island or Queens address
 *  under the borough (or a Queens neighbourhood), not under New York. Only
 *  the spellings of New York itself get them, never "Manhattan". */
export const NEW_YORK_SPELLINGS = new Set(["new york", "nyc", "new york city", "纽约", "紐約"]);
export const NEW_YORK_BOROUGHS = ["manhattan", "brooklyn", "bronx", "the bronx", "staten island", ...BOROUGH_TOWNS.queens!];

/** Cities Google files as a region, not a locality: a municipality or a
 *  city-state whose addresses carry it only as `administrative_area_level_1`
 *  (上海市, Taipei City, Tokyo, Seoul) or as the country (Singapore, Hong
 *  Kong). Such a read city is confirmed by that component; no other read
 *  locality ever is (a state or a country says nothing about which branch). */
export const CITY_REGIONS = new Set([
  "shanghai", "beijing", "tianjin", "chongqing", "taipei", "tokyo", "seoul", "busan", "singapore", "hong kong",
  "macau", "macao",
]);

/** A county (`administrative_area_level_2`) that is one city, so naming it
 *  names the city: San Francisco is a city and county in one. Any other
 *  county ("Orange County", "King County", "Los Angeles County") holds many
 *  towns and confirms no branch by itself. A district filed at that level
 *  (Taipei's "Xinyi District", a 区) is part of a city and still confirms. */
export const CITY_COUNTIES = new Set([
  "san francisco county", "city and county of san francisco", "city and county of honolulu", "honolulu county",
  "city and county of denver", "denver county", "philadelphia county",
]);

/** A neighbourhood word many cities have: by itself it says no city
 *  ("Downtown" is Culver City's as well as Los Angeles's), so it confirms
 *  a place only together with a city that is confirmed too. Compared with
 *  the whole word read: 上城区 (Hangzhou), 老城区 (Luoyang) and "Center
 *  City" (Philadelphia) are districts with these names, not the bare
 *  words. */
export const GENERIC_NEIGHBOURHOODS = [
  "downtown", "midtown", "uptown", "old town", "old city", "chinatown", "koreatown", "japantown", "little italy",
  "little saigon", "financial district", "arts district", "fashion district", "theater district", "theatre district",
  "historic district", "city center", "city centre", "town center", "town centre", "centre", "center", "waterfront",
  "市中心", "市区", "市區", "唐人街", "中国城", "中國城", "华埠", "華埠", "老城", "韩国城", "韓國城",
  "韩国街", "韓國街", "日本城", "小意大利", "金融区", "金融區", "下城", "中城", "上城",
];

/** Cities (and New York's boroughs, which posts use as cities). */
const CITIES = new Set([
  ...Object.values(CITY_ALIASES),
  ...Object.keys(CITY_ALIASES),
  "brooklyn", "queens", "manhattan", "bronx", "staten island", "oakland", "berkeley", "san jose", "palo alto",
  "pasadena", "santa monica", "glendale", "burbank", "alhambra", "san gabriel", "arcadia", "long beach", "anaheim",
  "austin", "houston", "dallas", "denver", "boulder", "portland", "miami", "atlanta", "new orleans", "nashville",
  "honolulu", "phoenix", "minneapolis", "detroit", "montreal", "mexico city", "kyoto", "yokohama", "busan",
]);

/** The locality is a city by itself ("Chicago", "Brooklyn", "芝加哥"). */
export function isKnownCity(locality: string): boolean {
  return CITIES.has(locality.trim().toLowerCase().replace(/\s+/g, " "));
}

/** What follows a city's name when the name is a street's: 北京路, 南京东路,
 *  上海街, 香港中路, 西安大道. Such a street is in any city, not in that one. */
const HAN_STREET_AFTER = /^[东西南北中東]?(大道|大街|路|街|道|巷|弄|胡同)/u;

/** The Han city names of CITY_ALIASES a Han locality carries ("旧金山唐人街"
 *  → 旧金山), except where the name is a street's ("北京路" → none,
 *  "南京东路" → none). */
export function hanCitiesIn(locality: string): string[] {
  return Object.keys(CITY_ALIASES).filter((k) => {
    if (!/\p{Script=Han}/u.test(k)) return false;
    for (let at = locality.indexOf(k); at >= 0; at = locality.indexOf(k, at + 1)) {
      if (!HAN_STREET_AFTER.test(locality.slice(at + k.length))) return true;
    }
    return false;
  });
}

/** New York City's own parts: a borough or a Queens neighbourhood read for
 *  New York confirms a place only inside the city, never a namesake town
 *  (Glendale CA, Corona CA, Woodside CA, Elmhurst IL, Manhattan KS). */
export const NEW_YORK_PARTS = new Set(["manhattan", "brooklyn", "bronx", "the bronx", "staten island", "queens"]);
/** The city's counties, as Google writes them (`administrative_area_level_2`). */
export const NEW_YORK_COUNTIES = new Set(["new york county", "kings county", "bronx county", "richmond county", "queens county"]);
