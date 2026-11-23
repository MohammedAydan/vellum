import { test } from "@playwright/test";

// Audit-only: runs against local preview servers (AUDIT_BASE/AUDIT_OUT), never in CI.
test.skip(!!process.env.CI, "audit-only spec: requires local vite preview servers");

const OUT = process.env.AUDIT_OUT ?? "/downloads/p8-after";
const APP = process.env.AUDIT_BASE ?? "http://127.0.0.1:3002";

const PAGES: Array<{ slug: string; path: string }> = [
  { slug: "index", path: "/docs/index" },
  { slug: "quickstart", path: "/docs/quickstart" },
  { slug: "authentication", path: "/docs/authentication" },
  { slug: "query", path: "/docs/query" },
  { slug: "security-rules", path: "/docs/security-rules" },
];

test("audit docs matrix", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const combo of [
    { theme: "dark", prefix: "", tag: "en" },
    { theme: "light", prefix: "", tag: "en" },
    { theme: "dark", prefix: "/ar", tag: "ar" },
  ]) {
    await page.addInitScript((t) => localStorage.setItem("vellum_theme", t), combo.theme);
    for (const p of PAGES) {
      const path = combo.prefix ? p.path.replace("/docs/", "/docs/ar/") : p.path;
      await page.goto(`${APP}${path}`);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${OUT}/docs-${p.slug}-${combo.theme}-${combo.tag}.png` });
    }
  }

  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("vellum_theme", "dark"));
  await page.goto(`${APP}/docs/index`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/docs-m-index-dark-en.png` });
});
