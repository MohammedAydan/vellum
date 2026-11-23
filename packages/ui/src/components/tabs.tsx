import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/cn"

export type TabsVariant = "default" | "line" | "underline" | "pills"

const TabsVariantContext = React.createContext<TabsVariant>("underline")

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & {
    orientation?: "horizontal" | "vertical"
    variant?: TabsVariant
  }
>(({ className, orientation = "horizontal", variant = "underline", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.Root
      ref={ref}
      data-slot="tabs"
      data-orientation={orientation}
      data-variant={variant}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  </TabsVariantContext.Provider>
))
Tabs.displayName = TabsPrimitive.Root.displayName

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        /** Supabase-style page sub-navigation — a single bottom rule. */
        underline: "gap-1 rounded-none border-b border-border bg-transparent px-0.5",
        /** Segmented control — a muted track with elevated active segment. */
        pills: "gap-1 rounded-lg bg-muted p-1",
      },
    },
    defaultVariants: {
      variant: "underline",
    },
  }
)

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> &
    VariantProps<typeof tabsListVariants>
>(({ className, variant, ...props }, ref) => {
  const contextVariant = React.useContext(TabsVariantContext)
  const resolvedVariant = variant ?? contextVariant ?? "underline"
  return (
    <TabsPrimitive.List
      ref={ref}
      data-slot="tabs-list"
      data-variant={resolvedVariant}
      className={cn(tabsListVariants({ variant: resolvedVariant }), className)}
      {...props}
    />
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

const underlineTriggerClasses = [
  "group-data-[variant=underline]/tabs-list:rounded-none",
  "group-data-[variant=underline]/tabs-list:border-0",
  "group-data-[variant=underline]/tabs-list:bg-transparent!",
  "group-data-[variant=underline]/tabs-list:px-3",
  "group-data-[variant=underline]/tabs-list:shadow-none!",
  "group-data-[variant=underline]/tabs-list:text-muted-foreground",
  "group-data-[variant=underline]/tabs-list:data-[state=active]:bg-transparent!",
  "group-data-[variant=underline]/tabs-list:data-[state=active]:text-foreground",
  "group-data-[variant=underline]/tabs-list:after:bottom-[-1px]!",
  "group-data-[variant=underline]/tabs-list:after:h-0.5!",
  "group-data-[variant=underline]/tabs-list:after:bg-primary!",
  "group-data-[variant=underline]/tabs-list:data-[state=active]:after:opacity-100",
].join(" ")

const pillsTriggerClasses = [
  "group-data-[variant=pills]/tabs-list:rounded-md",
  "group-data-[variant=pills]/tabs-list:data-[state=active]:bg-background",
  "group-data-[variant=pills]/tabs-list:data-[state=active]:text-foreground",
  "group-data-[variant=pills]/tabs-list:data-[state=active]:shadow-sm",
  "group-data-[variant=pills]/tabs-list:data-[state=active]:after:opacity-0",
].join(" ")

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pe-1 has-data-[icon=inline-start]:ps-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
      "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
      "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-end-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
      underlineTriggerClasses,
      pillsTriggerClasses,
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    data-slot="tabs-content"
    className={cn("flex-1 text-sm outline-none", className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
}
