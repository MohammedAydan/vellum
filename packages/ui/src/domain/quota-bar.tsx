import * as React from "react";
import { cn } from "../lib/cn.js";

export interface QuotaBarProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  current: number;
  max: number;
  unit?: string;
  formatter?: (val: number) => string;
}

export function QuotaBar({
  label,
  current,
  max,
  unit = "",
  formatter,
  className,
  ...props
}: QuotaBarProps) {
  const percentage = Math.min(100, Math.max(0, max > 0 ? (current / max) * 100 : 0));

  const status =
    percentage >= 90 ? "danger" : percentage >= 75 ? "warning" : "normal";

  const formattedCurrent = formatter ? formatter(current) : `${current.toLocaleString()}${unit}`;
  const formattedMax = formatter ? formatter(max) : `${max.toLocaleString()}${unit}`;

  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span dir="ltr" className="font-mono text-muted-foreground">
          {formattedCurrent} / {formattedMax} ({percentage.toFixed(0)}%)
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-300 rounded-full",
            status === "danger"
              ? "bg-destructive"
              : status === "warning"
              ? "bg-warning"
              : "bg-primary"
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
