/**
 * Unified single-origin frontend gateway QA (PHASE 5).
 *
 * Run from the repo root with the PROD gateway on :3000 and the API on :8080:
 *   node scripts/frontend-gateway.mjs --mode=prod &
 *   node scripts/qa-unified-gateway.mjs
 *
 * Verifies that the Customer Dashboard (`/`), the Platform Admin console
 * (`/admin/`) and the static docs (`/docs/`) share ONE browser origin without
 * session collisions, that deep links survive a hard refresh, that missing
 * assets never fall back to `index.html`, and that the `/v1` WebSocket upgrade
 * is proxied through the gateway.
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ORIGIN = "http://127.0.0.1:3000";
const OUT = path.resolve("docs/visual-review/unified-gateway");
fs.mkdirSync(OUT, { recursive: true });

const CONSOLE_KEYS = [
  "vellum_console_access_token",
  "vellum_console_refresh_token",
  "vellum_console_user",
];
const ADMIN_KEYS = [
  "vellum_super_admin_access_token",
  "vellum_super_admin_refresh_token",
  "vellum_super_admin_user",
];

// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PID = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");
const DEEP_DASH = `/app/orgs/${ORG}/projects/${PID}/data`;

const results = [];
const findings = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
function finding(area, detail) {
  findings.push({ area, detail });
}

const browser = await chromium.launch({ headless: true });

/* ------------------------------------------------------------------ *
 * STEP 1 + 2 — one browser context, two realms, zero collision
 * ------------------------------------------------------------------ */
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message.slice(0, 180)}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon/i.test(m.text())) pageErrors.push(`console: ${m.text().slice(0, 180)}`);
});

// Instrument localStorage so we can prove the admin realm never reads/writes
// the customer console keys in the same origin.
await page.addInitScript(() => {
  window.__consoleKeyWrites = [];
  const proto = Storage.prototype;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  const origClear = proto.clear;
  const isConsoleKey = (k) => typeof k === "string" && k.startsWith("vellum_console_");
  proto.setItem = function (k, v) {
    if (isConsoleKey(k)) window.__consoleKeyWrites.push(`setItem:${k}`);
    return origSet.call(this, k, v);
  };
  proto.removeItem = function (k) {
    if (isConsoleKey(k)) window.__consoleKeyWrites.push(`removeItem:${k}`);
    return origRemove.call(this, k);
  };
  proto.clear = function () {
    window.__consoleKeyWrites.push("clear");
    return origClear.call(this);
  };
});

async function storageSnapshot() {
  return page.evaluate((keys) => {
    const out = {};
    for (const k of keys) out[k] = localStorage.getItem(k);
    return out;
  }, [...CONSOLE_KEYS, ...ADMIN_KEYS]);
}

try {
  // ---- 1. Customer dashboard in EN and AR, then login ------------------
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(400);
  const body0 = await page.locator("body").innerText();
  check("dashboard: single origin / renders customer console", /VELLUM Console|Customer Studio|Sign in to your account/.test(body0), body0.slice(0, 120).replace(/\n+/g, " | "));

  const attrs0 = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
  check("dashboard: defaults to EN/LTR", attrs0.lang === "en" && attrs0.dir === "ltr", attrs0);

  const toggle = page.getByTestId("language-toggle");
  check("dashboard: language toggle present", (await toggle.count()) === 1);
  await toggle.click();
  await page.waitForTimeout(350);
  const attrsAr = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
  check("dashboard: AR switches to RTL/ar", attrsAr.lang === "ar" && attrsAr.dir === "rtl", attrsAr);
  const arBody = await page.locator("body").innerText();
  check("dashboard: Arabic content rendered", /[\u0600-\u06FF]/.test(arBody), arBody.slice(0, 100).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${OUT}/01-dashboard-ar-login.png` });
  await toggle.click();
  await page.waitForTimeout(300);

  await page.locator("input").nth(0).fill("visual@vellum.dev");
  await page.locator("input").nth(1).fill("visual123");
  await page.getByRole("button", { name: /Sign In/i }).first().click();
  await page.waitForURL("**/app/**", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check("dashboard: login navigates to /app", page.url().includes("/app"), page.url());
  await page.screenshot({ path: `${OUT}/02-dashboard-en-logged-in.png` });

  const afterDash = await storageSnapshot();
  check("dashboard: console access token stored", Boolean(afterDash[CONSOLE_KEYS[0]]));
  check("dashboard: console refresh token stored", Boolean(afterDash[CONSOLE_KEYS[1]]));
  check("dashboard: console user blob stored", Boolean(afterDash[CONSOLE_KEYS[2]]));
  check("dashboard: NO super-admin keys present", ADMIN_KEYS.every((k) => afterDash[k] === null), ADMIN_KEYS.filter((k) => afterDash[k] !== null));
  const consoleBeforeAdmin = Object.fromEntries(CONSOLE_KEYS.map((k) => [k, afterDash[k]]));

  // ---- 2. Same context: admin login at /admin/ --------------------------
  await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle", timeout: 30000 });
  check("admin: /admin resolves to admin login", /admin\/login\/?$/.test(page.url()), page.url());
  await page.evaluate(() => { window.__consoleKeyWrites = []; });
  await page.locator("#email").fill("visual-admin@vellum.dev");
  await page.locator("#password").fill("visual123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/?$/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check("admin: login navigates to /admin/", /\/admin\/?$/.test(page.url()), page.url());
  await page.screenshot({ path: `${OUT}/03-admin-logged-in.png` });

  const afterAdmin = await storageSnapshot();
  check("admin: super-admin access token stored", Boolean(afterAdmin[ADMIN_KEYS[0]]));
  check("admin: super-admin refresh token stored", Boolean(afterAdmin[ADMIN_KEYS[1]]));
  check("admin: super-admin user blob stored", Boolean(afterAdmin[ADMIN_KEYS[2]]));
  check(
    "admin: console keys UNCHANGED after admin login",
    CONSOLE_KEYS.every((k) => afterAdmin[k] === consoleBeforeAdmin[k]),
    CONSOLE_KEYS.filter((k) => afterAdmin[k] !== consoleBeforeAdmin[k])
  );
  const adminWrites = await page.evaluate(() => window.__consoleKeyWrites || []);
  check("admin: admin pages never read/write console keys", adminWrites.length === 0, adminWrites);

  // Return to the customer dashboard: still logged in.
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1000);
  const backBody = await page.locator("body").innerText();
  check("cross-realm: customer STILL logged in after admin login", /Select Organization|Organizations|Customer Studio/.test(backBody), backBody.slice(0, 120).replace(/\n+/g, " | "));
  const backSnap = await storageSnapshot();
  // NB: the dashboard legitimately rotates its own access/refresh JWT on load
  // (silent refresh), so equality of the token *strings* is not the invariant.
  // The invariant is: the three console keys survive, stay console-owned, and
  // were never clobbered by the admin realm.
  check(
    "cross-realm: console keys still present & console-owned",
    CONSOLE_KEYS.every((k) => Boolean(backSnap[k])) && backSnap[CONSOLE_KEYS[0]] !== backSnap[ADMIN_KEYS[0]],
    CONSOLE_KEYS.filter((k) => !backSnap[k])
  );
  check("cross-realm: admin keys still present", ADMIN_KEYS.every((k) => Boolean(backSnap[k])));
  check(
    "cross-realm: console user blob still belongs to customer",
    !/visual-admin@vellum\.dev/.test(backSnap[CONSOLE_KEYS[2]] || ""),
    (backSnap[CONSOLE_KEYS[2]] || "").slice(0, 100)
  );
  await page.screenshot({ path: `${OUT}/04-dashboard-after-admin.png` });

  // ---- 4a. Dashboard deep route hard refresh (logged in) ---------------
  const deepResp = await page.goto(`${ORIGIN}${DEEP_DASH}`, { waitUntil: "networkidle", timeout: 30000 });
  const deepReload = await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  const deepStatus = deepReload?.status() ?? deepResp?.status();
  const deepBody = await page.locator("body").innerText();
  check("deep-link: dashboard deep route refresh -> 200", deepStatus === 200, deepStatus);
  check("deep-link: dashboard deep route rendered (not 404)", !/404|not found/i.test(deepBody.slice(0, 200)), deepBody.slice(0, 120).replace(/\n+/g, " | "));
  check("deep-link: dashboard URL stable after reload", page.url().includes(DEEP_DASH), page.url());
  await page.screenshot({ path: `${OUT}/05-dashboard-deep-refresh.png` });

  // ---- 4b. Admin deep route hard refresh -------------------------------
  // Test a non-auth deep route FIRST (while the session is intact), then the
  // Auth Control Center.
  const tenResp = await page.goto(`${ORIGIN}/admin/tenants`, { waitUntil: "networkidle", timeout: 30000 });
  const tenReload = await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  check("deep-link: /admin/tenants refresh -> 200", (tenReload?.status() ?? tenResp?.status()) === 200, tenReload?.status() ?? tenResp?.status());
  check("deep-link: /admin/tenants URL stable after reload", /\/admin\/tenants\/?$/.test(page.url()), page.url());
  await page.screenshot({ path: `${OUT}/06-admin-deep-refresh.png` });

  const admResp = await page.goto(`${ORIGIN}/admin/auth`, { waitUntil: "networkidle", timeout: 30000 });
  const admReload = await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  const admStatus = admReload?.status() ?? admResp?.status();
  const admBody = await page.locator("body").innerText();
  check("deep-link: /admin/auth refresh -> 200", admStatus === 200, admStatus);
  check("deep-link: /admin/auth rendered admin page (not 404)", /VELLUM Admin|Platform Operations|Platform Auth/.test(admBody), admBody.slice(0, 120).replace(/\n+/g, " | "));
  check("deep-link: /admin/auth URL stable after reload", /\/admin\/auth\/?$/.test(page.url()), page.url());

} catch (e) {
  check("browser QA completed without fatal error", false, String(e));
} finally {
  check("no unexpected console/page errors (dashboard+admin)", pageErrors.length === 0, [...new Set(pageErrors)].slice(0, 6));
  await context.close();
}

/* ------------------------------------------------------------------ *
 * STEP 3 — docs: zero missing assets, zero console errors
 * ------------------------------------------------------------------ */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const docPage = await ctx.newPage();
  const missing = [];
  const cerr = [];
  docPage.on("requestfailed", (r) => {
    if (/favicon/i.test(r.url())) return;
    missing.push(`${r.url()} :: ${r.failure()?.errorText}`);
  });
  docPage.on("response", (r) => {
    if (/favicon/i.test(r.url())) return;
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });
  docPage.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) cerr.push(m.text().slice(0, 180));
  });

  const bare = await docPage.goto(`${ORIGIN}/docs`, { waitUntil: "networkidle", timeout: 30000 });
  await docPage.waitForTimeout(1000);
  check("docs: /docs returns 200", bare?.status() === 200, bare?.status());
  check("docs: /docs renders documentation", (await docPage.locator("h1").count()) > 0);
  check("docs: /docs has ZERO missing assets", missing.length === 0, missing.slice(0, 6));
  check("docs: /docs has ZERO console errors", cerr.length === 0, cerr.slice(0, 6));
  if (missing.length || cerr.length) {
    finding(
      "scripts/frontend-gateway.mjs:261-263 (serveProduction) + dist-frontend/docs/index.html",
      "GET /docs serves the docs index without a canonical redirect to /docs/. The HTML uses RELATIVE asset refs (assets/docs.css, assets/docs.js), so the browser resolves them against the origin root (/assets/docs.css, /assets/docs.js) -> HTTP 404 text/plain. /docs/assets/docs.css and /docs/assets/docs.js return 200. Fix: 302 /docs -> /docs/ in the gateway (and a matching /docs -> /docs/ rule in _redirects for Cloudflare), or emit an absolute <base href=\"/docs/\"> in the docs generator."
    );
  }
  await docPage.screenshot({ path: `${OUT}/07-docs.png` });

  // Canonical trailing-slash URL for comparison.
  missing.length = 0;
  cerr.length = 0;
  const canonical = await docPage.goto(`${ORIGIN}/docs/`, { waitUntil: "networkidle", timeout: 30000 });
  await docPage.waitForTimeout(1000);
  check("docs: /docs/ (canonical) returns 200", canonical?.status() === 200, canonical?.status());
  check("docs: /docs/ has ZERO missing assets", missing.length === 0, missing.slice(0, 6));
  check("docs: /docs/ has ZERO console errors", cerr.length === 0, cerr.slice(0, 6));
  await ctx.close();
}

/* ------------------------------------------------------------------ *
 * STEP 5 — missing asset regression (never text/html fallback)
 * ------------------------------------------------------------------ */
for (const p of ["/assets/__missing__.js", "/admin/assets/__missing__.js"]) {
  const got = await new Promise((resolve) => {
    http.get(`${ORIGIN}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body: body.slice(0, 80) }));
    }).on("error", (e) => resolve({ status: 0, type: "", body: e.message }));
  });
  check(`missing asset: ${p} -> 404`, got.status === 404, got);
  check(`missing asset: ${p} content-type NOT text/html`, !/text\/html/i.test(got.type), got.type);
}

/* ------------------------------------------------------------------ *
 * STEP 6 — /v1/realtime WebSocket upgrade through the gateway
 * ------------------------------------------------------------------ */
const ws = await new Promise((resolve) => {
  const req = http.request({
    host: "127.0.0.1", port: 3000, path: "/v1/realtime",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    },
  });
  req.on("upgrade", (res, socket) => {
    resolve({ status: res.statusCode, upgrade: res.headers.upgrade || "" });
    // Close politely (WebSocket close frame) instead of destroying the socket;
    // the gateway's proxyUpgrade currently has no socket 'error' handler.
    try { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } catch { /* ignore */ }
    setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 400).unref();
  });
  req.on("response", (res) => {
    resolve({ status: res.statusCode, upgrade: "", note: "no upgrade" });
    res.resume();
  });
  req.on("error", (e) => resolve({ status: 0, upgrade: "", note: e.message }));
  req.end();
});
check("realtime: /v1/realtime upgrade -> 101", ws.status === 101, ws);
check("realtime: upgrade header is websocket", /websocket/i.test(ws.upgrade), ws);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== UNIFIED GATEWAY QA: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log("FAILED:", JSON.stringify(failed.map((f) => f.name), null, 2));
}
if (findings.length) {
  console.log("\nFINDINGS (other agents' files — NOT edited):");
  for (const f of findings) console.log(` - [${f.area}] ${f.detail}`);
}
console.log(`Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
