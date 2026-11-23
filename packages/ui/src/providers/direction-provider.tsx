"use client";

import * as React from "react";
import { DirectionProvider as RadixDirectionProvider } from "@radix-ui/react-direction";

export interface VellumDirectionProviderProps {
  children: React.ReactNode;
  dir: "ltr" | "rtl";
}

/**
 * Supplies Radix's direction context and mirrors the direction onto <html>
 * (`dir` + `lang`) so the `[dir="rtl"]` Arabic font stack and logical CSS
 * properties take effect.
 */
export function VellumDirectionProvider({
  children,
  dir,
}: VellumDirectionProviderProps): React.JSX.Element {
  React.useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const root: HTMLElement = document.documentElement;
    root.dir = dir;
    root.lang = dir === "rtl" ? "ar" : "en";
  }, [dir]);

  return <RadixDirectionProvider dir={dir}>{children}</RadixDirectionProvider>;
}
