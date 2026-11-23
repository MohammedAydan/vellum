import * as React from "react";
import { Badge } from "../components/badge.js";
import { TimestampDisplay } from "../primitives/timestamp-display.js";
import { TruncatedText } from "../primitives/truncated-text.js";
import { cn } from "../lib/cn.js";

export interface AuditLogEvent {
  id: string;
  timestamp: string | number | Date;
  actor: {
    type: "user" | "api_key";
    id: string;
    label: string;
  };
  action: string;
  resource: string;
  ipAddress?: string;
  status: "success" | "denied" | "error";
}

export interface AuditLogRowProps extends React.HTMLAttributes<HTMLDivElement> {
  event: AuditLogEvent;
}

export function AuditLogRow({ event, className, ...props }: AuditLogRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border border-border/60 bg-surface p-3 text-xs transition-colors hover:bg-muted/30",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant={
            event.status === "success"
              ? "success"
              : event.status === "denied"
              ? "danger"
              : "warning"
          }
          className="text-[10px] uppercase font-mono tracking-wider shrink-0"
        >
          {event.status}
        </Badge>

        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground font-mono">
              {event.action}
            </span>
            <span className="text-muted-foreground">on</span>
            <TruncatedText
              text={event.resource}
              maxLength={28}
              className="font-medium text-foreground"
            />
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>Actor:</span>
            <span className="font-medium text-foreground">{event.actor.label}</span>
            <span>({event.actor.type})</span>
            {event.ipAddress ? (
              <>
                <span>•</span>
                <span className="font-mono">{event.ipAddress}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="shrink-0 text-end">
        <TimestampDisplay date={event.timestamp} />
      </div>
    </div>
  );
}
