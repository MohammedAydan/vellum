import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = "/home/ubuntu/projects/document-db/docs/visual-review/docs-site";
mkdirSync(out, { recursive: true });
const base = process.env.DOCS_SITE_URL || "http://127.0.0.1:8898";

const browser = await chromium.launch({ headless: true });
const shots = [
  ["home-dark", "/index.html", "dark", { width: 1440, height: 900 }],
  ["realtime-dark", "/realtime.html", "dark", { width: 1440, height: 1000 }],
  ["tabs-rest", "/quickstart.html", "dark", { width: 1440, height: 900 }, "rest"],
  ["reference-dark", "/reference/rest-control-plane.html", "dark", { width: 1440, height: 900 }],
  ["home-light", "/index.html", "light", { width: 1440, height: 900 }],
  ["home-mobile", "/index.html", "dark", { width: 390, height: 844 }],
  ["ar-home-dark", "/ar/index.html", "dark", { width: 1440, height: 900 }],
  ["ar-quickstart-dark", "/ar/quickstart.html", "dark", { width: 1440, height: 1000 }],
  ["ar-home-mobile", "/ar/index.html", "dark", { width: 390, height: 844 }],
];
for (const [name, path, theme, viewport, tab] of shots) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript((t) => localStorage.setItem("vellum-docs-theme", t), theme);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (tab) await page.locator(`.et-tab[data-example-tab="${tab}"]`).first().click();
  await page.screenshot({ path: `${out}/${name}.png` });
  const info = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    title: document.title,
    codeBlocks: document.querySelectorAll(".code-block").length,
    verified: document.querySelectorAll(".cb-verified").length,
  }));
  console.log(name, JSON.stringify(info), "errors=" + errors.length);
  await page.close();
}
await browser.close();
