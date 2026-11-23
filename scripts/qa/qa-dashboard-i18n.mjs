// Customer Dashboard i18n QA — real-browser (Playwright Chromium) assertions.
// Run from the repo root: node scripts/qa-dashboard-i18n.mjs
//
// Verifies the EN default, the AR/RTL switch, Arabic page headings across
// multiple routes, locale persistence across reloads, and the switch back to
// EN/LTR. Screenshots are written to /tmp/opencode/dashboard-i18n/.
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/tmp/opencode/dashboard-i18n";
fs.mkdirSync(OUT, { recursive: true });

const BASE = "http://127.0.0.1:3000";
// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PID = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");
const DASH_BASE = `/app/orgs/${ORG}/projects/${PID}`;
const AR = /[\u0600-\u06FF]/;

const results = [];
const errors = [];

function assert(name, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

function wire(page) {
  page.on("pageerror", (e) => errors.push(`JS ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 500/.test(text)) {
      errors.push(`console ${text.slice(0, 160)}`);
    }
  });
  page.on("response", (r) => {
    // QA-created duplicate indexes can make /indexes answer 500; the project's
    // other browser QA scripts apply the same narrow exemption.
    if (r.status() >= 500 && !r.url().includes("/indexes")) {
      errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
    }
  });
}

async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(600);
}

async function h1(page) {
  const locator = page.locator("h1").first();
  await locator.waitFor({ state: "visible", timeout: 12000 });
  return (await locator.innerText()).trim();
}

/** Auth screens put their title in CardTitle, not in the page h1 (which is the hero). */
async function cardTitle(page) {
  const locator = page.locator('[data-slot="card-title"]').first();
  await locator.waitFor({ state: "visible", timeout: 12000 });
  return (await locator.innerText()).trim();
}

async function waitForText(page, text) {
  await page.waitForFunction(
    (needle) => document.body && document.body.innerText.includes(needle),
    text,
    { timeout: 12000 }
  );
}

async function htmlAttrs(page) {
  return page.evaluate(() => ({
    dir: document.documentElement.getAttribute("dir"),
    lang: document.documentElement.getAttribute("lang"),
    locale: (() => {
      try {
        return window.localStorage.getItem("vellum.locale");
      } catch {
        return null;
      }
    })(),
  }));
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

// Authenticate once; the dashboard session is injected into a fresh context.
const auth = await fetch("http://127.0.0.1:8080/v1/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());
if (!auth.token) {
  console.error("AUTH FAILED", JSON.stringify(auth).slice(0, 200));
  process.exit(1);
}

const session = {
  user: { id: "visual", email: "visual@vellum.dev", name: "Visual Reviewer" },
  token: auth.token,
  refreshToken: auth.refreshToken,
  expiresAt: new Date(Date.now() + 604800000).toISOString(),
};

function seedDashboardSession(context) {
  return context.addInitScript((s) => {
    localStorage.setItem("vellum_console_access_token", s.token);
    localStorage.setItem("vellum_console_refresh_token", s.refreshToken ?? "");
    localStorage.setItem("vellum_console_user", JSON.stringify({ user: s.user, expiresAt: s.expiresAt }));
  }, session);
}

const browser = await chromium.launch({ headless: true });

// ---------------------------------------------------------------------------
// 1. Anonymous auth pages: toggle present, EN default, AR switch works there.
// ---------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  wire(page);

  await go(page, "/login");
  const toggle = page.getByTestId("language-toggle");
  assert("login: language toggle visible", (await toggle.count()) === 1 && (await toggle.isVisible()));
  assert("login: default EN heading present", (await cardTitle(page)) === "Sign in to your account", await cardTitle(page));
  assert("login: EN body strings present", (await page.locator("body").innerText()).includes("Enter your email and password"));
  let attrs = await htmlAttrs(page);
  assert("login: defaults to LTR/EN", attrs.dir === "ltr" && attrs.lang === "en" && attrs.locale === "en", JSON.stringify(attrs));
  await shot(page, "01-login-en");

  await toggle.click();
  await page.waitForTimeout(400);
  attrs = await htmlAttrs(page);
  assert("login: toggle switches html to RTL/AR", attrs.dir === "rtl" && attrs.lang === "ar" && attrs.locale === "ar", JSON.stringify(attrs));
  assert("login: Arabic heading visible", (await cardTitle(page)) === "تسجيل الدخول إلى حسابك", await cardTitle(page));
  await shot(page, "02-login-ar");

  // Toggle label must follow the active locale (EN -> AR -> EN).
  assert("login: toggle label follows locale", (await toggle.innerText()).includes("AR"));
  await toggle.click();
  await page.waitForTimeout(300);
  assert("login: toggle back to EN label", (await toggle.innerText()).includes("EN"));

  for (const [path, label] of [
    ["/signup", "signup"],
    ["/mfa", "mfa"],
  ]) {
    await go(page, path);
    const t = page.getByTestId("language-toggle");
    assert(`${label}: language toggle visible`, (await t.count()) === 1 && (await t.isVisible()));
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// 2. Dashboard: EN default strings, AR nav + headings, persistence, switch back.
// ---------------------------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await seedDashboardSession(ctx);
const page = await ctx.newPage();
wire(page);

await go(page, "/app");
const toggle = page.getByTestId("language-toggle");
assert("app: language toggle visible in topbar", (await toggle.count()) === 1 && (await toggle.isVisible()));
let attrs = await htmlAttrs(page);
assert("app: default is LTR/EN", attrs.dir === "ltr" && attrs.lang === "en" && attrs.locale === "en", JSON.stringify(attrs));
assert("app: default EN page heading present", (await h1(page)) === "Select Organization", await h1(page));
let body = await page.locator("body").innerText();
assert(
  "app: default EN nav labels present",
  ["Organizations", "Database Explorer", "API Keys", "Usage & Quotas"].every((s) => body.includes(s)),
  body.slice(0, 160).replace(/\n+/g, " | ")
);
await shot(page, "03-dashboard-en");

// --- Switch to Arabic -------------------------------------------------------
await toggle.click();
await page.waitForTimeout(500);
attrs = await htmlAttrs(page);
assert("app: toggle sets html dir=rtl", attrs.dir === "rtl", JSON.stringify(attrs));
assert("app: toggle sets html lang=ar", attrs.lang === "ar", JSON.stringify(attrs));
assert("app: locale persisted to localStorage", attrs.locale === "ar", JSON.stringify(attrs));
assert("app: Arabic org heading visible", (await h1(page)) === "اختر مؤسسة", await h1(page));
body = await page.locator("body").innerText();
assert(
  "app: Arabic nav labels visible",
  ["المؤسسات", "مستكشف قاعدة البيانات", "مفاتيح API"].every((s) => body.includes(s)),
  body.slice(0, 200).replace(/\n+/g, " | ")
);
await shot(page, "04-dashboard-ar");

// --- Arabic page headings on different routes -------------------------------
const arRoutes = [
  [`/app/orgs/${ORG}`, "مشاريع المؤسسة", "05-ar-projects"],
  [`${DASH_BASE}/data`, "مستكشف قاعدة البيانات", "07-ar-data"],
  [`${DASH_BASE}/query`, "ملعب الاستعلامات", "08-ar-query"],
  [`${DASH_BASE}/rules`, "استوديو قواعد الأمان", "09-ar-rules"],
  [`${DASH_BASE}/indexes`, "الفهارس المركّبة", "10-ar-indexes"],
  [`${DASH_BASE}/keys`, "إدارة مفاتيح API", "11-ar-keys"],
  [`/app/orgs/${ORG}/projects/${PID}/usage`, "الاستخدام والحصص", "12-ar-usage"],
  ["/app/settings", "الإعدادات والأمان", "13-ar-settings"],
];

const arHeadings = [];
for (const [route, expected, screenshot] of arRoutes) {
  await go(page, route);
  const heading = await h1(page);
  const ok = heading === expected && AR.test(heading);
  if (ok) arHeadings.push({ route, heading });
  assert(`ar: heading on ${route.split("/app")[1] || "/app"}`, ok, `expected "${expected}", got "${heading}"`);
  if (["05-ar-projects", "07-ar-data", "09-ar-rules", "11-ar-keys"].includes(screenshot)) {
    await shot(page, screenshot);
  }
}
assert("ar: at least 3 Arabic page headings on different routes", arHeadings.length >= 3, `found ${arHeadings.length}`);

// --- Reload: locale persists ------------------------------------------------
await go(page, `${DASH_BASE}/data`);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
attrs = await htmlAttrs(page);
assert("ar: locale persists after reload", attrs.dir === "rtl" && attrs.lang === "ar" && attrs.locale === "ar", JSON.stringify(attrs));
assert("ar: Arabic heading persists after reload", (await h1(page)) === "مستكشف قاعدة البيانات", await h1(page));
await shot(page, "14-ar-after-reload");

// --- Switch back to English -------------------------------------------------
await toggle.click();
await page.waitForTimeout(500);
attrs = await htmlAttrs(page);
assert("en: switch back sets html dir=ltr", attrs.dir === "ltr", JSON.stringify(attrs));
assert("en: switch back sets html lang=en", attrs.lang === "en", JSON.stringify(attrs));
assert("en: switch back updates localStorage", attrs.locale === "en", JSON.stringify(attrs));
assert("en: English heading restored", (await h1(page)) === "Database Explorer", await h1(page));
body = await page.locator("body").innerText();
assert("en: English nav labels restored", ["Organizations", "Database Explorer", "API Keys"].every((s) => body.includes(s)));
await shot(page, "15-en-after-switch-back");

assert("no browser page errors", errors.length === 0, JSON.stringify([...new Set(errors)].slice(0, 6)));

await ctx.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
console.log(`SCREENSHOTS ${OUT}`);
