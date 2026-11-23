import * as React from "react";
import { CheckCircle2, Play, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "../components/badge.js";
import { Button } from "../components/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/card.js";
import { CodeEditor } from "../components/code-editor.js";
import { Input } from "../components/input.js";
import { Label } from "../components/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.js";
import { cn } from "../lib/cn.js";

export interface RulesEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  onFormat?: () => void;
  readOnly?: boolean;
  className?: string;
}

export function RulesEditor({
  value,
  onChange,
  error,
  onFormat,
  readOnly = false,
  className,
}: RulesEditorProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Security Rules AST (JSON)
        </Label>
        {onFormat ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onFormat}
            disabled={readOnly}
          >
            Format JSON
          </Button>
        ) : null}
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <CodeEditor
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          className="min-h-[280px]"
        />
      </div>

      {error ? (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

export interface SimulationResult {
  allowed: boolean;
  reason?: string;
  evaluatedNodes?: number;
  durationMs?: number;
}

export interface RulesSimulatorProps {
  onSimulate: (context: {
    operation: "get" | "list" | "create" | "update" | "delete";
    path: string;
    authUid: string;
    authRole: string;
  }) => SimulationResult | Promise<SimulationResult>;
  className?: string;
}

export function RulesSimulator({
  onSimulate,
  className,
}: RulesSimulatorProps) {
  const [operation, setOperation] = React.useState<
    "get" | "list" | "create" | "update" | "delete"
  >("get");
  const [path, setPath] = React.useState("users/user_123");
  const [authUid, setAuthUid] = React.useState("user_123");
  const [authRole, setAuthRole] = React.useState("user");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<SimulationResult | null>(null);

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await onSimulate({ operation, path, authUid, authRole });
      setResult(res);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={cn("border-border bg-surface", className)}>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span>Security Rules Simulator</span>
          {result ? (
            result.allowed ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="size-3" />
                ALLOW
              </Badge>
            ) : (
              <Badge variant="danger" className="gap-1">
                <XCircle className="size-3" />
                DENY
              </Badge>
            )
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-2xs">Operation</Label>
            <Select
              value={operation}
              onValueChange={(v) =>
                setOperation(
                  v as "get" | "list" | "create" | "update" | "delete"
                )
              }
            >
              <SelectTrigger className="h-8 text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="get">get</SelectItem>
                <SelectItem value="list">list</SelectItem>
                <SelectItem value="create">create</SelectItem>
                <SelectItem value="update">update</SelectItem>
                <SelectItem value="delete">delete</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-2xs">Document Path</Label>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder="collection/doc"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-2xs">Auth UID (auth.uid)</Label>
            <Input
              value={authUid}
              onChange={(e) => setAuthUid(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder="user_id"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-2xs">Auth Role (token.role)</Label>
            <Input
              value={authRole}
              onChange={(e) => setAuthRole(e.target.value)}
              className="h-8 text-xs font-mono"
              placeholder="admin, user"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-xs text-muted-foreground font-mono">
            {result?.durationMs !== undefined ? (
              <span>Eval time: {result.durationMs.toFixed(2)}ms</span>
            ) : null}
          </div>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleRun}
            disabled={loading}
          >
            <Play className="size-3.5 fill-current" />
            Run Simulator
          </Button>
        </div>

        {result?.reason ? (
          <p className="rounded border border-border/60 bg-muted/30 p-2 text-xs font-mono text-muted-foreground">
            {result.reason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
