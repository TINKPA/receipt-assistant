/**
 * Does the place Google found carry the name that was asked for?
 *
 * Find Place always answers with its best guess, and a guess for a name it
 * does not know is some other place nearby ("Supercalifragilistic Noodle
 * House" came back as a Sawtelle noodle shop). A match whose name shares
 * too little with the query is therefore not linked; it is kept as a
 * suggestion the person confirms (src/wish/places.ts).
 *
 * Names are compared as sets of significant tokens: letters folded
 * (accents dropped, case ignored, `&` read as "and", apostrophes removed),
 * generic words ("restaurant", "cafe", "the") left out, and a run of
 * CJK characters taken one character at a time (so 岭南小馆 and 嶺南小館
 * still share half their characters). `nameMatches` is the rule;
 * `nameScore` is recorded beside a match for whoever reads it later.
 */

const GENERIC = new Set([
  "the", "and", "of", "a", "an", "at", "on", "in", "by", "de", "la", "le", "el", "les", "los", "las", "di", "da",
  "restaurant", "restaurante", "ristorante", "cafe", "bar", "kitchen", "house", "shop", "store", "eatery", "bistro",
  "co", "inc", "llc", "ltd",
  "餐", "厅", "廳", "店", "馆", "館", "家",
]);

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/** Only the words that never name anything: articles and the like. */
const ARTICLES = new Set([
  "the", "and", "of", "a", "an", "at", "on", "in", "by", "de", "la", "le", "el", "les", "los", "las", "di", "da",
]);

export function nameTokens(s: string): string[] {
  return tokens(s).filter((t) => !GENERIC.has(t));
}

/** Every word of a name but its articles: "The Kitchen Boulder" →
 *  kitchen, boulder. For "do the two names share a word at all", where
 *  "kitchen" or "house" counts. */
export function looseTokens(s: string): string[] {
  return tokens(s).filter((t) => !ARTICLES.has(t));
}

function tokens(s: string): string[] {
  const folded = s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "");
  const out: string[] = [];
  for (const word of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (CJK.test(word)) {
      // Split a mixed run: each CJK character alone, other letters as words.
      let latin = "";
      for (const ch of word) {
        if (CJK.test(ch)) {
          if (latin) out.push(latin);
          latin = "";
          out.push(ch);
        } else latin += ch;
      }
      if (latin) out.push(latin);
    } else out.push(word);
  }
  return out;
}

export function hasCjk(s: string): boolean {
  return CJK.test(s);
}

/** Common characters written only in Traditional or only in Simplified
 *  Chinese: enough to tell which one a short name is in (鼎泰豐 → 豐). */
const TRADITIONAL_ONLY = new Set(
  "豐臺灣館麵東車門們來說華國這個為會時從點過還開關長電學鳥龍風飯雞魚滷燒餐廳樓蘭縣區鄉號廣場隊鍋湯餅蝦魷鮮麼記樂興發義賣買萬與葉張陳劉黃楊趙師傅藝術醫藥體雲園圓壽厲勝夢實寶寫將專業書畫無熱燈營環現當樹橋機檔歡歲歷氣漢灣滿濟澤爾牆獨猶產畢盡盤確稱穩競筆節範築篮紅級紙細絲經綠網緣總織罐聯聲腸臉舊莊萊蓮處號蘇衛裝製見規親觀訂計記設許試話認語說請讀貓貝買資賓車軍農這進運過道遠選邊鄧醬鐵鍾鎮門開間閣陽隨難雙離電韓頁頂項順頭題顏願類風飛飲養餘館馬駐體髮鬆麥齊齋龍龜鯛鱔鴨鵝麵",
);
const SIMPLIFIED_ONLY = new Set(
  "丰湾馆东车门们来说华国这个为会时从点过还开关长电学鸟龙风饭鸡鱼卤烧餐厅楼兰县区乡号广场队锅汤饼虾鱿鲜么记乐兴发义卖买万与叶张陈刘黄杨赵师傅艺术医药体园圆寿厉胜梦实宝写将专业书画无热灯营环现当树桥机档欢岁历气汉满济泽尔墙独犹产毕尽盘确称稳竞笔节筑篮红级纸细丝经绿网缘总织罐联声肠脸旧庄莱莲处苏卫装制见规亲观订计设许试话认语请读猫贝资宾军农进运远选边邓酱铁钟镇间阁阳随难双离韩页顶项顺头题颜愿类飞饮养马驻发麦齐斋龟鲷鳝鸭鹅捞",
);

/** The language to ask Google Text Search in for what a person typed, from
 *  its script: Japanese kana, Korean hangul, Chinese Han (Traditional when
 *  it carries a Traditional-only character and no Simplified-only one),
 *  else none (Google's default, English). */
export function searchLanguageFor(text: string): string | undefined {
  if (/[぀-ヿ]/u.test(text)) return "ja";
  if (/[가-힯]/u.test(text)) return "ko";
  if (!hasCjk(text)) return undefined;
  const chars = [...text];
  const trad = chars.some((c) => TRADITIONAL_ONLY.has(c) && !SIMPLIFIED_ONLY.has(c));
  const simp = chars.some((c) => SIMPLIFIED_ONLY.has(c) && !TRADITIONAL_ONLY.has(c));
  return trad && !simp ? "zh-TW" : "zh-CN";
}

/** 0..1: how much of the shorter name the other one carries (a name
 *  contained in the other, spaces removed, is 1). Recorded with a match. */
export function nameScore(query: string, found: string): number {
  const q = nameTokens(query);
  const f = nameTokens(found);
  if (q.length === 0 || f.length === 0) return 0;
  const qs = new Set(q);
  const fs = new Set(f);
  if (squashContains(q, f)) return 1;
  let shared = 0;
  for (const t of fs) if (qs.has(t)) shared++;
  return shared / Math.min(qs.size, fs.size);
}

function squashContains(q: string[], f: string[]): boolean {
  const qj = q.join("");
  const fj = f.join("");
  return Math.min(qj.length, fj.length) >= 4 && (qj.includes(fj) || fj.includes(qj));
}

const isCjkToken = (t: string) => CJK.test(t);

/** Can the two names be compared at all? A name in Han characters and
 *  Google's English name for the same place ("嶺南小館", "R & G Lounge")
 *  share no script, so no word can agree or disagree. */
export function comparable(query: string, found: string): boolean {
  const q = nameTokens(query);
  const f = nameTokens(found);
  const qc = q.some(isCjkToken);
  const ql = q.some((t) => !isCjkToken(t));
  const fc = f.some(isCjkToken);
  const fl = f.some((t) => !isCjkToken(t));
  return (qc && fc) || (ql && fl);
}

/**
 * Strong enough to link without asking: one name's significant words are
 * all in the other ("Joe's Pizza" in "Joe's Pizza Mid-City", "République"
 * in "Republique m"), or one is the other with the spaces removed. Two
 * names that each carry a word the other lacks are different places as
 * often as not ("Sugarfish Little Tokyo", "SUGARFISH Little Italy"). CJK
 * names need half their characters shared instead (and two of them at
 * least), because traditional and simplified forms of one name differ.
 */
export function nameMatches(query: string, found: string): boolean {
  const q = nameTokens(query);
  const f = nameTokens(found);
  if (q.length === 0 || f.length === 0) return false;
  if (squashContains(q, f)) return true;
  const qs = new Set(q);
  const fs = new Set(f);
  if (q.some(isCjkToken) || f.some(isCjkToken)) {
    // Half the characters, and at least two of them unless a name is one
    // character long: two-character names sharing one (蜀味, 滋味成都) are
    // other places as often as not.
    let shared = 0;
    for (const t of fs) if (qs.has(t)) shared++;
    return nameScore(query, found) >= 0.5 && shared >= Math.min(2, qs.size, fs.size);
  }
  return [...qs].every((t) => fs.has(t)) || [...fs].every((t) => qs.has(t));
}
