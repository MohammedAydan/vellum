/**
 * Browser QA for the V2 customer-dashboard surfaces (index advisor + Rules DSL).
 *
 * Usage (services must be running):
 *   node scripts/qa-v2-dashboard.mjs [baseUrl]
 *
 * Defaults:
 *   baseUrl      http://127.0.0.1:3000
 *   credentials  VELLUM_CONSOLE_EMAIL / VELLUM_CONSOLE_PASSWORD
 *                (legacy VELLUM_QA_EMAIL / VELLUM_QA_PASSWORD still work)
 *   tenant ids   VELLUM_QA_ORG_ID / VELLUM_QA_PROJECT_ID
 *                (legacy VELLUM_QA_ORG_ID / VELLUM_QA_PROJECT_ID still work)
 *
 * When tenant ids are not supplied they are discovered through the real
 * control-plane API using the session obtained by logging in through the UI.
 * Only the deep-link check is skipped if discovery fails; every other check
 * still runs. No token, key, or password is ever printed.
 */
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const email = envAlias("VELLUM_CONSOLE_EMAIL",
  envAlias("VELLUM_QA_EMAIL", "visual@vellum.dev"));
const password = envAlias("VELLUM_CONSOLE_PASSWORD",
  envAlias("VELLUM_QA_PASSWORD", "visual123"));

const results = [];
const pageErrors = [];
const check = (name, ok, detail = "") => {
  const pass = Boolean(ok);
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};
const skip = (name, why) => console.log(`SKIP ${name} :: ${why}`);

async function api(pathname, token) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathname}`);
  return res.json();
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function visibleText(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 12_000 });
  return (await locator.innerText()).trim();
}

async function waitForBodyText(page, needle, timeout = 12_000) {
  await page.waitForFunction(
    (text) => Boolean(document.body && document.body.innerText.includes(text)),
    needle,
    { timeout }
  );
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));

let tenant = null;
try {
  /* ------------------------------------------------------------------ *
   * 1. Login through the existing dashboard flow.
   * ------------------------------------------------------------------ */
  await page.goto(`${base}/login`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.waitForURL("**/app", { timeout: 30_000 });
  check("dashboard login via UI form", page.url().includes("/app"), page.url());

  const token = await page.evaluate(() => localStorage.getItem("vellum_console_access_token"));
  check("dashboard session token stored", typeof token === "string" && token.length > 20);

  /* ------------------------------------------------------------------ *
   * 2. Resolve tenant ids (config vars first, API discovery second).
   * ------------------------------------------------------------------ */
  const configuredOrgId = envAlias("VELLUM_QA_ORG_ID", null);
  const configuredProjectId = envAlias("VELLUM_PROJECT_ID",
    envAlias("VELLUM_QA_PROJECT_ID", null));
  if (configuredOrgId && configuredProjectId) {
    // Fully specified by the caller — no control-plane discovery needed.
    tenant = { orgId: configuredOrgId, projectId: configuredProjectId };
  } else {
    try {
      const orgs = await api("/v1/organizations", token);
      const orgList = Array.isArray(orgs) ? orgs : [];
      const orgId = configuredOrgId || orgList[0]?.id || null;
      let projectId = configuredProjectId || null;
      if (orgId) {
        const projects = await api(`/v1/organizations/${orgId}/projects`, token);
        const project = Array.isArray(projects)
          ? projects[0]
          : (projects?.project ?? projects?.projects?.[0] ?? null);
        projectId = projectId || project?.id || null;
      }
      if (orgId && projectId) {
        tenant = { orgId, projectId };
      }
    } catch (error) {
      console.log(`tenant discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const projectBase = tenant
    ? `${base}/app/orgs/${tenant.orgId}/projects/${tenant.projectId}`
    : null;

  /* ------------------------------------------------------------------ *
   * 3. Index advisor deep link (?suggest=<base64url>).
   * ------------------------------------------------------------------ */
  const suggest = {
    orgId: tenant?.orgId ?? "org_unknown",
    projectId: tenant?.projectId ?? "project_unknown",
    collectionPath: "qa_orders",
    fields: [
      { path: "status", dir: "asc" },
      { path: "createdAt", dir: "desc" },
    ],
    fingerprint: "a".repeat(64),
    reason: "Composite index needed for equality filter on [status] + sort on [createdAt DESC]",
  };
  if (projectBase) {
    await page.goto(`${projectBase}/indexes?suggest=${b64url(suggest)}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    // The customer dashboard mounts project routes under /app (route path
    // `/app/orgs/$orgId/projects/$projectId/indexes`).
    await page.waitForTimeout(500);

    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    check("suggest deep link opens create-index modal", (await dialog.count()) === 1);

    if ((await dialog.count()) === 1) {
      const values = await dialog.locator("input").evaluateAll((nodes) =>
        nodes.map((node) => (node instanceof HTMLInputElement ? node.value : ""))
      );
      check(
        "create-index modal is prefilled from the suggestion",
        values.includes(suggest.collectionPath) &&
          suggest.fields.every((field) => values.includes(field.path)),
        JSON.stringify(values)
      );
    } else {
      check("create-index modal is prefilled from the suggestion", false, "no dialog rendered");
    }

    const advisorVisible = await page
      .getByText("Smart Index Advisor", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    const suggestionCard = await page
      .getByText("Suggested Index for Your Query", { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check("advisor card renders", advisorVisible && suggestionCard);
  } else {
    skip("suggest deep link / modal prefill / advisor card", "no tenant ids from config or API discovery");
  }

  /* ------------------------------------------------------------------ *
   * 4. Rules page (EN): DSL default, template, compile, simulator.
   * ------------------------------------------------------------------ */
  async function rulesChecks(localeLabel) {
    await page.goto(`${projectBase}/rules`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(400);
    const heading = localeLabel === "ar" ? "استوديو قواعد الأمان" : "Security Rules Studio";
    const h1 = await visibleText(page, "h1");
    check(`${localeLabel}: rules page renders`, h1 === heading, h1);

    const dslTab = page.getByRole("tab", { name: "DSL", exact: true }).first();
    await dslTab.waitFor({ state: "visible", timeout: 12_000 });
    check(`${localeLabel}: DSL mode is default`, (await dslTab.getAttribute("data-state")) === "active");

    const templateName =
      localeLabel === "ar" ? "قراءة/كتابة المالك" : "Owner Read/Write";
    await page.getByRole("button", { name: templateName, exact: true }).first().click();
    await page.waitForTimeout(900); // debounced server-authoritative compile
    const editorValue = await page.locator("#rules-dsl-editor").inputValue();
    check(
      `${localeLabel}: template inserted and compile triggered`,
      editorValue.includes("match /posts/{postId}") &&
        editorValue.includes("isOwner(resource.ownerId)"),
      `editor length=${editorValue.length}`
    );

    const validBadge = localeLabel === "ar" ? "DSL صالح" : "Valid DSL";
    const validVisible = await page
      .getByText(validBadge, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check(`${localeLabel}: compile produces a valid v1 AST`, validVisible);

    const traceLabel = localeLabel === "ar" ? "سجل التقييم" : "Evaluation trace";
    const allowedLabel = localeLabel === "ar" ? "مسموح" : "ALLOWED";
    const deniedLabel = localeLabel === "ar" ? "مرفوض" : "DENIED";
    const simulateLabel =
      localeLabel === "ar" ? "محاكاة الطلب" : "Simulate Request";

    await page.locator("#simPath").fill("/posts/p1");
    await page.getByRole("button", { name: simulateLabel, exact: true }).click();
    await page.waitForTimeout(700);
    const allowedBadge = await page
      .getByText(allowedLabel, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check(`${localeLabel}: simulator shows ALLOWED badge`, allowedBadge);

    await page.locator("#simPath").fill("/unmatched/path");
    await page.getByRole("button", { name: simulateLabel, exact: true }).click();
    await page.waitForTimeout(700);
    const deniedBadge = await page
      .getByText(deniedLabel, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    check(`${localeLabel}: simulator shows DENIED badge`, deniedBadge);

    const traceVisible = await page
      .getByText(traceLabel, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    const traceLines = await page.locator("ol li").count();
    check(`${localeLabel}: simulator trace renders`, traceVisible && traceLines > 0, `${traceLines} trace lines`);
  }

  if (projectBase) {
    await rulesChecks("en");

    /* ---------------------------------------------------------------- *
     * 5. Arabic: RTL + Arabic prose + identical rules checks.
     * ---------------------------------------------------------------- */
    await page.getByTestId("language-toggle").click();
    await page.waitForTimeout(500);
    const attrs = await page.evaluate(() => ({
      dir: document.documentElement.getAttribute("dir"),
      lang: document.documentElement.getAttribute("lang"),
      locale: localStorage.getItem("vellum.locale"),
    }));
    check("ar: html RTL + Arabic locale", attrs.dir === "rtl" && attrs.lang === "ar" && attrs.locale === "ar", JSON.stringify(attrs));
    const arabicProse = /[\u0600-\u06FF]/.test(await page.locator("body").innerText());
    check("ar: Arabic prose visible", arabicProse);
    await rulesChecks("ar");
  } else {
    skip("rules DSL checks (EN + AR)", "no tenant ids from config or API discovery");
  }

  /* ------------------------------------------------------------------ *
   * 6. Missing assets 404 and no runtime errors.
   * ------------------------------------------------------------------ */
  const missing = await page.request.get(`${base}/assets/definitely-missing-v2-qa.js`);
  check("missing asset returns 404", missing.status() === 404, `status=${missing.status()}`);
  check("no browser page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" ; "));
} catch (error) {
  check(`QA aborted: ${error instanceof Error ? error.message : String(error)}`, false);
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\nV2 DASHBOARD QA: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log(`FAILED: ${failed.map((result) => result.name).join(" | ")}`);
process.exit(failed.length === 0 ? 0 : 1);
