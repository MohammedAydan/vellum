import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Github,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DocsShell,
  DocsSidebar,
  DocsToc,
  useCommandPaletteShortcut,
  useVellumTheme,
  cn,
  VellumLogo,
} from "@vellum/ui";
import { ALL_PAGES, NAV_GROUPS, neighbors, pageHref, type Lang, type Localized } from "./nav";
import { getPage } from "./registry";

interface Route { lang: Lang; slug: string }

function parseRoute(): Route {
  const base = import.meta.env.BASE_URL || "/docs/";
  let path = window.location.pathname;
  if (path === base.replace(/\/$/, "")) path = base;
  let rest = path.startsWith(base) ? path.slice(base.length) : "";
  let lang: Lang = "en";
  if (rest === "ar" || rest.startsWith("ar/")) {
    lang = "ar";
    rest = rest.slice(3);
  }
  const slug = rest.replace(/^\/+|\/+$/g, "") || "index";
  return { lang, slug };
}

function useRoute(): [Route, (href: string) => void] {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((href: string) => {
    window.history.pushState({}, "", href);
    setRoute(parseRoute());
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);
  return [route, navigate];
}

interface TocItem { id: string; label: string; level: number }

function SearchPalette({ lang, open, onClose, navigate }: { lang: Lang; open: boolean; onClose: () => void; navigate: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      openerRef.current = document.activeElement as HTMLElement;
      const shell = document.querySelector<HTMLElement>(".docs-app > div");
      if (shell) shell.inert = true;
      return () => { if (shell) shell.inert = false; };
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = q
      ? ALL_PAGES.filter((p) =>
          p.title[lang].toLowerCase().includes(q) ||
          p.desc[lang].toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          (p.keywords ?? []).some((k) => k.toLowerCase().includes(q)))
      : ALL_PAGES;
    return pages.slice(0, 10);
  }, [query, lang]);

  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="search-dialog" aria-describedby={undefined}
        style={{ width: "min(620px, calc(100vw - 32px))", maxWidth: "none", padding: 0, gap: 0 }}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); openerRef.current?.focus(); }}>
        <DialogTitle className="sr-only">{lang === "ar" ? "البحث في التوثيق" : "Search documentation"}</DialogTitle>
        <div className="search-input-row">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && results[0]) {
                navigate(pageHref(results[0].slug, lang));
                onClose();
              }
            }}
            placeholder={lang === "ar" ? "ابحث في الأدلة والمرجع…" : "Search guides, APIs and references…"}
          />
          <button type="button" className="search-esc" onClick={onClose}>ESC</button>
        </div>
        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-empty">{lang === "ar" ? "لا نتائج" : "No results"} · {query}</div>
          ) : results.map((p) => (
            <button
              type="button"
              key={p.slug}
              className="search-result"
              onClick={() => { navigate(pageHref(p.slug, lang)); onClose(); }}
            >
              <span className="search-result-icon"><BookOpen size={15} /></span>
              <span className="search-result-text">
                <span className="search-result-title">{p.title[lang]}</span>
                <span className="search-result-desc">{p.desc[lang]}</span>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        <div className="search-foot">
          <span><kbd>↵</kbd> {lang === "ar" ? "للفتح" : "to open"}</span>
          <span><kbd>esc</kbd> {lang === "ar" ? "للإغلاق" : "to close"}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const [route, navigate] = useRoute();
  // Cmd/Ctrl+K is owned by the shared command-palette shortcut hook; Escape
  // closes the docs-owned dialog that keeps the QA search contract intact.
  const { open: searchOpen, setOpen: setSearchOpen } = useCommandPaletteShortcut();
  const [toc, setToc] = useState<TocItem[]>([]);
  const articleRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme, setTheme } = useVellumTheme();
  const { lang, slug } = route;
  const PageComponent = getPage(lang, slug) ?? getPage("en", slug);
  const meta = ALL_PAGES.find((p) => p.slug === slug) ?? {
    slug,
    title: { en: "Page not found", ar: "الصفحة غير موجودة" } as Localized,
    desc: { en: "", ar: "" } as Localized,
    keywords: [] as string[],
  };
  const { prev, next } = neighbors(slug);
  const isArabic = lang === "ar";

  useEffect(() => {
    document.documentElement.lang = isArabic ? "ar" : "en";
    document.documentElement.dir = isArabic ? "rtl" : "ltr";
    document.title = `${meta.title[lang]} · VELLUM Docs`;
  }, [isArabic, lang, meta.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  // Nav scroll affordance: toggle a shadow class when the sidebar can scroll up.
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>(".sidebar-scroll");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("is-scrolled", nav.scrollTop > 4);
    onScroll();
    nav.addEventListener("scroll", onScroll, { passive: true });
    return () => nav.removeEventListener("scroll", onScroll);
  }, [slug, lang]);

  useEffect(() => {
    setToc([]);
    const rebuild = () => {
      const heads = articleRef.current?.querySelectorAll<HTMLElement>(".doc-h2, .doc-h3") ?? [];
      const items = Array.from(heads).filter((h) => Boolean(h.id)).map((h) => ({
        id: h.id,
        label: h.textContent?.replace(/^#/, "").trim() ?? "",
        level: h.classList.contains("doc-h3") ? 3 : 2,
      }));
      setToc((current) => (
        current.length === items.length && current.every((v, i) => v.id === items[i]?.id)
          ? current
          : items
      ));
    };
    // Lazy page chunks can resolve after navigation; observing the article
    // keeps the rail in sync whenever headings appear or change.
    const observer = new MutationObserver(rebuild);
    if (articleRef.current) observer.observe(articleRef.current, { childList: true, subtree: true });
    rebuild();
    return () => observer.disconnect();
  }, [slug, lang]);

  const go = (href: string) => (e: MouseEvent) => {
    e.preventDefault();
    navigate(href);
  };

  const otherLangHref = pageHref(slug, isArabic ? "en" : "ar");

  const topbarStart = (
    <div className="docs-topbar-start">
      <a className="brand" href={pageHref("index", lang)} onClick={go(pageHref("index", lang))}>
        <VellumLogo size={28} />
        <span className="brand-name">VELLUM <span className="brand-sub">{isArabic ? "/ التوثيق" : "/ Docs"}</span></span>
      </a>
      <span className="version-pill">v0.0.1</span>
      <span
        className="beta-pill"
        title={isArabic ? "VELLUM في مرحلة تجريبية عامة. قد تتغير الواجهات والميزات قبل الإصدار 1.0." : "VELLUM is in public beta. APIs and features may change before 1.0."}
      >
        BETA
      </span>
      <button aria-label={isArabic ? "البحث في التوثيق" : "Search documentation"} className="search-trigger" type="button" onClick={() => setSearchOpen(true)}>
        <Search size={15} />
        <span>{isArabic ? "ابحث في التوثيق" : "Search documentation"}</span>
        <kbd>⌘K</kbd>
      </button>
    </div>
  );

  const topbarEnd = (
    <div className="docs-topbar-end">
      <a className="top-link" href={otherLangHref} onClick={go(otherLangHref)} title={isArabic ? "English" : "العربية"}>
        {isArabic ? "EN" : "ع"}
      </a>
      <a className="icon-button" href="https://github.com/MohammedAydan/vellum" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
        <Github size={17} />
      </a>
      <Button
        id="themeToggle"
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Toggle theme"
        className={cn("icon-button")}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        {resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
      </Button>
    </div>
  );

  const sidebar = (
    <>
      <div className="sidebar-scroll">
        <DocsSidebar
          activeId={slug}
          groups={NAV_GROUPS.map((group, index) => ({
            id: group.title.en || `group-${index}`,
            label: group.title[lang],
            items: group.items.map((item) => ({
              id: item.slug,
              label: item.title[lang],
              href: pageHref(item.slug, lang),
              active: item.slug === slug,
            })),
          }))}
        />
      </div>
      <div className="sidebar-foot">
        <span className="live-dot" />
        {isArabic ? "أمثلة قابلة للتشغيل" : "Runnable manifest examples"}
      </div>
    </>
  );

  const tocRail = (
    <>
      <div className="toc-title toc-title-local">{isArabic ? "في هذه الصفحة" : "On this page"}</div>
      <DocsToc items={toc.map((item) => ({ id: item.id, label: item.label, level: item.level as 2 | 3 }))} />

    </>
  );

  return (
    <div className="docs-app">
      <DocsShell
        navigationLabel={isArabic ? "قائمة التوثيق" : "Documentation navigation"}
        topbarStart={topbarStart}
        topbarEnd={topbarEnd}
        sidebar={sidebar}
        toc={tocRail}
      >
        <div className="docs-content" ref={articleRef}>
          <div className="breadcrumb">
            <span>{isArabic ? "التوثيق" : "Docs"}</span>
            <ChevronRight size={13} />
            <span>{NAV_GROUPS.find((g) => g.items.some((i) => i.slug === slug))?.title[lang] ?? "—"}</span>
            <ChevronRight size={13} />
            <strong>{meta.title[lang]}</strong>
          </div>
          {PageComponent ? (
            <Suspense fallback={<div className="page-loading">{isArabic ? "جارٍ التحميل…" : "Loading…"}</div>}>
              <PageComponent key={`${lang}:${slug}`} />
            </Suspense>
          ) : (
            <div className="page-loading">
              <p>{isArabic ? "هذه الصفحة غير موجودة." : "This documentation page does not exist."}</p>
              <p>
                <a href={pageHref("index", lang)} onClick={go(pageHref("index", lang))}>
                  {isArabic ? "العودة إلى مقدمة التوثيق" : "Back to the documentation home"}
                </a>
              </p>
            </div>
          )}
          <div className="page-nav">
            {prev ? (
              <a className="page-nav-card" href={pageHref(prev.slug, lang)} onClick={go(pageHref(prev.slug, lang))}>
                <span className="page-nav-label"><ArrowLeft size={13} /> {isArabic ? "السابق" : "Previous"}</span>
                <span className="page-nav-title">{prev.title[lang]}</span>
              </a>
            ) : <span />}
            {next ? (
              <a className="page-nav-card page-nav-next" href={pageHref(next.slug, lang)} onClick={go(pageHref(next.slug, lang))}>
                <span className="page-nav-label">{isArabic ? "التالي" : "Next"} <ArrowRight size={13} /></span>
                <span className="page-nav-title">{next.title[lang]}</span>
              </a>
            ) : <span />}
          </div>
          <footer className="docs-footer">
            <span>VELLUM · {isArabic ? "قاعدة مستندات أصلية على PostgreSQL" : "PostgreSQL-native document database"}</span>
            <span className="footer-check"><Check size={13} /> {isArabic ? "توثيق النسخة التجريبية" : "Beta developer docs"}</span>
          </footer>
        </div>
      </DocsShell>

      <SearchPalette lang={lang} open={searchOpen} onClose={() => setSearchOpen(false)} navigate={navigate} />
    </div>
  );
}
