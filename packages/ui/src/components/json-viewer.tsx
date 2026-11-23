import * as React from "react";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface JsonViewerProps {
  data: unknown;
  initialExpandedDepth?: number;
  className?: string;
  copyable?: boolean;
}

export function JsonViewer({
  data,
  initialExpandedDepth = 2,
  className,
  copyable = true,
}: JsonViewerProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div dir="ltr" className={cn("relative rounded-md border bg-muted/20 p-3 font-mono text-xs overflow-auto text-start", className)}>
      {copyable && (
        <button
          onClick={handleCopy}
          aria-label="Copy JSON"
          className="absolute end-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
      <JsonNode value={data} depth={0} maxDepth={initialExpandedDepth} />
    </div>
  );
}

function JsonNode({ value, depth, maxDepth }: { value: unknown; depth: number; maxDepth: number }) {
  const [isExpanded, setIsExpanded] = React.useState(depth < maxDepth);

  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground italic">undefined</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-amber-600 dark:text-amber-400 font-semibold">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }
  if (typeof value === "string") {
    return <span className="text-emerald-600 dark:text-emerald-400">"{value}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;

    return (
      <span>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
          <span className="text-muted-foreground text-[10px] ms-0.5">[{value.length}]</span>
        </button>
        {isExpanded ? (
          <div className="ps-4 border-s border-border/50 my-0.5 space-y-0.5">
            {value.map((item, idx) => (
              <div key={idx} className="flex items-start">
                <span className="text-muted-foreground me-1 select-none">{idx}:</span>
                <JsonNode value={item} depth={depth + 1} maxDepth={maxDepth} />
              </div>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground"> [...]</span>
        )}
      </span>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span>{"{}"}</span>;

    return (
      <span>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
          <span className="text-muted-foreground text-[10px] ms-0.5">{"{" + entries.length + "}"}</span>
        </button>
        {isExpanded ? (
          <div className="ps-4 border-s border-border/50 my-0.5 space-y-0.5">
            {entries.map(([k, v]) => (
              <div key={k} className="flex items-start">
                <span className="text-purple-600 dark:text-purple-400 font-medium me-1.5 select-none">{k}:</span>
                <JsonNode value={v} depth={depth + 1} maxDepth={maxDepth} />
              </div>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground"> {"{...}"}</span>
        )}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}
