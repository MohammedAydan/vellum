import * as React from "react";
import { FolderOpen } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon = <FolderOpen className="size-10 text-muted-foreground/60" />,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex min-h-[220px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-8 text-center animate-in fade-in-50",
        className
      )}
    >
      <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-muted/50">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
