import { docsPageSlugs } from './docs-pages.mjs';
/**
 * Browser QA for the React documentation site.
 * Requires the unified gateway on :3000 with a freshly built React docs bundle.
 * Usage: node scripts/qa-docs-react.mjs [baseUrl]
 */
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));

// 1. Home loads as a React app with the expected shell.
await page.goto(`${base}/docs/`, { waitUntil: "networkidle", timeout: 60000 });
check("docs home renders", await page.locator("h1.doc-h1").count() === 1);
check("sidebar groups render", await page.locator(".nav-group").count() >= 7);
check("topbar search renders", await page.locator(".search-trigger").count() === 1);
await page.waitForSelector(".toc-rail .toc-link", { timeout: 15000 }).catch(() => undefined);
check("toc rail renders", await page.locator(".toc-rail .toc-link").count() >= 3);

// 2. Client-side navigation keeps the same document and updates the heading.
await page.getByRole("link", { name: "Quickstart", exact: true }).first().click();
await page.waitForURL("**/docs/quickstart/", { timeout: 15000 });
check("quickstart route navigates", (await page.locator("h1.doc-h1").innerText()).length > 3);
check("breadcrumb updates", (await page.locator(".breadcrumb").innerText()).includes("Quickstart"));

// 3. Code tabs switch real content.
const tabs = page.locator(".code-tab");
await page.waitForSelector(".code-tab", { timeout: 15000 }).catch(() => undefined);
if (await tabs.count() > 1) {
  const first = await page.locator(".code-tabs .code-pre").first().innerText();
  await tabs.nth(1).click();
  const second = await page.locator(".code-tabs .code-pre").first().innerText();
  check("code tabs switch content", first !== second);
} else {
  check("code tabs switch content", false, "no tabs rendered on quickstart");
}

// 4. Search palette opens, filters and navigates.
await page.keyboard.press("Control+k");
await page.waitForSelector(".search-dialog", { timeout: 10000 });
await page.locator(".search-input-row input").fill("pagination");
await page.keyboard.press("Enter");
await page.waitForURL("**/docs/pagination/", { timeout: 15000 });
check("search palette navigates", page.url().includes("/docs/pagination/"));

// 5. Theme toggle changes the persisted theme.
const beforeTheme = await page.evaluate(() => document.documentElement.dataset.theme);
await page.locator('button[aria-label="Toggle theme"]').click();
const afterTheme = await page.evaluate(() => document.documentElement.dataset.theme);
check("theme toggle works", beforeTheme !== afterTheme, `${beforeTheme} → ${afterTheme}`);

// 6. Arabic language toggle flips direction and renders Arabic prose.
await page.getByRole("link", { name: "ع", exact: true }).click();
await page.waitForURL("**/docs/ar/pagination/", { timeout: 15000 });
await page.waitForSelector("h1.doc-h1", { timeout: 15000 });
check("arabic route renders", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
check("arabic prose renders", /[\u0600-\u06ff]/.test(await page.locator("h1.doc-h1").innerText()));

// 7. Missing assets must 404, never fall back to index.html.
const missing = await page.request.get(`${base}/docs/assets/definitely-missing.js`);
check("missing asset returns 404", missing.status() === 404, `status=${missing.status()}`);

// 8. Every page in both languages renders an h1 and no runtime error.
const slugs = docsPageSlugs();
let rendered = 0;
for (const lang of ["", "ar/"]) {
  for (const slug of slugs) {
    const res = await page.goto(`${base}/docs/${lang}${slug}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!res || res.status() !== 200) continue;
    try {
      await page.waitForSelector("h1.doc-h1", { timeout: 8000 });
      const title = (await page.locator("h1.doc-h1").innerText()).trim();
      if (title && !title.includes("…") && !/placeholder|pending/i.test(title)) rendered++;
    } catch { /* counted as not rendered */ }
  }
}
check("all localized pages render", rendered === slugs.length * 2, `${rendered}/${slugs.length * 2}`);
check("no runtime page errors", errors.length === 0, errors.slice(0, 3).join(" ; "));

await browser.close();
console.log(`\nDOCS REACT QA: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
