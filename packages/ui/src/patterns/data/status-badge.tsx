import * as React from "react";
import { Badge } from "../../components/badge.js";
import { cn } from "../../lib/cn.js";

type StatusValue =
  | "active"
  | "disabled"
  | "verified"
  | "unverified"
  | "pending"
  | "applied"
  | "dismissed"
  | "open"
  | "acknowledged"
  | "resolved"
  | "paid"
  | "past_due"
  | "suspended"
  | "critical"
  | "high"
  | "medium"
  | "low";

type Tone = "emerald" | "amber" | "red" | "blue" | "zinc";

export interface StatusBadgeProps {
  status: StatusValue;
  label?: string;
  dot?: boolean;
}

const STATUS_TONES: Record<StatusValue, Tone> = {
  active: "emerald",
  disabled: "zinc",
  verified: "emerald",
  unverified: "amber",
  pending: "amber",
  applied: "emerald",
  dismissed: "zinc",
  open: "blue",
  acknowledged: "blue",
  resolved: "emerald",
  paid: "emerald",
  past_due: "red",
  suspended: "red",
  critical: "red",
  high: "red",
  medium: "amber",
  low: "zinc",
};

const STATUS_LABELS: Record<StatusValue, string> = {
  active: "Active",
  disabled: "Disabled",
  verified: "Verified",
  unverified: "Unverified",
  pending: "Pending",
  applied: "Applied",
  dismissed: "Dismissed",
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  paid: "Paid",
  past_due: "Past due",
  suspended: "Suspended",
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const TONE_PILL: Record<Tone, string> = {
  emerald:
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
  blue: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  zinc: "border-zinc-500/20 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

const TONE_DOT: Record<Tone, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-blue-500",
  zinc: "bg-zinc-500",
};

export function StatusBadge({
  status,
  label,
  dot = true,
}: StatusBadgeProps): React.JSX.Element {
  const tone = STATUS_TONES[status];
  return (
    <Badge
      data-slot="status-badge"
      variant="outline"
      className={cn("gap-1.5", TONE_PILL[tone])}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
        />
      ) : null}
      <span>{label ?? STATUS_LABELS[status]}</span>
    </Badge>
  );
}
