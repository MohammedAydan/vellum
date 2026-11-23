import * as React from "react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "../lib/cn.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.js";

export interface TimestampDisplayProps
  extends React.HTMLAttributes<HTMLTimeElement> {
  date: Date | string | number;
  relative?: boolean;
  dateFormat?: string;
}

export function TimestampDisplay({
  date,
  relative = true,
  dateFormat = "yyyy-MM-dd HH:mm:ss 'UTC'",
  className,
  ...props
}: TimestampDisplayProps) {
  const dateObj = React.useMemo(() => {
    if (date instanceof Date) return date;
    return new Date(date);
  }, [date]);

  const isValid = !isNaN(dateObj.getTime());

  if (!isValid) {
    return <span className={cn("text-muted-foreground", className)}>Invalid date</span>;
  }

  const iso = dateObj.toISOString();
  const formatted = format(dateObj, dateFormat);
  const relativeText = `${formatDistanceToNow(dateObj, { addSuffix: true })}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={iso}
            data-slot="timestamp-display"
            className={cn("cursor-help font-mono text-xs text-muted-foreground tabular-nums", className)}
            {...props}
          >
            {relative ? relativeText : formatted}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs space-y-0.5">
            <p className="font-semibold">{iso}</p>
            <p className="text-muted-foreground">{formatted}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
