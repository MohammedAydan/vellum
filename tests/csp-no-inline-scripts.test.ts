import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

/** Inline `<script>` blocks that would run code. JSON-LD and other data types are inert. */
function inlineExecutableScripts(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) continue;
    if (body.length > 0) found.push(body.slice(0, 60));
  }
  return found;
}

describe("page CSP: script-src 'self' needs zero inline scripts", () => {
  it.each(["dashboard", "admin", "docs"])("apps/%s/index.html has no inline script", (app) => {
    const html = fs.readFileSync(path.join(root, "apps", app, "index.html"), "utf8");
    expect(inlineExecutableScripts(html)).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("public site pages load their scripts from files", async () => {
    const tpl = await import(path.join(root, "scripts/site/template.mjs"));
    const routeOf = (slug: string, lang: string) => (slug === "home" ? (lang === "ar" ? "/ar" : "/") : `${lang === "ar" ? "/ar" : ""}/${slug}`);
    for (const slug of ["home", "features", "sdks", "security"]) {
      for (const lang of ["en", "ar"]) {
        const html: string = tpl.renderPage({
          page: { slug, title: { en: "t", ar: "t" }, desc: { en: "d", ar: "d" } },
          lang,
          origin: "https://example.test",
          routeOf,
        });
        expect(inlineExecutableScripts(html), `${slug}/${lang}`).toEqual([]);
        expect(html).toContain('src="/site-early.js"');
        expect(html).toContain('src="/site.js"');
      }
    }
    expect(inlineExecutableScripts(tpl.renderNotFound({ origin: "https://example.test" }))).toEqual([]);
  });

  it("the deployed CSP forbids inline and eval scripts and framing", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")) as {
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    const csp = cfg.headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(script.trim()).toBe("'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
  });
});
