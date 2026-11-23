import { test } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

// Audit-only: runs against local preview servers (AUDIT_BASE/AUDIT_OUT), never in CI.
test.skip(!!process.env.CI, "audit-only spec: requires local vite preview servers");

const OUT = process.env.AUDIT_OUT ?? "/downloads/p8-after";
const APP = process.env.AUDIT_BASE ?? "http://127.0.0.1:3000";
const P = `/app/orgs/${ORG_ID}/projects/${PROJECT_ID}`;

const PAGES: Array<{ slug: string; path: string; wait: number }> = [
  { slug: "orgs", path: "/app", wait: 1500 },
  { slug: "org-projects", path: `/app/orgs/${ORG_ID}`, wait: 1500 },
  { slug: "proj-overview", path: P, wait: 2500 },
  { slug: "data", path: `${P}/data`, wait: 4000 },
  { slug: "query", path: `${P}/query`, wait: 2500 },
  { slug: "indexes", path: `${P}/indexes`, wait: 2500 },
  { slug: "rules", path: `${P}/rules`, wait: 2500 },
  { slug: "relations", path: `${P}/relations`, wait: 2500 },
  { slug: "keys", path: `${P}/keys`, wait: 2500 },
  { slug: "auth", path: `${P}/auth`, wait: 4000 },
  { slug: "usage", path: `${P}/usage`, wait: 2500 },
  { slug: "billing", path: `/app/orgs/${ORG_ID}/billing`, wait: 4000 },
  { slug: "settings", path: "/app/settings", wait: 1500 },
];

async function seed(page: import("@playwright/test").Page, theme: string, locale: string, collapsed = false) {
  await page.addInitScript(
    ([t, l, c]) => {
      localStorage.setItem("vellum_theme", t as string);
      localStorage.setItem("vellum.locale", l as string);
      if (c) localStorage.setItem("vellum:sidebar-collapsed", "true");
    },
    [theme, locale, collapsed] as const,
  );
}

function comboTest(name: string, theme: string, locale: string, pages: typeof PAGES) {
  test(`dashboard ${name}`, async ({ page }) => {
    test.setTimeout(110000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await seed(page, theme, locale);
    await mockApi(page);
    await seedSession(page, false);
    for (const p of pages) {
      await page.goto(`${APP}${p.path}`);
      await page.waitForTimeout(p.wait);
      await page.screenshot({ path: `${OUT}/dash-${p.slug}-${theme}-${locale}.png` });
    }
  });
}

const FIRST = PAGES.slice(0, 7);
const SECOND = PAGES.slice(7);

comboTest("dark-en a", "dark", "en", FIRST);
comboTest("dark-en b", "dark", "en", SECOND);
comboTest("light-en a", "light", "en", FIRST);
comboTest("light-en b", "light", "en", SECOND);
comboTest("dark-ar a", "dark", "ar", FIRST);
comboTest("dark-ar b", "dark", "ar", SECOND);

test("dashboard collapsed rail", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, "dark", "en", true);
  await mockApi(page);
  await seedSession(page, false);
  await page.goto(`${APP}${P}/data`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/dash-data-dark-en-collapsed.png` });
});

test("dashboard mobile", async ({ page }) => {
  test.setTimeout(110000);
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, "dark", "en");
  await mockApi(page);
  await seedSession(page, false);
  for (const p of [
    { slug: "orgs", path: "/app", wait: 1500 },
    { slug: "data", path: `${P}/data`, wait: 4000 },
    { slug: "rules", path: `${P}/rules`, wait: 2500 },
    { slug: "auth", path: `${P}/auth`, wait: 4000 },
  ]) {
    await page.goto(`${APP}${p.path}`);
    await page.waitForTimeout(p.wait);
    await page.screenshot({ path: `${OUT}/dash-m-${p.slug}-dark-en.png` });
  }
});
