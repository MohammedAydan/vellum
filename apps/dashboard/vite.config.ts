import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Customer Dashboard is served at the origin root on the unified gateway.
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../packages/ui/src"),
      "@vellum/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@vellum/core": path.resolve(__dirname, "../../packages/core/src"),
      "@vellum/api-contract": path.resolve(__dirname, "../../packages/api-contract/src"),
      "@vellum/database-control": path.resolve(__dirname, "../../packages/database-control/src"),
    },
  },
  // Cloudflare quick-tunnel hostnames (and any custom tunnel domain) must be
  // allowed in preview mode, otherwise Vite answers 403 to public requests.
  preview: {
    host: "0.0.0.0",
    allowedHosts: [".trycloudflare.com"],
    // The SPA calls the API at its own origin; proxy /v1 (including WS) to the
    // local API so a public tunnel needs no CORS changes or hardcoded host.
    proxy: {
      "/v1": { target: "http://127.0.0.1:8080", changeOrigin: true, ws: true },
    },
  },
  server: {
    port: 5173,
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/v1": {
        target: process.env.VITE_API_BASE_URL || "http://localhost:8080",
        changeOrigin: true,
      },
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
