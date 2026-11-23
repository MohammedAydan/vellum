import * as React from "react";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table.js";
import { Button } from "../components/button.js";
import { Skeleton } from "../components/skeleton.js";
import { ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "../lib/cn.js";
import { EmptyState, type EmptyStateProps } from "./empty-state.js";

export interface CursorPageInfo {
  nextCursor?: string | null;
  previousCursor?: string | null;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  isFetching?: boolean;
}

export interface DataGridCursorPagination {
  mode: "cursor";
  pageInfo?: CursorPageInfo;
  onNext?: (cursor: string) => void;
  onPrevious?: (cursor: string) => void;
  label?: string;
}

export interface DataGridProps<TData, TValue = unknown> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pageSize?: number;
  onRowClick?: (row: TData) => void;
  selectedRowId?: string | null;
  getRowId?: (row: TData) => string;
  className?: string;
  emptyMessage?: string;
  toolbar?: React.ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  emptyState?: React.ReactNode | EmptyStateProps;
  stickyHeader?: boolean;
  pagination?: DataGridCursorPagination;
}

function isEmptyStateProps(
  value: React.ReactNode | EmptyStateProps
): value is EmptyStateProps {
  return (
    typeof value === "object" &&
    value !== null &&
    !React.isValidElement(value) &&
    "title" in value &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

export function DataGrid<TData, TValue = unknown>({
  columns,
  data,
  pageSize = 10,
  onRowClick,
  selectedRowId,
  getRowId,
  className,
  emptyMessage = "No results found.",
  toolbar,
  loading = false,
  skeletonRows = 5,
  emptyState,
  stickyHeader = true,
  pagination,
}: DataGridProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    state: {
      sorting,
    },
    initialState: {
      pagination: {
        pageSize,
      },
    },
    ...(getRowId ? { getRowId } : {}),
  });

  const rows = table.getRowModel().rows;
  const isFetching = pagination?.pageInfo?.isFetching === true;
  const nextCursor = pagination?.pageInfo?.nextCursor;
  const previousCursor = pagination?.pageInfo?.previousCursor;
  const hasNext =
    (pagination?.pageInfo?.hasNextPage ?? Boolean(nextCursor)) &&
    Boolean(nextCursor);
  const hasPrevious =
    (pagination?.pageInfo?.hasPreviousPage ?? Boolean(previousCursor)) &&
    Boolean(previousCursor);

  const renderedEmptyState = React.useMemo(() => {
    if (emptyState === undefined) {
      return (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      );
    }
    if (isEmptyStateProps(emptyState)) {
      return <EmptyState {...emptyState} />;
    }
    return emptyState;
  }, [emptyState, emptyMessage]);

  return (
    <div className={cn("space-y-4", className)}>
      {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      <div className="overflow-hidden rounded-md border bg-card">
        <Table stickyHeader={stickyHeader}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const isSorted = header.column.getIsSorted();

                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground"
                        >
                          <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          {isSorted === "asc" ? (
                            <ArrowUp className="size-3.5 text-primary" />
                          ) : isSorted === "desc" ? (
                            <ArrowDown className="size-3.5 text-primary" />
                          ) : (
                            <ArrowUpDown className="size-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: skeletonRows }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`}>
                  {columns.map((_, colIndex) => (
                    <TableCell key={`skeleton-${rowIndex}-${colIndex}`}>
                      <Skeleton className="h-4 w-full max-w-28" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((row) => {
                const isSelected = selectedRowId !== undefined && getRowId
                  ? getRowId(row.original) === selectedRowId
                  : row.getIsSelected();
                return (
                  <TableRow
                    key={row.id}
                    data-state={isSelected ? "selected" : undefined}
                    onClick={() => onRowClick?.(row.original)}
                    className={cn(
                      onRowClick && "cursor-pointer hover:bg-muted/50",
                      isSelected && "bg-muted"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  {renderedEmptyState}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination ? (
        <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
          {pagination.label ? <span>{pagination.label}</span> : <span />}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => previousCursor && pagination.onPrevious?.(previousCursor)}
              disabled={!hasPrevious || isFetching}
            >
              <ChevronLeft className="size-3.5 me-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nextCursor && pagination.onNext?.(nextCursor)}
              disabled={!hasNext || isFetching}
            >
              Next
              <ChevronRight className="size-3.5 ms-1" />
            </Button>
          </div>
        </div>
      ) : table.getPageCount() > 1 ? (
        <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
          <div>
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()} (
            {table.getFilteredRowModel().rows.length} rows)
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="size-3.5 me-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
              <ChevronRight className="size-3.5 ms-1" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
