import * as React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { cn } from "../lib/cn.js";
import { useTheme } from "../hooks/use-theme.js";

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Minimum height of the editor surface. */
  minHeight?: string;
  maxHeight?: string;
  height?: string;
  className?: string;
  placeholder?: string;
  /** `json` (default) or `plaintext`. */
  language?: "json" | "plaintext";
  /** Renders a destructive ring — pair with an inline error message. */
  invalid?: boolean;
  /** Accessible name for the editor surface. */
  label?: string;
}

/**
 * CodeMirror 6 wrapper, themed with design tokens.
 *
 * The wrapper owns the border/focus ring; CodeMirror itself is transparent so
 * the editor reads as a first-class input, not an embedded iframe.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  minHeight = "160px",
  maxHeight = "600px",
  height,
  className,
  placeholder,
  language = "json",
  invalid = false,
  label,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <div
      dir="ltr"
      className={cn(
        "group/code overflow-hidden rounded-md border border-input bg-surface shadow-2xs",
        "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
        invalid && "border-destructive focus-within:border-destructive focus-within:ring-destructive/25",
        className
      )}
    >
      <CodeMirror
        value={value}
        onCreateEditor={(view) => {
          view.contentDOM.setAttribute("aria-label", label ?? "Code editor");
        }}
        {...(label ? { "aria-label": label } : { "aria-label": "Code editor" })}
        {...(height ? { height } : {})}
        minHeight={minHeight}
        maxHeight={maxHeight}
        theme={isDark ? "dark" : "light"}
        extensions={language === "json" ? [json()] : []}
        {...(onChange ? { onChange } : {})}
        readOnly={readOnly}
        {...(placeholder ? { placeholder } : {})}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          history: true,
          foldGutter: true,
          drawSelection: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          syntaxHighlighting: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          rectangularSelection: true,
          crosshairCursor: false,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          defaultKeymap: true,
          searchKeymap: true,
          historyKeymap: true,
          foldKeymap: true,
          completionKeymap: true,
          lintKeymap: true,
        }}
      />
    </div>
  );
}
CodeEditor.displayName = "CodeEditor";
