import type { Page, Route } from "@playwright/test";

export const DASH_SESSION = {
  user: { id: "usr_e2e", email: "e2e@vellum.dev", name: "E2E User" },
  token: "e2e-session-token",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

export const ADMIN_SESSION = {
  user: {
    id: "usr_owner_e2e",
    name: "E2E Owner",
    email: "owner@vellum.dev",
    platformRole: "owner",
  },
  token: "e2e-admin-token",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

export const ORG_ID = "org_e2e_0001";
export const PROJECT_ID = "proj_e2e_0001";

/**
 * Seed a client session before any application code runs. Each realm owns three
 * discrete localStorage keys so the two consoles can share one browser origin.
 */
export async function seedSession(page: Page, admin = false): Promise<void> {
  const session = admin ? ADMIN_SESSION : DASH_SESSION;
  const keys = admin
    ? {
        access: "vellum_super_admin_access_token",
        refresh: "vellum_super_admin_refresh_token",
        user: "vellum_super_admin_user",
      }
    : {
        access: "vellum_console_access_token",
        refresh: "vellum_console_refresh_token",
        user: "vellum_console_user",
      };
  await page.addInitScript(
    ({ keys, session }) => {
      localStorage.setItem(keys.access, session.token);
      localStorage.setItem(keys.refresh, (session as { refreshToken?: string }).refreshToken ?? "");
      localStorage.setItem(keys.user, JSON.stringify({ user: session.user, expiresAt: session.expiresAt }));
    },
    { keys, session }
  );
}

const document = (id: string, name: string, version = 1) => ({
  id,
  path: `users/${id}`,
  version,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-16T10:00:00.000Z",
  data: { name, role: "admin" },
});

const queryResponse = (docs: unknown[]) => ({
  documents: docs,
  nextCursor: null,
  meta: {
    count: docs.length,
    indexUsed: "idx_docs_data_gin_active",
    executionTimeMs: 3.25,
    compiledSql: "SELECT d.id, d.data FROM documents d WHERE d.path LIKE $1 ORDER BY d.document_id ASC LIMIT $2",
  },
});

/** Route all /v1/* calls to deterministic fixtures. No backend or secrets needed. */
export async function mockApi(page: Page): Promise<void> {
  await page.route("**/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    // ---- Auth ----
    if (path.endsWith("/auth/sign-in/email") || path.endsWith("/auth/sign-up/email")) {
      return json({ user: DASH_SESSION.user, token: DASH_SESSION.token, expiresAt: DASH_SESSION.expiresAt });
    }
    if (path.includes("/auth/mfa/status")) return json({ enabled: false });
    if (path.includes("/auth/mfa/setup")) {
      return json({
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/VELLUM:e2e@vellum.dev?secret=JBSWY3DPEHPK3PXP&issuer=VELLUM",
        recoveryCodes: ["AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF"],
      });
    }
    if (path.includes("/auth/mfa/verify")) return json({ enabled: true });
    if (path.includes("/auth/mfa/disable")) return json({ enabled: false });

    // ---- Admin ----
    if (path === "/v1/admin/login") {
      return json({ user: ADMIN_SESSION.user, token: ADMIN_SESSION.token, expiresAt: ADMIN_SESSION.expiresAt });
    }
    if (path === "/v1/admin/overview") {
      return json({
        status: "healthy",
        tenantsCount: 2,
        projectsCount: 4,
        keysCount: 6,
        usersCount: 8,
        planes: { controlDb: "connected", dataDb: "connected" },
        metrics: [],
        nodes: [],
      });
    }
    if (path === "/v1/admin/tenants") {
      return json([
        {
          id: ORG_ID,
          name: "E2E Tenant",
          slug: "e2e-tenant",
          billingEmail: "billing@e2e.dev",
          plan: "pro",
          status: "active",
          storageMb: 420,
          dailyReads: 1200,
          dailyWrites: 340,
          projectsCount: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    }
    if (path.startsWith("/v1/admin/tenants/")) {
      return json({
        id: ORG_ID,
        name: "E2E Tenant",
        slug: "e2e-tenant",
        billingEmail: "billing@e2e.dev",
        plan: "pro",
        status: "active",
        storageMb: 420,
        dailyReads: 1200,
        dailyWrites: 340,
        projectsCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        projects: [],
      });
    }
    if (path === "/v1/admin/audit-logs") {
      return json([
        {
          id: "aud_e2e_1",
          timestamp: "2026-11-16T10:00:00.000Z",
          actorUserId: "usr_owner_e2e",
          actorType: "operator",
          action: "tenant.suspended",
          category: "lifecycle",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          targetId: ORG_ID,
          metadata: { reason: "e2e" },
        },
      ]);
    }
    if (path === "/v1/admin/features") {
      if (method === "POST") return json({ key: "e2e_flag", description: "E2E", enabled: true, rolloutPercent: 100, updatedAt: new Date().toISOString(), updatedBy: "usr_owner_e2e" });
      return json([
        { key: "e2e_flag", description: "E2E feature flag", enabled: true, rolloutPercent: 100, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: null },
      ]);
    }

    // ---- Console: orgs / projects ----
    if (path === "/v1/console/organizations") {
      return json([{ id: ORG_ID, slug: "e2e-tenant", name: "E2E Tenant", billingEmail: "billing@e2e.dev", plan: "pro" }]);
    }
    if (path.startsWith("/v1/console/organizations/") && path.endsWith("/projects")) {
      return json([{ id: PROJECT_ID, organizationId: ORG_ID, slug: "e2e-project", name: "E2E Project", status: "active" }]);
    }
    if (path.startsWith("/v1/console/projects/") && path.endsWith("/collections")) {
      if (method === "POST") {
        return json({
          id: "col_e2e_users",
          name: "users",
          description: "E2E users",
          documentCount: 2,
          storageBytes: 1024,
          lastDocumentAt: "2026-11-16T10:00:00.000Z",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-16T10:00:00.000Z",
        }, 201);
      }
      return json({
        collections: [
          {
            id: "col_e2e_users",
            name: "users",
            description: "E2E users",
            documentCount: 2,
            storageBytes: 1024,
            lastDocumentAt: "2026-11-16T10:00:00.000Z",
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-16T10:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }

    // ---- Console: data plane ----
    if (path.endsWith("/query")) return json(queryResponse([document("usr_101", "Ada Lovelace")]));
    if (path.includes("/documents/")) {
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        return json(document("usr_e2e_test", "E2E User"), method === "POST" ? 201 : 200);
      }
      if (method === "DELETE") return json({ deleted: true });
      return json(queryResponse([document("usr_101", "Ada Lovelace"), document("usr_102", "Grace Hopper", 2)]));
    }
    if (path.endsWith("/indexes")) {
      if (method === "POST") return json({ id: "idx_e2e", collectionPath: "users", fields: [{ field: "role", direction: "ASC" }], status: "READY" }, 201);
      return json({ indexes: [{ id: "idx_e2e", collectionPath: "users", fields: [{ field: "role", direction: "ASC" }], status: "READY", entriesCount: 12, createdAt: "2026-11-01T00:00:00.000Z" }] });
    }
    if (path.endsWith("/api-keys")) {
      if (method === "POST") return json({ apiKey: { id: "key_e2e", name: "E2E", keyType: "server", keyPrefix: "sk_e2e", createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null }, rawKey: "sk_e2e_secret" }, 201);
      return json([{ id: "key_e2e", name: "E2E Key", keyType: "server", keyPrefix: "sk_e2e", createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null }]);
    }
    if (path.includes("/api-keys/") && method === "DELETE") return json({ success: true });
    if (path.endsWith("/rulesets")) {
      if (method === "POST") return json({ id: "rules_e2e", version: 1 }, 201);
      return json({ version: 1, rulesAst: { version: 1, rules: [] } });
    }

    // ---- Relation rules (referential integrity) ----
    if (path.endsWith("/relation-rules")) {
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { rules?: unknown[]; expectedVersion?: number | null };
        if (body.expectedVersion !== 3) {
          return json({ error: { code: "ABORTED_CONFLICT", message: "Relation rules version conflict" } }, 409);
        }
        return json({ projectId: PROJECT_ID, version: 4, rules: body.rules ?? [] });
      }
      return json({
        projectId: PROJECT_ID,
        version: 3,
        rules: [
          { collection: "posts", field: "authorId", targetCollection: "users", onDelete: "cascade", version: 3 },
          { collection: "comments", field: "postId", targetCollection: "posts", onDelete: "restrict", version: 3 },
        ],
      });
    }

    // ---- V2 Rules DSL Studio ----
    if (path.endsWith("/rules/decompile") && method === "POST") {
      return json({ dsl: "rules_version = '2';\n\nmatch /users/{userId} {\n  allow read: if true;\n}\n" });
    }
    if (path.endsWith("/rules/compile") && method === "POST") {
      return json({ ast: { version: 1, rules: [] }, diagnostics: [] });
    }
    if (path.endsWith("/rules/simulate") && method === "POST") {
      return json({
        allowed: true,
        matchedRule: "/users/{userId}",
        evaluationTrace: ["pattern /users/{userId} matched", "allow.read → true", "ALLOWED"],
      });
    }

    // ---- V2 Smart Index Advisor ----
    if (path.endsWith("/indexes/recommendations")) return json({ recommendations: [] });

    // ---- Auth Studio ----
    if (path.endsWith("/auth/admin/config")) {
      return json({
        id: "authcfg_e2e",
        projectId: PROJECT_ID,
        authServiceSuspended: false,
        suspensionReason: null,
        maxUsersQuota: 10000,
        maxSignupsPerHour: 100,
        enableEmailPassword: true,
        requireEmailVerification: false,
        providers: [
          { provider: "password", enabled: true },
          { provider: "google.com", enabled: true },
          { provider: "github.com", enabled: false },
        ],
      });
    }
    if (path.includes("/auth/admin/users/") && method === "GET") {
      const uid = path.split("/auth/admin/users/")[1] ?? "usr_e2e_1";
      return json({
        user: {
          id: uid,
          email: "ada@example.com",
          emailVerified: true,
          displayName: "Ada Lovelace",
          photoUrl: null,
          phoneNumber: null,
          phoneVerified: false,
          isDisabled: false,
          isAnonymous: false,
          customClaims: { role: "admin" },
          metadata: {},
          createdAt: "2026-11-01T12:00:00Z",
          updatedAt: "2026-11-20T12:00:00Z",
          lastSignInAt: "2026-11-22T12:00:00Z",
        },
        identities: [
          { id: "idn_1", provider: "password", providerUserId: "ada@example.com", lastSignInAt: "2026-11-22T12:00:00Z", createdAt: "2026-11-01T12:00:00Z" },
        ],
        sessions: [
          { id: "ses_1", userId: uid, revoked: false, revokedReason: null, revokedAt: null, expiresAt: "2026-12-22T12:00:00Z", rotationCounter: 1, createdAt: "2026-11-22T12:00:00Z", lastUsedAt: "2026-11-22T12:30:00Z" },
        ],
        mfa: { enabled: false, factorType: null, enrolledAt: null },
      });
    }
    if (path.endsWith("/auth/admin/users") && method === "GET") {
      return json({
        users: [
          { id: "usr_e2e_1", email: "ada@example.com", emailVerified: true, displayName: "Ada Lovelace", photoUrl: null, phoneNumber: null, phoneVerified: false, isDisabled: false, isAnonymous: false, customClaims: { role: "admin" }, metadata: {}, createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-20T12:00:00Z", lastSignInAt: "2026-11-22T12:00:00Z" },
          { id: "usr_e2e_2", email: "grace@example.com", emailVerified: false, displayName: "Grace Hopper", photoUrl: null, phoneNumber: null, phoneVerified: false, isDisabled: false, isAnonymous: false, customClaims: {}, metadata: {}, createdAt: "2026-11-05T12:00:00Z", updatedAt: "2026-11-19T12:00:00Z", lastSignInAt: null },
        ],
        nextCursor: null,
      });
    }

    return json({ error: { message: `Unmocked E2E endpoint: ${method} ${path}` } }, 404);
  });
}
