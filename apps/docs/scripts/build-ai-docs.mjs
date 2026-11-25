/**
 * Generates the machine-readable documentation set into dist/ after `vite build`:
 *   llms.txt, llms-full.txt, <slug>.md (en) and ar/<slug>.md, agent-prompt.md,
 *   AGENTS.md and openapi.json (developer-facing data plane + end-user auth only).
 * Pages are rendered with the same React components the site uses, then
 * converted to Markdown, so the .md files can never drift from the HTML pages.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { htmlToMarkdown } from "./html-to-md.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");
const ORIGIN = (process.env.DOCS_ORIGIN || "https://vellum-console.vercel.app").replace(/\/$/, "");
const API_ORIGIN = (process.env.VELLUM_API_ORIGIN || "https://vellum-api-mag-1.vercel.app").replace(/\/$/, "");
const FULL_EXCLUDE = new Set(["privacy", "terms", "reference/packages"]);

const OPENAPI_KEEP = [
  /^\/v1\/health$/,
  /^\/v1\/projects\/\{projectId\}\/(documents\/\{path\}|query|batchWrite|transactions:begin|transactions:commit|indexes|indexes\/\{indexId\}|documents:referencedBy|documents:aggregate|documents:bulk-delete)$/,
  /^\/v1\/projects\/\{projectId\}\/auth\/(?!admin\/)/,
];

if (!fs.existsSync(dist)) throw new Error("dist/ not found: run vite build first");

const server = await createServer({ root, appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
try {
  const nav = await server.ssrLoadModule("/src/nav.ts");
  const { PAGES } = await server.ssrLoadModule("/src/registry.ts");
  const { buildAgentPrompt } = await server.ssrLoadModule("/src/agent-prompt.ts");
  const AGENT_PROMPT = buildAgentPrompt(ORIGIN);
  const { generateOpenApiSpec } = await server.ssrLoadModule("/../../packages/api-contract/src/openapi.ts");

  const url = (slug, lang, ext = "md") => `${ORIGIN}/docs/${lang === "ar" ? "ar/" : ""}${slug}.${ext}`;
  const write = (rel, body) => {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  // Per-page Markdown. Pages are lazy() wrappers in the registry, so load the module directly.
  const md = { en: new Map(), ar: new Map() };
  for (const lang of ["en", "ar"]) {
    for (const page of nav.ALL_PAGES) {
      const mod = await server.ssrLoadModule(`/src/pages/${lang}/${page.slug}.tsx`);
      const html = renderToStaticMarkup(createElement(mod.default));
      const body = htmlToMarkdown(html, { baseUrl: ORIGIN });
      const canonical = `${ORIGIN}${nav.pageHref(page.slug, lang).replace(/^\/docs\/docs\//, "/docs/")}`;
      md[lang].set(page.slug, `> Source: ${canonical}\n\n${body}`);
      write(`${lang === "ar" ? "ar/" : ""}${page.slug}.md`, md[lang].get(page.slug));
    }
  }
  // The agent guide page is itself a registry page; make sure it exists in both languages.
  void PAGES;

  // llms.txt
  const lines = [
    "# VELLUM",
    "",
    "> VELLUM is a PostgreSQL-native document database with a Firestore-style API: collections, documents, queries, composite indexes, security rules, end-user auth and realtime. Official SDKs: @vellumdb/sdk-js (TypeScript/JavaScript) and vellum_flutter (Flutter/Dart). Public beta.",
    "",
    "Every page below is plain Markdown. Start with the agent guide, then the page for the task at hand.",
    "",
  ];
  for (const group of nav.NAV_GROUPS) {
    if (group.title.en === "Legal") continue;
    lines.push(`## ${group.title.en}`, "");
    for (const p of group.items) lines.push(`- [${p.title.en}](${url(p.slug, "en")}): ${p.desc.en}`);
    lines.push("");
  }
  lines.push(
    "## Optional",
    "",
    `- [Full documentation in one file](${ORIGIN}/docs/llms-full.txt): every guide and reference concatenated`,
    `- [Agent prompt](${ORIGIN}/docs/agent-prompt.md): paste into an AI assistant before asking it to build with VELLUM`,
    `- [OpenAPI 3.1 spec](${ORIGIN}/docs/openapi.json): machine-readable data plane and end-user auth endpoints`,
    `- [Arabic documentation index](${ORIGIN}/docs/ar/llms.txt)`,
    "",
  );
  write("llms.txt", lines.join("\n"));

  // Arabic index
  const ar = ["# VELLUM", "", "> قاعدة مستندات أصلية على PostgreSQL بواجهة شبيهة بـ Firestore. كل صفحة أدناه بصيغة Markdown.", ""];
  for (const group of nav.NAV_GROUPS) {
    if (group.title.en === "Legal") continue;
    ar.push(`## ${group.title.ar}`, "");
    for (const p of group.items) ar.push(`- [${p.title.ar}](${url(p.slug, "ar")}): ${p.desc.ar}`);
    ar.push("");
  }
  write("ar/llms.txt", ar.join("\n"));

  // llms-full.txt
  const full = [fs.readFileSync(path.join(dist, "llms.txt"), "utf8").split("## Optional")[0].trimEnd(), ""];
  full.push("---", "", "# Agent prompt", "", AGENT_PROMPT.trim(), "");
  for (const p of nav.ALL_PAGES) {
    if (FULL_EXCLUDE.has(p.slug)) continue;
    full.push("---", "", md.en.get(p.slug).trim(), "");
  }
  write("llms-full.txt", full.join("\n"));

  // Agent prompt + AGENTS.md
  write("agent-prompt.md", AGENT_PROMPT.trim() + "\n");
  write("AGENTS.md", AGENT_PROMPT.trim() + "\n");

  // Public OpenAPI subset
  const spec = generateOpenApiSpec(API_ORIGIN);
  spec.paths = Object.fromEntries(Object.entries(spec.paths).filter(([p]) => OPENAPI_KEEP.some((re) => re.test(p))));
  write("openapi.json", JSON.stringify(spec, null, 2) + "\n");

  console.log(`[ai-docs] wrote ${nav.ALL_PAGES.length * 2} markdown pages, llms.txt, llms-full.txt, agent-prompt.md, AGENTS.md, openapi.json (${Object.keys(spec.paths).length} paths)`);
} finally {
  await server.close();
}
