"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ style, toastOptions, ...props }: ToasterProps) => {
  const { theme: activeTheme = "system" } = useTheme()
  // `useTheme` returns an arbitrary string; Sonner accepts only these literals.
  const theme =
    activeTheme === "light" || activeTheme === "dark"
      ? activeTheme
      : "system"

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "group toast group-[.toaster]:border-border group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg",
          title: "font-medium text-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success:
            "group-[.toaster]:border-success-500/30 group-[.toaster]:bg-success-500/10 group-[.toaster]:text-success-700 dark:group-[.toaster]:text-success-300",
          error:
            "group-[.toaster]:border-destructive/30 group-[.toaster]:bg-destructive/10 group-[.toaster]:text-destructive",
          warning:
            "group-[.toaster]:border-warning-500/30 group-[.toaster]:bg-warning-500/10 group-[.toaster]:text-warning-700 dark:group-[.toaster]:text-warning-300",
          info: "group-[.toaster]:border-info-500/30 group-[.toaster]:bg-info-500/10 group-[.toaster]:text-info-700 dark:group-[.toaster]:text-info-300",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export { Toaster, Sonner }
