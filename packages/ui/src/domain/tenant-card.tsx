import * as React from "react";
import { Building2, ChevronRight } from "lucide-react";
import { Badge } from "../components/badge.js";
import { Button } from "../components/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/card.js";
import { TruncatedText } from "../primitives/truncated-text.js";
import { cn } from "../lib/cn.js";

export interface TenantCardProps extends React.HTMLAttributes<HTMLDivElement> {
  id: string;
  name: string;
  plan: "hobby" | "pro" | "enterprise";
  documentCount?: number;
  storageMb?: number;
  monthlySpend?: number;
  onManage?: () => void;
}

export function TenantCard({
  id,
  name,
  plan,
  documentCount = 0,
  storageMb = 0,
  monthlySpend = 0,
  onManage,
  className,
  ...props
}: TenantCardProps) {
  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md border-border bg-surface",
        className
      )}
      {...props}
    >
      <CardHeader className="flex flex-row items-start justify-between p-4 pb-2 space-y-0">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-primary shrink-0" />
            <CardTitle className="text-base font-semibold truncate">
              {name}
            </CardTitle>
            <Badge
              variant={
                plan === "enterprise"
                  ? "default"
                  : plan === "pro"
                  ? "secondary"
                  : "outline"
              }
              className="text-2xs uppercase tracking-wider font-mono"
            >
              {plan}
            </Badge>
          </div>
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <span>Org ID:</span>
            <TruncatedText text={id} maxLength={16} copyable />
          </div>
        </div>

        {onManage ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={onManage}
          >
            Manage
            <ChevronRight className="size-3.5" />
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="p-4 pt-2">
        <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-center">
          <div>
            <p className="text-muted-foreground">Documents</p>
            <p className="mt-0.5 font-mono font-semibold text-foreground">
              {documentCount.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Storage</p>
            <p className="mt-0.5 font-mono font-semibold text-foreground">
              {(storageMb / 1024).toFixed(1)} GB
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Est. Spend</p>
            <p className="mt-0.5 font-mono font-semibold text-foreground">
              ${monthlySpend.toFixed(2)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
