import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent } from "../../components/card.js";
import { cn } from "../../lib/cn.js";

export interface KpiMetricCardProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  icon?: React.ReactNode;
  subtitle?: string;
  onClick?: () => void;
  mono?: boolean;
}

const DELTA_TONES = {
  up: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  down: "bg-red-500/10 text-red-700 dark:text-red-400",
  neutral: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400",
} as const;

const DELTA_ICONS = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  neutral: Minus,
} as const;

export function KpiMetricCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  icon,
  subtitle,
  onClick,
  mono = false,
}: KpiMetricCardProps): React.JSX.Element {
  const interactive = typeof onClick === "function";
  const DeltaIcon = DELTA_ICONS[deltaTone];

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onClick) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    },
    [onClick]
  );

  const content = (
    <CardContent className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {icon ? (
          <span className="ms-auto text-muted-foreground/70" aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold leading-tight tabular-nums text-foreground",
          mono && "font-mono"
        )}
      >
        {value}
      </div>
      {delta ? (
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
              DELTA_TONES[deltaTone]
            )}
          >
            <DeltaIcon className="size-3" aria-hidden="true" />
            {delta}
          </span>
          {subtitle ? (
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
        </div>
      ) : subtitle ? (
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      ) : null}
    </CardContent>
  );

  return (
    <Card
      data-slot="kpi-metric-card"
      size="sm"
      className={cn(
        "gap-0 py-3",
        interactive &&
          "cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
      {...(interactive
        ? { role: "button", tabIndex: 0, onClick, onKeyDown: handleKeyDown }
        : {})}
    >
      {content}
    </Card>
  );
}
