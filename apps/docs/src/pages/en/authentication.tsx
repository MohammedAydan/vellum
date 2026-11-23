import { Api, Callout, Code, CodeTabs, Doc, OL, P, PageLink, Section, Table, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      title="Authentication"
      description="API keys, end-user tokens, console sessions, TOTP MFA, rotation, and least-privilege access."
      eyebrow="Get started"
    >
      <Section id="three-realms" title="Three isolated realms">
        <P>
          VELLUM has three authentication realms. They share only stateless crypto primitives; storage, signing
          secrets, JWT <code>typ</code>/<code>iss</code>/<code>aud</code>, claims, and middleware are fully
          separate. A token minted for one realm is rejected by the other two.
        </P>
        <Table
          head={["Realm", "Surface", "Credential"]}
          rows={[
            [
              <code>SUPER_ADMIN</code>,
              <code>/v1/admin/**</code>,
              "Platform operator session, refresh cookie vellum_admin_rt, path /v1/admin/auth.",
            ],
            [
              <code>CUSTOMER_CONSOLE</code>,
              <code>/v1/console/**</code>,
              "Dashboard session, refresh cookie vellum_console_rt, path /v1/console/auth.",
            ],
            [
              <code>PROJECT_END_USER</code>,
              <code>/v1/projects/:projectId/auth/**</code>,
              "Project-scoped end-user JWT issued by the document plane's auth service.",
            ],
          ]}
        />
        <Callout tone="danger" title="The document plane is EdDSA-only">
          <p>
            Public document requests use an API key plus an optional EdDSA end-user bearer. There is no HS256
            fallback, no anonymous fallback, and no implicit master key. A console session JWT is not accepted
            on the document plane, and an API key is not accepted on the console plane. The live harness
            verifies both directions of that rejection.
          </p>
        </Callout>
        <P>
          For realm internals, refresh rotation, and rate limits, see{" "}
          <PageLink slug="end-user-auth">End users &amp; the three realms</PageLink>.
        </P>
      </Section>

      <Section id="api-keys" title="API keys: pk_ and sk_">
        <P>
          Every document-plane call presents a key in the <code>x-vellum-api-key</code> header. The SDKs also
          send the legacy <code>x-project-key</code> alias for compatibility. Never put a key in a URL or a
          query string.
        </P>
        <Table
          head={["Prefix", "Type", "Body"]}
          rows={[
            [<code>pk_</code>, "Public (browser / mobile)", "32 base62 characters"],
            [<code>sk_</code>, "Server (trusted infrastructure)", "48 base62 characters"],
          ]}
        />
        <P>
          Keys have the shape <code>&lt;prefix&gt;_&lt;random&gt;</code>, for example{" "}
          <code>pk_…</code> or <code>sk_…</code>. Only a 16-character prefix and a digest are
          persisted: <code>SHA256(fullKey + ":" + API_KEY_PEPPER)</code>, compared in constant time. The
          plaintext is returned once, at creation. Verified keys are cached in-process for 30 seconds;
          revocation and rotation publish <code>NOTIFY vellum_cache_invalidate</code> so other instances drop
          their entry.
        </P>
        <Table
          head={["Operation", "Required server-key scope"]}
          rows={[
            ["get, list, query", <code>documents:read</code>],
            ["create, set, update, delete, batchWrite, transactions", <code>documents:write</code>],
            ["index management", <code>indexes:manage</code>],
            ["everything", <code>*</code>],
          ]}
        />
        <P>
          A public key cannot manage composite indexes. A missing scope yields <code>PERMISSION_DENIED</code>{" "}
          (403); a missing or invalid key yields <code>UNAUTHENTICATED</code> (401).
        </P>
        <CodeTabs
          tabs={[
            {
              label: "curl",
              lang: "bash",
              code: `curl "https://api.example.com/v1/projects/<PROJECT_ID>/documents/users/u_123" \\
  -H "x-vellum-api-key: <YOUR_PUBLIC_KEY>" \\
  -H "Authorization: Bearer <END_USER_JWT>"`,
            },
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_PUBLIC_KEY>",
  // Optional EdDSA end-user token for auth.uid / auth.claims in rules.
  getAuthToken: async () => currentUserJwt(),
});`,
            },
          ]}
        />
      </Section>

      <Section id="end-user-tokens" title="End-user tokens and rules evaluation">
        <P>
          When a public key is used, an optional bearer token supplies the end-user identity in{" "}
          <code>authorization: Bearer &lt;jwt&gt;</code> or <code>x-vellum-user-token</code>. The rules AST can
          read <code>auth.uid</code> and <code>auth.claims.&lt;field&gt;</code>, so one public key can serve
          many users without granting any of them implicit access.
        </P>
        <P>
          Both SDKs expose an auth façade that manages sign-up, sign-in, silent refresh, and the bearer token
          on every request.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `await db.auth.signUpWithEmailAndPassword({
  email: "ada@example.com",
  password: "correct horse battery staple",
  displayName: "Ada",
});

await db.auth.signInWithEmailAndPassword("ada@example.com", "correct horse battery staple");
const jwt = await db.auth.getIdToken(); // EdDSA bearer, sent on document calls
await db.auth.signOut();`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `await client.auth.signUpWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct horse battery staple',
  displayName: 'Ada',
);

await client.auth.signInWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct horse battery staple',
);
final jwt = await client.auth.getIdToken();
await client.auth.signOut();`,
            },
          ]}
        />
        <P>
          These façades call the project-scoped auth tier, mounted at{" "}
          <code>/v1/projects/:projectId/auth</code>. All routes except the public JWKS document
          require the project API key.
        </P>
        <Table
          head={["Endpoint", "Purpose"]}
          rows={[
            [<code>POST /auth/sign-up/email</code>, "Create an end user and issue an access/refresh pair."],
            [<code>POST /auth/sign-in/email</code>, "Verify the password (scrypt); may return an MFA ticket."],
            [<code>POST /auth/token/refresh</code>, "Rotate a refresh token for a new access token."],
            [<code>POST /auth/sign-out</code>, "Revoke a session or all sessions for the user."],
            [<code>GET /auth/user</code>, "Read the signed-in user's profile."],
            [<code>PATCH /auth/user</code>, "Update the profile and re-project the users document."],
            [<code>GET /.well-known/jwks.json</code>, "Public EdDSA verification keys — no API key needed."],
            [<code>POST /auth/mfa/enroll</code>, "Begin TOTP enrollment; returns secret and recovery codes."],
            [<code>POST /auth/mfa/verify</code>, "Confirm enrollment with a TOTP or recovery code."],
            [<code>POST /auth/mfa/challenge</code>, "Exchange a sign-in MFA ticket for a session."],
          ]}
        />
      </Section>

      <Section id="console-sessions-and-mfa" title="Console sessions and TOTP MFA">
        <P>
          The dashboard authenticates against the control plane with email/password. Passwords are hashed with
          scrypt (<code>N=2^14, r=8, p=1</code>). Console access tokens are short-lived; refresh tokens live in
          realm-specific HttpOnly cookies. Every console request checks organization membership and writes an
          audit-log entry.
        </P>
        <Table
          head={["Endpoint", "Purpose"]}
          rows={[
            [<code>POST /v1/auth/sign-up/email</code>, "Create a user, default organization and project."],
            [<code>POST /v1/auth/sign-in/email</code>, "Verify password and issue a customer_console session."],
            [<code>GET /v1/auth/session</code>, "Validate the presented token and return its claims."],
            [<code>POST /v1/auth/sign-out</code>, "Revoke the refresh session when one is presented."],
            [<code>POST /v1/console/auth/refresh</code>, "Rotate the console access/refresh pair."],
            [<code>POST /v1/admin/login</code>, "Issue a super_admin session for platform operators."],
            [<code>POST /v1/admin/auth/session/refresh</code>, "Rotate the super-admin access/refresh pair."],
          ]}
        />
        <P>
          MFA is RFC 6238 TOTP: SHA-1, a 30-second period, six digits, and one-step (±30 s) tolerance. Every
          MFA route requires a valid session. The secret is encrypted at rest in the control-plane{" "}
          <code>mfa_secrets</code> table and recovery codes are stored as keyed hashes.
        </P>
        <Api method="GET" path="/v1/auth/mfa/status">
          <P>Returns <code>{"{ enabled: boolean }"}</code> for the signed-in operator.</P>
        </Api>
        <Api method="POST" path="/v1/auth/mfa/setup">
          <P>
            Returns the secret, an <code>otpauth://</code> URI, and eight recovery codes. Repeated calls before
            verification return the same secret and codes; the raw codes are shown only here.
          </P>
        </Api>
        <Api method="POST" path="/v1/auth/mfa/verify">
          <P>Accepts a six-digit TOTP code and enables MFA: <code>{"{ \"code\": \"123456\" }"}</code>.</P>
        </Api>
        <Api method="POST" path="/v1/auth/mfa/disable">
          <P>Accepts a TOTP code or one unused recovery code.</P>
        </Api>
        <P>
          Verification attempts are throttled by an in-process sliding window — five attempts per 60 seconds
          by default — with all durable state in PostgreSQL. No Redis is involved.
        </P>
      </Section>

      <Section id="rotation" title="Create, revoke, and rotate keys">
        <P>
          Keys are managed through the session-authenticated console API. The plaintext is returned only by
          the create call; list responses contain prefixes, scopes, status, and usage metadata.
        </P>
        <Table
          head={["Endpoint", "Purpose"]}
          rows={[
            [<code>POST /v1/console/projects/:projectId/api-keys</code>, "Create a key; the raw value appears only in this response."],
            [<code>GET /v1/console/projects/:projectId/api-keys</code>, "List keys for the project."],
            [<code>DELETE /v1/console/projects/:projectId/api-keys/:keyId</code>, "Revoke immediately and publish a cache invalidation."],
          ]}
        />
        <Code
          lang="bash"
          title="Create a server key"
          code={`curl -X POST \\
  "https://api.example.com/v1/console/projects/<PROJECT_ID>/api-keys" \\
  -H "Authorization: Bearer <CONSOLE_ACCESS_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"billing-worker","keyType":"server"}'`}
        />
        <OL
          items={[
            <>Create the replacement key and store its raw value in your secret manager.</>,
            <>Deploy it to clients and confirm traffic has moved.</>,
            <>Revoke the old key by id. Revocation is enforced against the control-plane record, so a cached key cannot be used after its <code>revokedAt</code> is set.</>,
          ]}
        />
        <P>
          The live harness verifies that a freshly validated key is rejected on the very next request after
          revocation with <code>401 UNAUTHENTICATED</code>.
        </P>
      </Section>

      <Section id="least-privilege" title="Least privilege and secret hygiene">
        <UL
          items={[
            <>Use a separate key per project; never reuse a key across projects.</>,
            <>Prefer <code>pk_</code> keys in client apps and let security rules decide access. Reserve <code>sk_</code> keys for trusted servers.</>,
            <>Choose the narrowest key type that works: prefer a read-only <code>pk_</code> key in client apps, and reserve an <code>sk_</code> key for trusted servers that need writes or index management.</>,
            <>Set an expiry on temporary keys and audit every <code>api_key.created</code> and <code>api_key.revoked</code> event.</>,
            <>Enable TOTP MFA for every console operator and store recovery codes in a secure vault.</>,
          ]}
        />
        <Callout tone="danger" title="Never log credentials">
          <p>
            Do not log raw <code>pk_</code>/<code>sk_</code> keys, bearer JWTs, or database URLs. The structured
            logger in <code>@vellum/observability</code> redacts these patterns automatically; keep all
            application logs on that path. Use placeholders such as <code>&lt;YOUR_API_KEY&gt;</code> in
            examples and load real values from environment variables at runtime.
          </p>
        </Callout>
        <P>
          Next: <PageLink slug="security-rules">Security rules</PageLink> explains the deny-by-default AST
          evaluated for public keys, and <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>{" "}
          lists the exact error for each breach.
        </P>
      </Section>
    </Doc>
  );
}
