import * as React from "react";
import { cn } from "../../lib/cn.js";

export interface PageHeaderProps {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Canonical page heading. This is the shared pattern; the original
 * `PageHeader` export in `primitives/app-shell.tsx` is intentionally left in
 * place for backwards compatibility.
 */
export function PageHeader({
  title,
  description,
  badge,
  breadcrumb,
  actions,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-2 min-w-0">{breadcrumb}</div> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {badge ? <span className="inline-flex shrink-0 items-center">{badge}</span> : null}
        </div>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}
