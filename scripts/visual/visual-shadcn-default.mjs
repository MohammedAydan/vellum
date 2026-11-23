import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const out = "/home/ubuntu/projects/document-db/docs/visual-review/shadcn-default";
const { mkdirSync } = await import("node:fs");
mkdirSync(out, { recursive: true });

async function capture(name, url, email, password, submit, viewport, theme = "dark") {
  const page = await browser.newPage({ viewport });
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(email);
  await page.locator("input").nth(1).fill(password);
  const btn = page.getByRole("button", { name: submit });
  if (await btn.count()) await btn.click();
  else await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(3200);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  const probe = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const btn = document.querySelector("button");
    return {
      theme: document.documentElement.className,
      bodyBg: s.backgroundColor,
      bodyColor: s.color,
      bodyFont: s.fontFamily.split(",")[0],
      sampleBtn: btn ? getComputedStyle(btn).backgroundColor : null,
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
    };
  });
  console.log(name, JSON.stringify(probe), "errors=" + errors.length);
  await page.close();
}

await capture("dashboard-dark-desktop", "http://127.0.0.1:5173/", "visual@vellum.dev", "visual123", /Sign In/i, { width: 1440, height: 900 });
await capture("dashboard-dark-mobile", "http://127.0.0.1:5173/", "visual@vellum.dev", "visual123", /Sign In/i, { width: 390, height: 844 });
await capture("admin-dark-desktop", "http://127.0.0.1:5174/", "visual-admin@vellum.dev", "visual123", /Authenticate/i, { width: 1440, height: 900 });
await capture("admin-dark-mobile", "http://127.0.0.1:5174/", "visual-admin@vellum.dev", "visual123", /Authenticate/i, { width: 390, height: 844 });
await capture("dashboard-light-desktop", "http://127.0.0.1:5173/", "visual@vellum.dev", "visual123", /Sign In/i, { width: 1440, height: 900 }, "light");
await capture("admin-light-desktop", "http://127.0.0.1:5174/", "visual-admin@vellum.dev", "visual123", /Authenticate/i, { width: 1440, height: 900 }, "light");
await browser.close();
