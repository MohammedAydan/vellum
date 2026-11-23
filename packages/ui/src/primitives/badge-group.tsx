import * as React from "react";
import { Badge, type BadgeProps } from "../components/badge.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.js";
import { cn } from "../lib/cn.js";

export interface BadgeGroupItem {
  id: string;
  label: string;
  variant?: BadgeProps["variant"];
}

export interface BadgeGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  items: (string | BadgeGroupItem)[];
  maxCount?: number;
  badgeVariant?: BadgeProps["variant"];
}

export function BadgeGroup({
  items,
  maxCount = 3,
  badgeVariant = "secondary",
  className,
  ...props
}: BadgeGroupProps) {
  const normalized: BadgeGroupItem[] = React.useMemo(() => {
    return items.map((item, idx) => {
      if (typeof item === "string") {
        return { id: `${item}-${idx}`, label: item, variant: badgeVariant };
      }
      return { ...item, variant: item.variant ?? badgeVariant };
    });
  }, [items, badgeVariant]);

  const visible = normalized.slice(0, maxCount);
  const overflow = normalized.slice(maxCount);

  return (
    <div
      data-slot="badge-group"
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
      {...props}
    >
      {visible.map((b) => (
        <Badge key={b.id} variant={b.variant}>
          {b.label}
        </Badge>
      ))}
      {overflow.length > 0 ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Badge
                  variant="outline"
                  className="cursor-pointer font-mono hover:bg-accent"
                >
                  +{overflow.length}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-wrap gap-1 max-w-xs">
                {overflow.map((b) => (
                  <Badge key={b.id} variant={b.variant} className="text-2xs">
                    {b.label}
                  </Badge>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}
