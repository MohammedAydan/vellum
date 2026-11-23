/**
 * Builds a dependency-free, fully static, bilingual (EN/AR) documentation site.
 *
 * SECURITY: every code sample is escaped, syntax-highlighted, inert text.
 * The site has no markdown runtime, no eval, and never executes an example.
 * Tabs (Flutter / JS-TS / REST) only show/hide pre-rendered panels.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { highlight } from "./docs-highlight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guidesDir = resolve(root, process.env.VELLUM_GUIDES_DIR || "docs/guides");
const outDir = resolve(root, process.env.VELLUM_SITE_DIR || "docs/site");
const examplesDir = resolve(root, process.env.VELLUM_EXAMPLES_DIR || "examples");
const generatedDir = resolve(root, process.env.VELLUM_GENERATED_DIR || "docs/generated/examples");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-|-$/g, "");

const UI = {
  en: {
    badge: "VERIFIED EXAMPLES · STATIC", search: "Search docs", toc: "On this page",
    foot1: "VELLUM v1 · official shadcn/ui default design",
    foot2: "Generated from docs/guides — do not edit HTML directly.",
    sidebarFoot: "Examples are executed against the live API and rendered as inert text. No code runs in this site.",
    crumb: "Documentation", verified: "VERIFIED SOURCE", refOnly: "Reference only — not executed here (no Dart toolchain).",
    captured: "OUTPUT · captured from a real run", copy: "Copy", copied: "Copied", close: "esc",
    searchPlaceholder: "Search guides, APIs, examples…", noResults: "No results for", switchLang: "العربية", langCode: "AR",
    tabsLabel: "SDK / protocol", flutter: "Flutter / Dart", js: "JS / TypeScript", rest: "REST",
  },
  ar: {
    badge: "أمثلة مُتحقَّق منها · ثابتة", search: "ابحث في التوثيق", toc: "في هذه الصفحة",
    foot1: "VELLUM v1 · التصميم الافتراضي الرسمي لـ shadcn/ui",
    foot2: "مولَّد من docs/guides — لا تعدّل HTML مباشرة.",
    sidebarFoot: "تُنفَّذ الأمثلة على الـ API الحي وتُعرض كنص خامل. لا يُنفَّذ أي كود داخل هذا الموقع.",
    crumb: "التوثيق", verified: "مصدر مُتحقَّق منه", refOnly: "للمرجعية فقط — لم يُنفَّذ هنا (لا توجد أداة Dart).",
    captured: "النتيجة · مُلتقطة من تشغيل فعلي", copy: "نسخ", copied: "تم النسخ", close: "إغلاق",
    searchPlaceholder: "ابحث في الأدلة والواجهات والأمثلة…", noResults: "لا نتائج لـ", switchLang: "English", langCode: "EN",
    tabsLabel: "المجموعة / البروتوكول", flutter: "Flutter / Dart", js: "JS / TypeScript", rest: "REST",
  },
};

function listMarkdownFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listMarkdownFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".md")) out.push({ path: resolve(dir, entry.name), slug: `${prefix}${entry.name.slice(0, -3)}` });
  }
  return out;
}

function parseFrontmatter(text) {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  const meta = { title: "Untitled", order: 999, group: "Guides", description: "" };
  if (!match) return { meta, body: text };
  for (const line of match[1].split("\n")) {
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2].replace(/^["']|["']$/g, "");
    if (kv[1] === "order") meta.order = Number(value) || 999;
    else meta[kv[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

let KNOWN_SLUGS = new Set();

function relativeUrl(targetSlug, currentSlug) {
  const rel = posix.relative(posix.dirname(currentSlug) || ".", targetSlug);
  return `${rel}.html`;
}

function resolveHref(href, currentSlug) {
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  let clean = href.split("#")[0];
  const hash = href.includes("#") ? `#${href.split("#")[1]}` : "";
  if (!clean.endsWith(".md")) return href;
  clean = clean.replace(/^\/docs\/guides\//, "").replace(/^\/?guides\//, "").replace(/^\//, "").replace(/\.md$/, "");
  const target = posix.normalize(posix.join(posix.dirname(currentSlug) || ".", clean));
  // Links to documents outside docs/guides point at the repository source
  // instead of a non-existent generated page.
  if (KNOWN_SLUGS.size > 0 && !KNOWN_SLUGS.has(target)) {
    return `https://github.com/MohammedAydan/document-db/blob/main/docs/${target}.md${hash}`;
  }
  return relativeUrl(target, currentSlug) + hash;
}

function inline(text, currentSlug) {
  const codeSpans = [];
  let s = String(text).replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code class="inline-code">${esc(code)}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${esc(resolveHref(href, currentSlug))}">${label}</a>`);
  return s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd() : null;
}

function codeBlock(code, lang, opts = {}) {
  const label = (lang || "text").toUpperCase();
  const badge = opts.verified
    ? `<span class="cb-badge cb-verified" title="${esc(opts.locale === "ar" ? "تم تشغيل المصدر على الـ API الحي" : "Source was executed against the live API")}">✓ ${esc(UI[opts.locale || "en"].verified)}</span>`
    : "";
  const output = opts.output
    ? `<div class="cb-head"><span class="cb-lang cb-terminal">${esc(UI[opts.locale || "en"].captured)}</span><button class="cb-copy" type="button">${esc(UI[opts.locale || "en"].copy)}</button></div>
       <pre class="cb-out"><code class="hl-text">${esc(opts.output)}</code></pre>`
    : opts.note
      ? `<div class="et-note">${esc(opts.note)}</div>`
      : "";
  return `<div class="code-block${output ? " with-output" : ""}">
  <div class="cb-head"><span class="cb-lang">${esc(label)}</span>${badge}<button class="cb-copy" type="button">${esc(UI[opts.locale || "en"].copy)}</button></div>
  <pre><code class="hl-code">${highlight(code, lang)}</code></pre>${output}
</div>`;
}

function loadManifest() {
  const path = resolve(examplesDir, "ts/manifest.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : raw.examples;
}
const manifest = loadManifest();

function exampleTabsBlock(id, currentSlug, locale) {
  const entry = manifest.find((e) => e.id === id);
  const t = UI[locale];
  if (!entry) return `<div class="admonition admonition-warning"><p>Unknown example id <code>${esc(id)}</code>.</p></div>`;
  const tsFile = resolve(examplesDir, "ts", entry.file || `${id}.ts`);
  const restFile = resolve(examplesDir, entry.rest || `rest/${id}.mjs`);
  const dartFile = resolve(examplesDir, entry.dart || `flutter/${id}.dart`);
  const tsSource = readIf(tsFile) ?? `// Missing: ${entry.file}`;
  const restSource = readIf(restFile) ?? `// Missing: ${entry.rest || `rest/${id}.mjs`}`;
  const dartSource = readIf(dartFile) ?? `// Missing: ${entry.dart || `flutter/${id}.dart`}`;
  const tsOut = readIf(resolve(generatedDir, `${id}.txt`)) ?? `(Output not captured. Run \`corepack pnpm docs:examples\`.)`;
  const restOut = readIf(resolve(generatedDir, `${id}.rest.txt`));

  const tabs = [
    { key: "dart", label: t.flutter, lang: "dart", source: dartSource, note: t.refOnly },
    { key: "ts", label: t.js, lang: "ts", source: tsSource, output: tsOut, verified: true },
    { key: "rest", label: t.rest, lang: "js", source: restSource, output: restOut, verified: Boolean(restOut) },
  ];
  const buttons = tabs.map((tab) => `<button type="button" class="et-tab${tab.key === "ts" ? " is-active" : ""}" data-example-tab="${tab.key}" role="tab" aria-selected="${tab.key === "ts"}">${esc(tab.label)}</button>`).join("");
  const panels = tabs.map((tab) => `<div class="et-panel" data-example-panel="${tab.key}" role="tabpanel"${tab.key === "ts" ? "" : " hidden"}>${codeBlock(tab.source, tab.lang, { output: tab.output, note: tab.note, verified: tab.verified, locale })}</div>`).join("");
  return `<div class="example-tabs" data-example-tabs>
  <div class="et-head"><span class="et-label">${esc(t.tabsLabel)}</span><div class="et-tablist" role="tablist">${buttons}</div></div>
  <div class="et-panels">${panels}</div>
</div>`;
}

function exampleBlock(id, currentSlug, locale) {
  const entry = manifest.find((e) => e.id === id);
  if (!entry) return `<div class="admonition admonition-warning"><p>Unknown example id <code>${esc(id)}</code>.</p></div>`;
  const source = readIf(resolve(examplesDir, "ts", entry.file)) ?? `// Missing: ${entry.file}`;
  const output = readIf(resolve(generatedDir, `${id}.txt`)) ?? "(Output not captured yet.)";
  return `<div class="example-wrap">${codeBlock(source, "ts", { verified: true, output, locale })}</div>`;
}

function renderMarkdown(body, currentSlug, locale) {
  const lines = body.split("\n");
  const out = [];
  const headings = [];
  let i = 0;
  const isBlockStart = (l) => /^\s*(#{1,4}\s|```|:::?|[-*]\s|\d+\.\s|>|---\s*$|\|)/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") { i++; continue; }

    if (t.startsWith("```")) {
      const lang = t.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(codeBlock(buf.join("\n"), lang, { locale }));
      continue;
    }

    const ex = /^:::example-tabs?\s+(\S+)\s*$/.exec(t);
    if (ex) {
      out.push(t.startsWith(":::example-tabs") ? exampleTabsBlock(ex[1], currentSlug, locale) : exampleBlock(ex[1], currentSlug, locale));
      i++;
      continue;
    }

    const adm = /^:::(note|warning|tip|important)(?:\s+(.*))?$/.exec(t);
    if (adm) {
      const buf = adm[2] ? [adm[2]] : [];
      i++;
      while (i < lines.length && lines[i].trim() !== ":::") buf.push(lines[i++]);
      i++;
      out.push(`<div class="admonition admonition-${adm[1]}"><div class="admonition-label">${adm[1].toUpperCase()}</div>${buf.filter((l) => l.trim()).map((l) => `<p>${inline(l, currentSlug)}</p>`).join("")}</div>`);
      continue;
    }

    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      const anchor = slugify(title);
      headings.push({ level, title, anchor });
      out.push(`<h${level} id="${esc(anchor)}">${inline(title, currentSlug)}<a class="anchor" href="#${esc(anchor)}" aria-label="Link to section">#</a></h${level}>`);
      i++;
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const parseRow = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(parseRow(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${header.map((c) => `<th>${inline(c, currentSlug)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, currentSlug)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((it) => `<li>${inline(it, currentSlug)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(`<ol>${items.map((it) => `<li>${inline(it, currentSlug)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${buf.map((l) => `<p>${inline(l, currentSlug)}</p>`).join("")}</blockquote>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "), currentSlug)}</p>`);
  }
  return { html: out.join("\n"), headings };
}

const enFiles = listMarkdownFiles(guidesDir).filter((f) => !f.slug.startsWith("ar/"));
const arFiles = listMarkdownFiles(resolve(guidesDir, "ar")).map((f) => ({ ...f, slug: `ar/${f.slug}` }));
const pages = [...enFiles.map((f) => ({ ...f, locale: "en" })), ...arFiles.map((f) => ({ ...f, locale: "ar" }))]
  .map((f) => ({ ...f, ...parseFrontmatter(readFileSync(f.path, "utf8")) }));
if (pages.length === 0) throw new Error("No guides found in docs/guides");
KNOWN_SLUGS = new Set(pages.map((p) => p.slug));
pages.sort((a, b) => a.locale.localeCompare(b.locale) || (a.slug.endsWith("/index") || a.slug === "index" ? -1 : b.slug === "index" || b.slug.endsWith("/index") ? 1 : a.meta.order - b.meta.order || a.meta.title.localeCompare(b.meta.title)));

mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(outDir, "assets"), { recursive: true });
mkdirSync(resolve(outDir, "ar/assets"), { recursive: true });

for (const locale of ["en", "ar"]) {
  const localePages = pages.filter((p) => p.locale === locale);
  const index = localePages.map((p) => ({
    title: p.meta.title, description: p.meta.description, url: `${p.slug}.html`, group: p.meta.group,
    text: p.body.replace(/```[\s\S]*?```/g, " ").replace(/[#>*|`]/g, " ").replace(/\s+/g, " ").slice(0, 1200),
  }));
  const target = locale === "en" ? resolve(outDir, "assets/search-index.json") : resolve(outDir, "ar/assets/search-index.json");
  writeFileSync(target, JSON.stringify(index));
}

const navFor = (locale, currentSlug) => {
  const groups = new Map();
  for (const p of pages.filter((x) => x.locale === locale)) {
    if (!groups.has(p.meta.group)) groups.set(p.meta.group, []);
    groups.get(p.meta.group).push(p);
  }
  return [...groups.entries()]
    .map(([group, items]) => `<div class="nav-group"><div class="nav-group-title">${esc(group)}</div><ul>${items.map((p) => `<li><a href="${esc(relativeUrl(p.slug, currentSlug))}" class="nav-link${p.slug === `${locale === "ar" ? "ar/" : ""}index` ? " nav-home" : ""}">${esc(p.meta.title)}</a></li>`).join("")}</ul></div>`)
    .join("");
};

for (const page of pages) {
  const t = UI[page.locale];
  const { html, headings } = renderMarkdown(page.body, page.slug, page.locale);
  const toc = headings.filter((h) => h.level === 2 || h.level === 3).map((h) => `<a href="#${esc(h.anchor)}" class="toc-link toc-l${h.level}">${esc(h.title)}</a>`).join("");
  const depth = page.slug.split("/").length - 1;
  const base = "../".repeat(depth);
  const other = page.locale === "en" ? `${base}ar/${page.slug}.html` : `${base}${page.slug.slice(3)}.html`;
  const langAttrs = page.locale === "ar" ? 'lang="ar" dir="rtl"' : 'lang="en" dir="ltr"';
  const pageHtml = `<!doctype html>
<html ${langAttrs} data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.meta.title)} · VELLUM Docs</title>
<meta name="description" content="${esc(page.meta.description)}">
<link rel="stylesheet" href="${base}assets/docs.css">
</head>
<body data-base="${base}">
<header class="topbar">
  <button class="mobile-menu" id="mobileMenu" type="button" aria-label="☰">☰</button>
  <a class="brand" href="${base}${page.locale === "ar" ? "ar/" : ""}index.html"><span class="brand-mark">◈</span><span>VELLUM <span class="brand-dim">/ ${esc(t.crumb)}</span></span></a>
  <span class="top-badge">${esc(t.badge)}</span>
  <div class="top-actions">
    <button class="search-trigger" id="searchTrigger" type="button">${esc(t.search)} <kbd>⌘K</kbd></button>
    <a class="lang-link" href="${esc(other)}" title="${esc(t.switchLang)}">${esc(t.langCode)}</a>
    <button class="icon-btn" id="themeToggle" type="button" aria-label="◐">◐</button>
    <a class="icon-btn" href="https://github.com/MohammedAydan/document-db" target="_blank" rel="noopener" aria-label="GitHub">⌥</a>
  </div>
</header>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-inner">${navFor(page.locale, page.slug)}</div>
    <div class="sidebar-foot">${esc(t.sidebarFoot)}</div>
  </aside>
  <main class="main">
    <div class="breadcrumb">${esc(page.meta.group)} <span>/</span> <strong>${esc(page.meta.title)}</strong></div>
    <article class="article">${html}</article>
    <footer class="article-foot"><span>${esc(t.foot1)}</span><span>${esc(t.foot2)}</span></footer>
  </main>
  <aside class="toc"><div class="toc-title">${esc(t.toc)}</div>${toc}</aside>
</div>
<div class="search-overlay" id="searchOverlay" hidden>
  <div class="search-box"><input id="searchInput" type="search" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off"><button id="searchClose" type="button">${esc(t.close)}</button></div>
  <div class="search-results" id="searchResults"></div>
</div>
<script src="${base}assets/docs.js" defer></script>
</body>
</html>`;
  const target = resolve(outDir, `${page.slug}.html`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pageHtml);
}

const css = `:root{color-scheme:dark;--bg:#0b0b0e;--bg-soft:#121216;--panel:#17171c;--panel-2:#1d1d23;--line:#2a2a33;--fg:#ededf2;--muted:#a1a1ad;--faint:#71717e;--blue:#7aa2f7;--green:#66d9a0;--amber:#f5c26b;--red:#ff7b7b;--purple:#c4a7ff;--code-bg:#101014;--shadow:0 12px 40px rgba(0,0,0,.45)}
html[data-theme="light"]{color-scheme:light;--bg:#ffffff;--bg-soft:#fafafa;--panel:#ffffff;--panel-2:#f6f6f7;--line:#e6e6e9;--fg:#18181b;--muted:#5a5a66;--faint:#8b8b96;--blue:#2f6fe4;--green:#16855a;--amber:#a86b12;--red:#c94040;--purple:#8250c4;--code-bg:#f7f7f8;--shadow:0 10px 30px rgba(0,0,0,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.topbar{position:sticky;top:0;z-index:50;height:60px;display:flex;align-items:center;gap:14px;padding:0 20px;background:color-mix(in oklab,var(--bg) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;color:var(--fg);font-weight:700;font-size:16px;letter-spacing:-.02em}.brand:hover{text-decoration:none}.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:16px}.brand-dim{color:var(--faint);font-weight:500}
.top-badge{font-size:10px;letter-spacing:.1em;color:var(--green);border:1px solid color-mix(in oklab,var(--green) 35%,transparent);border-radius:999px;padding:3px 9px;white-space:nowrap}
.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.search-trigger{display:flex;align-items:center;gap:8px;min-width:190px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);font-size:13px;cursor:pointer;text-align:left}.search-trigger kbd{margin-left:auto;font-size:10px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--faint)}
.icon-btn,.lang-link{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);cursor:pointer;font-size:13px;font-weight:600;text-decoration:none}.lang-link:hover,.icon-btn:hover{color:var(--fg);text-decoration:none}
.mobile-menu{display:none;background:none;border:0;color:var(--fg);font-size:20px;cursor:pointer}
.layout{display:grid;grid-template-columns:268px minmax(0,820px) 220px;gap:40px;max-width:1500px;margin:0 auto;padding:32px 28px 80px}
.sidebar{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow-y:auto;padding-right:10px}
.nav-group{margin-bottom:24px}.nav-group-title{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:0 0 8px 10px}
.nav-group ul{list-style:none;margin:0;padding:0}.nav-link{display:block;padding:6px 10px;border-radius:7px;color:var(--muted);font-size:13.5px}.nav-link:hover{background:var(--panel);color:var(--fg);text-decoration:none}.nav-link.active{background:var(--panel-2);color:var(--fg);font-weight:600;box-shadow:inset 2px 0 0 var(--fg)}
.sidebar-foot{margin-top:28px;padding:12px;border:1px dashed var(--line);border-radius:8px;color:var(--faint);font-size:11px;line-height:1.5}
.main{min-width:0}.breadcrumb{color:var(--faint);font-size:12px;margin-bottom:18px}.breadcrumb span{margin:0 7px}.breadcrumb strong{color:var(--muted);font-weight:500}
.article h1,.article h2,.article h3,.article h4{letter-spacing:-.02em;line-height:1.3;margin:38px 0 14px;scroll-margin-top:80px}.article h1{font-size:32px;margin-top:0}.article h2{font-size:26px}.article h3{font-size:20px}.article h4{font-size:16px}
.article p{margin:0 0 14px;color:color-mix(in oklab,var(--fg) 88%,var(--muted))}.article ul,.article ol{margin:0 0 16px;padding-left:22px;color:var(--muted)}.article li{margin:5px 0}
.anchor{margin-left:8px;color:var(--faint);opacity:0;font-size:.75em}.article h2:hover .anchor,.article h3:hover .anchor{opacity:1}
.inline-code{font:12.5px/1.5 "JetBrains Mono",ui-monospace,monospace;background:var(--panel-2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--fg)}
.article hr{border:0;border-top:1px solid var(--line);margin:32px 0}
blockquote{margin:18px 0;padding:10px 16px;border-left:3px solid var(--line);background:var(--panel);border-radius:0 8px 8px 0;color:var(--muted)}
.table-wrap{overflow-x:auto;margin:18px 0;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:10px 13px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--panel-2);color:var(--fg);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}td{color:var(--muted)}
.admonition{margin:20px 0;padding:14px 16px;border:1px solid var(--line);border-left-width:3px;border-radius:9px;background:var(--panel)}.admonition p{margin:4px 0;color:var(--muted)}.admonition-label{font-size:10px;letter-spacing:.12em;font-weight:800;margin-bottom:4px}
.admonition-note{border-left-color:var(--blue)}.admonition-note .admonition-label{color:var(--blue)}.admonition-warning{border-left-color:var(--amber)}.admonition-warning .admonition-label{color:var(--amber)}.admonition-tip{border-left-color:var(--green)}.admonition-tip .admonition-label{color:var(--green)}.admonition-important{border-left-color:var(--red)}.admonition-important .admonition-label{color:var(--red)}
.example-wrap,.example-tabs{margin:22px 0}.example-meta{display:flex;gap:10px;align-items:center;margin-bottom:8px;color:var(--faint);font-size:12px}.example-id{font:11px "JetBrains Mono",monospace;color:var(--green);border:1px solid color-mix(in oklab,var(--green) 30%,transparent);border-radius:5px;padding:2px 7px}
.et-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}.et-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-weight:700}.et-tablist{display:flex;gap:4px;padding:3px;background:var(--panel-2);border:1px solid var(--line);border-radius:9px}
.et-tab{padding:5px 12px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:12px;cursor:pointer}.et-tab:hover{color:var(--fg)}.et-tab.is-active{background:var(--fg);color:var(--bg);font-weight:600}
.et-panel[hidden]{display:none}.et-note{padding:10px 14px;background:color-mix(in oklab,var(--amber) 8%,transparent);border-top:1px solid var(--line);color:var(--muted);font-size:11.5px}
.code-block{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--code-bg);margin:0;box-shadow:var(--shadow)}
.cb-head{display:flex;align-items:center;gap:10px;padding:7px 12px;background:var(--panel-2);border-bottom:1px solid var(--line)}.cb-lang{font:10px "JetBrains Mono",monospace;letter-spacing:.08em;color:var(--faint)}.cb-terminal{color:var(--green)}
.cb-badge{font:9px "JetBrains Mono",monospace;letter-spacing:.06em;border-radius:999px;padding:2px 7px}.cb-verified{color:var(--green);background:color-mix(in oklab,var(--green) 12%,transparent)}
.cb-copy{margin-left:auto;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer}.cb-badge+.cb-copy{margin-left:0}
.code-block pre{margin:0;padding:14px 16px;overflow-x:auto;font:12.5px/1.65 "JetBrains Mono",ui-monospace,monospace;color:var(--fg);tab-size:2;direction:ltr;text-align:left}
.code-block .cb-out{background:color-mix(in oklab,var(--green) 4%,var(--code-bg));color:color-mix(in oklab,var(--fg) 80%,var(--muted));border-top:1px solid var(--line)}
.hl-comment{color:var(--faint);font-style:italic}.hl-string{color:var(--green)}.hl-number{color:var(--amber)}.hl-keyword{color:var(--blue);font-weight:600}.hl-fn{color:var(--purple)}.hl-type{color:var(--amber)}.hl-property{color:var(--fg)}
.article-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:56px;padding-top:18px;border-top:1px solid var(--line);color:var(--faint);font-size:11px}
.toc{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow-y:auto;padding-top:4px}.toc-title{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:10px}.toc-link{display:block;padding:4px 0;color:var(--muted);font-size:12px;border-left:2px solid transparent;padding-left:10px}.toc-link:hover,.toc-link.active{color:var(--fg);border-left-color:var(--fg);text-decoration:none}.toc-l3{padding-left:22px;font-size:11.5px}
.search-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}.search-overlay[hidden]{display:none}
.search-box{display:flex;width:min(620px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}.search-box input{flex:1;padding:14px 16px;background:transparent;border:0;outline:0;color:var(--fg);font-size:15px}.search-box button{padding:0 14px;background:transparent;border:0;color:var(--faint);cursor:pointer;font-size:12px}
.search-results{width:min(620px,92vw);max-height:55vh;overflow-y:auto;margin-top:8px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.search-item{display:block;padding:12px 16px;border-bottom:1px solid var(--line)}.search-item:last-child{border:0}.search-item:hover{background:var(--panel-2);text-decoration:none}.search-item strong{display:block;color:var(--fg);font-size:14px}.search-item span{color:var(--muted);font-size:12px}.search-item em{color:var(--faint);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
html[dir="rtl"] .layout{grid-template-columns:220px minmax(0,820px) 268px}.layout{direction:ltr}html[dir="rtl"] .layout{direction:rtl}html[dir="rtl"] .article{text-align:right}html[dir="rtl"] .nav-link{box-shadow:inset -2px 0 0 transparent}html[dir="rtl"] .nav-link.active{box-shadow:inset -2px 0 0 var(--fg)}
@media(max-width:1200px){.layout{grid-template-columns:240px minmax(0,1fr);gap:28px}.toc{display:none}}
@media(max-width:820px){.topbar{padding:0 12px;gap:8px}.mobile-menu{display:block}.top-badge,.search-trigger{display:none}.layout{display:block;padding:20px 16px 60px}.sidebar{display:none;position:fixed;top:60px;left:0;bottom:0;width:280px;background:var(--bg);z-index:40;border-right:1px solid var(--line);padding:18px}.sidebar.open{display:block}}
`;

const js = `(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem("vellum-docs-theme");
  if (saved) root.dataset.theme = saved;
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next; localStorage.setItem("vellum-docs-theme", next);
  });
  document.querySelectorAll(".cb-copy").forEach((btn) => btn.addEventListener("click", async () => {
    const block = btn.closest(".code-block");
    const heads = [...block.querySelectorAll(".cb-head")];
    const pres = [...block.querySelectorAll("pre")];
    const target = pres[heads.indexOf(btn.closest(".cb-head"))] || pres[0];
    try { await navigator.clipboard.writeText(target.textContent || ""); btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1400); } catch { btn.textContent = "Failed"; }
  }));
  document.querySelectorAll(".et-tab").forEach((tab) => tab.addEventListener("click", () => {
    const wrap = tab.closest("[data-example-tabs]");
    const key = tab.dataset.exampleTab;
    wrap.querySelectorAll(".et-tab").forEach((b) => { const on = b === tab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    wrap.querySelectorAll(".et-panel").forEach((p) => { p.hidden = p.dataset.examplePanel !== key; });
  }));
  const base = document.body.dataset.base || "";
  let index = [];
  fetch(base + "assets/search-index.json").then((r) => r.json()).then((d) => (index = d)).catch(() => {});
  const overlay = document.getElementById("searchOverlay");
  const input = document.getElementById("searchInput");
  const results = document.getElementById("searchResults");
  const open = () => { overlay.hidden = false; input.focus(); };
  const close = () => { overlay.hidden = true; input.value = ""; results.innerHTML = ""; };
  document.getElementById("searchTrigger").addEventListener("click", open);
  document.getElementById("searchClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
    if (e.key === "Escape") close();
  });
  const runSearch = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ""; return; }
    const hits = index.filter((p) => (p.title + " " + p.description + " " + p.text).toLowerCase().includes(q)).slice(0, 12);
    results.innerHTML = hits.length ? hits.map((p) => \`<a class="search-item" href="\${base + p.url}"><em>\${p.group}</em><strong>\${p.title}</strong><span>\${p.description}</span></a>\`).join("") : \`<div class="search-item"><span>—</span></div>\`;
  };
  input.addEventListener("input", runSearch);
  const current = decodeURIComponent(location.pathname.split("/").pop().replace(".html", ""));
  document.querySelectorAll(".nav-link").forEach((a) => {
    const href = decodeURIComponent(a.getAttribute("href") || "").replace(".html", "");
    if (href === current || (href.endsWith("/" + current) && current.includes("/"))) a.classList.add("active");
  });
  const links = [...document.querySelectorAll(".toc-link")];
  if ("IntersectionObserver" in window && links.length) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((l) => l.classList.toggle("active", l.getAttribute("href") === "#" + entry.target.id));
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    document.querySelectorAll("h2[id],h3[id]").forEach((h) => obs.observe(h));
  }
  document.getElementById("mobileMenu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
})();`;
writeFileSync(resolve(outDir, "assets/docs.css"), css);
writeFileSync(resolve(outDir, "assets/docs.js"), js);

console.log(`Built ${pages.length} static pages (EN ${pages.filter((p) => p.locale === "en").length} / AR ${pages.filter((p) => p.locale === "ar").length}) → docs/site/`);
console.log("Tabs: Flutter / JS-TS / REST · syntax highlighting enabled · code is inert escaped text.");
