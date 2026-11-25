import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

const rootVersion: string = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
).version;

export default defineConfig({
  // Documentation is served under `/docs/` on the unified gateway; this
  // rewrites built asset URLs (e.g. /docs/assets/*.js), not SPA routes.
  base: "/docs/",
  // The version badge follows the repository version, so a release bump needs no docs edit.
  define: { __VELLUM_VERSION__: JSON.stringify(rootVersion) },
  // The shared design system ships Tailwind v4 CSS. The plugin must run before
  // Vite's CSS pipeline so the `@import "tailwindcss"` in @vellum/ui/index.css
  // and every logical utility class used by the shared patterns are compiled.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../packages/ui/src"),
      "@vellum/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 600 },
});
