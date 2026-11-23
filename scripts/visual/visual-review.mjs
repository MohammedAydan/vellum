import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/home/ubuntu/projects/document-db/docs/visual-review";
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];

const TARGETS = [
  { name: "dashboard", url: "http://127.0.0.1:5173/" },
  { name: "admin", url: "http://127.0.0.1:5174/" },
];

const browser = await chromium.launch({ headless: true });
for (const target of TARGETS) {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`); });
    try {
      await page.goto(target.url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1200);
      const path = `${OUT}/${target.name}-${vp.name}.png`;
      await page.screenshot({ path, fullPage: false });
      const title = await page.title();
      const bodyText = (await page.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " | ");
      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
      }));
      console.log(JSON.stringify({ name: `${target.name}-${vp.name}`, title, bodyText, overflow, errors: errors.slice(0, 4), path }));
    } catch (e) {
      console.log(JSON.stringify({ name: `${target.name}-${vp.name}`, failed: String(e).slice(0, 300) }));
    }
    await page.close();
  }
}
await browser.close();
