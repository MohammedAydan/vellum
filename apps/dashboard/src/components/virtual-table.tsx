import * as React from "react";
import { cn, useI18n } from "@vellum/ui";

export interface VirtualTableColumn<T> {
  header: string;
  className?: string;
  render: (row: T) => React.ReactNode;
}

export interface VirtualTableProps<T> {
  rows: T[];
  columns: Array<VirtualTableColumn<T>>;
  rowHeight?: number;
  height?: number;
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  emptyMessage?: string;
}

export interface VirtualWindowRange {
  start: number;
  end: number;
  totalHeight: number;
  safeRowHeight: number;
  safeViewportHeight: number;
  clampedScrollTop: number;
}

const DEFAULT_ROW_HEIGHT = 40;
const DEFAULT_VIEWPORT_HEIGHT = 420;
const DEFAULT_OVERSCAN = 6;

/**
 * Pure windowing calculation with defensive guards against 0 rows,
 * negative/NaN/Infinity dimensions, and out-of-range scroll offsets.
 */
export function computeVirtualWindow(params: {
  rowCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): VirtualWindowRange {
  const safeRowCount =
    Number.isFinite(params.rowCount) && params.rowCount > 0
      ? Math.floor(params.rowCount)
      : 0;
  const safeRowHeight =
    Number.isFinite(params.rowHeight) && params.rowHeight > 0
      ? params.rowHeight
      : DEFAULT_ROW_HEIGHT;
  const safeViewportHeight =
    Number.isFinite(params.viewportHeight) && params.viewportHeight > 0
      ? params.viewportHeight
      : DEFAULT_VIEWPORT_HEIGHT;
  const safeOverscan =
    params.overscan !== undefined && Number.isFinite(params.overscan) && params.overscan >= 0
      ? Math.floor(params.overscan)
      : DEFAULT_OVERSCAN;

  const totalHeight = safeRowCount * safeRowHeight;
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const clampedScrollTop = Number.isFinite(params.scrollTop)
    ? Math.min(Math.max(0, params.scrollTop), maxScrollTop)
    : 0;

  if (safeRowCount === 0) {
    return {
      start: 0,
      end: 0,
      totalHeight: 0,
      safeRowHeight,
      safeViewportHeight,
      clampedScrollTop: 0,
    };
  }

  const start = Math.max(0, Math.floor(clampedScrollTop / safeRowHeight) - safeOverscan);
  const visibleCount = Math.ceil(safeViewportHeight / safeRowHeight) + safeOverscan * 2;
  const end = Math.min(safeRowCount, start + visibleCount);

  return {
    start,
    end,
    totalHeight,
    safeRowHeight,
    safeViewportHeight,
    clampedScrollTop,
  };
}

/**
 * Lightweight windowed table. Only the rows intersecting the viewport are
 * mounted, so large document pages stay cheap to render.
 * Row height is fixed; column widths come from the caller's class names.
 */
export function VirtualTable<T>({
  rows,
  columns,
  rowHeight = DEFAULT_ROW_HEIGHT,
  height = DEFAULT_VIEWPORT_HEIGHT,
  getRowKey,
  onRowClick,
  selectedKey,
  emptyMessage,
}: VirtualTableProps<T>) {
  const { t } = useI18n();
  const resolvedEmptyMessage = emptyMessage ?? t("common.noRows");
  const safeRows = React.useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);
  const safeColumns = React.useMemo(() => (Array.isArray(columns) ? columns : []), [columns]);
  const [scrollTop, setScrollTop] = React.useState(0);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);

  const windowRange = React.useMemo(
    () =>
      computeVirtualWindow({
        rowCount: safeRows.length,
        rowHeight,
        viewportHeight: height,
        scrollTop,
        overscan: DEFAULT_OVERSCAN,
      }),
    [safeRows.length, rowHeight, height, scrollTop]
  );

  // When the dataset shrinks below the previous scroll offset, clamp smoothly.
  React.useEffect(() => {
    if (scrollTop !== windowRange.clampedScrollTop) {
      setScrollTop(windowRange.clampedScrollTop);
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = windowRange.clampedScrollTop;
      }
    }
  }, [scrollTop, windowRange.clampedScrollTop]);

  const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const raw = e.currentTarget.scrollTop;
    const next = Number.isFinite(raw) && raw > 0 ? raw : 0;
    setScrollTop((prev) => (prev === next ? prev : next));
  }, []);

  const gridTemplateColumns = React.useMemo(
    () => `repeat(${Math.max(1, safeColumns.length)}, minmax(0, 1fr))`,
    [safeColumns.length]
  );

  const visible = React.useMemo(
    () => safeRows.slice(windowRange.start, windowRange.end),
    [safeRows, windowRange.start, windowRange.end]
  );

  if (safeRows.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
        {resolvedEmptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div
        className="grid items-center border-b bg-muted/40 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        style={{ gridTemplateColumns, height: windowRange.safeRowHeight }}
      >
        {safeColumns.map((col, i) => (
          <span key={`col-hdr-${i}-${col.header}`} className={cn("truncate", col.className)}>
            {col.header}
          </span>
        ))}
      </div>
      <div
        ref={scrollContainerRef}
        role="list"
        className="overflow-y-auto"
        style={{ height: windowRange.safeViewportHeight }}
        onScroll={handleScroll}
        data-testid="virtual-table-scroll"
      >
        <div style={{ height: windowRange.totalHeight, position: "relative" }}>
          {visible.map((row, offset) => {
            const index = windowRange.start + offset;
            const rawKey = getRowKey(row, index);
            const key = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : `row-${index}`;
            const selected = selectedKey != null && key === selectedKey;
            return (
              <div
                key={key}
                role="listitem"
                data-testid="document-row"
                {...(onRowClick ? { onClick: () => onRowClick(row) } : {})}
                className={cn(
                  "absolute left-0 right-0 grid items-center border-b px-3 text-xs transition-colors last:border-0",
                  onRowClick && "cursor-pointer hover:bg-muted/50",
                  selected && "bg-primary/10"
                )}
                style={{
                  top: index * windowRange.safeRowHeight,
                  height: windowRange.safeRowHeight,
                  gridTemplateColumns,
                }}
              >
                {safeColumns.map((col, i) => (
                  <span key={`${key}-col-${i}`} className={cn("truncate", col.className)}>
                    {col.render(row)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
