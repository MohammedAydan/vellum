/**
 * Browser QA for the Security Fortress / Billing dashboards (EN + AR).
 *
 * Usage (services must be running):
 *   node scripts/qa-fortress-dashboard.mjs [baseUrl]
 *
 * Defaults:
 *   baseUrl      http://127.0.0.1:3000
 *   customer     visual@vellum.dev  / visual123
 *   admin        visual-admin@vellum.dev / visual123
 *   tenant ids   VELLUM_QA_ORG_ID / VELLUM_QA_PROJECT_ID
 *   credentials  VELLUM_CONSOLE_EMAIL / VELLUM_CONSOLE_PASSWORD and
 *                VELLUM_ADMIN_EMAIL / VELLUM_ADMIN_PASSWORD
 *
 * Modelled on scripts/qa-v2-dashboard.mjs. No token, key or password is
 * printed. Every check is a real browser assertion; no mocked UI state.
 */
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const customerEmail = process.env.VELLUM_CONSOLE_EMAIL || process.env.VELLUM_QA_EMAIL || "visual@vellum.dev";
const customerPassword = process.env.VELLUM_CONSOLE_PASSWORD || process.env.VELLUM_QA_PASSWORD || "visual123";
const adminEmail = process.env.VELLUM_ADMIN_EMAIL || process.env.VELLUM_QA_ADMIN_EMAIL || "visual-admin@vellum.dev";
const adminPassword = process.env.VELLUM_ADMIN_PASSWORD || process.env.VELLUM_QA_ADMIN_PASSWORD || "visual123";

const results = [];
const pageErrors = [];
const check = (name, ok, detail = "") => {
  const pass = Boolean(ok);
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

async function bodyText(page) {
  return (await page.locator("body").innerText()).trim();
}

async function waitForText(page, needle, timeout = 15_000) {
  await page.waitForFunction(
    (text) => Boolean(document.body && document.body.innerText.includes(text)),
    needle,
    { timeout }
  );
}

function hasAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

const browser = await chromium.launch({ headless: true });

try {
  const customerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const customerPage = await customerContext.newPage();
  customerPage.on("pageerror", (error) => pageErrors.push(`customer: ${error.message.slice(0, 200)}`));

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (error) => pageErrors.push(`admin: ${error.message.slice(0, 200)}`));

  /* ---------------------------------------------------------------- *
   * 1. Customer login + tenant resolution.
   * ---------------------------------------------------------------- */
  await customerPage.goto(`${base}/login`, { waitUntil: "networkidle", timeout: 60_000 });
  await customerPage.locator("#email").fill(customerEmail);
  await customerPage.locator("#password").fill(customerPassword);
  await customerPage.getByRole("button", { name: "Sign In", exact: true }).click();
  await customerPage.waitForURL("**/app", { timeout: 30_000 });
  check("customer dashboard login via UI form", customerPage.url().includes("/app"));

  const customerToken = await customerPage.evaluate(() =>
    localStorage.getItem("vellum_console_access_token")
  );
  check("customer session token stored", typeof customerToken === "string" && customerToken.length > 20);

  const configuredOrgId = envAlias("VELLUM_QA_ORG_ID", null);
  let orgId = configuredOrgId;
  if (!orgId && customerToken) {
    try {
      const res = await fetch(`${base}/v1/organizations`, {
        headers: { accept: "application/json", authorization: `Bearer ${customerToken}` },
      });
      if (res.ok) {
        const orgs = await res.json();
        orgId = (Array.isArray(orgs) ? orgs[0]?.id : null) || null;
      }
    } catch {
      // Discovery failure is reported by the billing-page checks below.
    }
  }
  check(
    "tenant overrides accepted / org id resolved",
    typeof orgId === "string" && orgId.length > 0,
    `org=${Boolean(configuredOrgId)}${configuredOrgId ? "" : " (org discovered via API)"}`
  );

  /* ---------------------------------------------------------------- *
   * 2. Customer billing page — EN plan, usage, progress bars.
   * ---------------------------------------------------------------- */
  if (orgId) {
    await customerPage.goto(`${base}/app/orgs/${encodeURIComponent(orgId)}/billing`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await waitForText(customerPage, "Organization Billing");
    const en = await bodyText(customerPage);
    check(
      "customer billing: EN heading + plan/usage/pricing text",
      hasAll(en, [
        "Organization Billing",
        "Current Plan",
        "Real-Time Usage",
        "Document Reads",
        "Projected cost this month",
        "Hard Monthly Spend Cap",
        "Quota decisions",
      ])
    );
    // QuotaBar renders "current / max (p%)"; storage/egress add a "GB" unit.
    const bars =
      en.match(/\d[\d,.]*(?:\s*[A-Za-z]+)? \/ \d[\d,.]*(?:\s*[A-Za-z]+)? \(\d+%\)/g) ?? [];
    check("customer billing: quota progress bars render with percentages", bars.length >= 7, `${bars.length} bars`);
    check(
      "customer billing: live-data badge present",
      en.includes("LIVE DATA"),
      "summary fetched from the fortress API"
    );

    /* 3. Customer billing page — AR toggle. */
    await customerPage.locator('[data-testid="language-toggle"]').first().click();
    await customerPage.waitForTimeout(500);
    const arState = await customerPage.evaluate(() => ({
      dir: document.documentElement.getAttribute("dir"),
      lang: document.documentElement.getAttribute("lang"),
    }));
    const ar = await bodyText(customerPage);
    check(
      "customer billing: AR toggles RTL + Arabic prose",
      arState.dir === "rtl" && arState.lang === "ar" && /[\u0600-\u06FF]/.test(ar),
      JSON.stringify(arState)
    );
    check(
      "customer billing: AR plan/usage labels render",
      hasAll(ar, ["فوترة المؤسسة", "الخطة الحالية", "الاستخدام المباشر", "قراءات المستندات"])
    );
  } else {
    check("customer billing: EN plan/usage/pricing text", false, "no org id available");
    check("customer billing: quota progress bars render with percentages", false, "no org id");
    check("customer billing: live-data badge present", false, "no org id");
    check("customer billing: AR toggles RTL + Arabic prose", false, "no org id");
    check("customer billing: AR plan/usage labels render", false, "no org id");
  }

  /* ---------------------------------------------------------------- *
   * 4. Admin login + security command center (EN).
   * ---------------------------------------------------------------- */
  await adminPage.goto(`${base}/admin/login`, { waitUntil: "networkidle", timeout: 60_000 });
  await adminPage.locator("#email").fill(adminEmail);
  await adminPage.locator("#password").fill(adminPassword);
  await adminPage.locator('button[type="submit"]').click();
  await adminPage.waitForURL(/\/admin\/?$/, { timeout: 30_000 });
  check("admin console login via UI form", /\/admin\/?$/.test(adminPage.url()));

  await adminPage.goto(`${base}/admin/security`, { waitUntil: "networkidle", timeout: 60_000 });
  await waitForText(adminPage, "Security Command Center");
  const securityEn = await bodyText(adminPage);
  check(
    "admin security: threat cards + chain integrity (EN)",
    hasAll(securityEn, [
      "Security Command Center",
      "Critical Threats",
      "High Threats",
      "Active Blocks",
      "Hash Chain Integrity",
    ])
  );
  const verifyButton = adminPage.getByRole("button", {
    name: "Verify Audit & Billing Hash Chains",
    exact: true,
  });
  check("admin security: live Verify Hash Chains button present", (await verifyButton.count()) === 1);
  await verifyButton.click();
  await adminPage
    .waitForFunction(
      () =>
        /Audit log hash chain|Billing ledger hash chain|Both hash chains verified/.test(
          document.body?.innerText ?? ""
        ),
      undefined,
      { timeout: 15_000 }
    )
    .catch(() => undefined);
  const proofText = await bodyText(adminPage);
  check(
    "admin security: clicking verifier shows cryptographic proof for both chains",
    hasAll(proofText, ["Audit log hash chain", "Billing ledger hash chain"]) &&
      /VALID|INVALID/.test(proofText),
    "audit + billing chain proof cards rendered"
  );

  /* ---------------------------------------------------------------- *
   * 5. Admin billing (EN) — MRR KPIs + org table.
   * ---------------------------------------------------------------- */
  await adminPage.goto(`${base}/admin/billing`, { waitUntil: "networkidle", timeout: 60_000 });
  await waitForText(adminPage, "Revenue & Quota Control Center");
  const billingEn = await bodyText(adminPage);
  check(
    "admin billing: MRR/overage KPIs (EN)",
    hasAll(billingEn, [
      "Revenue & Quota Control Center",
      "Monthly Recurring Revenue",
      "Projected Overage",
      "Platform Reads",
      "Platform Egress",
    ])
  );
  check(
    "admin billing: organization table renders (EN)",
    hasAll(billingEn, ["Organization Billing & Quotas", "Organization", "Plan"]) &&
      (await adminPage.locator("tbody tr").count()) > 0,
    `${await adminPage.locator("tbody tr").count()} rows`
  );

  /* ---------------------------------------------------------------- *
   * 6. Admin AR — RTL + translated KPIs + org table.
   * ---------------------------------------------------------------- */
  await adminPage.locator('[data-testid="language-toggle"]').first().click();
  await adminPage.waitForTimeout(500);
  const adminArState = await adminPage.evaluate(() => ({
    dir: document.documentElement.getAttribute("dir"),
    lang: document.documentElement.getAttribute("lang"),
  }));
  const billingAr = await bodyText(adminPage);
  check(
    "admin billing: AR toggles RTL + Arabic prose",
    adminArState.dir === "rtl" && adminArState.lang === "ar" && /[\u0600-\u06FF]/.test(billingAr),
    JSON.stringify(adminArState)
  );
  check(
    "admin billing: AR KPIs + org table render",
    hasAll(billingAr, [
      "مركز الإيرادات والتحكم بالحصص",
      "الإيراد المتكرر الشهري",
      "التجاوز المتوقع",
      "فوترة المؤسسات وحصصها",
      "المؤسسة",
      "الخطة",
    ])
  );

  /* ---------------------------------------------------------------- *
   * 7. No uncaught browser errors anywhere.
   * ---------------------------------------------------------------- */
  check("no browser page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" ; "));
} catch (error) {
  check(`QA aborted: ${error instanceof Error ? error.message : String(error)}`, false);
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nFORTRESS QA: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log(`FAILED: ${failed.map((result) => result.name).join(" | ")}`);
process.exit(failed.length === 0 ? 0 : 1);
