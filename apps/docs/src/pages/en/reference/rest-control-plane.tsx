import { Api, Callout, Code, CodeTabs, Doc, P, PageLink, Section, Table } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Control plane REST API"
      description="Session-authenticated endpoints for authentication, organizations, projects, API keys, rulesets, metering and platform administration. These surfaces are separate from the API-key-authenticated document plane."
      eyebrow="Reference"
    >
      <Section id="realms" title="Three isolated realms">
        <P>
          Control plane routes are grouped into three realms. Each realm signs its own access tokens,
          and a token issued by one realm is rejected by the others — even when both consoles are
          served from the same browser origin.
        </P>
        <Table
          head={["Realm", "Base path", "Proof", "Session details"]}
          rows={[
            [<code>SUPER_ADMIN</code>, <code>/v1/admin/**</code>, "Realm-bound HS256 access token", "Refresh token in the HttpOnly vellum_admin_rt cookie (Path /v1/admin/auth)."],
            [<code>CUSTOMER_CONSOLE</code>, <code>/v1/console/**</code>, "Realm-bound HS256 access token", "Refresh token in the HttpOnly vellum_console_rt cookie (Path /v1/console/auth)."],
            [<code>PROJECT_END_USER</code>, <code>/v1/projects/:projectId/auth/**</code>, "EdDSA project-scoped JWT", "Issued by the project's end-user auth tier; verified against the project's Ed25519 keys."],
          ]}
        />
        <P>
          Send the access token as <code>Authorization: Bearer &lt;token&gt;</code> on every
          authenticated request; browsers send the matching refresh cookie automatically. Refresh
          tokens rotate as single-use SHA-256 hashes with a 15-second concurrency grace window. For
          end-user tokens there is no HS256 fallback — an invalid token is rejected rather than
          treated as anonymous. See{" "}
          <PageLink slug="end-user-auth">End users &amp; the three realms</PageLink>.
        </P>
        <Callout tone="warning" title="Not the document plane">
          <P>
            These endpoints never accept a <code>pk_</code> or <code>sk_</code> API key as the session
            proof. Conversely, a console or admin session token cannot read or write documents. For
            those operations use the{" "}
            <PageLink slug="reference/rest-data-plane">data plane REST API</PageLink>.
          </P>
        </Callout>
      </Section>

      <Section id="public-auth" title="Public authentication endpoints">
        <P>
          Customer sign-up and sign-in are public. They issue a realm-bound console access token and
          set the <code>vellum_console_rt</code> refresh cookie. Throttles apply: 10 failed attempts
          per 15 minutes for sign-in and sign-up.
        </P>
        <Api method="POST" path="/v1/auth/sign-up/email">
          <P>
            Required headers: <code>content-type: application/json</code>. Creates the user, a default
            organization, a default project and an API key.
          </P>
          <CodeTabs
            tabs={[
              {
                label: "Request",
                lang: "json",
                code: JSON.stringify(
                  { name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse-battery" },
                  null,
                  2
                ),
              },
              {
                label: "Response · 201",
                lang: "json",
                code: JSON.stringify(
                  {
                    success: true,
                    user: { id: "usr_…", name: "Ada Lovelace", email: "ada@example.com", platformRole: "customer" },
                    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
                    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
                    refreshToken: "a2J4c…",
                    organization: { id: "org_…", slug: "ada-lovelace-k3j9z", planId: "free" },
                    project: { id: "proj_…", slug: "default" },
                    apiKey: { id: "key_…", keyPrefix: "sk_a1b2b2c3" },
                    expiresAt: "2026-11-17T09:15:00.000Z",
                  },
                  null,
                  2
                ),
              },
            ]}
          />
        </Api>
        <Api method="POST" path="/v1/auth/sign-in/email">
          <P>
            Required headers: <code>content-type: application/json</code>. Returns the same access
            and refresh token pair. Passwords are verified with scrypt (N=2¹⁴, r=8, p=1).
          </P>
          <Code
            title="Request"
            code={JSON.stringify({ email: "ada@example.com", password: "correct-horse-battery" }, null, 2)}
          />
        </Api>
        <Api method="GET" path="/v1/auth/session">
          <P>
            Required header: <code>Authorization: Bearer &lt;access token&gt;</code>. Verifies the
            presented token instead of trusting its presence.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                session: {
                  valid: true,
                  uid: "usr_…",
                  claims: { sub: "usr_…", role: "customer", orgIds: ["org_…"] },
                  expiresAt: "2026-11-17T09:15:00.000Z",
                },
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="POST" path="/v1/auth/sign-out">
          <P>
            Required header: <code>Authorization: Bearer &lt;refresh token&gt;</code> when revoking a
            session. End-user JWTs are stateless, so a missing refresh token is a no-op.
          </P>
          <Code title="Response · 200" code={JSON.stringify({ success: true, message: "Signed out successfully" }, null, 2)} />
        </Api>
        <Api method="POST" path="/v1/console/auth/refresh">
          <P>
            Public endpoint. Reads the opaque refresh token from the JSON body or the{" "}
            <code>vellum_console_rt</code> cookie, rotates it, and returns a new access token.
          </P>
          <Code title="Request" code={JSON.stringify({ refreshToken: "a2J4c…" }, null, 2)} />
        </Api>
        <P>
          Additional Better Auth flows are mounted at <code>/v1/auth/**</code>, and TOTP MFA is
          available at <code>GET /v1/auth/mfa/status</code>, <code>POST /v1/auth/mfa/setup</code>,{" "}
          <code>POST /v1/auth/mfa/verify</code> and <code>POST /v1/auth/mfa/disable</code>.
        </P>
      </Section>

      <Section id="console" title="Customer console (/v1/console/**)">
        <P>
          Every console route requires a <code>CUSTOMER_CONSOLE</code> session token, an organization
          membership check, and an immutable audit-log entry for mutations. The dashboard uses these
          routes instead of long-lived master keys.
        </P>
        <Api method="GET" path="/v1/console/organizations">
          <P>Required header: <code>Authorization: Bearer &lt;console access token&gt;</code>.</P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              [{ id: "org_…", name: "Ada's Organization", slug: "ada-lovelace-k3j9z", planId: "free" }],
              null,
              2
            )}
          />
        </Api>
        <Api method="GET" path="/v1/console/organizations/:orgId/projects">
          <P>Required header: console session token. Non-members receive 403 PERMISSION_DENIED.</P>
        </Api>
        <Api method="POST" path="/v1/console/projects/:projectId/api-keys">
          <P>
            Required headers: console session token, <code>content-type: application/json</code>. The{" "}
            <code>rawKey</code> is returned only once at creation — store it in a secret manager
            immediately.
          </P>
          <Code
            title="Request"
            code={JSON.stringify({ name: "Backend server", keyType: "server" }, null, 2)}
          />
          <Code
            title="Response · 201"
            code={JSON.stringify(
              {
                apiKey: {
                  id: "key_…",
                  projectId: "proj_…",
                  name: "Backend server",
                  keyType: "server",
                  keyPrefix: "sk_a1b2b2c3",
                  createdAt: "2026-11-17T09:00:00.000Z",
                },
                rawKey: "sk_a1b2b2c3…",
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="DELETE" path="/v1/console/projects/:projectId/api-keys/:keyId">
          <P>Required header: console session token. Revocation is audited and invalidates caches.</P>
          <Code title="Response · 200" code={JSON.stringify({ success: true, revoked: { id: "key_…", keyPrefix: "sk_a1b2b2c3" } }, null, 2)} />
        </Api>
        <Api method="POST" path="/v1/console/projects/:projectId/rulesets">
          <P>
            Required headers: console session token, <code>content-type: application/json</code>. The
            v1 JSON AST is validated (depth ≤ 10, ≤ 100 nodes) before publication.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                rulesAst: {
                  schemaVersion: "1.0",
                  rules: [
                    { pattern: "users/{uid}", allow: { op: "==", left: { var: "auth.uid" }, right: { var: "resource.ownerId" } } },
                  ],
                },
              },
              null,
              2
            )}
          />
        </Api>
        <P>The console also mirrors document operations, always through the same rules and engine pipeline:</P>
        <Table
          head={["Method", "Path", "Purpose"]}
          rows={[
            [<code>POST</code>, <code>/v1/console/projects/:projectId/query</code>, "Structured query"],
            [<code>POST</code>, <code>…/batchWrite</code>, "Atomic batch mutations"],
            [<code>POST</code>, <><code>…/transactions:begin</code> / <code>…/transactions:commit</code></>, "OCC transactions"],
            [<>GET / POST / PUT / PATCH / DELETE</>, <code>…/documents/*</code>, "Document read, create, set, update, delete"],
            [<>GET / POST / DELETE</>, <><code>…/indexes</code> / <code>…/indexes/:indexId</code></>, "Composite index management"],
            [<>GET / POST</>, <code>…/rulesets</code>, "Read and publish the active ruleset"],
            [<>GET / POST / DELETE</>, <code>…/api-keys</code>, "API key management"],
          ]}
        />
      </Section>

      <Section id="admin" title="Platform admin (/v1/admin/**)">
        <P>
          Super-admin routes require a <code>SUPER_ADMIN</code> session token. Bootstrap endpoints
          (<code>setup-status</code>, <code>setup-owner</code>, <code>login</code>, and the refresh
          route) are public; the remaining routes require an operator role of <code>owner</code>,{" "}
          <code>admin</code> or <code>support_readonly</code>, with write routes restricted to owners
          and admins.
        </P>
        <Api method="GET" path="/v1/admin/setup-status">
          <P>Public. Reports whether a platform master owner exists.</P>
          <Code
            title="Response · 200"
            code={JSON.stringify({ initialized: true, ownerCount: 1, requiresSetup: false, totalUsers: 12 }, null, 2)}
          />
        </Api>
        <Api method="POST" path="/v1/admin/setup-owner">
          <P>
            Public once. Creates the master owner and returns a super-admin session; a second call
            returns <code>409 ALREADY_EXISTS</code>.
          </P>
          <Code
            title="Request"
            code={JSON.stringify({ name: "Platform Owner", email: "owner@example.com", password: "at-least-8-chars" }, null, 2)}
          />
        </Api>
        <Api method="POST" path="/v1/admin/login">
          <P>
            Public. Throttled to 10 failures per 15 minutes. Returns a realm-bound access token and
            sets the <code>vellum_admin_rt</code> cookie.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                success: true,
                user: { id: "usr_…", name: "Platform Owner", email: "owner@example.com", platformRole: "owner" },
                token: "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
                accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
                refreshToken: "m8Qw…",
                expiresAt: "2026-11-17T09:15:00.000Z",
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="GET" path="/v1/admin/overview">
          <P>
            Required header: super-admin session token. All counts and telemetry come from live
            PostgreSQL reads — no fabricated metrics and no DSNs.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                status: "healthy",
                version: "0.0.1",
                tenantsCount: 42,
                projectsCount: 118,
                keysCount: 263,
                usersCount: 87,
                planes: { controlDb: "connected", dataDb: "connected" },
                nodes: [
                  { id: "pg-control-primary", role: "Control Plane PostgreSQL (Primary)", type: "control", endpoint: "control-plane://postgresql", status: "healthy", activeConnections: 4, maxConnections: 100, uptime: "12d 3h" },
                  { id: "pg-data-primary", role: "Data Plane PostgreSQL + RLS", type: "data", endpoint: "data-plane://postgresql", status: "healthy", activeConnections: 7, maxConnections: 100, uptime: "12d 3h" },
                ],
                telemetry: { outboxLagSeqId: 0, usageTotals: { documentReads: 182034, documentWrites: 44012, documentDeletes: 1204, realtimeMessagesSent: 9012, egressBytes: 81234567, storageBytes: 2345678901, days: 30 } },
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="GET" path="/v1/admin/tenants">
          <P>
            Required header: super-admin session token. Daily usage is aggregated from{" "}
            <code>project_usage_daily</code>.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              [
                { id: "org_…", name: "Acme Inc", slug: "acme", billingEmail: "billing@acme.test", plan: "pro", status: "active", storageMb: 128, dailyReads: 4204, dailyWrites: 610, projectsCount: 3, createdAt: "2026-08-02T10:00:00.000Z" },
              ],
              null,
              2
            )}
          />
        </Api>
        <Api method="GET" path="/v1/admin/tenants/:orgId">
          <P>Required header: super-admin session token. Returns tenant metadata and its projects.</P>
        </Api>
        <Api method="POST" path="/v1/admin/tenants/:orgId/suspend">
          <P>Required header: super-admin session token with write role. The action is audit-logged.</P>
          <Code title="Response · 200" code={JSON.stringify({ success: true, status: "suspended" }, null, 2)} />
          <P>
            The sibling endpoint <code>POST /v1/admin/tenants/:orgId/reactivate</code> returns{" "}
            <code>{'{"success":true,"status":"active"}'}</code>.
          </P>
        </Api>
        <Api method="GET" path="/v1/admin/audit-logs">
          <P>
            Required header: super-admin session token. Filters: <code>limit</code>, <code>cursor</code>,{" "}
            <code>action</code>, <code>actorUserId</code>, <code>organizationId</code>,{" "}
            <code>projectId</code>, <code>from</code>, <code>to</code>. Keyset pagination — never SQL{" "}
            <code>OFFSET</code>. Add <code>?envelope=true</code> for a structured body; otherwise the
            response is an array and paging metadata is in the <code>X-Total-Count</code>,{" "}
            <code>X-Has-More</code> and <code>X-Next-Cursor</code> headers.
          </P>
          <Code
            title="Response · 200 with ?envelope=true"
            code={JSON.stringify(
              {
                items: [
                  { id: "log_…", timestamp: "2026-11-17T09:00:00.000Z", actorUserId: "usr_…", actorType: "operator", action: "tenant.suspended", category: "lifecycle", organizationId: "org_…", projectId: "proj_global", targetId: "org_…", metadata: { slug: "acme", status: "suspended" } },
                ],
                total: 1820,
                nextCursor: "eyJ0IjoiMjAyNi0xMS0xN1QwOTowMDowMC4wMDBaIiwiaWQiOiJsb2df…In0",
                hasMore: true,
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="GET" path="/v1/admin/features">
          <P>
            Required header: super-admin session token. Feature flags are PostgreSQL-backed; create
            and update with <code>POST /v1/admin/features</code> or{" "}
            <code>PUT /v1/admin/features/:key</code>, patch with{" "}
            <code>PATCH /v1/admin/features/:key</code>, and delete with{" "}
            <code>DELETE /v1/admin/features/:key</code>.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              [{ key: "realtime_v2", description: "Durable outbox realtime", enabled: true, rolloutPercent: 100, updatedBy: "usr_…" }],
              null,
              2
            )}
          />
        </Api>
        <Callout tone="danger" title="Customer payloads are never exposed">
          <P>
            Every admin response passes through a recursive sanitizer: document <code>data</code>,{" "}
            <code>beforeData</code> and <code>afterData</code> are stripped, as are password and token
            hashes and encrypted secrets. Operators see tenant metadata, quotas, index health and
            audit logs only.
          </P>
        </Callout>
      </Section>

      <Section id="metering" title="Metering (/usage)">
        <Api method="GET" path="/v1/projects/:projectId/usage">
          <P>
            Required header: a control-plane session token with project access. Optional query
            parameters <code>from</code> and <code>to</code> accept <code>YYYY-MM-DD</code>. Rows come
            from <code>project_usage_daily</code> in the control plane; the data plane is only read
            through aggregate views.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                projectId: "proj_…",
                from: "2026-11-01",
                to: "2026-11-17",
                generatedAt: "2026-11-17T09:00:00.000Z",
                days: 17,
                totals: { documentReads: 12040, documentWrites: 3120, documentDeletes: 88, realtimeMessagesSent: 640, egressBytes: 2345678, storageBytes: 98765432 },
                usage: [
                  { projectId: "proj_…", usageDate: "2026-11-17", documentReads: 812, documentWrites: 190, documentDeletes: 4, realtimeMessagesSent: 41, egressBytes: 120400, storageBytes: 98765432, updatedAt: "2026-11-17T08:59:00.000Z" },
                ],
              },
              null,
              2
            )}
          />
        </Api>
      </Section>

      <Section id="end-user-auth" title="Project end-user auth">
        <P>
          Each project exposes its own <code>PROJECT_END_USER</code> auth tier. These
          endpoints issue and verify EdDSA <code>vellum+enduser+jwt</code> tokens that the document
          plane accepts as an optional end-user bearer. The project's public keys are published
          as JWKS.
        </P>
        <Api method="POST" path="/v1/projects/:projectId/auth/sign-up/email">
          <P>Required headers: <code>content-type: application/json</code>. Creates an end user scoped to this project.</P>
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/auth/sign-in/email">
          <P>Required headers: <code>content-type: application/json</code>. Returns the end-user token pair.</P>
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/auth/token/refresh">
          <P>Required headers: <code>content-type: application/json</code>. Rotates a refresh token; replay revokes the realm's sessions.</P>
        </Api>
        <Api method="GET" path="/v1/projects/:projectId/auth/.well-known/jwks.json">
          <P>Public. Publishes the project's Ed25519 public keys for token verification.</P>
        </Api>
        <Table
          head={["Method", "Path suffix", "Purpose"]}
          rows={[
            [<code>POST</code>, <code>/sign-in/anonymous</code>, "Anonymous end-user session"],
            [<code>POST</code>, <code>/sign-in/provider</code>, "OAuth provider sign-in"],
            [<>GET / PATCH</>, <code>/user</code>, "Read or update the current end user"],
            [<code>POST</code>, <><code>/password/reset</code> / <code>/password/confirm</code></>, "Password reset flow (throttled)"],
            [<code>POST</code>, <><code>/email/verify/request</code> / <code>/email/verify/confirm</code></>, "Email verification (throttled)"],
            [<code>POST</code>, <><code>/mfa/enroll</code> / <code>/mfa/verify</code> / <code>/mfa/challenge</code></>, "TOTP enrollment and challenge"],
          ]}
        />
        <P>
          Use the returned access token as <code>authorization: Bearer &lt;token&gt;</code> or{" "}
          <code>x-vellum-user-token</code> on document plane calls. Full flow details are in{" "}
          <PageLink slug="end-user-auth">End users &amp; the three realms</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
