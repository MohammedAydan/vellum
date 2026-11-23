import * as React from "react";
import { Progress } from "../../components/progress.js";
import { cn } from "../../lib/cn.js";

export interface UsageProgressMeterProps {
  label: string;
  used: number;
  limit: number;
  format?: (n: number) => string;
  warningThreshold?: number;
  criticalThreshold?: number;
}

type MeterTone = "emerald" | "amber" | "red";

const TONE_BAR: Record<MeterTone, string> = {
  emerald: "[&>div]:bg-emerald-500",
  amber: "[&>div]:bg-amber-500",
  red: "[&>div]:bg-red-500",
};

const TONE_TEXT: Record<MeterTone, string> = {
  emerald: "text-emerald-700 dark:text-emerald-400",
  amber: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
};

const defaultFormatter = new Intl.NumberFormat();

export function UsageProgressMeter({
  label,
  used,
  limit,
  format = (n: number) => defaultFormatter.format(n),
  warningThreshold = 0.8,
  criticalThreshold = 0.95,
}: UsageProgressMeterProps): React.JSX.Element {
  const ratio = limit > 0 ? used / limit : 0;
  const percentage = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const tone: MeterTone =
    ratio >= criticalThreshold
      ? "red"
      : ratio >= warningThreshold
        ? "amber"
        : "emerald";

  return (
    <div data-slot="usage-progress-meter" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span
          className={cn(
            "rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
            TONE_TEXT[tone]
          )}
        >
          {percentage}%
        </span>
      </div>
      <Progress
        value={percentage}
        aria-label={label}
        className={cn("h-2 bg-muted", TONE_BAR[tone])}
      />
      <div dir="ltr" className="text-[11px] tabular-nums text-muted-foreground">
        {format(used)} / {format(limit)}
      </div>
    </div>
  );
}
