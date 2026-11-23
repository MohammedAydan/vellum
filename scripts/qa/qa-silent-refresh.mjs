// Silent-refresh browser QA — real Chromium against local dashboard/admin.
// Verifies pre-flight (expired JWT in storage) and reactive 401 replay keep the UI alive.
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";

const OUT = "/tmp/opencode/silent-refresh-qa";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const errors = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

// Dev default console secret from apps/api/src/config.ts (not a production secret).
const CONSOLE_SECRET = "dev_jwt_secret_change_me_to_32_char_random_string_jkl345";
const ADMIN_SECRET = CONSOLE_SECRET;
function b64(v) {
  return Buffer.from(v).toString("base64url");
}
function expiredToken(secret, realm, typ, iss, aud, uid, role) {
  const header = b64(JSON.stringify({ alg: "HS256", typ }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64(
    JSON.stringify({
      typ: "access",
      realm,
      iss,
      aud,
      sub: uid,
      uid,
      role,
      orgIds: [],
      jti: crypto.randomUUID(),
      exp: now - 60,
    })
  );
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const browser = await chromium.launch({ headless: true });

// ---------------- Dashboard: login, then force expired access token ----------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`dashboard pageerror: ${e.message.slice(0, 160)}`));
  const refreshCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/console/auth/refresh")) refreshCalls.push(r.method());
  });

  await page.goto("http://127.0.0.1:3000/login", { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill("visual@vellum.dev");
  await page.locator("input").nth(1).fill("visual123");
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL("**/app/**", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const stored = await page.evaluate(() => ({
    accessToken: localStorage.getItem("vellum_console_access_token"),
    refreshToken: localStorage.getItem("vellum_console_refresh_token"),
    user: JSON.parse(localStorage.getItem("vellum_console_user") || "{}"),
  }));
  check("dashboard login stored a session with refreshToken", Boolean(stored.refreshToken));
  const uid = stored.user?.user?.id || "visual";

  await page.evaluate(
    ({ token }) => {
      localStorage.setItem("vellum_console_access_token", token);
      const blob = JSON.parse(localStorage.getItem("vellum_console_user") || "{}");
      blob.expiresAt = new Date(Date.now() - 1000).toISOString();
      localStorage.setItem("vellum_console_user", JSON.stringify(blob));
    },
    { token: expiredToken(CONSOLE_SECRET, "customer_console", "vellum+console+jwt", "vellum:control-plane:console", "vellum-customer-console", uid, "customer") }
  );

  await page.goto("http://127.0.0.1:3000/app", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const body = await page.locator("body").innerText();
  check("dashboard expired token triggers silent refresh", refreshCalls.length >= 1, `refresh calls=${refreshCalls.length}`);
  check("dashboard no 'Something went wrong'", !body.includes("Something went wrong"), body.slice(0, 140).replace(/\n/g, " | "));
  check("dashboard no raw session error", !body.includes("Invalid, expired, or revoked session token"));
  const after = await page.evaluate(() => localStorage.getItem("vellum_console_access_token"));
  check("dashboard stored token was rotated", Boolean(after) && after !== stored.accessToken);
  await page.screenshot({ path: `${OUT}/dashboard-silent-refresh.png`, fullPage: true });
  await page.close();
}

// ---------------- Admin: login, then force expired access token ----------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`admin pageerror: ${e.message.slice(0, 160)}`));
  const refreshCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/admin/auth/session/refresh")) refreshCalls.push(r.method());
  });

  await page.goto("http://127.0.0.1:3000/admin/login", { waitUntil: "networkidle" });
  await page.locator("#email").fill("visual-admin@vellum.dev");
  await page.locator("#password").fill("visual123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/admin", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const stored = await page.evaluate(() => ({
    accessToken: localStorage.getItem("vellum_super_admin_access_token"),
    refreshToken: localStorage.getItem("vellum_super_admin_refresh_token"),
    user: JSON.parse(localStorage.getItem("vellum_super_admin_user") || "{}"),
  }));
  check("admin login stored a session with refreshToken", Boolean(stored.refreshToken));
  const uid = stored.user?.user?.id || "visual-admin";

  await page.evaluate(
    ({ token }) => {
      localStorage.setItem("vellum_super_admin_access_token", token);
      const blob = JSON.parse(localStorage.getItem("vellum_super_admin_user") || "{}");
      blob.expiresAt = new Date(Date.now() - 1000).toISOString();
      localStorage.setItem("vellum_super_admin_user", JSON.stringify(blob));
    },
    { token: expiredToken(ADMIN_SECRET, "super_admin", "vellum+superadmin+jwt", "vellum:control-plane:super-admin", "vellum-super-admin", uid, "owner") }
  );

  await page.goto("http://127.0.0.1:3000/admin", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const body = await page.locator("body").innerText();
  check("admin expired token triggers silent refresh", refreshCalls.length >= 1, `refresh calls=${refreshCalls.length}`);
  check("admin no 'Something went wrong'", !body.includes("Something went wrong"), body.slice(0, 140).replace(/\n/g, " | "));
  check("admin no raw session error", !body.includes("Invalid, expired, or revoked session token"));
  const after = await page.evaluate(() => localStorage.getItem("vellum_super_admin_access_token"));
  check("admin stored token was rotated", Boolean(after) && after !== stored.accessToken);
  await page.screenshot({ path: `${OUT}/admin-silent-refresh.png`, fullPage: true });
  await page.close();
}

check("no browser page errors", errors.length === 0, errors.slice(0, 4).join(" ; "));
await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n=== SILENT REFRESH QA: ${passed}/${results.length} passed ===`);
if (passed !== results.length) process.exit(1);
