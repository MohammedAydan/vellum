/**
 * Live bootstrap for the JS/TS SDK testbed.
 *
 * Provisions an isolated organization + project + API keys + security ruleset
 * over real HTTP (global fetch). No mocks, no database clients, no simulations.
 * Every value that could identify a credential is kept in memory and is never
 * written to stdout or to an error message.
 */
import { randomUUID } from "node:crypto";

/** The v1 rules AST installed for every run. */
export const TESTBED_RULES_AST = {
  version: 1,
  rules: [
    {
      // Automatic projection writes use a system bypass; developer reads and
      // writes of their own projected document are allowed.
      match: "users/{userId}",
      allow: {
        get: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
        list: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
        create: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
        update: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
        delete: false,
      },
    },
    {
      // Signed-in users may read; only the owner may mutate a task.
      match: "tasks/{taskId}",
      allow: {
        get: { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
        list: { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
        create: { op: "==", left: { var: "request.data.ownerId" }, right: { var: "auth.uid" } },
        update: { op: "==", left: { var: "resource.data.ownerId" }, right: { var: "auth.uid" } },
        delete: { op: "==", left: { var: "resource.data.ownerId" }, right: { var: "auth.uid" } },
      },
    },
    {
      // Claim-gated collection used by the custom-claims scenario.
      match: "admin_reports/{reportId}",
      allow: {
        get: {
          op: "all",
          conditions: [
            { op: "==", left: { var: "auth.claims.role" }, right: { val: "moderator" } },
            { op: ">=", left: { var: "auth.claims.clearance" }, right: { val: 3 } },
          ],
        },
        list: {
          op: "all",
          conditions: [
            { op: "==", left: { var: "auth.claims.role" }, right: { val: "moderator" } },
            { op: ">=", left: { var: "auth.claims.clearance" }, right: { val: 3 } },
          ],
        },
        create: {
          op: "all",
          conditions: [
            { op: "==", left: { var: "auth.claims.role" }, right: { val: "moderator" } },
            { op: ">=", left: { var: "auth.claims.clearance" }, right: { val: 3 } },
          ],
        },
        update: {
          op: "all",
          conditions: [
            { op: "==", left: { var: "auth.claims.role" }, right: { val: "moderator" } },
            { op: ">=", left: { var: "auth.claims.clearance" }, right: { val: 3 } },
          ],
        },
        delete: {
          op: "all",
          conditions: [
            { op: "==", left: { var: "auth.claims.role" }, right: { val: "moderator" } },
            { op: ">=", left: { var: "auth.claims.clearance" }, right: { val: 3 } },
          ],
        },
      },
    },
  ],
} as const;

export interface BootstrapResult {
  baseUrl: string;
  organizationId: string;
  projectId: string;
  publicKey: string;
  serverKey: string;
  runId: string;
  /** The exact AST installed for this run. */
  rules: typeof TESTBED_RULES_AST;
}

interface HttpReply<T> {
  status: number;
  body: T;
}

async function jsonRequest<T>(
  baseUrl: string,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpReply<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: (parsed ?? {}) as T };
}

function expectOk<T>(reply: HttpReply<T>, what: string): T {
  if (reply.status < 200 || reply.status >= 300) {
    const detail = reply.body as { error?: { code?: string; message?: string } } | null;
    const code = detail?.error?.code ?? "UNKNOWN_ERROR";
    const message = detail?.error?.message ?? "request failed";
    throw new Error(`${what} failed (HTTP ${reply.status}, ${code}: ${message})`);
  }
  return reply.body;
}

/** Resolve the API base URL from environment variables (never logged). */
export function resolveBaseUrl(): string {
  const raw = process.env["VELLUM_API_BASE_URL"] ?? "http://127.0.0.1:8080";
  return raw.replace(/\/+$/, "");
}

/**
 * Create a fresh tenant for this run. Uses a UUID suffix for every slug and
 * user identity so repeated runs can never collide.
 */
export async function bootstrap(baseUrl = resolveBaseUrl()): Promise<BootstrapResult> {
  // Fail fast and loudly when the live API is not reachable.
  let ready: HttpReply<{ mode?: string }>;
  try {
    ready = await jsonRequest<{ mode?: string }>(baseUrl, "/v1/health/ready");
  } catch {
    throw new Error(`Document Database API at the configured base URL is not reachable; start it before running the testbed`);
  }
  if (ready.status >= 500) {
    throw new Error(`Document Database API reported an unhealthy database plane (HTTP ${ready.status})`);
  }

  const runId = randomUUID();
  const suffix = runId.replace(/-/g, "").slice(0, 12);

  const org = expectOk(
    await jsonRequest<{ id: string }>(baseUrl, "/v1/organizations", "POST", {
      name: `JS Testbed ${suffix}`,
      slug: `js-testbed-org-${suffix}`,
      planTier: "pro",
    }),
    "organization provisioning"
  );
  if (!org.id) throw new Error("organization provisioning returned no id");

  const createdProject = expectOk(
    await jsonRequest<{
      project: { id: string };
    }>(baseUrl, `/v1/organizations/${org.id}/projects`, "POST", {
      name: "JS Testbed Project",
      slug: `js-testbed-proj-${suffix}`,
    }),
    "project provisioning"
  );
  const projectId = createdProject.project?.id;
  if (!projectId) {
    throw new Error("project provisioning returned no project id");
  }

  const keysPath = `/v1/projects/${projectId}/api-keys`;
  const pub = expectOk(
    await jsonRequest<{ rawKey: string }>(baseUrl, keysPath, "POST", {
      name: "js-testbed-publishable",
      keyType: "publishable",
    }),
    "publishable API key provisioning"
  );
  const srv = expectOk(
    await jsonRequest<{ rawKey: string }>(baseUrl, keysPath, "POST", {
      name: "js-testbed-server",
      keyType: "secret",
    }),
    "secret API key provisioning"
  );
  if (!pub.rawKey?.startsWith("pk_") || !srv.rawKey?.startsWith("sk_")) {
    throw new Error("API key provisioning returned unexpected key material");
  }

  expectOk(
    await jsonRequest(
      baseUrl,
      `/v1/projects/${projectId}/rulesets`,
      "POST",
      { rulesAst: TESTBED_RULES_AST }
    ),
    "security ruleset publication"
  );

  return {
    baseUrl,
    organizationId: org.id,
    projectId,
    publicKey: pub.rawKey,
    serverKey: srv.rawKey,
    runId,
    rules: TESTBED_RULES_AST,
  };
}
