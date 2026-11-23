import * as React from "react";
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from "lucide-react";
import { Button } from "../components/button.js";
import { Input } from "../components/input.js";
import { cn } from "../lib/cn.js";

export interface IndexFieldDefinition {
  id: string;
  fieldPath: string;
  order: "ASC" | "DESC";
}

export interface IndexFieldsRowProps {
  field: IndexFieldDefinition;
  onChange: (field: IndexFieldDefinition) => void;
  onRemove: () => void;
  canRemove?: boolean;
  className?: string;
}

export function IndexFieldsRow({
  field,
  onChange,
  onRemove,
  canRemove = true,
  className,
}: IndexFieldsRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-surface p-2 shadow-xs",
        className
      )}
    >
      <div className="cursor-grab text-muted-foreground p-1">
        <GripVertical className="size-4" />
      </div>

      <div className="flex-1 min-w-[140px]">
        <Input
          value={field.fieldPath}
          onChange={(e) => onChange({ ...field, fieldPath: e.target.value })}
          placeholder="Field path (e.g. status, user.age)"
          className="h-8 text-xs font-mono"
        />
      </div>

      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs font-mono gap-1"
        onClick={() =>
          onChange({
            ...field,
            order: field.order === "ASC" ? "DESC" : "ASC",
          })
        }
      >
        {field.order === "ASC" ? (
          <>
            <ArrowUp className="size-3" />
            ASC
          </>
        ) : (
          <>
            <ArrowDown className="size-3" />
            DESC
          </>
        )}
      </Button>

      {canRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive shrink-0"
          onClick={onRemove}
          aria-label="Remove index field"
        >
          <Trash2 className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
