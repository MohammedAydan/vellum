import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/table.js";
import { Button } from "../../components/button.js";
import { Skeleton } from "../../components/skeleton.js";
import { cn } from "../../lib/cn.js";
import { EmptyState } from "../../primitives/empty-state.js";

export interface DataTableColumn<T> {
  id: string;
  header: string;
  accessor?: (row: T) => React.ReactNode;
  align?: "start" | "end" | "center";
  mono?: boolean;
  sortable?: boolean;
  width?: string;
}

export type DataTablePagination =
  | {
      page: number;
      pageSize: number;
      total: number;
      onPageChange: (page: number) => void;
    }
  | {
      cursor?: string;
      nextCursor?: string;
      onNext?: () => void;
      onPrev?: () => void;
    };

export interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  loading?: boolean;
  toolbar?: React.ReactNode;
  emptyState?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectedId?: string;
  pagination?: DataTablePagination;
  className?: string;
}

type SortDirection = "asc" | "desc";

interface SortState {
  id: string;
  direction: SortDirection;
}

const ALIGN_CLASSES: Record<NonNullable<DataTableColumn<unknown>["align"]>, string> = {
  start: "text-start",
  end: "text-end",
  center: "text-center",
};

/** Scalars sort naturally; rendered elements fall back to an empty key (stable order). */
function cellSortValue<T>(row: T, column: DataTableColumn<T>): string | number {
  const rendered = column.accessor?.(row);
  if (typeof rendered === "string" || typeof rendered === "number") {
    return rendered;
  }
  return "";
}

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  loading = false,
  toolbar,
  emptyState,
  onRowClick,
  selectedId,
  pagination,
  className,
}: DataTableProps<T>): React.JSX.Element {
  const [sort, setSort] = React.useState<SortState | null>(null);

  const sortedRows = React.useMemo(() => {
    if (!sort) {
      return rows;
    }
    const column = columns.find((candidate) => candidate.id === sort.id);
    if (!column || !column.sortable) {
      return rows;
    }
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = cellSortValue(a, column);
      const bValue = cellSortValue(b, column);
      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * factor;
      }
      return (
        String(aValue).localeCompare(String(bValue), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * factor
      );
    });
  }, [rows, columns, sort]);

  const toggleSort = React.useCallback((column: DataTableColumn<T>) => {
    if (!column.sortable) {
      return;
    }
    setSort((current) => {
      if (current?.id !== column.id) {
        return { id: column.id, direction: "asc" };
      }
      return {
        id: column.id,
        direction: current.direction === "asc" ? "desc" : "asc",
      };
    });
  }, []);

  const totalPages =
    pagination && "page" in pagination
      ? Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.pageSize)))
      : 1;
  const currentPage = pagination && "page" in pagination ? pagination.page : 1;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table stickyHeader>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => {
                const isSorted = sort?.id === column.id;
                return (
                  <TableHead
                    key={column.id}
                    aria-sort={
                      isSorted
                        ? sort?.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={cn(
                      "h-8 bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground",
                      ALIGN_CLASSES[column.align ?? "start"],
                      column.mono && "font-mono tabular-nums"
                    )}
                    {...(column.width ? { style: { width: column.width } } : {})}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className="inline-flex items-center gap-1.5 hover:text-foreground"
                      >
                        <span>{column.header}</span>
                        {isSorted ? (
                          sort?.direction === "asc" ? (
                            <ArrowUp className="size-3 text-primary" />
                          ) : (
                            <ArrowDown className="size-3 text-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, rowIndex) => (
                <TableRow key={`skeleton-row-${rowIndex}`} className="hover:bg-transparent">
                  {columns.map((column) => (
                    <TableCell key={column.id}>
                      <Skeleton className="h-3.5 w-full max-w-24" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : sortedRows.length > 0 ? (
              sortedRows.map((row) => {
                const isSelected = selectedId !== undefined && getRowId(row) === selectedId;
                return (
                  <TableRow
                    key={getRowId(row)}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={() => onRowClick?.(row)}
                    className={cn(onRowClick && "cursor-pointer", isSelected && "bg-muted")}
                  >
                    {columns.map((column) => (
                      <TableCell
                        key={column.id}
                        className={cn(
                          "text-xs",
                          ALIGN_CLASSES[column.align ?? "start"],
                          column.mono && "font-mono tabular-nums"
                        )}
                      >
                        {column.accessor?.(row) ?? null}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0">
                  {emptyState ?? (
                    <EmptyState
                      icon={<Inbox className="size-10 text-muted-foreground/60" />}
                      title="No results found"
                      description="Try adjusting your filters or search criteria."
                      className="min-h-44 border-0 bg-transparent"
                    />
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-1 pt-1 text-xs text-muted-foreground">
          {"page" in pagination ? (
            <>
              <span className="tabular-nums">
                Page {currentPage} of {totalPages}
                <span className="hidden sm:inline"> · {pagination.total} total</span>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pagination.onPageChange(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  <ChevronLeft className="size-3.5 me-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pagination.onPageChange(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  Next
                  <ChevronRight className="size-3.5 ms-1" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <span />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pagination.onPrev?.()}
                  disabled={!pagination.cursor || !pagination.onPrev}
                >
                  <ChevronLeft className="size-3.5 me-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pagination.onNext?.()}
                  disabled={!pagination.nextCursor || !pagination.onNext}
                >
                  Next
                  <ChevronRight className="size-3.5 ms-1" />
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
