import * as React from "react";
import { cn } from "../../lib/cn.js";
import { CopyButton } from "../../primitives/copy-button.js";

/** A single language/example tab inside a {@link CodeBlock}. */
export interface CodeBlockTab {
  id: string;
  label: string;
  code: string;
  language?: string;
}

export interface CodeBlockProps {
  code?: string;
  language?: string;
  filename?: string;
  tabs?: CodeBlockTab[];
  showLineNumbers?: boolean;
  className?: string;
  title?: string;
}

/**
 * Keywords shared by the developer/docs languages (TypeScript, Dart/Flutter,
 * cURL and the security-rules DSL). Tokens wrapped with `hl-keyword` /
 * `hl-string` are intentional compatibility hooks for the generated docs CSS.
 */
const KEYWORDS = new Set<string>([
  // JavaScript / TypeScript
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "new", "class", "extends", "import", "from", "export", "default", "async",
  "await", "try", "catch", "finally", "throw", "this", "void", "typeof",
  "instanceof", "delete", "super", "switch", "case", "break", "continue",
  "do", "yield", "type", "interface", "enum", "as", "in", "of", "keyof",
  "readOnly", "public", "private", "protected", "static", "get", "set",
  "true", "false", "null", "undefined",
  // Dart / Flutter
  "final", "late", "dynamic", "Future", "Stream", "String", "int", "double",
  "bool", "List", "Map", "Set", "package", "library", "abstract", "mixin",
  "factory", "print", "required", "sealed", "when",
  // Security-rules DSL
  "match", "allow", "deny", "request", "resource", "read", "write", "create",
  "update", "list", "auth", "isOwner", "isAuthenticated", "and", "or", "not",
  // cURL / shell
  "curl", "echo", "export", "source", "sudo", "bash", "sh",
]);

function tokenClass(token: string): string | undefined {
  if (/^["'`]/.test(token)) return "hl-string";
  if (token.startsWith("//")) return "hl-comment";
  if (/^\d/.test(token)) return "hl-number";
  if (KEYWORDS.has(token)) return "hl-keyword";
  return undefined;
}

/**
 * Lightweight, deterministic tokenizer. It never executes code and only wraps
 * recognised tokens in spans so the docs syntax-highlighting CSS keeps working
 * after the docs app migrates to this shared pattern.
 */
function highlightLine(line: string, lineIndex: number): React.ReactNode {
  if (line.length === 0) return "\u00a0";

  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\/\/[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) {
      nodes.push(line.slice(cursor, match.index));
    }
    const token = match[0];
    const className = tokenClass(token);
    nodes.push(
      className
        ? <span key={`${lineIndex}-${match.index}`} className={className}>{token}</span>
        : token
    );
    cursor = match.index + token.length;
  }

  if (cursor < line.length) {
    nodes.push(line.slice(cursor));
  }
  return nodes;
}

/**
 * Canonical developer code block. Renders a monospace (JetBrains Mono) surface
 * with optional filename/language header, multi-language tabs, line numbers and
 * a one-click copy control.
 *
 * QA hooks kept intentionally stable: `code-block`, `code-head`, `code-tab`,
 * `code-copy`, `code-pre`, `hl-keyword`, `hl-string`, plus
 * `button[title="Copy to clipboard"]` (emitted by the shared `CopyButton`).
 */
export function CodeBlock({
  code,
  language,
  filename,
  tabs,
  showLineNumbers = false,
  className,
  title,
}: CodeBlockProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = React.useState(0);

  const hasTabs = tabs !== undefined && tabs.length > 0;
  const clampedIndex = hasTabs ? Math.min(activeIndex, (tabs?.length ?? 1) - 1) : 0;
  const activeTab = hasTabs ? tabs?.[clampedIndex] : undefined;
  const shownCode = activeTab?.code ?? code ?? "";
  const shownLanguage = activeTab?.language ?? language;

  const lines = React.useMemo(() => shownCode.split("\n"), [shownCode]);
  const headerLabel = title ?? filename ?? shownLanguage;

  return (
    <div
      className={cn(
        "code-block overflow-hidden rounded-lg border border-border bg-muted/20",
        hasTabs && "code-tabs",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5",
          hasTabs && "code-tabs-head"
        )}
      >
        {hasTabs ? (
          <div
            className="code-tab-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            role="tablist"
            aria-label="Code language"
            data-example-tabs=""
          >
            {tabs?.map((tab, index) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={index === clampedIndex}
                className={cn(
                  "code-tab et-tab shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  index === clampedIndex && "is-active bg-muted text-foreground"
                )}
                data-example-tab={tab.language ?? tab.id}
                onClick={() => setActiveIndex(index)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="code-lang truncate font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {headerLabel ?? "code"}
          </span>
        )}
        <CopyButton
          value={shownCode}
          size="icon-sm"
          variant="ghost"
          aria-label="Copy code"
          className="code-copy ms-auto shrink-0 text-muted-foreground"
        />
      </div>

      <pre className="code-pre overflow-x-auto px-4 py-3 text-xs leading-relaxed" dir="ltr" tabIndex={0} aria-label="Code example">
        <code className="font-mono [font-family:'JetBrains_Mono',ui-monospace,monospace]">
          {lines.map((line, index) => (
            <span key={index} className="flex">
              {showLineNumbers ? (
                <span
                  aria-hidden="true"
                  className="inline-block w-8 shrink-0 select-none pe-3 text-end text-muted-foreground/60"
                >
                  {index + 1}
                </span>
              ) : null}
              <span className="whitespace-pre">{highlightLine(line, index)}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
CodeBlock.displayName = "CodeBlock";
