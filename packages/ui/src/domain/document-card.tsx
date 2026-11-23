import * as React from "react";
import { Edit2, MoreVertical, Trash2 } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.js";
import { CopyButton } from "../primitives/copy-button.js";
import { FieldTypeBadge } from "../primitives/field-badge.js";
import { TimestampDisplay } from "../primitives/timestamp-display.js";
import { cn } from "../lib/cn.js";

export interface DocumentFieldSummary {
  name: string;
  type: string;
  preview: string;
}

export interface DocumentCardProps extends React.HTMLAttributes<HTMLDivElement> {
  id: string;
  path: string;
  version?: number;
  updatedAt?: string | number | Date;
  fields?: DocumentFieldSummary[];
  onEdit?: () => void;
  onDelete?: () => void;
  onSelect?: () => void;
}

export function DocumentCard({
  id,
  path,
  version,
  updatedAt,
  fields = [],
  onEdit,
  onDelete,
  onSelect,
  className,
  ...props
}: DocumentCardProps) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-md border-border bg-surface",
        className
      )}
      onClick={onSelect}
      {...props}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 p-4 pb-2">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="font-mono text-sm font-semibold truncate">
              {id}
            </CardTitle>
            <CopyButton value={path} className="size-6 p-0" />
            {typeof version === "number" ? (
              <Badge variant="outline" className="text-[10px] h-4 px-1">
                v{version}
              </Badge>
            ) : null}
          </div>
          <p className="font-mono text-xs text-muted-foreground truncate">
            {path}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Document options"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit ? (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Edit2 className="me-2 size-3.5" />
                Edit document
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(path);
              }}
            >
              Copy path
            </DropdownMenuItem>
            {onDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                >
                  <Trash2 className="me-2 size-3.5" />
                  Delete document
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>

      <CardContent className="p-4 pt-2">
        {fields.length > 0 ? (
          <div className="space-y-1.5 rounded-md border border-border/50 bg-muted/40 p-2 font-mono text-xs">
            {fields.slice(0, 4).map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between gap-2 overflow-hidden"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <FieldTypeBadge type={f.type} />
                  <span className="font-medium text-foreground truncate">
                    {f.name}
                  </span>
                </div>
                <span className="text-muted-foreground truncate max-w-[50%]">
                  {f.preview}
                </span>
              </div>
            ))}
            {fields.length > 4 ? (
              <p className="text-[10px] text-muted-foreground pt-1">
                +{fields.length - 4} more fields…
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No fields</p>
        )}
      </CardContent>

      {updatedAt ? (
        <CardFooter className="p-4 pt-0 flex justify-between items-center text-xs text-muted-foreground">
          <span>Updated</span>
          <TimestampDisplay date={updatedAt} />
        </CardFooter>
      ) : null}
    </Card>
  );
}
