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
};

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
