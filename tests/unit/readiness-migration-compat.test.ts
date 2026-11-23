import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checksumOfSql, controlMigrationsDir, dataMigrationsDir,
  isMigrationChecksumCompatible, listMigrationFiles, type RawPgClient,
} from "@vellum/database-control";
import { healthRoutes, setReadinessProbe } from "../../apps/api/src/routes/health.js";
import { defaultReadinessProbe } from "../../apps/api/src/composition/root.js";

const historical = "636e94d843980b47344ba6edc43d187959d4db3887ab65a9a09670d098d2ec06";
const replacement = "aab0460c41b187ae7119caa508892c7fb04f152c1fe9af5d1ccd3d4442840720";
const filename = "0013_vellum_rebrand.sql";

function installProbe(options: { drift?: string; missingRepair?: boolean } = {}) {
  setReadinessProbe({
    async withClient(config, work) {
      const data = config.connectionString.includes("data");
      const directory = data ? dataMigrationsDir() : controlMigrationsDir();
      const rows = listMigrationFiles(directory)
        .filter((name) => !(data && options.missingRepair && name.startsWith("0014_")))
        .map((name) => ({
          filename: name,
          applied_at: new Date(0),
          checksum: data && name === filename
            ? options.drift ?? historical
            : checksumOfSql(fs.readFileSync(path.join(directory, name), "utf8")),
        }));
      const client = { query: async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
        if (sql.includes("FROM schema_migrations")) return { rows };
        return { rows: [{ probe_ok: 1, backend_pid: 1, server_version: "18" }] };
      } } as unknown as RawPgClient;
      return work(client);
    },
  });
}

beforeEach(() => {
  vi.stubEnv("DATABASE_MODE", "postgres");
  vi.stubEnv("CONTROL_DATABASE_URL", "postgres://control");
  vi.stubEnv("DATA_DATABASE_URL", "postgres://data");
  vi.stubEnv("CONTROL_DATABASE_URL_DIRECT", "");
  vi.stubEnv("DATA_DATABASE_URL_DIRECT", "");
  vi.stubEnv("DATA_DATABASE_URL_LISTEN", "postgres://data");
});
afterEach(() => {
  setReadinessProbe(defaultReadinessProbe);
  vi.unstubAllEnvs();
});

describe("historical migration repair readiness", () => {
  it("shares only the exact data-plane checksum exception with the migrator", () => {
    expect(checksumOfSql(fs.readFileSync(path.join(dataMigrationsDir(), filename), "utf8"))).toBe(replacement);
    expect(isMigrationChecksumCompatible("data_db", filename, historical, replacement)).toBe(true);
    expect(isMigrationChecksumCompatible("control_db", filename, historical, replacement)).toBe(false);
    expect(isMigrationChecksumCompatible("data_db", "0012.sql", historical, replacement)).toBe(false);
    expect(isMigrationChecksumCompatible("data_db", filename, replacement, historical)).toBe(false);
    expect(isMigrationChecksumCompatible("data_db", filename, historical, "f".repeat(64))).toBe(false);
  });
  it("returns 200 with the historical 0013 ledger and applied 0014 repair", async () => {
    installProbe();
    const response = await healthRoutes.request("/health/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, checks: { dataMigrations: { drift: [], missing: [] } } });
  });
  it("still returns 503 for any unrecognized checksum drift", async () => {
    installProbe({ drift: "f".repeat(64) });
    const response = await healthRoutes.request("/health/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, checks: { dataMigrations: { drift: [filename] } } });
  });
  it("still returns 503 if forward repair 0014 has not been applied", async () => {
    installProbe({ missingRepair: true });
    const response = await healthRoutes.request("/health/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, checks: { dataMigrations: { missing: ["0014_shared_cluster_role_convergence.sql"] } } });
  });
});
