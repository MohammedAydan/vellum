import * as React from "react";
import { cn } from "../lib/cn.js";

export type WireFieldType =
  | "string"
  | "number"
  | "boolean"
  | "int64"
  | "timestamp"
  | "reference"
  | "ref"
  | "geopoint"
  | "geo"
  | "bytes"
  | "null"
  | "map"
  | "array";

export interface FieldBadgeProps {
  type: WireFieldType | string;
  className?: string;
}

export function FieldBadge({ type, className }: FieldBadgeProps) {
  const normalized = type.toLowerCase();

  const config: Record<
    string,
    { label: string; color: string }
  > = {
    string: { label: "string", color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
    number: { label: "number", color: "bg-blue-500/10 text-blue-600 border-blue-500/30" },
    boolean: { label: "bool", color: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
    int64: { label: "int64", color: "bg-indigo-500/10 text-indigo-600 border-indigo-500/30" },
    timestamp: { label: "timestamp", color: "bg-cyan-500/10 text-cyan-600 border-cyan-500/30" },
    reference: { label: "ref", color: "bg-purple-500/10 text-purple-600 border-purple-500/30" },
    ref: { label: "ref", color: "bg-purple-500/10 text-purple-600 border-purple-500/30" },
    geopoint: { label: "geo", color: "bg-rose-500/10 text-rose-600 border-rose-500/30" },
    geo: { label: "geo", color: "bg-rose-500/10 text-rose-600 border-rose-500/30" },
    bytes: { label: "bytes", color: "bg-orange-500/10 text-orange-600 border-orange-500/30" },
    null: { label: "null", color: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30" },
    map: { label: "map", color: "bg-violet-500/10 text-violet-600 border-violet-500/30" },
    array: { label: "array", color: "bg-pink-500/10 text-pink-600 border-pink-500/30" },
  };

  const current = config[normalized] ?? {
    label: type,
    color: "bg-muted text-muted-foreground border-border",
  };

  return (
    <span
      data-slot="field-badge"
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium font-mono uppercase tracking-wider tabular-nums select-none",
        current.color,
        className
      )}
    >
      {current.label}
    </span>
  );
}

export { FieldBadge as FieldTypeBadge };
export type { FieldBadgeProps as FieldTypeBadgeProps };

