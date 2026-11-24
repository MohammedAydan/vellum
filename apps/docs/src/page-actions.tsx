import { Check, ChevronDown, Copy, ExternalLink, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "./nav";

/** Absolute URL of a page's Markdown twin, e.g. /docs/query.md or /docs/ar/query.md. */
export function markdownUrl(slug: string, lang: Lang, origin = window.location.origin): string {
  const base = (import.meta.env.BASE_URL || "/docs/") === "/" ? "/docs/" : (import.meta.env.BASE_URL as string).replace(/\/*$/, "/");
  return `${origin}${base}${lang === "ar" ? "ar/" : ""}${slug}.md`;
}

const L = {
  en: { menu: "Copy page", copy: "Copy as Markdown", copied: "Copied", view: "View as Markdown", chatgpt: "Open in ChatGPT", claude: "Open in Claude", ask: "Read this page and help me with it:" },
  ar: { menu: "نسخ الصفحة", copy: "نسخ بصيغة Markdown", copied: "تم النسخ", view: "عرض بصيغة Markdown", chatgpt: "فتح في ChatGPT", claude: "فتح في Claude", ask: "اقرأ هذه الصفحة وساعدني بها:" },
} as const;

export function PageActions({ slug, lang, getFallbackText }: { slug: string; lang: Lang; getFallbackText: () => string }) {
  const t = L[lang];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const md = markdownUrl(slug, lang);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const copy = async () => {
    let text = "";
    try {
      const res = await fetch(md, { headers: { accept: "text/markdown, text/plain" } });
      const body = await res.text();
      if (res.ok && !/^\s*<!doctype html|^\s*<html/i.test(body)) text = body;
    } catch { /* fall back below */ }
    if (!text) text = getFallbackText();
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
    setOpen(false);
  };

  const prompt = `${t.ask} ${md}`;
  const links = [
    { label: t.view, href: md },
    { label: t.chatgpt, href: `https://chatgpt.com/?q=${encodeURIComponent(prompt)}` },
    { label: t.claude, href: `https://claude.ai/new?q=${encodeURIComponent(prompt)}` },
  ];

  return (
    <div className="page-actions" ref={ref}>
      <button type="button" className="page-actions-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t.copied : t.menu}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="page-actions-menu" role="menu">
          <button type="button" role="menuitem" onClick={copy}><FileText size={14} />{t.copy}</button>
          {links.map((l) => (
            <a key={l.href} role="menuitem" href={l.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              <ExternalLink size={14} />{l.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
