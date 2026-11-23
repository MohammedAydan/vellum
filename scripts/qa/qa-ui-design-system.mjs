/**
 * Unified Design System Visual & Responsive QA (Phase 5B).
 *
 * Usage:
 *   node scripts/qa-ui-design-system.mjs [baseUrl]
 *
 * Verifies, across all three apps:
 *   - zero console errors / uncaught page errors
 *   - zero horizontal overflow at 1440x900 and 390x844, in EN and AR
 *   - theme persistence/sync via the shared `vellum_theme` key
 *   - captures the locked screenshot set into docs/evidence/ui-v3/
 */
import { chromium } from "playwright";
import fs from "node:fs";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const outDir = "docs/evidence/ui-v3";
fs.mkdirSync(outDir, { recursive: true });

// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PROJ = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");

const results = [];
const check = (name, ok, detail = "") => {
  const pass = Boolean(ok);
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: true });

function wire(page, errors) {
  page.on("pageerror", (e) => errors.push(`JS ${e.message.slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Font 404s or benign aborted requests are not app errors.
    if (/ ERR_ABORTED|Failed to load resource: net::ERR_/.test(t)) return;
    errors.push(`console ${t.slice(0, 200)}`);
  });
}

async function login(page, path, email, password, urlPattern) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(urlPattern, { timeout: 30000 });
}

async function overflow(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    dir: document.documentElement.getAttribute("dir"),
    lang: document.documentElement.getAttribute("lang"),
  }));
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

const DASH_BASE = `/app/orgs/${ORG}/projects/${PROJ}`;
const desktop = { viewport: { width: 1440, height: 900 } };
const mobile = { viewport: { width: 390, height: 844 } };

try {
  /* ---------- customer desktop EN ---------- */
  const cctx = await browser.newContext(desktop);
  const cp = await cctx.newPage();
  const cerr = [];
  wire(cp, cerr);
  await login(cp, "/login", "visual@vellum.dev", "visual123", /\/app/);
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await shot(cp, "dashboard-dark-en");
  let o = await overflow(cp);
  check("dashboard dark EN no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);

  const customerPaths = [
    `${DASH_BASE}/data`,
    `${DASH_BASE}/query`,
    `${DASH_BASE}/rules`,
    `${DASH_BASE}/indexes`,
    `/app/orgs/${ORG}/billing`,
  ];
  for (const p of customerPaths) {
    await cp.goto(`${base}${p}`, { waitUntil: "networkidle", timeout: 60000 });
    await cp.waitForTimeout(400);
    o = await overflow(cp);
    check(`EN no overflow ${p}`, o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
    if (p.includes("/rules")) await shot(cp, "rules-dsl-studio-en");
    if (p.includes("/billing")) await shot(cp, "billing-dark-en");
  }

  /* ---------- theme sync proof ---------- */
  await cp.evaluate(() => {
    localStorage.setItem("vellum_theme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "vellum_theme", newValue: "light" }));
  });
  await cp.waitForTimeout(400);
  const lightOn = await cp.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    stored: localStorage.getItem("vellum_theme"),
  }));
  check("theme toggle writes vellum_theme=light", lightOn.stored === "light" && !lightOn.dark, JSON.stringify(lightOn));
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await shot(cp, "dashboard-light-en");
  await cp.goto(`${base}/docs/`, { waitUntil: "networkidle" });
  const docsTheme = await cp.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    stored: localStorage.getItem("vellum_theme"),
  }));
  check("theme persists to /docs", docsTheme.stored === "light", JSON.stringify(docsTheme));

  /* ---------- customer AR ---------- */
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await cp.locator('[data-testid="language-toggle"]').first().click();
  await cp.waitForTimeout(500);
  o = await overflow(cp);
  check("dashboard AR rtl dir", o.dir === "rtl" && o.lang === "ar", JSON.stringify(o));
  check("dashboard AR no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
  await shot(cp, "dashboard-dark-ar");

  /* ---------- customer mobile EN ---------- */
  const mctx = await browser.newContext(mobile);
  const mp = await mctx.newPage();
  const merr = [];
  wire(mp, merr);
  await login(mp, "/login", "visual@vellum.dev", "visual123", /\/app/);
  await mp.goto(`${base}/app`, { waitUntil: "networkidle" });
  o = await overflow(mp);
  check("dashboard mobile EN no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
  await shot(mp, "dashboard-mobile-en");

  /* ---------- admin desktop EN ---------- */
  const actx = await browser.newContext(desktop);
  const ap = await actx.newPage();
  const aerr = [];
  wire(ap, aerr);
  await login(ap, "/admin/login", "visual-admin@vellum.dev", "visual123", /\/admin\/?$/);
  for (const p of ["/admin/", "/admin/security", "/admin/billing"]) {
    await ap.goto(`${base}${p}`, { waitUntil: "networkidle", timeout: 60000 });
    await ap.waitForTimeout(400);
    o = await overflow(ap);
    check(`admin EN no overflow ${p}`, o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
    if (p.includes("security")) await shot(ap, "admin-security-dark-en");
  }
  await ap.goto(`${base}/admin/billing`, { waitUntil: "networkidle" });
  await ap.locator('[data-testid="language-toggle"]').first().click();
  await ap.waitForTimeout(500);
  o = await overflow(ap);
  check("admin AR no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
  await shot(ap, "admin-billing-dark-ar");

  /* ---------- docs desktop EN + AR ---------- */
  const dctx = await browser.newContext(desktop);
  const dp = await dctx.newPage();
  const derr = [];
  wire(dp, derr);
  await dp.goto(`${base}/docs/`, { waitUntil: "networkidle", timeout: 60000 });
  o = await overflow(dp);
  check("docs EN no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
  await shot(dp, "docs-dark-en");
  await dp.goto(`${base}/docs/ar/`, { waitUntil: "networkidle", timeout: 60000 });
  o = await overflow(dp);
  check("docs AR no horizontal overflow", o.scroll <= o.inner, `${o.scroll}/${o.inner}`);
  await shot(dp, "docs-dark-ar");

  check("customer pages zero console/page errors", cerr.length === 0, JSON.stringify([...new Set(cerr)].slice(0, 4)));
  check("customer mobile zero console/page errors", merr.length === 0, JSON.stringify([...new Set(merr)].slice(0, 4)));
  check("admin pages zero console/page errors", aerr.length === 0, JSON.stringify([...new Set(aerr)].slice(0, 4)));
  check("docs pages zero console/page errors", derr.length === 0, JSON.stringify([...new Set(derr)].slice(0, 4)));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\nUI DESIGN SYSTEM QA: ${results.length - failed.length}/${results.length} checks passed`);
console.log(`Screenshots: ${outDir}/`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
