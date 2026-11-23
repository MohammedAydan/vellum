import * as React from "react";
import { CheckCircle2, AlertTriangle, XCircle, Database, Radio, Server } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/card.js";
import { Badge } from "../components/badge.js";
import { cn } from "../lib/cn.js";

export interface ServiceHealth {
  name: string;
  status: "healthy" | "degraded" | "down";
  latencyMs?: number;
  details?: string;
}

export interface ClusterHealthCardProps extends React.HTMLAttributes<HTMLDivElement> {
  clusterName?: string;
  services?: ServiceHealth[];
  outboxLagMs?: number;
  activeWsConnections?: number;
}

export function ClusterHealthCard({
  clusterName = "PostgreSQL · control + data planes",
  services = [
    { name: "Control Plane DB", status: "healthy" },
    { name: "Data Plane DB (RLS)", status: "healthy" },
    { name: "Realtime LISTEN/NOTIFY", status: "healthy" },
  ],
  // Zero is the honest default: these are populated from /v1/admin/overview.
  outboxLagMs = 0,
  activeWsConnections = 0,
  className,
  ...props
}: ClusterHealthCardProps) {
  const allHealthy = services.every((s) => s.status === "healthy");

  return (
    <Card className={cn("border-border bg-surface", className)} {...props}>
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-3">
        <div className="flex items-center gap-2">
          <Server className="size-4 text-primary" />
          <CardTitle className="text-sm font-semibold">{clusterName}</CardTitle>
        </div>
        <Badge variant={allHealthy ? "success" : "warning"}>
          {allHealthy ? "Operational" : "Degraded"}
        </Badge>
      </CardHeader>

      <CardContent className="p-4 pt-0 space-y-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
            <p className="text-muted-foreground">Outbox watermark gap</p>
            <p className="mt-1 font-mono text-base font-semibold text-foreground">
              {outboxLagMs} seq ids
            </p>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
            <p className="text-muted-foreground">Realtime messages (30d)</p>
            <p className="mt-1 font-mono text-base font-semibold text-foreground">
              {activeWsConnections.toLocaleString()}
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Subsystem Health
          </p>
          <div className="space-y-1.5">
            {services.map((svc) => (
              <div
                key={svc.name}
                className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/40"
              >
                <div className="flex items-center gap-2">
                  {svc.name.includes("DB") ? (
                    <Database className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Radio className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="font-medium text-foreground">{svc.name}</span>
                </div>

                <div className="flex items-center gap-2">
                  {svc.latencyMs !== undefined ? (
                    <span className="font-mono text-2xs text-muted-foreground">
                      {svc.latencyMs.toFixed(1)}ms
                    </span>
                  ) : null}
                  {svc.status === "healthy" ? (
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                  ) : svc.status === "degraded" ? (
                    <AlertTriangle className="size-3.5 text-amber-500" />
                  ) : (
                    <XCircle className="size-3.5 text-rose-500" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
