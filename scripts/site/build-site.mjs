#!/usr/bin/env node
/**
 * Generates the static public site (home, features, SDKs, security, 404) in
 * English and Arabic, plus robots.txt and sitemap.xml, into dist-frontend/.
 * Also writes per-page HTML shells for the docs SPA so every docs URL has its
 * own title, description, canonical, hreflang and JSON-LD for crawlers.
 * Node builtins only. Run by scripts/build-frontend.mjs after the apps are copied.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, DOCS_JSONLD_TYPE } from "./content.mjs";
import { CSS, JS, EARLY_JS, renderPage, renderNotFound, escapeHtml } from "./template.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "dist-frontend");
export const ORIGIN = (process.env.SITE_ORIGIN || "https://vellum-console.vercel.app").replace(/\/$/, "");

const write = (rel, body) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

export function buildSite() {
  if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error("dist-frontend/index.html (dashboard shell) missing");
  // The dashboard SPA shell moves off "/" so the root can be the public home page.
  fs.renameSync(path.join(OUT, "index.html"), path.join(OUT, "console-shell.html"));

  write("site.css", CSS);
  // Scripts are files, not inline, so the page CSP can be `script-src 'self'`.
  write("site-early.js", EARLY_JS);
  write("site.js", JS);
  fs.copyFileSync(path.join(ROOT, "assets/site/og-image.png"), path.join(OUT, "og-image.png"));
  fs.copyFileSync(path.join(ROOT, "assets/site/mark.png"), path.join(OUT, "mark.png"));

  const urls = [];
  for (const page of PAGES) {
    for (const lang of ["en", "ar"]) {
      const route = routeOf(page.slug, lang);
      write(route === "/" ? "index.html" : `${route.slice(1)}/index.html`.replace(/\/index\.html$/, ".html"), renderPage({ page, lang, origin: ORIGIN, routeOf }));
      urls.push({ page, lang, loc: ORIGIN + (route === "/" ? "/" : route) });
    }
  }
  write("404.html", renderNotFound({ origin: ORIGIN }));

  const docs = buildDocsShells();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'];
  const today = new Date().toISOString().slice(0, 10);
  const entry = (loc, alts, priority) => {
    lines.push("  <url>", `    <loc>${loc}</loc>`, `    <lastmod>${today}</lastmod>`, `    <priority>${priority}</priority>`);
    for (const [hl, href] of alts) lines.push(`    <xhtml:link rel="alternate" hreflang="${hl}" href="${href}"/>`);
    lines.push("  </url>");
  };
  for (const page of PAGES) {
    const en = ORIGIN + (routeOf(page.slug, "en") === "/" ? "/" : routeOf(page.slug, "en"));
    const ar = ORIGIN + routeOf(page.slug, "ar");
    const alts = [["en", en], ["ar", ar], ["x-default", en]];
    entry(en, alts, page.slug === "home" ? "1.0" : "0.8");
    entry(ar, alts, page.slug === "home" ? "0.9" : "0.7");
  }
  for (const d of docs) {
    const alts = [["en", d.en], ["ar", d.ar], ["x-default", d.en]];
    entry(d.en, alts, "0.6");
    entry(d.ar, alts, "0.5");
  }
  for (const p of ["/privacy", "/terms"]) entry(ORIGIN + p, [], "0.3");
  lines.push("</urlset>", "");
  write("sitemap.xml", lines.join("\n"));

  write("robots.txt", [
    "# Vellum public site. The console, admin and sign-in pages are not indexed.",
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /orgs/",
    "Disallow: /settings",
    "Disallow: /login",
    "Disallow: /signup",
    "Disallow: /mfa",
    "Disallow: /admin",
    "",
    "# AI crawlers and assistants are welcome to read the public docs.",
    "User-agent: GPTBot",
    "Allow: /",
    "User-agent: ClaudeBot",
    "Allow: /",
    "User-agent: PerplexityBot",
    "Allow: /",
    "User-agent: Google-Extended",
    "Allow: /",
    "",
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    "",
    `# LLM-friendly index: ${ORIGIN}/llms.txt`,
    "",
  ].join("\n"));

  console.log(`[build:site] ${urls.length} site pages, ${docs.length * 2} docs shells, sitemap.xml, robots.txt, 404.html`);
}

function routeOf(slug, lang) {
  const base = slug === "home" ? "" : `/${slug}`;
  if (lang === "ar") return `/ar${base}`;
  return slug === "home" ? "/" : base;
}

/** Per-page docs shells: same SPA, correct head for crawlers. */
function buildDocsShells() {
  const shellPath = path.join(OUT, "docs", "index.html");
  if (!fs.existsSync(shellPath)) return [];
  const shell = fs.readFileSync(shellPath, "utf8");
  const navSrc = fs.readFileSync(path.join(ROOT, "apps/docs/src/nav.ts"), "utf8");
  const pages = parseNav(navSrc);
  const out = [];
  for (const p of pages) {
    const enUrl = `${ORIGIN}/docs/${p.slug === "index" ? "" : p.slug}`.replace(/\/$/, p.slug === "index" ? "" : "/");
    const arUrl = `${ORIGIN}/docs/ar/${p.slug === "index" ? "" : p.slug}`.replace(/\/$/, "");
    const enCanon = p.slug === "index" ? `${ORIGIN}/docs` : `${ORIGIN}/docs/${p.slug}`;
    const arCanon = p.slug === "index" ? `${ORIGIN}/docs/ar` : `${ORIGIN}/docs/ar/${p.slug}`;
    void enUrl; void arUrl;
    for (const lang of ["en", "ar"]) {
      const canon = lang === "en" ? enCanon : arCanon;
      const title = `${p.title[lang]} | ${lang === "en" ? "Vellum Docs" : "توثيق Vellum"}`;
      const desc = p.desc[lang];
      const md = `${ORIGIN}/docs/${lang === "ar" ? "ar/" : ""}${p.slug === "index" ? "index" : p.slug}.md`;
      const ld = {
        "@context": "https://schema.org",
        "@type": DOCS_JSONLD_TYPE,
        headline: p.title[lang],
        description: desc,
        inLanguage: lang,
        url: canon,
        isPartOf: { "@type": "WebSite", name: "Vellum", url: ORIGIN },
        publisher: { "@type": "Organization", name: "Vellum", url: ORIGIN },
      };
      const head = [
        `<meta name="description" content="${escapeHtml(desc)}" />`,
        `<link rel="canonical" href="${canon}" />`,
        `<link rel="alternate" hreflang="en" href="${enCanon}" />`,
        `<link rel="alternate" hreflang="ar" href="${arCanon}" />`,
        `<link rel="alternate" hreflang="x-default" href="${enCanon}" />`,
        `<link rel="alternate" type="text/markdown" href="${md}" />`,
        `<meta property="og:type" content="article" />`,
        `<meta property="og:site_name" content="Vellum" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(desc)}" />`,
        `<meta property="og:url" content="${canon}" />`,
        `<meta property="og:image" content="${ORIGIN}/og-image.png" />`,
        `<meta property="og:locale" content="${lang === "ar" ? "ar_AR" : "en_US"}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
        `<meta name="twitter:image" content="${ORIGIN}/og-image.png" />`,
        `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
      ].join("\n    ");
      let html = shell
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(/<meta name="description"[^>]*>\s*/, "")
        .replace("</head>", `    ${head}\n  </head>`)
        .replace(/<html lang="en" dir="ltr">/, `<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">`);
      const fallback = `<noscript><main style="max-width:44rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif"><h1>${escapeHtml(p.title[lang])}</h1><p>${escapeHtml(desc)}</p><p><a href="${md}">${lang === "ar" ? "اقرأ هذه الصفحة بصيغة Markdown" : "Read this page as Markdown"}</a></p></main></noscript>`;
      html = html.replace(/<div id="root">\s*<\/div>/, `<div id="root">${LOADING_SPLASH(lang)}</div>${fallback}`);
      const rel = p.slug === "index" ? `docs${lang === "ar" ? "/ar" : ""}/index.html` : `docs${lang === "ar" ? "/ar" : ""}/${p.slug}/index.html`;
      if (p.slug === "index" && lang === "en") { fs.writeFileSync(shellPath, html); continue; }
      write(rel, html);
    }
    out.push({ en: enCanon, ar: arCanon });
  }
  return out;
}

const LOADING_SPLASH = (lang) => `<div class="vl-splash" role="status" aria-live="polite"><div class="vl-spin"></div><span>${lang === "ar" ? "جارٍ التحميل" : "Loading"}</span></div><style>.vl-splash{min-height:60vh;display:flex;gap:.75rem;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#8b95a7}.vl-spin{width:18px;height:18px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:vl-r .8s linear infinite}@keyframes vl-r{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.vl-spin{animation:none}}</style>`;

/** Reads slug/title/desc from nav.ts without importing TypeScript. */
function parseNav(src) {
  const re = /\{\s*slug:\s*"([^"]+)",\s*title:\s*t\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\),\s*desc:\s*t\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g;
  const unq = (s) => s.replace(/\\"/g, '"');
  const pages = [];
  let m;
  while ((m = re.exec(src))) pages.push({ slug: m[1], title: { en: unq(m[2]), ar: unq(m[3]) }, desc: { en: unq(m[4]), ar: unq(m[5]) } });
  if (pages.length < 5) throw new Error(`parseNav found only ${pages.length} docs pages; nav.ts format changed`);
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildSite();
