import * as React from "react";
import { ErrorState } from "../../primitives/error-state.js";
import { EmptyState } from "../../primitives/empty-state.js";
import { LoadingState } from "../../primitives/loading-state.js";

/** Re-exported verbatim so the `data-slot="empty-state"` QA hook stays intact. */
export {
  EmptyState,
  type EmptyStateProps,
} from "../../primitives/empty-state.js";

export interface ErrorAlertProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export interface AsyncRegionProps {
  /** Which of the designed states the region is in. */
  status: "loading" | "error" | "empty" | "ready";
  /** Skeleton that matches the final layout. Defaults to `LoadingState`. */
  skeleton?: React.ReactNode;
  /** Error-state copy. A retry button renders when `onRetry` is provided. */
  errorTitle?: string;
  errorMessage?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Empty-state content. Defaults to `EmptyState` with the props below. */
  empty?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The P0 hard rule for async UI, packaged: every region that waits on a
 * request renders one of three designed states — a skeleton that matches the
 * final layout, an error with retry, or an empty state with guidance and a
 * primary action — never a permanent skeleton wall (finding F3).
 */
export function AsyncRegion({
  status,
  skeleton,
  errorTitle,
  errorMessage,
  onRetry,
  retryLabel,
  empty,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  className,
  children,
}: AsyncRegionProps): React.JSX.Element {
  if (status === "loading") {
    return <div className={className}>{skeleton ?? <LoadingState />}</div>;
  }
  if (status === "error") {
    return (
      <div className={className}>
        <ErrorState
          {...(errorTitle !== undefined ? { title: errorTitle } : {})}
          {...(errorMessage !== undefined ? { message: errorMessage } : {})}
          {...(onRetry !== undefined ? { onRetry } : {})}
          {...(retryLabel !== undefined ? { retryLabel } : {})}
        />
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div className={className}>
        {empty ?? (
          <EmptyState
            title={emptyTitle}
            {...(emptyDescription !== undefined ? { description: emptyDescription } : {})}
            {...(emptyAction !== undefined ? { action: emptyAction } : {})}
          />
        )}
      </div>
    );
  }
  return <div className={className}>{children}</div>;
}

/**
 * Thin wrapper over the existing `ErrorState`, preserving its `role="alert"`
 * and `data-slot="error-state"` hooks.
 */
export function ErrorAlert({
  title,
  message,
  onRetry,
}: ErrorAlertProps): React.JSX.Element {
  return (
    <ErrorState
      {...(title !== undefined ? { title } : {})}
      message={message}
      {...(onRetry !== undefined ? { onRetry } : {})}
    />
  );
}
