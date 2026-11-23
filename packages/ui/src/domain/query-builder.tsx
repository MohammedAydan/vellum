import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "../components/button.js";
import { Input } from "../components/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.js";
import { cn } from "../lib/cn.js";

export type QueryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any";

export interface QueryFilter {
  id: string;
  field: string;
  op: QueryOperator;
  value: string;
}

export interface OrderByClause {
  id: string;
  field: string;
  direction: "asc" | "desc";
}

export interface QueryBuilderRowProps {
  filter: QueryFilter;
  onChange: (filter: QueryFilter) => void;
  onRemove: () => void;
  fieldOptions?: string[] | undefined;
}

export function QueryBuilderRow({
  filter,
  onChange,
  onRemove,
  fieldOptions,
}: QueryBuilderRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-40 sm:w-48">
        {fieldOptions && fieldOptions.length > 0 ? (
          <Select
            value={filter.field}
            onValueChange={(val) => onChange({ ...filter, field: val })}
          >
            <SelectTrigger className="h-8 text-xs font-mono">
              <SelectValue placeholder="Select field" />
            </SelectTrigger>
            <SelectContent>
              {fieldOptions.map((f) => (
                <SelectItem key={f} value={f} className="text-xs font-mono">
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={filter.field}
            onChange={(e) => onChange({ ...filter, field: e.target.value })}
            placeholder="Field name"
            className="h-8 text-xs font-mono"
          />
        )}
      </div>

      <div className="w-32">
        <Select
          value={filter.op}
          onValueChange={(val) =>
            onChange({ ...filter, op: val as QueryOperator })
          }
        >
          <SelectTrigger className="h-8 text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="==" className="text-xs font-mono">== (equals)</SelectItem>
            <SelectItem value="!=" className="text-xs font-mono">!= (not equal)</SelectItem>
            <SelectItem value="<" className="text-xs font-mono">&lt; (less than)</SelectItem>
            <SelectItem value="<=" className="text-xs font-mono">&lt;= (less or eq)</SelectItem>
            <SelectItem value=">" className="text-xs font-mono">&gt; (greater than)</SelectItem>
            <SelectItem value=">=" className="text-xs font-mono">&gt;= (greater or eq)</SelectItem>
            <SelectItem value="in" className="text-xs font-mono">in (match any)</SelectItem>
            <SelectItem value="not-in" className="text-xs font-mono">not-in</SelectItem>
            <SelectItem value="array-contains" className="text-xs font-mono">array-contains</SelectItem>
            <SelectItem value="array-contains-any" className="text-xs font-mono">array-contains-any</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 min-w-[120px]">
        <Input
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          placeholder="Value (e.g. true, 'alice', 42)"
          className="h-8 text-xs font-mono"
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-destructive shrink-0"
        onClick={onRemove}
        aria-label="Remove filter"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

export interface OrderByRowProps {
  order: OrderByClause;
  onChange: (order: OrderByClause) => void;
  onRemove: () => void;
  fieldOptions?: string[] | undefined;
}

export function OrderByRow({
  order,
  onChange,
  onRemove,
  fieldOptions,
}: OrderByRowProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-48">
        {fieldOptions && fieldOptions.length > 0 ? (
          <Select
            value={order.field}
            onValueChange={(val) => onChange({ ...order, field: val })}
          >
            <SelectTrigger className="h-8 text-xs font-mono">
              <SelectValue placeholder="Select field" />
            </SelectTrigger>
            <SelectContent>
              {fieldOptions.map((f) => (
                <SelectItem key={f} value={f} className="text-xs font-mono">
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={order.field}
            onChange={(e) => onChange({ ...order, field: e.target.value })}
            placeholder="Field name"
            className="h-8 text-xs font-mono"
          />
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs font-mono gap-1"
        onClick={() =>
          onChange({
            ...order,
            direction: order.direction === "asc" ? "desc" : "asc",
          })
        }
      >
        {order.direction === "asc" ? (
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

      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-destructive shrink-0"
        onClick={onRemove}
        aria-label="Remove order by clause"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

export interface QueryBuilderGroupProps {
  filters: QueryFilter[];
  onFiltersChange: (filters: QueryFilter[]) => void;
  orders?: OrderByClause[];
  onOrdersChange?: (orders: OrderByClause[]) => void;
  fieldOptions?: string[];
  maxFilters?: number;
  className?: string;
}

export function QueryBuilderGroup({
  filters,
  onFiltersChange,
  orders = [],
  onOrdersChange,
  fieldOptions,
  maxFilters = 10,
  className,
}: QueryBuilderGroupProps) {
  const addFilter = () => {
    if (filters.length >= maxFilters) return;
    const newFilter: QueryFilter = {
      id: `f_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      field: fieldOptions?.[0] ?? "",
      op: "==",
      value: "",
    };
    onFiltersChange([...filters, newFilter]);
  };

  const updateFilter = (index: number, updated: QueryFilter) => {
    const next = [...filters];
    next[index] = updated;
    onFiltersChange(next);
  };

  const removeFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const addOrder = () => {
    if (!onOrdersChange || orders.length >= 3) return;
    const newOrder: OrderByClause = {
      id: `o_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      field: fieldOptions?.[0] ?? "",
      direction: "asc",
    };
    onOrdersChange([...orders, newOrder]);
  };

  const updateOrder = (index: number, updated: OrderByClause) => {
    if (!onOrdersChange) return;
    const next = [...orders];
    next[index] = updated;
    onOrdersChange(next);
  };

  const removeOrder = (index: number) => {
    if (!onOrdersChange) return;
    onOrdersChange(orders.filter((_, i) => i !== index));
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface p-4 space-y-4",
        className
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Filter Clauses ({filters.length}/{maxFilters})
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={addFilter}
            disabled={filters.length >= maxFilters}
          >
            <Plus className="me-1 size-3" />
            Add Filter
          </Button>
        </div>

        {filters.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-2">
            No filter clauses added. All documents will be queried.
          </p>
        ) : (
          <div className="space-y-2">
            {filters.map((filter, index) => (
              <QueryBuilderRow
                key={filter.id}
                filter={filter}
                fieldOptions={fieldOptions}
                onChange={(f) => updateFilter(index, f)}
                onRemove={() => removeFilter(index)}
              />
            ))}
          </div>
        )}
      </div>

      {onOrdersChange ? (
        <div className="border-t border-border/60 pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sort Order ({orders.length}/3)
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={addOrder}
              disabled={orders.length >= 3}
            >
              <Plus className="me-1 size-3" />
              Add Order
            </Button>
          </div>

          {orders.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-1">
              Default ordering by document ID ascending.
            </p>
          ) : (
            <div className="space-y-2">
              {orders.map((order, index) => (
                <OrderByRow
                  key={order.id}
                  order={order}
                  fieldOptions={fieldOptions}
                  onChange={(o) => updateOrder(index, o)}
                  onRemove={() => removeOrder(index)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
