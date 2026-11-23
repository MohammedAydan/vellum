import * as React from "react";
import { cn } from "../lib/cn.js";
import { CopyButton } from "./copy-button.js";

export interface KeyValueRowProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  action?: React.ReactNode;
}

export function KeyValueRow({
  label,
  value,
  action,
  className,
  ...props
}: KeyValueRowProps) {
  return (
    <div
      data-slot="key-value-row"
      className={cn(
        "flex items-center justify-between gap-2 border-b border-border/50 py-2 text-sm last:border-b-0",
        className
      )}
      {...props}
    >
      <dt className="shrink-0 font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 max-w-[60%] items-center gap-2 truncate font-mono text-xs text-foreground tabular-nums">
        <span className="truncate">{value}</span>
        {action}
      </dd>
    </div>
  );
}

export interface KeyValueListProps
  extends React.HTMLAttributes<HTMLDListElement> {
  children: React.ReactNode;
}

export function KeyValueList({
  className,
  children,
  ...props
}: KeyValueListProps) {
  return (
    <dl
      data-slot="key-value-list"
      className={cn(
        "divide-y divide-border/50 rounded-md border border-border bg-surface p-3",
        className
      )}
      {...props}
    >
      {children}
    </dl>
  );
}

export interface PropertyItemProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  children: React.ReactNode;
  description?: React.ReactNode;
}

export function PropertyItem({
  title,
  description,
  children,
  className,
  ...props
}: PropertyItemProps) {
  return (
    <div
      data-slot="property-item"
      className={cn(
        "flex flex-col gap-1 border-b border-border/60 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
      {...props}
    >
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function PropertyList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="property-list"
      className={cn("rounded-lg border border-border bg-surface p-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CopyableFieldProps
  extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  /** Copied verbatim to the clipboard. */
  value: string;
  /** Optional masked/pretty rendering of `value`. */
  displayValue?: React.ReactNode;
  monospace?: boolean;
  successMessage?: string;
  truncate?: boolean;
}

/** A `KeyValueRow` whose value can be copied with the shared CopyButton. */
export function CopyableField({
  label,
  value,
  displayValue,
  monospace = true,
  successMessage,
  truncate = false,
  className,
  ...props
}: CopyableFieldProps) {
  return (
    <KeyValueRow
      data-slot="copyable-field"
      label={label}
      className={className}
      action={
        <CopyButton
          value={value}
          size="icon-sm"
          {...(successMessage ? { successMessage } : {})}
        />
      }
      {...props}
      value={
        <span
          className={cn(
            "tabular-nums",
            monospace && "font-mono",
            truncate && "truncate"
          )}
        >
          {displayValue ?? value}
        </span>
      }
    />
  );
}
