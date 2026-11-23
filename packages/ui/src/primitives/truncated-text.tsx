import * as React from "react";
import { cn } from "../lib/cn.js";
import { CopyButton } from "./copy-button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.js";

export interface TruncatedTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  maxLength?: number;
  copyable?: boolean;
}

export function TruncatedText({
  text,
  maxLength = 24,
  copyable = false,
  className,
  ...props
}: TruncatedTextProps) {
  const needsTruncation = text.length > maxLength;
  const displayed = needsTruncation
    ? `${text.slice(0, Math.floor(maxLength / 2))}…${text.slice(-Math.ceil(maxLength / 2))}`
    : text;

  return (
    <span data-slot="truncated-text" className={cn("inline-flex items-center gap-1.5 font-mono text-xs tabular-nums", className)} {...props}>
      {needsTruncation ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {displayed}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-mono text-xs select-all">{text}</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span>{displayed}</span>
      )}
      {copyable ? <CopyButton value={text} className="size-6 p-0" /> : null}
    </span>
  );
}
