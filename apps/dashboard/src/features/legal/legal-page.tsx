import { Link } from "@tanstack/react-router";
import { useI18n } from "@vellum/ui";
import { ALPHA_NOTICE, LEGAL, type LegalKind } from "./legal-content.js";

type Lang = "en" | "ar";

export function AlphaNotice() {
  const { locale } = useI18n();
  const copy = ALPHA_NOTICE[locale as Lang] ?? ALPHA_NOTICE.en;
  return (
    <div
      role="note"
      data-testid="alpha-notice"
      className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      <p className="mb-0.5 font-medium text-foreground">{copy.title}</p>
      <p>{copy.body}</p>
    </div>
  );
}

export function LegalLinks() {
  const { locale } = useI18n();
  const ar = locale === "ar";
  return (
    <nav aria-label={ar ? "الروابط القانونية" : "Legal"} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Link to="/privacy" className="underline underline-offset-2">{ar ? "سياسة الخصوصية" : "Privacy Policy"}</Link>
      <span aria-hidden="true">·</span>
      <Link to="/terms" className="underline underline-offset-2">{ar ? "شروط الاستخدام" : "Terms of Service"}</Link>
      <span aria-hidden="true">·</span>
      <Link to="/terms" hash="alpha" className="underline underline-offset-2">{ar ? "إخلاء المسؤولية" : "Disclaimer"}</Link>
    </nav>
  );
}

export function LegalPage({ kind }: { kind: LegalKind }) {
  const { locale } = useI18n();
  const doc = (LEGAL[locale as Lang] ?? LEGAL.en)[kind];
  const ar = locale === "ar";
  return (
    <main className="legal-page mx-auto w-full max-w-2xl px-5 py-10" data-testid={`legal-${kind}`}>
      <Link to="/login" className="text-xs text-muted-foreground hover:underline">{ar ? "العودة" : "Back"}</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{doc.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{doc.updated}</p>
      <div className="mt-5" id="alpha"><AlphaNotice /></div>
      {doc.sections.map((section) => (
        <section key={section.heading} className="mt-7">
          <h2 className="text-base font-semibold">{section.heading}</h2>
          <ul className="mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-muted-foreground">
            {section.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
      <div className="mt-10 border-t border-border pt-4"><LegalLinks /></div>
    </main>
  );
}
