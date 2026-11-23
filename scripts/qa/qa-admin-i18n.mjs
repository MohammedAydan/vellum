/**
 * QA: Platform Admin console English + Arabic (RTL) i18n.
 *
 * Real-browser assertions with Playwright (headless). Verifies the language
 * toggle, default English, switching to Arabic RTL, translated navigation and
 * page headings across the admin pages, persistence across reloads, switching
 * back to LTR/English, and zero page errors.
 *
 * Screenshots: /tmp/opencode/admin-i18n/
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:3000";
const OUT = "/tmp/opencode/admin-i18n";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`);
}

const ARABIC = /[\u0600-\u06FF]/;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200));
});

async function localeState() {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    stored: localStorage.getItem("vellum.locale"),
  }));
}

async function headingText() {
  return (await page.locator("h1").first().innerText()).trim();
}

try {
  // --- Login page: toggle present, default English ---
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(500);

  const loginToggle = page.locator('[data-testid="language-toggle"]');
  check("language toggle present on login page", (await loginToggle.count()) === 1);
  check("language toggle visible on login page", await loginToggle.isVisible());
  check("toggle shows EN while English is active", (await loginToggle.innerText()).includes("EN"));

  let state = await localeState();
  check("default document language is en", state.lang === "en", state);
  check("default document direction is ltr", state.dir === "ltr", state);
  check(
    "login page renders English heading",
    await page.getByText("Platform Admin Console", { exact: true }).isVisible(),
    { found: await page.getByText("Platform Admin Console", { exact: true }).count() }
  );
  await page.screenshot({ path: `${OUT}/01-login-en.png`, fullPage: true });

  // --- Authenticate as the seeded visual operator ---
  await page.locator("#email").fill("visual-admin@vellum.dev");
  await page.locator("#password").fill("visual123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  await page.waitForTimeout(800);

  const topbarToggle = page.locator('header [data-testid="language-toggle"]');
  check("language toggle present in admin top bar", (await topbarToggle.count()) === 1);
  check("language toggle visible in admin top bar", await topbarToggle.isVisible());

  state = await localeState();
  check("admin console stays English after login", state.lang === "en" && state.dir === "ltr", state);
  check(
    "cluster page renders English heading",
    (await headingText()).includes("Platform Cluster Telemetry"),
    { heading: await headingText() }
  );
  await page.screenshot({ path: `${OUT}/02-cluster-en.png`, fullPage: true });

  // --- Switch to Arabic (RTL) ---
  await topbarToggle.click();
  await page.waitForTimeout(400);

  state = await localeState();
  check("toggle switches document lang to ar", state.lang === "ar", state);
  check("toggle switches document direction to rtl", state.dir === "rtl", state);
  check("locale choice persisted to vellum.locale", state.stored === "ar", state);
  check("toggle shows AR while Arabic is active", (await topbarToggle.innerText()).includes("AR"));

  const navLabels = await page.locator("a").allInnerTexts();
  const expectedNav = [
    "صحة العنقود",
    "دليل المستأجرين",
    "مستكشف التدقيق",
    "مؤشرات التشغيل",
    "ميزات التجربة",
  ];
  for (const label of expectedNav) {
    check(`Arabic sidebar label visible: ${label}`, navLabels.some((t) => t.includes(label)), {
      matched: navLabels.filter((t) => t.includes(label)),
    });
  }

  // --- At least three Arabic page headings, one per required page ---
  const headings = [];

  const clusterHeading = await headingText();
  headings.push(clusterHeading);
  check(
    "Arabic heading on /admin",
    ARABIC.test(clusterHeading) && clusterHeading.includes("قياسات عنقود المنصة"),
    { heading: clusterHeading }
  );
  await page.screenshot({ path: `${OUT}/03-cluster-ar.png`, fullPage: true });

  await page.goto(`${BASE}/admin/tenants`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
  const tenantsHeading = await headingText();
  headings.push(tenantsHeading);
  check(
    "Arabic heading on /admin/tenants",
    ARABIC.test(tenantsHeading) && tenantsHeading.includes("دليل المستأجرين"),
    { heading: tenantsHeading }
  );
  const tenantsTableHeads = await page.locator("thead th").allInnerTexts();
  check(
    "Arabic table headers on /admin/tenants",
    tenantsTableHeads.some((t) => t.includes("المؤسسة")) &&
      tenantsTableHeads.some((t) => t.includes("الحالة")),
    { tenantsTableHeads }
  );
  await page.screenshot({ path: `${OUT}/04-tenants-ar.png`, fullPage: true });

  await page.goto(`${BASE}/admin/features`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
  const featuresHeading = await headingText();
  headings.push(featuresHeading);
  check(
    "Arabic heading on /admin/features",
    ARABIC.test(featuresHeading) && featuresHeading.includes("ميزات تجربة المنصة"),
    { heading: featuresHeading }
  );
  const featuresBody = await page.locator("body").innerText();
  check(
    "Arabic Feature Flags controls rendered",
    featuresBody.includes("تسجيل ميزة") && featuresBody.includes("حفظ التغييرات"),
    { snippet: featuresBody.slice(0, 300).replace(/\n+/g, " | ") }
  );
  await page.screenshot({ path: `${OUT}/05-features-ar.png`, fullPage: true });

  check(
    "at least three distinct Arabic page headings asserted",
    headings.filter((h) => ARABIC.test(h)).length >= 3,
    { headings }
  );

  // --- Extra coverage: audit + metrics Arabic headings ---
  await page.goto(`${BASE}/admin/audit`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(600);
  const auditHeading = await headingText();
  check("Arabic heading on /admin/audit", ARABIC.test(auditHeading) && auditHeading.includes("مستكشف تدقيق المنصة"), {
    heading: auditHeading,
  });
  await page.screenshot({ path: `${OUT}/06-audit-ar.png`, fullPage: true });

  await page.goto(`${BASE}/admin/metrics`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(600);
  const metricsHeading = await headingText();
  check(
    "Arabic heading on /admin/metrics",
    ARABIC.test(metricsHeading) && metricsHeading.includes("أداء النظام واتفاقيات زمن الاستجابة"),
    { heading: metricsHeading }
  );
  await page.screenshot({ path: `${OUT}/07-metrics-ar.png`, fullPage: true });

  // --- Persistence across reload ---
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(500);
  state = await localeState();
  check("Arabic RTL persists after reload", state.lang === "ar" && state.dir === "rtl", state);
  const navAfterReload = await page.locator("a").allInnerTexts();
  check(
    "Arabic navigation persists after reload",
    navAfterReload.some((t) => t.includes("صحة العنقود")),
    { matched: navAfterReload.filter((t) => t.includes("صحة العنقود")) }
  );
  await page.screenshot({ path: `${OUT}/08-metrics-ar-reloaded.png`, fullPage: true });

  // --- Switch back to English / LTR ---
  await page.locator('header [data-testid="language-toggle"]').click();
  await page.waitForTimeout(400);
  state = await localeState();
  check("toggle restores document lang to en", state.lang === "en", state);
  check("toggle restores document direction to ltr", state.dir === "ltr", state);
  check("restored locale persisted to vellum.locale", state.stored === "en", state);

  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(500);
  state = await localeState();
  check("English LTR persists after reload", state.lang === "en" && state.dir === "ltr", state);
  const navRestored = await page.locator("a").allInnerTexts();
  check(
    "English navigation restored",
    navRestored.some((t) => t.includes("Cluster Health")) &&
      navRestored.some((t) => t.includes("Feature Flags")),
    { matched: navRestored.filter((t) => /Cluster Health|Feature Flags/.test(t)) }
  );
  check(
    "English heading restored on /admin/metrics",
    (await headingText()).includes("System Performance & Latency SLAs"),
    { heading: await headingText() }
  );
  await page.screenshot({ path: `${OUT}/09-metrics-en-restored.png`, fullPage: true });

  check("no browser console/page errors", pageErrors.length === 0, { pageErrors });
} catch (e) {
  console.log("FATAL:", String(e));
  console.log("pageErrors:", pageErrors);
  check("QA completed without fatal error", false, { error: String(e) });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log("FAILED:", JSON.stringify(failed, null, 2));
  console.log(`Screenshots: ${OUT}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
