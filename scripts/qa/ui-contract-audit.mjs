#!/usr/bin/env node
/**
 * UI contract audit — the automated gate described in
 * /home/ubuntu/.opencode/plan/ui-improvement-plan.md (section 7).
 *
 * It drives the real frontends through Chromium, checks the contract
 * invariants (content direction, horizontal overflow, axe, clipped actions)
 * and writes screenshots + report.json.
 *
 * Usage:
 *   node scripts/ui-contract-audit.mjs \
 *     --base=http://127.0.0.1:3000 \
 *     --wave=1 \
 *     --checks=dir,overflow,axe \
 *     --axe-baseline=/tmp/opencode/ui-gate/axe-baseline.json \
 *     --out=/tmp/opencode/ui-gate/wave-1
 *
 * Exit codes: 0 = pass, 1 = violations, 2 = infrastructure/config failure.
 *
 * Read-only: this script never submits mutations, never deletes data and
 * never touches repository files other than writing to --out.
 */
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_CHECKS = new Set(["dir", "overflow", "axe", "clip"]);
const LOCALES = ["en", "ar"];
const THEMES = ["dark", "light"];
const WIDTHS = [1440, 390];

const ORG = process.env.UI_ORG_ID || "d29c31e0-e93f-402c-8499-74909e9bfb0a";
const PROJ = process.env.UI_PROJECT_ID || "1382468e-5dc0-44a8-9b68-5427a5b6ea5c";
const CUSTOMER_EMAIL = process.env.UI_CUSTOMER_EMAIL || "visual@vellum.dev";
const CUSTOMER_PASSWORD = process.env.UI_CUSTOMER_PASSWORD || "visual123";
const ADMIN_EMAIL = process.env.UI_ADMIN_EMAIL || "visual-admin@vellum.dev";
const ADMIN_PASSWORD = process.env.UI_ADMIN_PASSWORD || "visual123";

const ROUTES = [
  { name: "login", path: "/login", role: "public" },
  { name: "signup", path: "/signup", role: "public" },
  { name: "admin-login", path: "/admin/login", role: "public" },
  { name: "docs-home", path: "/docs/", role: "public" },

  { name: "app-home", path: "/app", role: "customer" },
  { name: "org-projects", path: `/app/orgs/${ORG}`, role: "customer" },
  { name: "data", path: `/app/orgs/${ORG}/projects/${PROJ}/data`, role: "customer" },
  { name: "query", path: `/app/orgs/${ORG}/projects/${PROJ}/query`, role: "customer" },
  { name: "rules", path: `/app/orgs/${ORG}/projects/${PROJ}/rules`, role: "customer" },
  { name: "indexes", path: `/app/orgs/${ORG}/projects/${PROJ}/indexes`, role: "customer" },
  { name: "keys", path: `/app/orgs/${ORG}/projects/${PROJ}/keys`, role: "customer" },
  { name: "auth-studio", path: `/app/orgs/${ORG}/projects/${PROJ}/auth`, role: "customer" },
  { name: "usage", path: `/app/orgs/${ORG}/projects/${PROJ}/usage`, role: "customer" },
  { name: "billing", path: `/app/orgs/${ORG}/billing`, role: "customer" },
  { name: "settings", path: "/app/settings", role: "customer" },

  { name: "admin-overview", path: "/admin/", role: "admin" },
  { name: "admin-tenants", path: "/admin/tenants", role: "admin" },
  { name: "admin-tenant-detail", path: `/admin/tenants/${ORG}`, role: "admin" },
  { name: "admin-audit", path: "/admin/audit", role: "admin" },
  { name: "admin-metrics", path: "/admin/metrics", role: "admin" },
  { name: "admin-features", path: "/admin/features", role: "admin" },
  { name: "admin-security", path: "/admin/security", role: "admin" },
  { name: "admin-billing", path: "/admin/billing", role: "admin" },
  { name: "admin-auth", path: "/admin/auth", role: "admin" },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/ui-contract-audit.mjs [options]",
      "",
      "  --base=<url>            Frontend origin (default http://127.0.0.1:3000)",
      "  --wave=<id>             Wave label used in the report (default 1)",
      "  --checks=<list>         Comma list: dir,overflow,axe,clip",
      "                          (default dir,overflow,axe)",
      "  --axe-baseline=<file>   JSON baseline of axe keys; only NEW keys fail",
      "  --out=<dir>             Output directory (default /tmp/opencode/ui-gate/wave-<wave>)",
      "  --help                  Show this help",
      "",
      "Env overrides: UI_ORG_ID, UI_PROJECT_ID, UI_CUSTOMER_EMAIL, UI_CUSTOMER_PASSWORD,",
      "               UI_ADMIN_EMAIL, UI_ADMIN_PASSWORD, UI_BASE_URL",
    ].join("\n")
  );
}

function failInfra(message) {
  const error = new Error(message);
  error.infrastructure = true;
  return error;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

function settleMs(name) {
  if (["data", "indexes", "usage", "billing", "admin-security", "admin-tenant-detail"].includes(name)) {
    return 2200;
  }
  if (name.startsWith("admin-")) return 1500;
  return 1200;
}

function axeKey(violation, node) {
  const target = Array.isArray(node?.target) ? node.target.join(" > ") : "";
  return `${violation.id}::${target}`;
}

function loadAxeBaseline(file) {
  if (!fs.existsSync(file)) throw failInfra(`axe baseline not found: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw failInfra(`axe baseline is not valid JSON: ${file}`);
  }
  if (Array.isArray(parsed)) {
    return new Set(parsed.map(String));
  }
  if (Array.isArray(parsed.keys)) {
    return new Set(parsed.keys.map(String));
  }
  if (Array.isArray(parsed.violations)) {
    const keys = [];
    for (const violation of parsed.violations) {
      for (const node of violation.nodes ?? []) keys.push(axeKey(violation, node));
    }
    return new Set(keys);
  }
  throw failInfra(`axe baseline shape not recognised: ${file}`);
}

async function loginState(browser, base, role) {
  const isAdmin = role === "admin";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${base}${isAdmin ? "/admin/login" : "/login"}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.locator("#email").fill(isAdmin ? ADMIN_EMAIL : CUSTOMER_EMAIL);
    await page.locator("#password").fill(isAdmin ? ADMIN_PASSWORD : CUSTOMER_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(isAdmin ? /\/admin\/?$/ : /\/app\/?$/, { timeout: 30000 });
    await page.waitForTimeout(600);
    return await context.storageState();
  } catch (error) {
    throw failInfra(
      `${role} login failed at ${base}${isAdmin ? "/admin/login" : "/login"}: ${error.message}`
    );
  } finally {
    await context.close();
  }
}

async function makeContext(browser, { locale, theme, storageState }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: locale === "ar" ? "ar-EG" : "en-US",
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(
    ({ nextLocale, nextTheme }) => {
      try {
        window.localStorage.setItem("vellum.locale", nextLocale);
        window.localStorage.setItem("vellum_theme", nextTheme);
      } catch {
        // about:blank and storage-blocked origins can throw; ignore.
      }
    },
    { nextLocale: locale, nextTheme: theme }
  );
  return context;
}

async function runCase(page, { base, route, locale, theme, width, checks, baseline }) {
  const scope = {
    route: route.path,
    routeName: route.name,
    role: route.role,
    locale,
    theme,
    width,
  };
  const failures = [];

  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${base}${route.path}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(settleMs(route.name));

  if (checks.has("dir")) {
    const state = await page.evaluate(() => {
      const main = document.querySelector("main");
      const inner = main ? main.firstElementChild : null;
      const root = getComputedStyle(document.documentElement).direction;
      return {
        hasShell: Boolean(main && inner),
        root,
        htmlDir: document.documentElement.getAttribute("dir"),
        inner: inner ? getComputedStyle(inner).direction : null,
      };
    });
    if (state.hasShell && state.inner !== state.root) {
      failures.push({
        ...scope,
        check: "dir",
        detail: `root=${state.root} htmlDir=${state.htmlDir ?? "null"} inner=${state.inner}`,
      });
    }
  }

  if (checks.has("overflow")) {
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    if (size.scroll > size.inner + 1) {
      failures.push({
        ...scope,
        check: "overflow",
        detail: `scrollWidth=${size.scroll} viewport=${size.inner}`,
      });
    }
  }

  if (checks.has("axe")) {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    if (baseline) {
      const keys = new Set();
      for (const violation of results.violations) {
        for (const node of violation.nodes ?? []) keys.add(axeKey(violation, node));
      }
      for (const key of keys) {
        if (!baseline.has(key)) {
          failures.push({ ...scope, check: "axe", detail: key });
        }
      }
    } else {
      for (const violation of results.violations) {
        if (violation.impact !== "serious" && violation.impact !== "critical") continue;
        failures.push({
          ...scope,
          check: "axe",
          detail: `${violation.id} (${violation.impact}) nodes=${violation.nodes.length}`,
        });
      }
    }
  }

  if (checks.has("clip")) {
    const result = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return { hasShell: false, clipped: [] };
      const clipped = [];
      const seen = new Set();
      for (const button of Array.from(main.querySelectorAll("button"))) {
        // Navigation tabs are intentionally horizontally scrollable; they are
        // not action buttons, so horizontal overflow there is not "clipping".
        if (button.closest('[role="tablist"], nav')) continue;
        const rect = button.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const style = getComputedStyle(button);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          continue;
        }
        // Disabled buttons use `disabled:pointer-events-none`, so elementFromPoint
        // legitimately returns their parent instead of the button. They are not
        // actionable controls and must not count as clipped actions.
        if (button.disabled) continue;
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

        const label = (button.getAttribute("aria-label") || button.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        const key = `${label}|${Math.round(rect.left)}|${Math.round(rect.right)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (rect.left < -1 || rect.right > window.innerWidth + 1) {
          clipped.push({
            reason: "outside-viewport",
            label,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          });
          continue;
        }

        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit) {
          clipped.push({ reason: "no-hit", label, left: Math.round(rect.left), right: Math.round(rect.right) });
          continue;
        }
        if (hit === button || button.contains(hit)) continue;
        clipped.push({
          reason: "covered",
          label: label || hit.tagName,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          hit: `${hit.tagName.toLowerCase()}.${String(hit.className || "").slice(0, 40)}`,
        });
      }
      return { hasShell: true, clipped };
    });

    if (result.hasShell) {
      for (const item of result.clipped) {
        failures.push({
          ...scope,
          check: "clip",
          detail: `${item.reason} "${item.label}" [${item.left},${item.right}]${
            item.hit ? ` hit=${item.hit}` : ""
          }`,
        });
      }
    }
  }

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    usage();
    return null;
  }

  const base = (args.base || process.env.UI_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const wave = args.wave || "1";
  const checks = new Set(
    String(args.checks || "dir,overflow,axe")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  for (const check of checks) {
    if (!ALLOWED_CHECKS.has(check)) {
      throw failInfra(`unknown check "${check}" (allowed: ${[...ALLOWED_CHECKS].join(", ")})`);
    }
  }

  const outDir = args.out || `/tmp/opencode/ui-gate/wave-${wave}`;
  fs.mkdirSync(outDir, { recursive: true });

  const baseline = args["axe-baseline"] ? loadAxeBaseline(args["axe-baseline"]) : null;
  const startedAt = new Date();
  const failures = [];
  const screenshots = [];
  let cases = 0;
  let browser;

  try {
    const probe = await fetch(`${base}/login`).catch(() => null);
    if (!probe || !probe.ok) {
      throw failInfra(`frontend is not reachable at ${base}/login (status ${probe ? probe.status : "no response"})`);
    }

    browser = await chromium.launch({ headless: true });
    const states = {
      customer: await loginState(browser, base, "customer"),
      admin: await loginState(browser, base, "admin"),
    };

    const total = ROUTES.length * LOCALES.length * THEMES.length * WIDTHS.length;
    console.log(`[ui-audit] base=${base} checks=${[...checks].join(",")} cases=${total}`);

    for (const role of ["public", "customer", "admin"]) {
      const routes = ROUTES.filter((route) => route.role === role);
      if (routes.length === 0) continue;

      for (const locale of LOCALES) {
        for (const theme of THEMES) {
          const context = await makeContext(browser, {
            locale,
            theme,
            storageState: role === "public" ? null : states[role],
          });

          for (const width of WIDTHS) {
            for (const route of routes) {
              const page = await context.newPage();
              cases += 1;
              try {
                const caseFailures = await runCase(page, {
                  base,
                  route,
                  locale,
                  theme,
                  width,
                  checks,
                  baseline,
                });
                failures.push(...caseFailures);
                const filename = `${slug(route.name)}-${locale}-${theme}-${width}.png`;
                await page.screenshot({ path: path.join(outDir, filename), fullPage: false });
                screenshots.push(filename);
              } catch (error) {
                failures.push({
                  route: route.path,
                  routeName: route.name,
                  role,
                  locale,
                  theme,
                  width,
                  check: "infra",
                  detail: String(error.message || error).slice(0, 300),
                });
              } finally {
                await page.close();
              }

              if (cases % 10 === 0 || cases === total) {
                console.log(
                  `[ui-audit] ${cases}/${total} cases, ${failures.length} failures`
                );
              }
            }
          }

          await context.close();
        }
      }
    }

    const finishedAt = new Date();
    return {
      wave,
      base,
      checks: [...checks],
      cases,
      failures,
      screenshots,
      axeBaseline: args["axe-baseline"] || null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outDir,
    };
  } finally {
    if (browser) await browser.close();
  }
}

main()
  .then((report) => {
    if (!report) return;
    const byCheck = report.failures.reduce((acc, failure) => {
      acc[failure.check] = (acc[failure.check] || 0) + 1;
      return acc;
    }, {});
    const reportPath = path.join(report.outDir, "report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log(
      `[ui-audit] done cases=${report.cases} failures=${report.failures.length} ${JSON.stringify(byCheck)}`
    );
    console.log(`[ui-audit] report=${reportPath}`);
    console.log(`[ui-audit] screenshots=${report.screenshots.length} dir=${report.outDir}`);
    if (report.failures.length > 0) {
      const infra = report.failures.filter((failure) => failure.check === "infra");
      const sample = report.failures
        .slice(0, 5)
        .map((failure) => `${failure.check} ${failure.route} ${failure.locale}/${failure.theme}/${failure.width}: ${failure.detail}`)
        .join("\n");
      console.error(`[ui-audit] FAIL\n${sample}`);
      process.exit(infra.length === report.failures.length ? 2 : 1);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[ui-audit] FATAL: ${error.message}`);
    process.exit(2);
  });
