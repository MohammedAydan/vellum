import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/cn"

export interface SpinnerProps extends React.ComponentProps<"svg"> {
  size?: "sm" | "default" | "lg" | string
}

const sizeMap: Record<string, string> = {
  sm: "size-3",
  default: "size-4",
  lg: "size-6",
}

function Spinner({ className, size = "default", ...props }: SpinnerProps) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("animate-spin", sizeMap[size] || "size-4", className)}
      {...props}
    />
  )
}

export { Spinner }
