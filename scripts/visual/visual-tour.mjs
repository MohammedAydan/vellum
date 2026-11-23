import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/home/ubuntu/projects/document-db/docs/visual-review";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function newPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`JS: ${e.message.slice(0, 140)}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/v1/")) problems.push(`HTTP ${r.status()}: ${new URL(r.url()).pathname}`);
  });
  return { page, problems };
}

async function capture(page, problems, name) {
  await page.waitForTimeout(1600);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  const info = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  results.push({ name, file, overflow: info.scrollW > info.clientW, problems: [...new Set(problems)] });
  problems.length = 0;
}

async function clickNav(page, text, mobile) {
  if (mobile) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const toggle = page.locator('button[aria-label="Toggle navigation menu"]');
    if (await toggle.count()) {
      try {
        await toggle.click({ timeout: 3000 });
      } catch { /* an open drawer may already be covering it */ }
      await page.waitForTimeout(400);
    }
  }
  const el = page.getByText(text, { exact: false }).first();
  if (await el.count()) {
    try {
      await el.click({ timeout: 4000 });
      await page.waitForTimeout(900);
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

async function login(page, url, email, password, buttonName) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(email);
  await page.locator("input").nth(1).fill(password);
  const btn = page.getByRole("button", { name: buttonName });
  if (await btn.count()) await btn.click(); else await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(3500);
}

for (const [width, height, tag, mobile] of [[1440, 900, "dash", false], [390, 844, "dash-m", true]]) {
  const { page, problems } = await newPage(width, height);
  await login(page, "http://127.0.0.1:5173/", "visual@vellum.dev", "visual123", /Sign In/i);
  await capture(page, problems, `${tag}-01-organizations`);
  results.push({ name: `${tag}-open-console`, clicked: await clickNav(page, "Open Console", mobile) });
  for (const [label, name] of [
    ["Database Explorer", `${tag}-03-explorer`],
    ["Query Playground", `${tag}-04-query`],
    ["Security Rules", `${tag}-05-rules`],
    ["Indexes", `${tag}-06-indexes`],
    ["API Keys", `${tag}-07-keys`],
    ["Usage & Quotas", `${tag}-08-usage`],
  ]) {
    await clickNav(page, label, mobile);
    await capture(page, problems, name);
  }
  await page.close();
}

for (const [width, height, tag, mobile] of [[1440, 900, "admin", false], [390, 844, "admin-m", true]]) {
  const { page, problems } = await newPage(width, height);
  await login(page, "http://127.0.0.1:5174/", "visual-admin@vellum.dev", "visual123", /Authenticate/i);
  await capture(page, problems, `${tag}-01-home`);
  for (const [label, name] of [
    ["Tenant Directory", `${tag}-02-tenants`],
    ["Audit Explorer", `${tag}-03-audit`],
    ["Operational Metrics", `${tag}-04-metrics`],
    ["Feature Flags", `${tag}-05-features`],
  ]) {
    await clickNav(page, label, mobile);
    await capture(page, problems, name);
  }
  await page.close();
}

await browser.close();
for (const r of results) console.log(JSON.stringify(r));
