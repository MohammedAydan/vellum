import * as React from "react";
import { AlertTriangle, Key, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "../components/badge.js";
import { Button } from "../components/button.js";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog.js";
import { CopyButton } from "../primitives/copy-button.js";
import { TimestampDisplay } from "../primitives/timestamp-display.js";
import { TruncatedText } from "../primitives/truncated-text.js";
import { cn } from "../lib/cn.js";

export interface ApiKeyCardProps {
  id: string;
  name: string;
  keyPrefix: string;
  scopes?: string[];
  createdAt: string | number | Date;
  lastUsedAt?: string | number | Date | null;
  onRevoke?: () => void;
  className?: string;
}

export function ApiKeyCard({
  name,
  keyPrefix,
  scopes = [],
  createdAt,
  lastUsedAt,
  onRevoke,
  className,
}: ApiKeyCardProps) {
  const isSecret = keyPrefix.startsWith("sk_");

  return (
    <Card className={cn("border-border bg-surface", className)}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 p-4 pb-2">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Key className="size-4 text-primary shrink-0" />
            <CardTitle className="text-sm font-semibold truncate">
              {name}
            </CardTitle>
          </div>
          <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span>Prefix:</span>
            <TruncatedText text={keyPrefix} maxLength={18} copyable />
          </div>
        </div>

        {onRevoke ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onRevoke}
            aria-label={`Revoke key ${name}`}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="p-4 pt-2">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-2xs font-mono">
            {isSecret ? "Secret Key (sk_)" : "Publishable Key (pk_)"}
          </Badge>
          {scopes.map((s) => (
            <Badge key={s} variant="secondary" className="text-2xs font-mono">
              {s}
            </Badge>
          ))}
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 flex justify-between items-center text-xs text-muted-foreground border-t border-border/40 mt-2">
        <div>
          <span>Created </span>
          <TimestampDisplay date={createdAt} />
        </div>
        {lastUsedAt ? (
          <div>
            <span>Used </span>
            <TimestampDisplay date={lastUsedAt} />
          </div>
        ) : (
          <span>Never used</span>
        )}
      </CardFooter>
    </Card>
  );
}

export interface ApiKeyRevealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  apiKey: string;
}

export function ApiKeyRevealDialog({
  open,
  onOpenChange,
  name,
  apiKey,
}: ApiKeyRevealDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 mb-2">
            <ShieldCheck className="size-6" />
          </div>
          <DialogTitle className="text-center">API Key Created</DialogTitle>
          <DialogDescription className="text-center text-xs text-muted-foreground">
            Save this key now. For your security, this key will never be
            displayed again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Store this key securely in your application secrets.</span>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">{name}</p>
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/50 p-2 font-mono text-xs select-all">
              <span className="truncate pe-2">{apiKey}</span>
              <CopyButton value={apiKey} />
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-center">
          <Button onClick={() => onOpenChange(false)}>
            I have saved this key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
