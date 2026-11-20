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
 * still share half their characters). The score is the share of the
 * smaller set found in the other; a name contained in the other, spaces
 * removed, scores 1; two names each of whose first word is in the other
 * score at least 0.75.
 */

const GENERIC = new Set([
  "the", "and", "of", "a", "an", "at", "on", "in", "by", "de", "la", "le", "el", "les", "los", "las", "di", "da",
  "restaurant", "restaurante", "ristorante", "cafe", "bar", "kitchen", "house", "shop", "store", "eatery", "bistro",
  "co", "inc", "llc", "ltd",
  "餐", "厅", "廳", "店", "馆", "館", "家",
]);

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

export function nameTokens(s: string): string[] {
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
  return out.filter((t) => !GENERIC.has(t));
}

export function hasCjk(s: string): boolean {
  return CJK.test(s);
}

/** 0..1: how much of the shorter name the other one carries. */
export function nameScore(query: string, found: string): number {
  const q = nameTokens(query);
  const f = nameTokens(found);
  if (q.length === 0 || f.length === 0) return 0;
  const qs = new Set(q);
  const fs = new Set(f);
  const squash = (a: string[]) => a.join("");
  const qj = squash(q);
  const fj = squash(f);
  if (Math.min(qj.length, fj.length) >= 4 && (qj.includes(fj) || fj.includes(qj))) return 1;
  let shared = 0;
  for (const t of fs) if (qs.has(t)) shared++;
  const overlap = shared / Math.min(qs.size, fs.size);
  // "Sugarfish Little Tokyo" asked, "SUGARFISH by sushi nozawa" found:
  // each name's first word is in the other. ("Joe's Pizza" and "Pizza
  // Hut" share a word, but "joes" is not in "Pizza Hut".)
  const leadsAgree = q[0]!.length >= 3 && f[0]!.length >= 3 && fs.has(q[0]!) && qs.has(f[0]!);
  return Math.max(overlap, leadsAgree ? 0.75 : 0);
}

/** Strong enough to link without asking. CJK names get a lower bar
 *  because traditional and simplified forms of one name differ. */
export function nameMatches(query: string, found: string): boolean {
  const score = nameScore(query, found);
  return score >= (hasCjk(query) || hasCjk(found) ? 0.5 : 0.6);
}
