import * as React from "react";
import { cn } from "../../lib/cn.js";
import { JsonViewer } from "../../components/json-viewer.js";

export interface JsonInspectorProps {
  value: unknown;
  editable?: boolean;
  onChange?: (next: string) => void;
  initialText?: string;
  minRows?: number;
  className?: string;
}

function serialize(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result ?? String(value);
  } catch {
    return String(value);
  }
}

interface ValidationResult {
  valid: boolean;
  message: string;
}

function validate(text: string): ValidationResult {
  try {
    JSON.parse(text);
    return { valid: true, message: "Valid JSON" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unexpected token";
    return { valid: false, message: detail };
  }
}

/**
 * Formatted JSON viewer with an optional editable textarea and a live
 * valid/invalid badge. Reuses the shared `JsonViewer` for the read-only tree.
 */
export function JsonInspector({
  value,
  editable = false,
  onChange,
  initialText,
  minRows = 8,
  className,
}: JsonInspectorProps): React.JSX.Element {
  const formatted = React.useMemo(() => serialize(value), [value]);
  const [text, setText] = React.useState(() => initialText ?? formatted);

  React.useEffect(() => {
    setText(initialText ?? formatted);
  }, [formatted, initialText]);

  const validation = React.useMemo(() => validate(text), [text]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground">
          JSON
        </span>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
            validation.valid
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              validation.valid ? "bg-emerald-500" : "bg-destructive"
            )}
          />
          {validation.valid ? "Valid JSON" : "Invalid JSON"}
        </span>
      </div>

      {editable ? (
        <>
          <textarea
            value={text}
            rows={minRows}
            spellCheck={false}
            dir="ltr"
            aria-label="JSON"
            aria-invalid={!validation.valid}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              onChange?.(next);
            }}
            className={cn(
              "w-full rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30",
              validation.valid ? "border-border" : "border-destructive"
            )}
          />
          {!validation.valid ? (
            <p className="text-xs text-destructive">{validation.message}</p>
          ) : null}
        </>
      ) : (
        <JsonViewer data={value} className="font-mono [font-family:'JetBrains_Mono',ui-monospace,monospace]" />
      )}
    </div>
  );
}
JsonInspector.displayName = "JsonInspector";
