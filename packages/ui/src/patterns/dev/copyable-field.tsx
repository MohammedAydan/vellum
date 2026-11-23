import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { CopyButton } from "../../primitives/copy-button.js";

export interface CopyableFieldProps {
  value: string;
  label?: string;
  secret?: boolean;
  mono?: boolean;
  className?: string;
}

const MASK = "••••••••";

/**
 * Read-only field for identifiers and credentials (project IDs, `pk_` / `sk_`
 * keys, callback and JWKS URLs, entry hashes). Optional secret masking hides the
 * displayed value while the copy control still copies the real value.
 *
 * Keeps the `button[title="Copy to clipboard"]` QA hook via the shared
 * `CopyButton` primitive.
 */
export function CopyableField({
  value,
  label,
  secret = false,
  mono = true,
  className,
}: CopyableFieldProps): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);
  const displayValue = secret && !revealed ? MASK : value;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      ) : null}
      <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 ps-3 pe-1 py-1">
        <input
          readOnly
          dir="ltr"
          value={displayValue}
          aria-label={label ?? "Value"}
          className={cn(
            "min-w-0 flex-1 select-all border-0 bg-transparent text-sm text-foreground outline-none",
            mono && "font-mono [font-family:'JetBrains_Mono',ui-monospace,monospace]"
          )}
        />
        {secret ? (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? "Hide value" : "Reveal value"}
            aria-pressed={revealed}
            title={revealed ? "Hide value" : "Reveal value"}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {revealed ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
          </button>
        ) : null}
        <CopyButton
          value={value}
          size="icon-sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
        />
      </div>
    </div>
  );
}
CopyableField.displayName = "CopyableField";
