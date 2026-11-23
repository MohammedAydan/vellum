import { Api, Callout, Code, CodeTabs, Doc, H3, P, PageLink, Section, Steps, Table } from "../../ui";

const PREFIX = "/v1/projects/:projectId/auth";

export default function Page() {
  return (
    <Doc
      title="End-user authentication"
      description="EdDSA-only end-user tokens, refresh rotation, MFA, and the exact end-user REST paths."
      eyebrow="Authentication"
    >
      <Section id="overview" title="Overview">
        <P>
          VELLUM credentials are <strong>fully isolated</strong> per surface. They share only stateless crypto
          primitives from <code>@vellum/auth</code> — scrypt, AES-256-GCM, SHA-256, TOTP, token generators, and
          rotation math. Storage tables, signing secrets, JWT <code>typ</code>/<code>iss</code>/<code>aud</code>,
          claim shapes, session services, and middleware are completely separate, so a token minted for one
          surface is rejected anywhere else.
        </P>
        <P>
          The <strong>document plane</strong> is a fourth, independent boundary. It never trusts a control-plane
          session: every document request needs a project API key (<code>x-vellum-api-key</code>; the legacy
          <code> x-project-key</code> alias is still read), and per-user authorization additionally needs an EdDSA
          end-user bearer in <code>authorization</code> or <code>x-vellum-user-token</code>. See{" "}
          <PageLink slug="authentication">Authentication</PageLink> for key types and{" "}
          <PageLink slug="security-rules">Security rules</PageLink> for how that identity is evaluated.
        </P>
        <Callout tone="info" title="Credentials are not interchangeable">
          Sessions and tokens minted outside this project&apos;s auth service are never valid on{" "}
          <code>/v1/projects/:projectId/auth</code> or on document routes — not even when a valid{" "}
          <code>pk_</code> key accompanies them.
        </Callout>
      </Section>

      <Section id="end-user-realm" title="The end-user credential">
        <Table
          head={["Credential", "Route family", "Session storage", "Secret / key", "Algorithm", "JWT typ", "iss", "aud"]}
          rows={[
            [
              <code>project_end_user</code>,
              <code>/v1/projects/:p/auth</code>,
              <code>data_db.project_auth_* (FORCE RLS)</code>,
              "Per-project Ed25519 key",
              <strong>EdDSA</strong>,
              <code>vellum+enduser+jwt</code>,
              <code>{"https://api.vellum.dev/v1/projects/<projectId>/auth"}</code>,
              <code>{"<projectId>"}</code>,
            ],
          ]}
        />
        <P>
          The end-user guard verifies the signature against the project&apos;s Ed25519 public key and then checks
          the realm claim, <code>aud</code> (the project id) and <code>iss</code>. Anything else — including any
          raw HS256 token — is rejected, even alongside a valid API key.
        </P>
      </Section>

      <Section id="tokens-and-jwks" title="End-user tokens & JWKS">
        <P>
          Access tokens are signed per project. Verification requires <code>alg=EdDSA</code>,
          <code>typ=vellum+enduser+jwt</code>, and exact matches on <code>aud</code> (the project id) and
          <code>iss</code>. A signed-but-expired token is reported as
          <code> TOKEN_EXPIRED</code> with <code>retryableWithRefresh: true</code>; every other verification failure
          collapses to a generic <code>UNAUTHENTICATED</code> so token material never leaks into an error body.
        </P>
        <Code
          lang="json"
          title="End-user access token (decoded)"
          code={`{
  "header": {
    "alg": "EdDSA",
    "typ": "vellum+enduser+jwt",
    "kid": "key_01HZX..."
  },
  "payload": {
    "iss": "https://api.vellum.dev/v1/projects/proj_123/auth",
    "sub": "u_9f2c...",
    "aud": "proj_123",
    "email": "ada@example.com",
    "email_verified": true,
    "is_anonymous": false,
    "claims": { "role": "member" },
    "iat": 1763462400,
    "exp": 1763466000,
    "auth_time": 1763462400,
    "jti": "9e1c0f7a-..."
  }
}`}
        />
        <Callout tone="danger" title="No HS256 fallback">
          End-user verification is EdDSA-only on both HTTP and WebSocket. Any HS256 token is
          rejected on the document plane even when a valid <code>pk_</code> key is present. The public key is
          project-scoped; projects without an auth config are initialized on first use, with the Ed25519
          private key encrypted at rest.
        </Callout>
        <H3 id="jwks">Public keys</H3>
        <Api method="GET" path={`${PREFIX}/.well-known/jwks.json`}>
          <P>
            Public JWKS document (OKP / Ed25519). This is the only end-user endpoint that does not require a
            project API key; gateways and clients fetch it to verify bearer tokens.
          </P>
        </Api>
      </Section>

      <Section id="rest-endpoints" title="End-user REST endpoints">
        <P>
          Every route below is mounted at <code>{PREFIX}</code>. All of them require a project API key bound to
          the requested project; the bearer token is optional except where the endpoint resolves
          the current user.
        </P>

        <H3 id="sign-up-and-sign-in">Sign-up & sign-in</H3>
        <Table
          head={["Method", "Path", "Notes"]}
          rows={[
            ["POST", <code>/sign-up/email</code>, "Creates the user and returns a session (201). Enforces password policy and registration guards."],
            ["POST", <code>/sign-in/email</code>, "Returns a session, or an MFA ticket when a verified TOTP factor exists."],
            ["POST", <code>/sign-in/anonymous</code>, "Creates an anonymous user and returns a session (201)."],
            ["POST", <code>/sign-in/provider</code>, "Links or creates an identity for an external provider."],
          ]}
        />
        <Api method="POST" path={`${PREFIX}/sign-in/email`}>
          <P>
            Successful sign-in returns <code>accessToken</code>, <code>refreshToken</code>, <code>tokenType</code>,
            <code> sessionId</code>, <code>expiresAt</code>, and the redacted <code>user</code>. Invalid credentials
            return <code>UNAUTHENTICATED</code>; disabled accounts return <code>PERMISSION_DENIED</code>.
          </P>
        </Api>
        <Api method="POST" path={`${PREFIX}/sign-up/email`}>
          <P>
            Requires <code>email</code> and <code>password</code>; optional <code>displayName</code>,
            <code> photoUrl</code>, <code>phoneNumber</code>, <code>metadata</code>, and <code>customClaims</code>.
            Existing emails return <code>ALREADY_EXISTS</code>, and a full project returns
            <code> QUOTA_EXCEEDED</code>.
          </P>
        </Api>

        <H3 id="refresh-and-sign-out-routes">Refresh & sign-out</H3>
        <Table
          head={["Method", "Path", "Notes"]}
          rows={[
            ["POST", <code>/token/refresh</code>, "Body: { refreshToken }. Returns a new access/refresh pair and session metadata."],
            ["POST", <code>/sign-out</code>, "With { refreshToken } revokes one session; otherwise revokes all sessions for the bearer's user."],
          ]}
        />
        <P>
          With <code>enable_user_projection</code> on (the default), sign-up, profile updates, and email-verification
          confirmation re-project the <code>users/{'{uid}'}</code> document through the document engine using
          merge semantics and an in-process system bypass — developers' own fields are preserved.
        </P>

        <H3 id="profile-verification-password">Profile, verification & password</H3>
        <Table
          head={["Method", "Path", "Notes"]}
          rows={[
            ["GET", <code>/user</code>, "Returns the current user's redacted record."],
            ["PATCH", <code>/user</code>, "Updates profile fields, metadata and custom claims; changing email clears verification."],
            ["POST", <code>/password/reset</code>, "Always { success: true, sent: true } — never reveals whether an email exists."],
            ["POST", <code>/password/confirm</code>, "Consumes the one-hour token, sets the new password and revokes all sessions."],
            ["POST", <code>/email/verify/request</code>, "Non-enumerating; accepts an email or the current bearer."],
            ["POST", <code>/email/verify/confirm</code>, "Consumes the token and marks the email verified."],
          ]}
        />

        <H3 id="mfa-routes">MFA</H3>
        <Table
          head={["Method", "Path", "Notes"]}
          rows={[
            ["POST", <code>/mfa/enroll</code>, "Returns a TOTP secret, an otpauth:// URI and one-time recovery codes."],
            ["POST", <code>/mfa/verify</code>, "Confirms enrollment with a six-digit TOTP code or a recovery code."],
            ["POST", <code>/mfa/challenge</code>, "Exchanges a single-use MFA ticket plus a code for a session."],
          ]}
        />
      </Section>

      <Section id="refresh-and-mfa" title="Refresh rotation & MFA behavior">
        <H3 id="refresh-rotation">Refresh rotation</H3>
        <P>
          Refresh tokens are opaque 32-byte values; only their SHA-256 hashes are stored. Rotation keeps the
          previous hash and a <code>rotated_at</code> timestamp so concurrent tabs do not fight each other:
        </P>
        <Steps
          items={[
            {
              title: "Current hash presented",
              body: "Normal rotation: store the previous hash, set rotated_at = now(), increment the rotation counter, and return a fresh pair.",
            },
            {
              title: "Previous hash within 15 seconds",
              body: "Treated as a benign concurrent tab: no session is revoked. A brand-new session is created for the same user and a fresh access/refresh pair is returned.",
            },
            {
              title: "Previous hash after 15 seconds",
              body: "Treated as replay: all of the user's sessions are revoked with reason refresh_token_replay_detected and the request fails UNAUTHENTICATED.",
            },
          ]}
        />
        <P>
          Both SDKs pre-flight refresh 45 seconds before <code>exp</code>, deduplicate with a single-flight mutex,
          and react to a <code>401</code> with one forced refresh plus one transparent replay.
        </P>

        <H3 id="mfa-flow">MFA flow</H3>
        <Steps
          items={[
            {
              title: "Enroll",
              body: "POST /mfa/enroll returns the secret, otpauth URI, and recovery codes. The factor is stored unverified until confirmation.",
            },
            {
              title: "Confirm",
              body: "POST /mfa/verify with a TOTP code or recovery code flips the factor to verified. Five bad codes revoke the caller's sessions.",
            },
            {
              title: "Challenge on sign-in",
              body: "A subsequent sign-in returns { mfaRequired: true, mfaTicket, factors: [\u0022totp\u0022], expiresAt }. The ticket is single-use and valid for five minutes.",
            },
            {
              title: "Exchange the ticket",
              body: "POST /mfa/challenge with the ticket and a code issues the session. After five bad codes the ticket is consumed and cannot be replayed.",
            },
          ]}
        />

        <H3 id="rate-limits">Rate limits</H3>
        <Table
          head={["Scope", "Window", "Limit", "Result"]}
          rows={[
            ["Failed /sign-in/email per (ip, email)", "15 min", "10", "429 TOO_MANY_REQUESTS + Retry-After"],
            ["Password reset / email verify per (ip, email)", "15 min", "5", "429 TOO_MANY_REQUESTS + Retry-After"],
            ["Failed MFA codes per ticket or user", "5 min", "5", "Ticket consumed or sessions revoked; 429"],
          ]}
        />
        <P>
          These are in-process sliding windows — throttle state, not durable state — in keeping with the
          zero-Redis doctrine.
        </P>
      </Section>

      <Section id="sdk-and-next" title="SDK examples & next steps">
        <CodeTabs
          tabs={[
            {
              label: "JavaScript / TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "proj_123",
  apiKey: "pk_...",
  endpoint: "https://api.vellum.dev",
});

const session = await db.auth.signUpWithEmailAndPassword({
  email: "ada@example.com",
  password: "correct-horse-battery",
  displayName: "Ada",
});
const token = await db.auth.getIdToken();

const result = await db.auth.signInWithEmailAndPassword({
  email: "ada@example.com",
  password: "correct-horse-battery",
});
if ("mfaRequired" in result) {
  const verified = await db.auth.verifyMfaChallenge({
    mfaTicket: result.mfaTicket,
    code: "123456",
  });
}
await db.auth.signOut();`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.vellum.dev',
  projectId: 'proj_123',
  apiKey: 'pk_...',
);

final user = await client.auth.signUpWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct-horse-battery',
);
final result = await client.auth.signInWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct-horse-battery',
);
final String? token = await client.auth.getIdToken();`,
            },
            {
              label: "cURL",
              lang: "bash",
              code: `curl -X POST \\
  "https://api.vellum.dev${PREFIX}/sign-in/email" \\
  -H "x-vellum-api-key: pk_..." \\
  -H "content-type: application/json" \\
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}'`,
            },
          ]}
        />
        <P>
          Pass the returned access token as a bearer alongside the project API key on document requests; the
          token's <code>sub</code> becomes <code>auth.uid</code> and its <code>claims</code> become
          <code> auth.claims</code> in the rules AST. After rotation, the SDKs re-send the WebSocket auth frame
          on the live connection.
        </P>
        <P>
          Continue with <PageLink slug="security-rules">Security rules</PageLink>, the{" "}
          <PageLink slug="reference/rest-data-plane">data plane REST reference</PageLink>, or the{" "}
          <PageLink slug="realtime">realtime protocol</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
