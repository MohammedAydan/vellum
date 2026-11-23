import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
} from "lucide-react";
import { Badge } from "../components/badge.js";
import { Button } from "../components/button.js";
import { cn } from "../lib/cn.js";

export interface DocumentTreeNode {
  id: string;
  name: string;
  path: string;
  type: "collection" | "document";
  count?: number;
  children?: DocumentTreeNode[];
}

export interface DocumentTreeProps {
  data: DocumentTreeNode[];
  selectedPath?: string;
  onSelect?: (node: DocumentTreeNode) => void;
  onCreateDocument?: (collectionPath: string) => void;
  className?: string;
}

export function DocumentTree({
  data,
  selectedPath,
  onSelect,
  onCreateDocument,
  className,
}: DocumentTreeProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface p-2 font-mono text-xs select-none",
        className
      )}
    >
      <div className="space-y-0.5">
        {data.map((node) => (
          <TreeNodeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onCreateDocument={onCreateDocument}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeItemProps {
  node: DocumentTreeNode;
  depth: number;
  selectedPath?: string | undefined;
  onSelect?: ((node: DocumentTreeNode) => void) | undefined;
  onCreateDocument?: ((collectionPath: string) => void) | undefined;
}

function TreeNodeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onCreateDocument,
}: TreeNodeItemProps) {
  const isSelected = selectedPath === node.path;
  const isCollection = node.type === "collection";
  const [expanded, setExpanded] = React.useState(true);

  const hasChildren = node.children && node.children.length > 0;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center justify-between rounded px-2 py-1.5 transition-colors cursor-pointer",
          isSelected
            ? "bg-primary/10 text-primary font-medium"
            : "text-foreground hover:bg-muted"
        )}
        style={{ paddingInlineStart: `${Math.max(8, depth * 16 + 8)}px` }}
        onClick={() => onSelect?.(node)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {isCollection ? (
            <button
              type="button"
              onClick={handleToggle}
              className="p-0.5 text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="w-4" />
          )}

          {isCollection ? (
            expanded ? (
              <FolderOpen className="size-3.5 text-amber-500 shrink-0" />
            ) : (
              <Folder className="size-3.5 text-amber-500 shrink-0" />
            )
          ) : (
            <FileText className="size-3.5 text-primary shrink-0" />
          )}

          <span className="truncate">{node.name}</span>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {typeof node.count === "number" ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {node.count}
            </Badge>
          ) : null}
          {isCollection && onCreateDocument ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={(e) => {
                e.stopPropagation();
                onCreateDocument(node.path);
              }}
              aria-label={`Create document in ${node.path}`}
            >
              <Plus className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      {isCollection && expanded && hasChildren ? (
        <div className="space-y-0.5">
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onCreateDocument={onCreateDocument}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
