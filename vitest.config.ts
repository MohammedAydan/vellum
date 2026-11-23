import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Explicit subpath aliases MUST precede their base package aliases:
      // Vite string aliases are prefix matches, so `@vellum/storage` alone
      // would rewrite `@vellum/storage/adapters` to a non-existent path.
      "@vellum/database-control/adapters": path.resolve(__dirname, "packages/database-control/src/adapters.ts"),
      "@vellum/database-control/contracts": path.resolve(__dirname, "packages/database-control/src/contracts/control-port.ts"),
      "@vellum/database-control/schema": path.resolve(__dirname, "packages/database-control/src/schema.ts"),
      "@vellum/storage/adapters": path.resolve(__dirname, "packages/storage/src/adapters.ts"),
      "@vellum/storage/contracts": path.resolve(__dirname, "packages/storage/src/contracts/storage-port.ts"),
      "@vellum/realtime/pubsub": path.resolve(__dirname, "packages/realtime/src/pg-notify-pubsub.ts"),
      "@vellum/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@vellum/api-contract": path.resolve(__dirname, "packages/api-contract/src/index.ts"),
      "@vellum/database-control": path.resolve(__dirname, "packages/database-control/src/index.ts"),
      "@vellum/database-data": path.resolve(__dirname, "packages/database-data/src/index.ts"),
      "@vellum/storage": path.resolve(__dirname, "packages/storage/src/index.ts"),
      "@vellum/authorization": path.resolve(__dirname, "packages/authorization/src/index.ts"),
      "@vellum/auth": path.resolve(__dirname, "packages/auth/src/index.ts"),
      "@vellum/query-engine": path.resolve(__dirname, "packages/query-engine/src/index.ts"),
      "@vellum/document-engine": path.resolve(__dirname, "packages/document-engine/src/index.ts"),
      "@vellum/realtime": path.resolve(__dirname, "packages/realtime/src/index.ts"),
      "@vellum/observability": path.resolve(__dirname, "packages/observability/src/index.ts"),
      "@vellum/security": path.resolve(__dirname, "packages/security/src/index.ts"),
      "@vellum/billing": path.resolve(__dirname, "packages/billing/src/index.ts"),
      "@vellumdb/sdk-js": path.resolve(__dirname, "packages/sdk-js/src/index.ts"),
      "@vellum/ui": path.resolve(__dirname, "packages/ui/src/index.ts"),
      "@vellum/api": path.resolve(__dirname, "apps/api/src/index.ts"),
      "@vellum/dashboard": path.resolve(__dirname, "apps/dashboard/src/index.ts"),
      "@vellum/admin": path.resolve(__dirname, "apps/admin/src/index.ts"),
      "@": path.resolve(__dirname, "packages/ui/src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: true,
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
