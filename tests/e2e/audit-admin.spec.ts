import { test } from "@playwright/test";
import { mockApi, seedSession } from "./helpers.js";

// Audit-only: runs against local preview servers (AUDIT_BASE/AUDIT_OUT), never in CI.
test.skip(!!process.env.CI, "audit-only spec: requires local vite preview servers");

const OUT = process.env.AUDIT_OUT ?? "/downloads/p8-after";
const APP = process.env.AUDIT_BASE ?? "http://127.0.0.1:3001";

const PAGES: Array<{ slug: string; path: string }> = [
  { slug: "index", path: "/" },
  { slug: "tenants", path: "/admin/tenants" },
  { slug: "audit", path: "/admin/audit" },
  { slug: "metrics", path: "/admin/metrics" },
  { slug: "features", path: "/admin/features" },
  { slug: "security", path: "/admin/security" },
  { slug: "billing", path: "/admin/billing" },
  { slug: "auth", path: "/admin/auth" },
];

test("audit admin matrix", async ({ page }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page);
  await seedSession(page, true);

  // dark EN: every page
  await page.addInitScript(() => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum.locale", "en");
  });
  for (const p of PAGES) {
    await page.goto(`${APP}${p.path}`);
    await page.waitForTimeout(5500);
    await page.screenshot({ path: `${OUT}/admin-${p.slug}-dark-en.png` });
  }

  // light EN + dark AR + mobile on the index
  await page.addInitScript(() => localStorage.setItem("vellum_theme", "light"));
  await page.goto(`${APP}/`);
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `${OUT}/admin-index-light-en.png` });

  await page.addInitScript(() => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum.locale", "ar");
  });
  await page.goto(`${APP}/`);
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `${OUT}/admin-index-dark-ar.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum.locale", "en");
  });
  await page.goto(`${APP}/`);
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `${OUT}/admin-m-index-dark-en.png` });
});
