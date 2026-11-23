import { chromium } from "playwright";
const OUT = "/home/ubuntu/projects/document-db/docs/visual-review";
const ORG = process.env.VELLUM_QA_ORG_ID || "d29c31e0-e93f-402c-8499-74909e9bfb0a";
const PID = process.env.VELLUM_QA_PROJECT_ID || "1382468e-5dc0-44a8-9b68-5427a5b6ea5c";
const base = `/app/orgs/${ORG}/projects/${PID}`;

const auth = await fetch("http://127.0.0.1:8080/v1/auth/sign-in/email", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await ctx.addInitScript((session) => {
  localStorage.setItem("vellum_console_access_token", session.token);
  localStorage.setItem("vellum_console_refresh_token", session.refreshToken ?? "");
  localStorage.setItem("vellum_console_user", JSON.stringify({ user: session.user, expiresAt: session.expiresAt }));
}, {
  user: { id: "visual", email: "visual@vellum.dev", name: "Visual Reviewer" },
  token: auth.token,
  refreshToken: auth.refreshToken,
  expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
});
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`JS ${e.message.slice(0, 120)}`));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/v1/")) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });

for (const [path, name] of [
  ["/data", "dash-m-03-explorer"],
  ["/query", "dash-m-04-query"],
  ["/rules", "dash-m-05-rules"],
  ["/indexes", "dash-m-06-indexes"],
  ["/keys", "dash-m-07-keys"],
]) {
  await page.goto(`http://127.0.0.1:3000${base}${path}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2200);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  const text = (await page.locator("body").innerText()).slice(0, 160).replace(/\n+/g, " | ");
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log(JSON.stringify({ name, file, overflow: o.sw > o.cw, text, problems: [...new Set(problems)] }));
  problems.length = 0;
}
await browser.close();
