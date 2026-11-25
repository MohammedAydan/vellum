import { T, FAQ } from "./content.mjs";

export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

export const CSS = `
:root{color-scheme:dark light;--bg:#0b1120;--fg:#e5e9f0;--mut:#9aa4b5;--line:#1e2738;--card:#101828;--acc:#10b981;--accfg:#04130d;--code:#0a0f1c}
@media(prefers-color-scheme:light){:root{--bg:#fafbfc;--fg:#111827;--mut:#5b6575;--line:#e3e7ee;--card:#fff;--acc:#059669;--accfg:#fff;--code:#f1f4f8}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic","Noto Sans",sans-serif}
a{color:inherit}a:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
.skip{position:absolute;inset-inline-start:.5rem;top:-3rem;background:var(--acc);color:var(--accfg);padding:.5rem .75rem;border-radius:6px;z-index:10}.skip:focus{top:.5rem}
.wrap{max-width:68rem;margin:0 auto;padding:0 1.25rem}
header.top{border-bottom:1px solid var(--line);position:sticky;top:0;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);z-index:5}
.bar{display:flex;align-items:center;gap:1rem;min-height:3.5rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:650;text-decoration:none;letter-spacing:.01em}.brand img{width:26px;height:26px}
nav.main{display:flex;gap:1.1rem;margin-inline-start:auto;align-items:center;flex-wrap:wrap;font-size:.92rem}
nav.main a{color:var(--mut);text-decoration:none}nav.main a:hover{color:var(--fg)}
.btn{display:inline-block;padding:.55rem .95rem;border-radius:8px;border:1px solid var(--line);text-decoration:none;font-weight:550;font-size:.92rem;color:var(--fg)}
.btn.pri{background:var(--acc);border-color:var(--acc);color:var(--accfg)}.btn:hover{filter:brightness(1.08)}
nav.main a.btn{color:var(--fg)}nav.main a.btn.pri{color:var(--accfg)}
.hero{padding:4.5rem 0 2.5rem}
.badge{display:inline-block;border:1px solid var(--line);color:var(--mut);padding:.15rem .6rem;border-radius:999px;font-size:.78rem;margin-bottom:1rem}
h1{font-size:clamp(1.9rem,4.6vw,3rem);line-height:1.15;margin:0 0 1rem;letter-spacing:-.02em;max-width:22ch}
[dir=rtl] h1{letter-spacing:0;line-height:1.35;max-width:26ch}
.lead{font-size:1.12rem;color:var(--mut);max-width:42rem;margin:0 0 1.5rem}
.cta{display:flex;gap:.7rem;flex-wrap:wrap;margin-bottom:1.5rem}
.install{display:grid;gap:.6rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));margin:1.5rem 0}
.install div{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem}
.install small{display:block;color:var(--mut);font-size:.78rem;margin-bottom:.15rem}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem;direction:ltr;unicode-bidi:isolate}
section.blk{padding:1.4rem 0;border-top:1px solid var(--line)}section.blk h2{font-size:1.2rem;margin:0 0 .4rem}section.blk p{margin:0;color:var(--mut);max-width:46rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));margin:1rem 0 2rem}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem;text-decoration:none}.card:hover{border-color:var(--acc)}
.card h3{margin:0 0 .3rem;font-size:1.02rem}.card p{margin:0;color:var(--mut);font-size:.93rem}
details{border-top:1px solid var(--line);padding:.9rem 0}details:last-of-type{border-bottom:1px solid var(--line)}summary{cursor:pointer;font-weight:600}details p{color:var(--mut);margin:.5rem 0 0;max-width:46rem}
h2.t{font-size:1.4rem;margin:2rem 0 .5rem}
footer{border-top:1px solid var(--line);margin-top:3rem;padding:2rem 0;color:var(--mut);font-size:.9rem}
.fcols{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));margin-bottom:1.5rem}.fcols h4{margin:0 0 .5rem;color:var(--fg);font-size:.85rem}.fcols a{display:block;color:var(--mut);text-decoration:none;padding:.15rem 0}.fcols a:hover{color:var(--fg)}
.nf{padding:6rem 0;text-align:center}.nf h1{margin-inline:auto}
@media(max-width:640px){.hero{padding:3rem 0 1.5rem}nav.main{margin-inline-start:0;width:100%}}
@media(prefers-reduced-motion:no-preference){.card{transition:border-color .15s}}
`;

function head({ lang, title, desc, canonical, alts, origin, ld, noindex }) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="theme-color" content="#0b1120">
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
<link rel="stylesheet" href="/site.css">
${(ld || []).map((o) => `<script type="application/ld+json">${json(o)}</script>`).join("\n")}
</head>`;
}

function chrome({ lang, otherHref, body, origin }) {
  const t = T[lang];
  const p = lang === "ar" ? "/ar" : "";
  const docs = lang === "ar" ? "/docs/ar" : "/docs";
  return `<a class="skip" href="#main">${t.skip}</a>
<header class="top"><div class="wrap bar">
<a class="brand" href="${p || "/"}"><img src="/mark.png" alt="" width="26" height="26"><span>Vellum</span></a>
<nav class="main" aria-label="Main">
<a href="${p}/features">${t.nav.features}</a><a href="${p}/sdks">${t.nav.sdks}</a><a href="${p}/security">${t.nav.security}</a><a href="${docs}">${t.nav.docs}</a>
<a href="${otherHref}" hreflang="${lang === "ar" ? "en" : "ar"}" lang="${lang === "ar" ? "en" : "ar"}">${t.footer.lang}</a>
<a class="btn" href="/login">${t.nav.signin}</a><a class="btn pri" href="/signup">${t.nav.start}</a>
</nav></div></header>
<main id="main">${body}</main>
<footer><div class="wrap">
<div class="fcols">
<div><h4>${t.footer.product}</h4><a href="${p}/features">${t.nav.features}</a><a href="${p}/sdks">${t.nav.sdks}</a><a href="${p}/security">${t.nav.security}</a></div>
<div><h4>${t.footer.resources}</h4><a href="${docs}">${t.nav.docs}</a><a href="/llms.txt">${t.footer.llms}</a><a href="/docs/openapi.json">${t.footer.openapi}</a><a href="https://github.com/MohammedAydan/vellum" rel="noopener">${t.footer.github}</a></div>
<div><h4>${t.footer.legal}</h4><a href="/privacy">${t.footer.privacy}</a><a href="/terms">${t.footer.terms}</a><a href="mailto:mohammedaydan12@gmail.com">${t.footer.contact}</a></div>
</div>
<p>${t.footer.beta}</p>
<p>&copy; ${new Date().getFullYear()} Vellum</p>
</div></footer>`;
}


export function renderPage({ page, lang, origin, routeOf }) {
  const t = T[lang];
  const b = page.body[lang];
  const here = (l) => origin + (routeOf(page.slug, l) === "/" ? "/" : routeOf(page.slug, l));
  const canonical = here(lang);
  const alts = [["en", here("en")], ["ar", here("ar")], ["x-default", here("en")]];
  const otherHref = here(lang === "ar" ? "en" : "ar");
  const isHome = page.slug === "home";
  const ctas = (b.cta || []).map(([label, href], i) => `<a class="btn${i === 0 ? " pri" : ""}" href="${href}">${escapeHtml(label)}</a>`).join("");
  const install = b.install ? `<div class="install">${b.install.map(([k, v]) => `<div><small>${escapeHtml(k)}</small><code>${escapeHtml(v)}</code></div>`).join("")}</div>` : "";
  const sections = (b.sections || []).map(([h, p]) => `<section class="blk"><h2>${escapeHtml(h)}</h2><p>${escapeHtml(p)}</p></section>`).join("");
  const cards = b.cards ? `<div class="grid">${b.cards.map(([h, p, href]) => `<a class="card" href="${href}"><h3>${escapeHtml(h)}</h3><p>${escapeHtml(p)}</p></a>`).join("")}</div>` : "";
  const faq = isHome ? `<h2 class="t">${escapeHtml(b.faqTitle)}</h2>${FAQ[lang].map(([q, a]) => `<details><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a)}</p></details>`).join("")}` : "";
  const body = `<div class="wrap"><div class="hero">${isHome ? `<span class="badge">${lang === "ar" ? "نسخة تجريبية عامة 0.0.3" : "Public beta 0.0.3"}</span>` : ""}<h1>${escapeHtml(b.h1)}</h1><p class="lead">${escapeHtml(b.lead)}</p>${ctas ? `<div class="cta">${ctas}</div>` : ""}${install}</div>${isHome ? cards : ""}${sections}${faq}</div>`;

  const org = { "@type": "Organization", "@id": `${origin}/#org`, name: "Vellum", url: origin, logo: `${origin}/mark.png`, email: "mohammedaydan12@gmail.com", sameAs: ["https://github.com/MohammedAydan/vellum", "https://www.npmjs.com/package/@vellumdb/sdk-js", "https://pub.dev/packages/vellum_flutter"] };
  const ld = [];
  if (isHome) {
    ld.push({ "@context": "https://schema.org", "@graph": [
      org,
      { "@type": "WebSite", "@id": `${origin}/#site`, name: "Vellum", url: origin, inLanguage: ["en", "ar"], publisher: { "@id": `${origin}/#org` } },
      { "@type": "SoftwareApplication", name: "Vellum", applicationCategory: "DeveloperApplication", operatingSystem: "Web, Node.js, Flutter", softwareVersion: "0.0.3", description: page.desc.en, url: origin, license: "https://opensource.org/licenses/MIT", publisher: { "@id": `${origin}/#org` } },
    ] });
    ld.push({ "@context": "https://schema.org", "@type": "FAQPage", inLanguage: lang, mainEntity: FAQ[lang].map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
  } else {
    ld.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Vellum", item: here(lang).replace(/\/(ar\/)?[^/]*$/, lang === "ar" ? "/ar" : "/") || origin },
      { "@type": "ListItem", position: 2, name: b.h1, item: canonical },
    ] });
    ld.push({ "@context": "https://schema.org", "@type": "WebPage", name: page.title[lang], description: page.desc[lang], url: canonical, inLanguage: lang, isPartOf: { "@id": `${origin}/#site` } });
  }
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
${head({ lang, title: page.title[lang], desc: page.desc[lang], canonical, alts, origin, ld })}
<body>
${chrome({ lang, otherHref, body, origin })}
</body>
</html>
`;
}

export function renderNotFound({ origin }) {
  const body = `<div class="wrap nf"><h1>404</h1><p class="lead" style="margin-inline:auto">${T.en.notFound.body}</p><div class="cta" style="justify-content:center"><a class="btn pri" href="/">${T.en.notFound.home}</a><a class="btn" href="/docs">${T.en.notFound.docs}</a></div></div>`;
  return `<!doctype html>
<html lang="en" dir="ltr">
${head({ lang: "en", title: "Page not found | Vellum", desc: T.en.notFound.body, origin, noindex: true })}
<body>
${chrome({ lang: "en", otherHref: "/ar", body, origin })}
</body>
</html>
`;
}
