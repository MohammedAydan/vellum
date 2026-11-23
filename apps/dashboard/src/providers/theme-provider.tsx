import * as React from "react";
import { VellumThemeProvider } from "@vellum/ui";

/**
 * Backwards-compatible wrapper around the shared theme provider. New code
 * imports `VellumThemeProvider` from `@vellum/ui` directly; this keeps the old
 * local provider import path working for any legacy consumer.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <VellumThemeProvider defaultTheme="dark">{children}</VellumThemeProvider>;
}
