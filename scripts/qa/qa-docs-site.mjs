/**
 * Real-browser QA for the bilingual static docs site: static safety, 3-tab
 * examples, syntax highlighting, RTL, navigation and search.
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname, join } from "node:path";
import { chromium } from "playwright";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const site = resolve(root, "docs/site");
const manifest = JSON.parse(readFileSync(resolve(root, "examples/ts/manifest.json"), "utf8"));
const entries = Array.isArray(manifest) ? manifest : manifest.examples;
const ids = new Set(entries.map((e) => e.id));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) failed++;
};

function walk(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, `${prefix}${e}/`));
    else out.push(`${prefix}${e}`);
  }
  return out;
}
const htmlFiles = existsSync(site) ? walk(site).filter((f) => f.endsWith(".html")) : [];
check("docs site generated", htmlFiles.length >= 40, `${htmlFiles.length} pages`);
check("english pages", htmlFiles.filter((f) => !f.startsWith("ar/")).length >= 20);
check("arabic pages", htmlFiles.filter((f) => f.startsWith("ar/")).length >= 20);

for (const f of htmlFiles) {
  const html = readFileSync(resolve(site, f), "utf8");
  const article = html.match(/<article class="article">([\s\S]*?)<\/article>/)?.[1] || "";
  const prose = article.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  check(`inert article ${f}`, !/<script\b|<\w[^>]*\son[a-z]+\s*=/i.test(prose) && !/\{\{/.test(article));
  if (f.startsWith("ar/")) check(`rtl document ${f}`, /dir="rtl"/.test(html) && /lang="ar"/.test(html));
}

const guideFiles = [];
for (const sub of ["", "ar/", "reference/", "sdks/", "ar/reference/", "ar/sdks/"]) {
  const dir = resolve(root, "docs/guides", sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) guideFiles.push(`docs/guides/${sub}${f}`);
}
const usedIds = new Set();
for (const f of guideFiles) {
  const text = readFileSync(resolve(root, f), "utf8");
  for (const match of text.matchAll(/^:::example-tabs?\s+(\S+)\s*$/gm)) {
    usedIds.add(match[1]);
    check(`example id '${match[1]}' declared`, ids.has(match[1]), f);
    check(`TS output ${match[1]}`, existsSync(resolve(root, `docs/generated/examples/${match[1]}.txt`)));
    check(`REST output ${match[1]}`, existsSync(resolve(root, `docs/generated/examples/${match[1]}.rest.txt`)));
  }
}
check("guides present", guideFiles.length >= 44, `${guideFiles.length} markdown files`);
check("all 13 examples referenced", ids.size === 13 && [...ids].every((id) => usedIds.has(id)), `${usedIds.size} unique ids`);

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const raw = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = raw === "/" ? "index.html" : raw.replace(/^\//, "");
  const path = resolve(site, rel);
  if (!path.startsWith(site) || !existsSync(path)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const goto = async (path) => page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "networkidle" });

await goto("/index.html");
check("EN nav renders", (await page.locator(".nav-link").count()) >= 20, `${await page.locator(".nav-link").count()}`);
check("EN locale link present", (await page.locator(".lang-link").count()) === 1);

await goto("/quickstart.html");
check("3 tabs on example", (await page.locator("[data-example-tabs] .et-tab").count()) >= 3);
const labels = await page.locator("[data-example-tabs] .et-tab").allTextContents();
check("tab labels", labels.some((l) => l.includes("Flutter")) && labels.some((l) => l.includes("JS")) && labels.some((l) => l.includes("REST")), labels.join("|"));
check("syntax highlighting", (await page.locator(".hl-keyword").count()) > 0 && (await page.locator(".hl-string").count()) > 0, `${await page.locator(".hl-keyword").count()} keywords`);
const tsVisible = await page.locator('[data-example-panel="ts"]').first().isVisible();
check("JS/TS panel active by default", tsVisible);
await page.locator('.et-tab[data-example-tab="rest"]').first().click();
check("REST tab switches panel", await page.locator('[data-example-panel="rest"]').first().isVisible());
await page.locator('.et-tab[data-example-tab="dart"]').first().click();
check("Flutter tab shows reference note", (await page.locator('[data-example-panel="dart"] .et-note').first().innerText()).length > 10);

// All links from root + nested pages, both locales.
let broken = [];
for (const p of ["/index.html", "/reference/rest-control-plane.html", "/ar/index.html", "/ar/reference/rest-control-plane.html"]) {
  if (!htmlFiles.includes(p.slice(1))) continue;
  await goto(p);
  const hrefs = await page.locator(".nav-link").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const articleLinks = await page.locator(".article a").evaluateAll((as) =>
    as.map((a) => a.getAttribute("href")).filter((h) => h && !/^(https?:|mailto:|#)/.test(h))
  );
  for (const href of [...hrefs, ...articleLinks]) {
    const url = new URL(href, `http://127.0.0.1:${port}${p}`);
    const res = await fetch(url);
    if (res.status !== 200) broken.push(`${p} -> ${href}`);
  }
}
check("all nav links resolve", broken.length === 0, broken.slice(0, 3).join(", "));

await goto("/ar/index.html");
check("AR rtl nav", (await page.locator(".nav-link").count()) >= 20);
check("AR page direction", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
check("AR locale link to EN", (await page.locator(".lang-link").getAttribute("href"))?.includes("index.html"));
await goto("/ar/quickstart.html");
check("AR 3 tabs", (await page.locator("[data-example-tabs] .et-tab").count()) >= 3);

// Search in both locales.
for (const [p, q] of [["/index.html", "transaction"], ["/ar/index.html", "المعاملات"]]) {
  await goto(p);
  await page.keyboard.press("Control+k");
  await page.locator("#searchInput").fill(q);
  await page.waitForTimeout(250);
  check(`static search ${p}`, (await page.locator(".search-item").count()) > 0, `${await page.locator(".search-item").count()} hits`);
  await page.keyboard.press("Escape");
}

await goto("/index.html");
await page.locator("#themeToggle").click();
check("theme toggle", ["light", "dark"].includes(await page.evaluate(() => document.documentElement.dataset.theme)));
await goto("/quickstart.html");
const codeText = await page.locator(".code-block pre code").first().textContent();
check("code is inert text", typeof codeText === "string" && codeText.length > 20);
check("no browser errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();
console.log(`\n=== DOCS QA: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} ===`);
process.exit(failed === 0 ? 0 : 1);
