import * as React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "../components/button.js";
import { cn } from "../lib/cn.js";

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  tone?: "error" | "warning" | "info" | "success";
  className?: string;
}

const toneClasses: Record<NonNullable<ErrorStateProps["tone"]>, string> = {
  error: "border-destructive/20 bg-destructive/5 text-destructive",
  warning: "border-warning-500/20 bg-warning-500/5 text-warning-700 dark:text-warning-300",
  info: "border-info-500/20 bg-info-500/5 text-info-700 dark:text-info-300",
  success: "border-success-500/20 bg-success-500/5 text-success-700 dark:text-success-300",
};

export function ErrorState({
  title = "Something went wrong",
  message = "An error occurred while loading this section.",
  onRetry,
  retryLabel = "Retry",
  tone = "error",
  className,
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        "flex min-h-[200px] flex-col items-center justify-center gap-1 rounded-lg border p-6 text-center",
        toneClasses[tone],
        className
      )}
    >
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-current/10">
        <AlertCircle className="size-6" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="max-w-sm text-xs text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
          <RefreshCw className="size-3.5 me-1.5" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
