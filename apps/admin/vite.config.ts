import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Platform Admin Console is served under `/admin/` on the unified gateway.
  // This rewrites built asset URLs (e.g. /admin/assets/*.js), not SPA routes.
  base: "/admin/",
  // Cloudflare quick-tunnel hostnames (and any custom tunnel domain) must be
  // allowed in preview mode, otherwise Vite answers 403 to public requests.
  preview: {
    host: "0.0.0.0",
    allowedHosts: [".trycloudflare.com"],
    // Same-origin API + WebSocket proxy so the public tunnel works without CORS.
    proxy: {
      "/v1": { target: "http://127.0.0.1:8080", changeOrigin: true, ws: true },
    },
  },
  server: {
    port: 5174,
    allowedHosts: [".trycloudflare.com"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../packages/ui/src"),
      "@vellum/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@vellum/core": path.resolve(__dirname, "../../packages/core/src"),
      "@vellum/api-contract": path.resolve(__dirname, "../../packages/api-contract/src"),
      "@vellum/database-control": path.resolve(__dirname, "../../packages/database-control/src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack")) {
            return "vendor-tanstack";
          }
          if (id.includes("recharts")) {
            return "vendor-recharts";
          }
          if (id.includes("codemirror") || id.includes("@codemirror") || id.includes("@uiw")) {
            return "vendor-codemirror";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
        },
      },
    },
  },
});
