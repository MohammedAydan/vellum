/**
 * Shared documentation primitives.
 *
 * Every page is a React component built from these blocks. The blocks keep the
 * visual language consistent across all guides and references, and the layout
 * shell derives its "On this page" rail from the ids emitted by Section/H3.
 *
 * Implementation note: the blocks are composed on top of `@vellum/ui` patterns
 * (CodeBlock, DocsCallout, HttpMethodBadge, Table/Card families) but keep the
 * historical class names and rendered text byte-for-byte, because all 60
 * bilingual page files and the QA selectors depend on them.
 */
import { cloneElement, type ReactNode } from "react";
import {
  cn,
  CodeBlock,
  DocsCallout,
  HttpMethodBadge,
  Table as UiTable,
  TableBody as UiTableBody,
  TableCell as UiTableCell,
  TableHead as UiTableHead,
  TableHeader as UiTableHeader,
  TableRow as UiTableRow,
} from "@vellum/ui";
import { pageHref, type Lang } from "./nav";

/** Internal link to another documentation page by slug (language-aware). */
export function PageLink({ slug, lang = "en", children }: { slug: string; lang?: Lang; children: ReactNode }) {
  return <a className="doc-link" href={pageHref(slug, lang)}>{children}</a>;
}

export type Tone = "info" | "success" | "warning" | "danger";

export interface DocProps {
  title: string;
  description: string;
  eyebrow?: string;
  children?: ReactNode;
}

export function Doc({ title, description, eyebrow, children }: DocProps) {
  return (
    <article className="doc-article">
      <header className="doc-header">
        {eyebrow ? <div className="doc-eyebrow">{eyebrow}</div> : null}
        <h1 className="doc-h1">{title}</h1>
        <p className="doc-lead">{description}</p>
      </header>
      {children}
      <div className="doc-end" />
    </article>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <section className="doc-section">
      <h2 className="doc-h2" id={id}>
        <a className="doc-anchor" href={`#${id}`} aria-label={`Link to ${title}`}>#</a>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function H3({ id, children }: { id?: string; children?: ReactNode }) {
  return <h3 className="doc-h3" id={id}>{children}</h3>;
}

export function P({ children }: { children?: ReactNode }) {
  return <p className="doc-p">{children}</p>;
}

export function UL({ items }: { items: ReactNode[] }) {
  return <ul className="doc-list">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
}

export function OL({ items }: { items: ReactNode[] }) {
  return <ol className="doc-list doc-list-ol">{items.map((item, i) => <li key={i}>{item}</li>)}</ol>;
}

export function Steps({ items }: { items: { title: string; body?: ReactNode }[] }) {
  return (
    <ol className="doc-steps">
      {items.map((step, i) => (
        <li key={i} className="doc-step">
          <div className="doc-step-num">{i + 1}</div>
          <div className="doc-step-body">
            <div className="doc-step-title">{step.title}</div>
            {step.body ? <div className="doc-step-text">{step.body}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface CodeProps {
  code: string;
  lang?: string;
  title?: string;
}

/** Single-language code surface backed by the shared CodeBlock pattern. */
export function Code({ code, lang, title }: CodeProps) {
  return <CodeBlock code={code} language={lang} title={title ?? lang} />;
}

export interface CodeTab extends CodeProps {
  label: string;
}

/** Multi-language example tabs backed by the shared CodeBlock pattern. */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  if (tabs.length === 0) return null;
  return (
    <CodeBlock
      tabs={tabs.map((tab, index) => ({
        id: `${index}`,
        label: tab.label,
        code: tab.code,
        language: tab.lang,
      }))}
    />
  );
}

const CALLOUT_LABELS: Record<Tone, string> = {
  info: "Note",
  success: "Good to know",
  warning: "Caution",
  danger: "Important",
};

/**
 * Callout built on the shared DocsCallout pattern. `callout-${tone}` is
 * re-applied so the long-standing page CSS selectors keep resolving exactly.
 */
export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  const sharedTone = tone === "success" ? "tip" : tone;
  const element = DocsCallout({
    tone: sharedTone,
    title: title ?? CALLOUT_LABELS[tone],
    children,
  });
  return cloneElement(element, {
    className: cn(element.props.className, `callout-${tone}`),
  });
}

/** Table built on the shared Table primitives with legacy class hooks kept. */
export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap" tabIndex={0}>
      <UiTable className="doc-table">
        <UiTableHeader>
          <UiTableRow>
            {head.map((h, i) => <UiTableHead key={i}>{h}</UiTableHead>)}
          </UiTableRow>
        </UiTableHeader>
        <UiTableBody>
          {rows.map((row, i) => (
            <UiTableRow key={i}>
              {row.map((cell, j) => <UiTableCell key={j}>{cell}</UiTableCell>)}
            </UiTableRow>
          ))}
        </UiTableBody>
      </UiTable>
    </div>
  );
}

export function Cards({ items }: { items: { title: string; body?: ReactNode; href?: string; icon?: string }[] }) {
  return (
    <div className="doc-cards">
      {items.map((item, i) => {
        const inner = (
          <>
            <div className="doc-card-title">{item.icon ? <span className="doc-card-icon">{item.icon}</span> : null}{item.title}</div>
            {item.body ? <div className="doc-card-body">{item.body}</div> : null}
            {item.href ? <span className="doc-card-arrow">→</span> : null}
          </>
        );
        return item.href
          ? <a className="doc-card doc-card-link" href={item.href} key={i}>{inner}</a>
          : <div className="doc-card" key={i}>{inner}</div>;
      })}
    </div>
  );
}

const SHARED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
type SharedMethod = Parameters<typeof HttpMethodBadge>[0]["method"];

function isSharedMethod(method: string): method is SharedMethod {
  return SHARED_METHODS.has(method);
}

/** API signature block; the method chip comes from the shared pattern. */
export function Api({ method, path, children }: { method: string; path: string; children?: ReactNode }) {
  const upper = method.toUpperCase();
  const badge = isSharedMethod(upper)
    ? <HttpMethodBadge method={upper} />
    : <span className="api-method">{upper}</span>;
  return (
    <div className="api-block">
      <div className="api-signature">
        {badge}
        <code className="api-path">{path}</code>
      </div>
      {children ? <div className="api-body">{children}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return <span className={cn("doc-badge", `badge-${tone}`)}>{children}</span>;
}

export function Definitions({ items }: { items: { term: ReactNode; def: ReactNode }[] }) {
  return (
    <dl className="doc-defs">
      {items.map((item, i) => (
        <div className="doc-def" key={i}>
          <dt>{item.term}</dt>
          <dd>{item.def}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Divider() {
  return <hr className="doc-divider" />;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:\/\//.test(href);
  return (
    <a className="doc-link" href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}{external ? <span aria-hidden="true"> ↗</span> : null}
    </a>
  );
}
