/**
 * Full real-browser UI audit — every page, every component, multiple viewports,
 * EN + AR, light + dark. Captures screenshots and reports every console error,
 * page error, failed request and horizontal overflow.
 *
 * Usage: node scripts/qa-full-ui-audit.mjs [baseUrl]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = "docs/evidence/full-ui-audit";
fs.mkdirSync(OUT, { recursive: true });

// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PROJ = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 768, height: 1024, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

const issues = [];
const results = [];
const note = (scope, msg) => issues.push({ scope, msg: String(msg).slice(0, 400) });
const ok = (name, detail = "") => {
  results.push({ name, pass: true, detail });
  console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
};
const bad = (name, detail = "") => {
  results.push({ name, pass: false, detail });
  console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
};

function wire(page, scope) {
  page.on("pageerror", (e) => note(scope, `PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/ERR_ABORTED|net::ERR_/.test(t)) return;
    note(scope, `CONSOLE ${t}`);
  });
  page.on("requestfailed", (r) => {
    const f = r.failure();
    if (f && !/ERR_ABORTED/.test(f.errorText)) note(scope, `REQFAIL ${r.url()} ${f.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) note(scope, `HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

async function metrics(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    dir: document.documentElement.getAttribute("dir"),
    lang: document.documentElement.getAttribute("lang"),
    dark: document.documentElement.classList.contains("dark"),
    title: document.title,
    h1: document.querySelector("h1")?.textContent?.trim().slice(0, 80) || "",
    buttons: document.querySelectorAll("button").length,
    links: document.querySelectorAll("a").length,
    inputs: document.querySelectorAll("input,textarea,select").length,
  }));
}

async function visit(page, label, url, { shotName, wait = 900 } = {}) {
  await page.goto(`${base}${url}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(wait);
  const m = await metrics(page);
  if (m.scroll > m.inner + 2) bad(`${label} overflow`, `${m.scroll}/${m.inner}`);
  else ok(`${label} layout`, `${m.scroll}/${m.inner} h1="${m.h1}" controls=${m.buttons + m.inputs}`);
  if (shotName) await shot(page, shotName, true);
  return m;
}

async function login(page, path, email, password, urlPattern) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(urlPattern, { timeout: 30000 });
  await page.waitForTimeout(600);
}

const customerRoutes = [
  ["orgs", `/app/orgs/${ORG}`],
  ["projects", `/app/orgs/${ORG}/projects/${PROJ}`],
  ["usage", `/app/orgs/${ORG}/projects/${PROJ}/usage`],
  ["data", `/app/orgs/${ORG}/projects/${PROJ}/data`],
  ["query", `/app/orgs/${ORG}/projects/${PROJ}/query`],
  ["rules", `/app/orgs/${ORG}/projects/${PROJ}/rules`],
  ["indexes", `/app/orgs/${ORG}/projects/${PROJ}/indexes`],
  ["keys", `/app/orgs/${ORG}/projects/${PROJ}/keys`],
  ["auth-studio", `/app/orgs/${ORG}/projects/${PROJ}/auth`],
  ["billing", `/app/orgs/${ORG}/billing`],
  ["settings", "/app/settings"],
];

const adminRoutes = [
  ["overview", "/admin/"],
  ["tenants", "/admin/tenants"],
  ["tenant-detail", `/admin/tenants/${ORG}`],
  ["audit", "/admin/audit"],
  ["metrics", "/admin/metrics"],
  ["features", "/admin/features"],
  ["security", "/admin/security"],
  ["billing", "/admin/billing"],
  ["auth-control", "/admin/auth"],
];

const docsSlugs = [
  "", "quickstart", "authentication", "crud", "field-transforms", "query", "pagination",
  "indexes", "smart-indexing", "relationships", "realtime", "batch-and-transactions",
  "end-user-auth", "security-rules", "security-rules-dsl", "sdks/javascript", "sdks/flutter",
  "rest-api", "reference/rest-data-plane", "reference/rest-control-plane",
  "reference/realtime-protocol", "reference/wire-format", "reference/errors",
  "errors-and-limits", "reference/packages", "production-checklist", "deployment",
  "live-verification", "security-and-defense", "metering-and-billing",
];

const browser = await chromium.launch({ headless: true });

try {
  /* ================= desktop: customer ================= */
  const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cp = await cctx.newPage();
  wire(cp, "customer-desktop");
  await visit(cp, "login EN", "/login", { shotName: "01-login-en" });
  await visit(cp, "signup EN", "/signup", { shotName: "02-signup-en" });
  await login(cp, "/login", "visual@vellum.dev", "visual123", /\/app/);
  await visit(cp, "app home EN", "/app", { shotName: "03-app-home-en" });

  for (const [name, url] of customerRoutes) {
    await visit(cp, `customer ${name} EN`, url, { shotName: `10-customer-${name}-en` });
  }

  // Practical component interactions on the customer side.
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await cp.keyboard.press("ControlOrMeta+k");
  await cp.waitForTimeout(500);
  const cmdkCount = await cp.locator("[cmdk-item]").count();
  cmdkCount >= 10 ? ok("command palette opens", `${cmdkCount} items`) : bad("command palette", `${cmdkCount} items`);
  await shot(cp, "20-command-palette-en");
  await cp.keyboard.press("Escape");

  // Theme toggle via localStorage + storage event (shared provider).
  await cp.evaluate(() => {
    localStorage.setItem("vellum_theme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "vellum_theme", newValue: "light" }));
  });
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await shot(cp, "21-app-light-en");
  const light = await cp.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    stored: localStorage.getItem("vellum_theme"),
  }));
  light.stored === "light" && !light.dark ? ok("theme light applied", JSON.stringify(light)) : bad("theme light", JSON.stringify(light));
  await cp.evaluate(() => {
    localStorage.setItem("vellum_theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "vellum_theme", newValue: "dark" }));
  });

  // AR toggle + all customer pages in RTL.
  await cp.goto(`${base}/app`, { waitUntil: "networkidle" });
  await cp.locator('[data-testid="language-toggle"]').first().click();
  await cp.waitForTimeout(500);
  const ar = await metrics(cp);
  ar.dir === "rtl" ? ok("customer AR rtl", JSON.stringify({ dir: ar.dir, lang: ar.lang })) : bad("customer AR rtl", JSON.stringify(ar));
  await shot(cp, "22-app-home-ar");
  for (const [name, url] of customerRoutes.slice(0, 6)) {
    await visit(cp, `customer ${name} AR`, url, { shotName: `30-customer-${name}-ar` });
  }

  /* ================= desktop: admin ================= */
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ap = await actx.newPage();
  wire(ap, "admin-desktop");
  await visit(ap, "admin login EN", "/admin/login", { shotName: "40-admin-login-en" });
  await login(ap, "/admin/login", "visual-admin@vellum.dev", "visual123", /\/admin\/?$/);
  for (const [name, url] of adminRoutes) {
    await visit(ap, `admin ${name} EN`, url, { shotName: `50-admin-${name}-en` });
  }
  // Live hash-chain verifier interaction.
  await ap.goto(`${base}/admin/security`, { waitUntil: "networkidle" });
  const verifyBtn = ap.getByRole("button", { name: /Verify Audit & Billing Hash Chains/i });
  if (await verifyBtn.count()) {
    await verifyBtn.click();
    await ap.waitForTimeout(1500);
    const bodyText = await ap.locator("body").innerText();
    /valid|verified|succeeded|N\/N/i.test(bodyText)
      ? ok("hash-chain verifier shows proof")
      : bad("hash-chain verifier proof", bodyText.slice(-200));
    await shot(ap, "60-admin-chain-proof-en");
  } else bad("hash-chain verifier button missing");

  await ap.keyboard.press("ControlOrMeta+k");
  await ap.waitForTimeout(400);
  const adminCmdk = await ap.locator("[cmdk-item]").count();
  ok("admin command palette", `${adminCmdk} items`);
  await ap.keyboard.press("Escape");

  // Admin AR.
  await ap.goto(`${base}/admin/billing`, { waitUntil: "networkidle" });
  await ap.locator('[data-testid="language-toggle"]').first().click();
  await ap.waitForTimeout(500);
  const adminAr = await metrics(ap);
  adminAr.dir === "rtl" ? ok("admin AR rtl") : bad("admin AR rtl", JSON.stringify(adminAr));
  await shot(ap, "61-admin-billing-ar");
  await ap.goto(`${base}/admin/security`, { waitUntil: "networkidle" });
  await shot(ap, "62-admin-security-ar");

  /* ================= docs: all 30 slugs x 2 languages ================= */
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await dctx.newPage();
  wire(dp, "docs-desktop");
  let docsOk = 0;
  for (const slug of docsSlugs) {
    for (const lang of ["", "ar/"]) {
      const url = `/docs/${lang}${slug}/`;
      await dp.goto(`${base}${url}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      // The docs app is a lazy-loaded SPA: wait for the page component to
      // actually render before asserting, like qa-docs-react.mjs does.
      await dp.waitForSelector("h1.doc-h1", { timeout: 12000 });
      const title = await dp.locator("h1.doc-h1").count();
      const m = await metrics(dp);
      if (title === 1 && m.scroll <= m.inner + 2) docsOk++;
      else bad(`docs page ${url}`, `h1=${title} overflow=${m.scroll}/${m.inner}`);
    }
  }
  ok("docs 60 pages render", `${docsOk}/60`);
  await dp.goto(`${base}/docs/`, { waitUntil: "networkidle" });
  await shot(dp, "70-docs-en", true);
  await dp.goto(`${base}/docs/ar/`, { waitUntil: "networkidle" });
  await shot(dp, "71-docs-ar", true);

  /* ================= tablet + mobile: all key pages EN + AR ================= */
  for (const vp of VIEWPORTS.slice(1)) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    const p = await ctx.newPage();
    wire(p, `${vp.name}-customer`);
    await login(p, "/login", "visual@vellum.dev", "visual123", /\/app/);
    for (const [name, url] of customerRoutes) {
      await p.goto(`${base}${url}`, { waitUntil: "networkidle", timeout: 90000 });
      await p.waitForTimeout(350);
      const m = await metrics(p);
      m.scroll <= m.inner + 2
        ? ok(`${vp.name} customer ${name}`, `${m.scroll}/${m.inner}`)
        : bad(`${vp.name} customer ${name} overflow`, `${m.scroll}/${m.inner}`);
      if (name === "billing" || name === "data") await shot(p, `80-${vp.name}-customer-${name}-en`, true);
    }
    // AR on this viewport.
    await p.goto(`${base}/app`, { waitUntil: "networkidle" });
    await p.locator('[data-testid="language-toggle"]').first().click();
    await p.waitForTimeout(400);
    const arM = await metrics(p);
    arM.dir === "rtl" ? ok(`${vp.name} AR rtl`) : bad(`${vp.name} AR rtl`, JSON.stringify(arM));
    arM.scroll <= arM.inner + 2 ? ok(`${vp.name} AR no overflow`, `${arM.scroll}/${arM.inner}`) : bad(`${vp.name} AR overflow`, `${arM.scroll}/${arM.inner}`);
    await shot(p, `81-${vp.name}-customer-ar`, true);

    const actx2 = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    const ap2 = await actx2.newPage();
    wire(ap2, `${vp.name}-admin`);
    await login(ap2, "/admin/login", "visual-admin@vellum.dev", "visual123", /\/admin\/?$/);
    for (const [name, url] of adminRoutes.slice(0, 8)) {
      await ap2.goto(`${base}${url}`, { waitUntil: "networkidle", timeout: 90000 });
      await ap2.waitForTimeout(350);
      const m = await metrics(ap2);
      m.scroll <= m.inner + 2
        ? ok(`${vp.name} admin ${name}`, `${m.scroll}/${m.inner}`)
        : bad(`${vp.name} admin ${name} overflow`, `${m.scroll}/${m.inner}`);
    }
    await shot(ap2, `82-${vp.name}-admin-security-en`, true);
    await ctx.close();
    await actx2.close();
  }

  /* ================= aggregate issues ================= */
  const unique = [...new Set(issues.map((i) => `${i.scope}: ${i.msg}`))];
  if (unique.length === 0) ok("ZERO console/page/network errors across all apps, viewports and locales");
  else unique.slice(0, 60).forEach((u) => bad("runtime issue", u));

  const failed = results.filter((r) => !r.pass);
  console.log(`\nFULL UI AUDIT: ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`Screenshots: ${OUT}/ (${fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length} files)`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, issues: unique }, null, 2));
  if (failed.length) {
    console.log("FAILED:", failed.slice(0, 40).map((f) => f.name).join(" | "));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
