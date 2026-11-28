import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  checksumOfSql,
  controlMigrationsDir,
  dataMigrationsDir,
  listMigrationFiles,
  type RawPgClient,
} from "@vellum/database-control";
import {
  healthRoutes,
  setReadinessProbe,
  resetReadinessRateLimits,
  reportDatabaseConnectivityFailure,
} from "../routes/health.js";
import { defaultReadinessProbe } from "../composition/root.js";
import { errorHandler } from "../middleware/error-handler.js";
import { requestId } from "../middleware/request-id.js";

/**
 * Health hardening (0.0.9): the unauthenticated readiness endpoint is a strict
 * public projection, the deprecated /health never reports "ok" while a plane
 * is down, liveness never touches the database, and database-connectivity
 * failures map to structured 503s.
 */

function installProbe(options: { failData?: boolean; throwIfCalled?: boolean } = {}) {
  setReadinessProbe({
    async withClient(config, work) {
      if (options.throwIfCalled) {
        throw new Error("readiness probe must not run for liveness");
      }
      if (options.failData && config.connectionString.includes("data")) {
        throw Object.assign(new Error("Your account or project has exceeded the quota"), { code: "53000" });
      }
      const data = config.connectionString.includes("data");
      const directory = data ? dataMigrationsDir() : controlMigrationsDir();
      const appliedRows = listMigrationFiles(directory).map((name) => ({
        filename: name,
        applied_at: new Date(0),
        checksum: checksumOfSql(fs.readFileSync(path.join(directory, name), "utf8")),
      }));
      const client = {
        query: async (sql: string) => {
          if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
          if (sql.includes("FROM schema_migrations")) return { rows: appliedRows };
          return { rows: [{ probe_ok: 1, backend_pid: 42, server_version: "18.1" }] };
        },
      } as unknown as RawPgClient;
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
  vi.stubEnv("NODE_ENV", "production");
  resetReadinessRateLimits();
});
afterEach(() => {
  setReadinessProbe(defaultReadinessProbe);
  vi.unstubAllEnvs();
});

describe("health endpoint hardening", () => {
  it("readiness is a strict public projection: no filenames, checksums, SQL, PIDs or error codes", async () => {
    installProbe();
    const res = await healthRoutes.fetch(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(".sql");
    expect(raw).not.toContain("checksum");
    expect(raw).not.toContain("SELECT");
    expect(raw).not.toContain("backend_pid");
    expect(raw).not.toContain("server_version");
    expect(raw).not.toContain("53000");
    expect(raw).not.toContain("applied_at");
  });

  it("readiness reports unready + 503 when the data plane is down, without leaking the SQLSTATE", async () => {
    installProbe({ failData: true });
    const res = await healthRoutes.fetch(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; checks: Record<string, { state: string }> };
    expect(body.ready).toBe(false);
    expect(body.checks["dataDb"]?.state).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("53000");
  });

  it("deprecated /health reports degraded + 503 when a plane is disconnected", async () => {
    installProbe({ failData: true });
    const res = await healthRoutes.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; planes: Record<string, string> };
    expect(body.status).toBe("degraded");
    expect(body.planes["dataDb"]).toBe("disconnected");
  });

  it("deprecated /health reports ok when all planes are connected", async () => {
    installProbe();
    const res = await healthRoutes.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("liveness never touches the database", async () => {
    installProbe({ throwIfCalled: true });
    const res = await healthRoutes.fetch(new Request("http://localhost/health/live"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });

  it("a connect-class DB error on a real request flips cached readiness immediately", async () => {
    const options = { failData: false };
    installProbe(options);
    const ok = await healthRoutes.fetch(new Request("http://localhost/health/ready"));
    expect(ok.status).toBe(200);
    // The database falls over; a real request surfaces a connect-class error
    // and the error handler reports it, expiring the healthy cache on the spot.
    options.failData = true;
    reportDatabaseConnectivityFailure();
    const res = await healthRoutes.fetch(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; checks: Record<string, { state: string }> };
    expect(body.ready).toBe(false);
    expect(body.checks["dataDb"]?.state).toBe("failed");
  });

  it("rate-limits unauthenticated readiness floods", async () => {
    installProbe();
    let last: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      last = await healthRoutes.fetch(new Request("http://localhost/health/ready"));
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });
});

describe("database-connectivity error mapping", () => {
  async function requestFor(thrown: unknown): Promise<Response> {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/boom", () => {
      throw thrown;
    });
    return app.fetch(new Request("http://localhost/boom"));
  }

  it("maps SQLSTATE 53000 to structured 503 with Retry-After", async () => {
    const res = await requestFor(Object.assign(new Error("quota exceeded"), { code: "53000" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("maps ECONNREFUSED (nested in cause) to 503", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const res = await requestFor(Object.assign(new Error("query failed"), { cause }));
    expect(res.status).toBe(503);
  });

  it("maps pg pool connect timeout messages to 503", async () => {
    const res = await requestFor(new Error("timeout exceeded when trying to connect"));
    expect(res.status).toBe(503);
  });

  it("leaves ordinary errors as 500 INTERNAL", async () => {
    const res = await requestFor(new Error("some other failure"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL");
  });
});

// Recipe 5 (P0-4): a data_db outage on any data/realtime route is a JSON 503 with Retry-After and X-Request-Id.
describe("data_db outage on data and realtime routes", () => {
  it.each([
    ["PUT", "/v1/projects/p/documents/presence/u1"],
    ["POST", "/v1/projects/p/batchWrite"],
    ["POST", "/v1/realtime/stream"],
  ])("%s %s returns structured 503, never a text/plain 500/502", async (method, route) => {
    const app = new Hono();
    app.use("*", requestId());
    app.onError(errorHandler);
    app.all("*", () => {
      throw Object.assign(new Error("Your account or project has exceeded the quota"), { code: "53000" });
    });
    const res = await app.fetch(new Request(`http://localhost${route}`, { method }));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    const raw = await res.text();
    expect(raw).not.toContain("53000");
    expect(JSON.parse(raw).error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
