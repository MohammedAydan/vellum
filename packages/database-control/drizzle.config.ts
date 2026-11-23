import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.CONTROL_DATABASE_URL || "postgresql://vellum_control:control_secret@localhost:5432/control_db",
  },
});
