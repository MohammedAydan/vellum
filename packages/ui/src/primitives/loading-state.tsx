import * as React from "react";
import { Skeleton } from "../components/skeleton.js";
import { cn } from "../lib/cn.js";

export interface LoadingStateProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function LoadingState({ rows = 5, columns = 4, className }: LoadingStateProps) {
  return (
    <div data-slot="loading-state" className={cn("w-full space-y-3 p-4", className)}>
      <div className="flex gap-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`header-${i}`} className="h-8 flex-1" />
        ))}
      </div>
      <div className="space-y-2 pt-2">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={`row-${r}`} className="flex gap-3">
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={`cell-${r}-${c}`} className="h-10 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
