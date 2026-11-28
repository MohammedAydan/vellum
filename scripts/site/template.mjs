import { T, FAQ } from "./content.mjs";
import { C, SNIP } from "./copy.mjs";
import { CSS } from "./css.mjs";
import { highlight } from "./highlight.mjs";

export { CSS };
/** Runs in <head> before first paint so `.js` styles apply without a flash. */
export const EARLY_JS = 'document.documentElement.classList.add("js")';
export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const esc = escapeHtml;
const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

export const JS = `(function(){var d=document;
d.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){var t=b.getAttribute("data-copy");(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){var o=b.textContent;b.textContent=b.getAttribute("data-done");setTimeout(function(){b.textContent=o},1400)}).catch(function(){})})})})();`;

function head({ lang, title, desc, canonical, alts, origin, ld, noindex }) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="theme-color" content="#f5f4f0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131210" media="(prefers-color-scheme: dark)">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
${(alts || []).map(([hl, href]) => `<link rel="alternate" hreflang="${hl}" href="${href}">`).join("\n")}
<link rel="alternate" type="text/plain" href="${origin}/llms.txt" title="llms.txt">
<link rel="icon" type="image/png" href="/favicon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vellum">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
${canonical ? `<meta property="og:url" content="${canonical}">` : ""}
<meta property="og:image" content="${origin}/og-image.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:locale" content="${lang === "ar" ? "ar_AR" : "en_US"}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${origin}/og-image.png">
<script src="/site-early.js"></script>
<link rel="stylesheet" href="/site.css">
${(ld || []).map((o) => `<script type="application/ld+json">${json(o)}</script>`).join("\n")}
</head>`;
}


const navLinks = (lang) => {
  const t = T[lang]; const p = lang === "ar" ? "/ar" : ""; const docs = lang === "ar" ? "/docs/ar" : "/docs";
  return [[`${p}/features`, t.nav.features], [`${p}/sdks`, t.nav.sdks], [`${p}/security`, t.nav.security], [docs, t.nav.docs]];
};

function chrome({ lang, otherHref, body }) {
  const t = T[lang]; const c = C[lang];
  const p = lang === "ar" ? "/ar" : ""; const docs = lang === "ar" ? "/docs/ar" : "/docs";
  const links = navLinks(lang);
  const other = `<a href="${otherHref}" hreflang="${lang === "ar" ? "en" : "ar"}" lang="${lang === "ar" ? "en" : "ar"}">${t.footer.lang}</a>`;
  return `<a class="skip" href="#main">${t.skip}</a>
<header class="top"><div class="wrap bar">
<a class="brand" href="${p || "/"}"><span>Vellum</span><i aria-hidden="true"></i></a>
<nav class="main" aria-label="Main">${links.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}${other}<a class="btn" href="/login">${t.nav.signin}</a><a class="btn pri" href="/signup">${t.nav.start}</a></nav>
<details class="menu"><summary>${c.menu}</summary><div class="sheet">${links.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}${other}<a href="/login">${t.nav.signin}</a><a href="/signup">${t.nav.start}</a></div></details>
</div></header>
<main id="main">${body}</main>
<footer><div class="wrap">
<div class="fcols">
<div><h4>${t.footer.product}</h4><a href="${p}/features">${t.nav.features}</a><a href="${p}/sdks">${t.nav.sdks}</a><a href="${p}/security">${t.nav.security}</a></div>
<div><h4>${t.footer.resources}</h4><a href="${docs}">${t.nav.docs}</a><a href="/llms.txt">${t.footer.llms}</a><a href="/docs/openapi.json">${t.footer.openapi}</a><a href="https://github.com/MohammedAydan/vellum" rel="noopener">${t.footer.github}</a></div>
<div><h4>${t.footer.legal}</h4><a href="/privacy">${t.footer.privacy}</a><a href="/terms">${t.footer.terms}</a><a href="mailto:mohammedaydan12@gmail.com">${t.footer.contact}</a></div>
</div>
<p>${t.footer.beta}</p>
<p>&copy; ${new Date().getFullYear()} Vellum</p>
</div></footer>
<script src="/site.js" defer></script>`;
}

/* ---------- components ---------- */
const win = (name, code, lang, extra = "") => `<div class="win${extra}"><div class="win-h"><span>${esc(name)}</span></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
const installBox = (cmd, c) => `<div class="install"><code><span class="pr">$</span>${esc(cmd)}</code><button class="copy" type="button" data-copy="${esc(cmd)}" data-done="${c.copied}">${c.copy}</button></div>`;
const shead = (n, eyebrow) => `<div class="shead"><span class="snum">${n}</span><p class="eyebrow">${eyebrow}</p></div>`;
const plate = (fig, caption, inner) => `<figure class="plate">${inner}<figcaption><b>${fig}</b><span>${caption}</span></figcaption></figure>`;

const feedHtml = (c) => `<div class="feed-h">${c.hero.feedTitle}</div><ul class="feed">${c.hero.feed.map(([a, p, v]) => `<li><b>${a}</b><em>${p}</em><s>${v}</s></li>`).join("")}</ul>`;

const graph = (lang) => `<svg class="graph" viewBox="0 0 260 230" role="img" aria-label="${lang === "ar" ? "مستند منشور يشير إلى مستخدمين" : "A post document referencing two user documents"}">
<path class="ed fl" d="M130 66 C 130 92 62 86 62 128"/><path class="ed fl" d="M130 66 C 130 92 198 86 198 128"/>
<rect class="nd hi" x="70" y="14" width="120" height="52" rx="3"/><text x="86" y="38">posts/p1</text><text class="sm" x="86" y="54">authorRef, editorRef</text>
<rect class="nd" x="6" y="128" width="112" height="52" rx="3"/><text x="20" y="152">users/u1</text><text class="sm" x="20" y="168">author</text>
<rect class="nd" x="142" y="128" width="112" height="52" rx="3"/><text x="156" y="152">users/u2</text><text class="sm" x="156" y="168">editor</text>
<text class="sm" x="132" y="206" text-anchor="middle" style="fill:var(--acc)">.include(["author"])</text>
</svg>`;

const arch = (c) => {
  const n = c.how.nodes;
  return `<div class="arch">
<div class="node"><h4>${n[0]}</h4><p>${n[1]}</p></div><div class="link"></div>
<div class="node"><h4>${n[2]}</h4><p>${n[3]}</p></div><div class="link"></div>
<div class="node pgbox"><span class="tag">${c.how.pg}</span><div class="pair"><div><h4>${n[4]}</h4><p>${n[5]}</p></div><div><h4>${n[6]}</h4><p>${n[7]}</p></div></div></div>
</div>`;
};

const lockIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

const faqHtml = (lang) => FAQ[lang].map(([q, a]) => `<details class="q"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");

const ctaBand = (c, lang) => `<div class="ctaband"><h2>${c.cta.h2}</h2><p>${c.cta.p}</p><div class="cta"><a class="btn pri lg" href="${lang === "ar" ? "/docs/ar/quickstart" : "/docs/quickstart"}">${c.cta.a}</a><a class="btn lg" href="/signup">${c.cta.b}</a></div></div>`;

/* ---------- pages ---------- */
function homeBody(lang) {
  const c = C[lang]; const h = c.hero; const b = c.bento; const p = lang === "ar" ? "/ar" : "";
  const docs = lang === "ar" ? "/docs/ar" : "/docs";
  const ledgerRows = [
    [b.q[0], b.q[1], "13 OPERATORS"],
    [b.r[0], b.r[1], ".include()"],
    [b.s[0], b.s[1], "RULES DSL"],
    [b.rt[0], b.rt[1], "LISTEN/NOTIFY"],
    [b.a[0], b.a[1], "OAUTH + MFA"],
    [b.i[0], b.i[1], "AUTO"],
  ];
  return `<section class="hero"><div class="wrap hero-grid">
<div><p class="kicker">${h.badge}</p>
<h1>${h.h1a}<br><em>${h.h1b}</em></h1>
<p class="lead">${h.lead}</p>
<div class="cta"><a class="btn pri lg" href="${docs}/quickstart">${h.cta1}</a><a class="btn lg" href="${docs}">${h.cta2}</a></div>
<div class="sub">${h.note}</div>
${installBox("npm install @vellumdb/sdk-js", c)}</div>
${win("tasks.ts", SNIP.hero, "ts")}
</div></section>
<div class="wrap"><div class="stats">${c.stats.map(([n, l, s]) => `<div class="stat"><strong>${n}</strong><span>${l}</span><small>${s}</small></div>`).join("")}</div></div>

<section class="s"><div class="wrap">${shead("01", c.how.eyebrow)}<h2>${c.how.h2}</h2><p class="sec-p">${c.how.p}</p>${arch(c)}</div></section>

<section class="s"><div class="wrap">${shead("02", b.eyebrow)}<h2>${b.h2}</h2>
<ol class="ledger">${ledgerRows.map(([t, d, tag], i) => `<li><span class="idx">${String(i + 1).padStart(2, "0")}</span><h3>${t}</h3><p>${d}</p><span class="tagx">${tag}</span></li>`).join("")}</ol>
<div class="plates">${plate("FIG. 02", b.q[0], win("query.ts", `const page = await db
  .collection("tasks")
  .where("status", "==", "open")
  .where("tags", "array-contains", "launch")
  .where("title", "contains_ci", "docs")
  .orderBy("priority", "desc")
  .limit(20)
  .get();`, "ts"))}
${plate("FIG. 03", b.s[0], win("rules", SNIP.rulesShort, "rules"))}</div></div></section>

<section class="s"><div class="wrap">${shead("03", c.walk.eyebrow)}<h2>${c.walk.h2}</h2>
<div class="walk">${plate("FIG. 04", c.walk.steps[0][0], win("query.ts", `const page = await db
  .collection("tasks")
  .where("status", "==", "open")
  .orderBy("priority", "desc")
  .limit(20)
  .get();`, "ts"))}
<div class="wrail">${c.walk.steps.map((_, i) => `<input type="radio" name="wk" id="wk${i + 1}"${i === 0 ? " checked" : ""}>`).join("")}
<ol class="wstack">${c.walk.steps.map((s, i) => `<li><label for="wk${i + 1}"><span class="wn">${String(i + 1).padStart(2, "0")}</span>${s[0]}<span class="wtag">${s[1]}</span></label></li>`).join("")}</ol>
<div class="wcaps">${c.walk.steps.map((s, i) => `<p class="wc c${i + 1}">${s[2]}</p>`).join("")}</div></div></div></div></section>

<section class="s"><div class="wrap">${shead("04", c.sdk.eyebrow)}<div class="sdk-grid"><div><h2>${c.sdk.h2}</h2><p class="sec-p">${c.sdk.p}</p>
${installBox(c.sdk.install[0], c)}${installBox(c.sdk.install[1], c)}<p style="margin-top:1.2rem"><a class="btn" href="${p}/sdks">${c.sdk.more}</a></p></div>
<div class="tabs"><input type="radio" name="t" id="tab1" checked><input type="radio" name="t" id="tab2"><div class="tabbar"><label for="tab1">${c.sdk.tabs[0]}</label><label for="tab2">${c.sdk.tabs[1]}</label></div>
<div class="panes"><div class="pane p1">${win("app.ts", SNIP.ts, "ts")}</div><div class="pane p2">${win("main.dart", SNIP.dart, "dart")}</div></div></div></div></div></section>

<section class="s"><div class="wrap">${shead("05", c.ai.eyebrow)}<div class="split"><div><h2>${c.ai.h2}</h2><p class="sec-p">${c.ai.p}</p><a class="btn" href="${docs}/ai-agents">${c.ai.cta}</a></div>
<div class="term">${win("terminal", SNIP.term, "bash")}</div></div></div></section>

<section class="s"><div class="wrap">${shead("06", c.aud.eyebrow)}<h2>${c.aud.h2}</h2>
<div class="aud"><div><h3>${c.aud.solo.h}</h3><ul>${c.aud.solo.points.map((x) => `<li>${x}</li>`).join("")}</ul></div>
<div><h3>${c.aud.team.h}</h3><ul>${c.aud.team.points.map((x) => `<li>${x}</li>`).join("")}</ul></div></div></div></section>

<section class="s"><div class="wrap"><h2>${c.faqTitle}</h2>${faqHtml(lang)}${ctaBand(c, lang)}</div></section>`;
}

function featuresBody(lang) {
  const c = C[lang]; const f = c.feat;
  const visual = (v) => v.startsWith("code:") ? win("query.ts", SNIP.ts.split("// Live")[0].split("// Query across any of 13 operators\n")[1].trim(), "ts") + `<div style="height:1rem"></div>` + win("include.ts", SNIP.include, "ts")
    : v === "graph" ? `<div class="cell">${graph(lang)}</div>`
    : v === "feed" ? `<div class="win" style="padding:1rem 1.1rem">${feedHtml(c)}</div><div style="height:1rem"></div>${win("realtime.ts", SNIP.realtime, "ts")}`
    : `<div class="chips">${f.chips.map((x, i) => `<span class="chip${i % 3 === 0 ? " on" : ""}">${x}</span>`).join("")}</div>`;
  const rows = f.rows.map(([h, p, v], i) => `<div class="feat"><div><p class="kicker"><span class="snum">${String(i + 1).padStart(2, "0")}</span></p><h2>${h}</h2><p>${p}</p></div><div>${visual(v)}</div></div>`).join("");
  return `<section class="phero"><div class="wrap"><h1 style="max-width:18ch">${f.h1}</h1><p class="lead">${f.lead}</p></div></section><div class="wrap">${rows}${ctaBand(c, lang)}</div>`;
}

function sdksBody(lang) {
  const c = C[lang]; const s = c.sdks; const docs = lang === "ar" ? "/docs/ar" : "/docs";
  const rows = s.rows.map(([h, p, cmd, l], i) => `<div class="feat"><div><p class="kicker"><span class="snum">${String(i + 1).padStart(2, "0")}</span></p><h2>${h}</h2><p>${p}</p>${installBox(cmd, c)}</div><div>${win(l === "ts" ? "app.ts" : "main.dart", SNIP[l], l)}</div></div>`).join("");
  return `<section class="phero"><div class="wrap"><h1 style="max-width:20ch">${s.h1}</h1><p class="lead">${s.lead}</p><div class="cta"><a class="btn pri lg" href="${docs}/quickstart">${s.cta}</a></div></div></section>
<div class="wrap">${rows}<div class="steps">${s.steps.map(([h, p]) => `<div class="step"><h3>${h}</h3><p>${p}</p></div>`).join("")}</div>${ctaBand(c, lang)}</div>`;
}

function securityBody(lang) {
  const c = C[lang]; const s = c.sec; const pl = s.planes;
  return `<section class="phero"><div class="wrap"><h1 style="max-width:20ch">${s.h1}</h1><p class="lead">${s.lead}</p>
<div class="planes"><div class="node"><h4>${pl[0]}</h4><p>${pl[1]}</p></div><div class="lock" title="${pl[4]}">${lockIcon}</div><div class="node pgbox"><span class="tag">${pl[4]}</span><h4>${pl[2]}</h4><p>${pl[3]}</p><p style="color:var(--acc)">${pl[5]}</p></div></div></div></section>
<div class="wrap" style="padding-top:2rem"><div class="cards">${s.cards.map(([h, p]) => `<div class="cell"><h3>${h}</h3><p>${p}</p></div>`).join("")}</div>
<div class="feat"><div><h2>${s.rulesTitle}</h2><p>${s.rulesP}</p></div><div>${win("rules", SNIP.rules, "rules")}</div></div>
<div class="cell" style="margin-top:1rem"><h3>${s.report[0]}</h3><p>${s.report[1]}</p><a class="btn" href="mailto:mohammedaydan12@gmail.com">${s.report[2]}</a></div>
${ctaBand(c, lang)}</div>`;
}

export function renderPage({ page, lang, origin, routeOf }) {
  const here = (l) => origin + (routeOf(page.slug, l) === "/" ? "/" : routeOf(page.slug, l));
  const canonical = here(lang);
  const alts = [["en", here("en")], ["ar", here("ar")], ["x-default", here("en")]];
  const otherHref = here(lang === "ar" ? "en" : "ar");
  const isHome = page.slug === "home";
  const body = { home: homeBody, features: featuresBody, sdks: sdksBody, security: securityBody }[page.slug](lang);

  const org = { "@type": "Organization", "@id": `${origin}/#org`, name: "Vellum", url: origin, logo: `${origin}/mark.png`, email: "mohammedaydan12@gmail.com", sameAs: ["https://github.com/MohammedAydan/vellum", "https://www.npmjs.com/package/@vellumdb/sdk-js", "https://pub.dev/packages/vellum_flutter"] };
  const ld = [];
  if (isHome) {
    ld.push({ "@context": "https://schema.org", "@graph": [
      org,
      { "@type": "WebSite", "@id": `${origin}/#site`, name: "Vellum", url: origin, inLanguage: ["en", "ar"], publisher: { "@id": `${origin}/#org` } },
      { "@type": "SoftwareApplication", name: "Vellum", applicationCategory: "DeveloperApplication", operatingSystem: "Web, Node.js, Flutter", softwareVersion: "0.0.10", description: page.desc.en, url: origin, license: "https://opensource.org/licenses/MIT", publisher: { "@id": `${origin}/#org` } },
    ] });
    ld.push({ "@context": "https://schema.org", "@type": "FAQPage", inLanguage: lang, mainEntity: FAQ[lang].map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
  } else {
    const homeUrl = lang === "ar" ? `${origin}/ar` : `${origin}/`;
    ld.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Vellum", item: homeUrl },
      { "@type": "ListItem", position: 2, name: page.title[lang].split("|")[0].trim(), item: canonical },
    ] });
    ld.push({ "@context": "https://schema.org", "@type": "WebPage", name: page.title[lang], description: page.desc[lang], url: canonical, inLanguage: lang, isPartOf: { "@id": `${origin}/#site` } });
  }
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
${head({ lang, title: page.title[lang], desc: page.desc[lang], canonical, alts, origin, ld })}
<body>
${chrome({ lang, otherHref, body })}
</body>
</html>
`;
}

export function renderNotFound({ origin }) {
  const body = `<div class="wrap nf"><h1><em>404</em></h1><p class="lead" style="margin-inline:auto">${T.en.notFound.body}</p><div class="cta" style="justify-content:center"><a class="btn pri lg" href="/">${T.en.notFound.home}</a><a class="btn lg" href="/docs">${T.en.notFound.docs}</a></div></div>`;
  return `<!doctype html>
<html lang="en" dir="ltr">
${head({ lang: "en", title: "Page not found | Vellum", desc: T.en.notFound.body, origin, noindex: true })}
<body>
${chrome({ lang: "en", otherHref: "/ar", body })}
</body>
</html>
`;
}
