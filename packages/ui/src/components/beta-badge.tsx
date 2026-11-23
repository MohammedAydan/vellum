import * as React from "react"

import { cn } from "@/lib/cn"

import { Badge } from "./badge.js"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip.js"

export interface BetaBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Visible label; defaults to the canonical uppercase "BETA". */
  label?: string
  /**
   * Optional explanation shown in a tooltip on hover/focus. Pass a localised
   * string from the host app's dictionary so EN/AR stay in sync. When omitted
   * the badge renders without a tooltip.
   */
  description?: string
}

/**
 * Product-stage marker shown next to the brand in every surface (console,
 * admin, docs) while VELLUM is in public beta. Renders the shared warning
 * badge variant so it reads consistently in light and dark themes, and uses
 * logical spacing only, so it is safe inside RTL (Arabic) layouts.
 */
function BetaBadge({
  label = "BETA",
  description,
  className,
  ...props
}: BetaBadgeProps): React.JSX.Element {
  const badge = (
    <Badge
      variant="warning"
      aria-label={description ?? label}
      className={cn(
        "cursor-default px-1.5 text-[9px] font-bold tracking-[0.1em] uppercase",
        className
      )}
      {...props}
    >
      {label}
    </Badge>
  )

  if (!description) return badge

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-56 text-center">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { BetaBadge }
