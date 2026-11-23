import * as React from "react";
import { cn } from "../../lib/cn.js";
import { CopyButton } from "../../primitives/copy-button.js";
import {
  KeyValueList as BaseKeyValueList,
  KeyValueRow,
} from "../../primitives/property-list.js";

export interface KeyValueListItem {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  copyable?: boolean;
}

export interface KeyValueListProps {
  items: KeyValueListItem[];
  columns?: 1 | 2;
}

/** Best-effort text extraction so copyable rows work with nested React nodes. */
function nodeToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeToText).join("");
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return nodeToText(props.children);
  }
  return "";
}

export function KeyValueList({
  items,
  columns = 1,
}: KeyValueListProps): React.JSX.Element {
  return (
    <BaseKeyValueList
      data-slot="key-value-list"
      className={cn("grid gap-x-6", columns === 2 && "sm:grid-cols-2")}
    >
      {items.map((item, index) => (
        <KeyValueRow
          key={`${item.label}-${index}`}
          label={item.label}
          value={
            <span className={cn("tabular-nums", item.mono === false && "font-sans")}>
              {item.value}
            </span>
          }
          {...(item.copyable
            ? {
                action: (
                  <CopyButton value={nodeToText(item.value)} size="icon-sm" />
                ),
              }
            : {})}
        />
      ))}
    </BaseKeyValueList>
  );
}
