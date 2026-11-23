import {
  Callout,
  Code,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Security"
      title="Security &amp; Defense in Depth"
      description="Multi-layered isolation across PostgreSQL RLS, constant-time cryptography, bounded AST rules evaluation, SSRF IPv4/IPv6 filtering, chunked body enforcement, and spoof-resistant IP extraction."
    >
      <P>
        VELLUM assumes that any single defensive layer can be misconfigured or probed by hostile
        traffic. Every request traverses independent, fail-closed security controls across the HTTP
        edge, authentication layer, rules engine, and PostgreSQL storage plane.
      </P>

      <Section id="rls-isolation" title="12-table single-round-trip RLS &amp; socket destruction">
        <P>
          All 12 tenant-scoped Data Plane tables enforce <code>ENABLE ROW LEVEL SECURITY</code> and{" "}
          <code>FORCE ROW LEVEL SECURITY</code> with a fail-closed policy:{" "}
          <code>project_id = NULLIF(current_setting(&apos;app.current_project_id&apos;, true), &apos;&apos;)::uuid</code>.
          When the GUC is unset or empty, PostgreSQL evaluates the predicate to <code>NULL</code>{" "}
          and denies every row automatically.
        </P>

        <Code
          lang="sql"
          title="Single-round-trip transaction-local tenant context (Neon / PgBouncer safe)"
          code={`BEGIN;
SELECT
  set_config('app.current_project_id', $1, true),
  set_config('statement_timeout', '5000ms', true),
  set_config('lock_timeout', '2000ms', true),
  set_config('idle_in_transaction_session_timeout', '15000ms', true);
-- ... tenant queries run under vellum_app (non-superuser, NOBYPASSRLS) ...
COMMIT;`}
        />

        <UL
          items={[
            <>
              <strong>All 12 RLS tables:</strong> <code>documents</code>,{" "}
              <code>document_indexes</code>, <code>document_index_entries</code>,{" "}
              <code>realtime_outbox</code>, <code>project_collections</code>,{" "}
              <code>project_auth_users</code>, <code>project_auth_identities</code>,{" "}
              <code>project_auth_sessions</code>, <code>project_auth_mfa</code>,{" "}
              <code>project_auth_tokens</code>, <code>transactions</code>, and{" "}
              <code>batch_idempotency_keys</code>.
            </>,
            <>
              <strong>Fail-fast validation before pool checkout:</strong> <code>projectId</code>{" "}
              must be a canonical non-nil 36-character UUID, privileged PostgreSQL roles (
              <code>postgres</code>, <code>neon_superuser</code>, <code>rdsadmin</code>,{" "}
              <code>pg_*</code>) are forbidden, and custom claims are stripped of{" "}
              <code>__proto__</code>/<code>constructor</code>/<code>prototype</code> and bounded to
              4,096 bytes / 32 keys / depth 3.
            </>,
            <>
              <strong>Rollback connection destruction:</strong> If <code>ROLLBACK</code> fails on
              error, <code>withTenantContext</code> passes the error to{" "}
              <code>client.release(destroyError)</code> so the pool destroys the tainted socket
              rather than recycling it to another tenant.
            </>,
          ]}
        />
      </Section>

      <Section id="constant-time-crypto" title="Constant-time cryptography (timingSafeEqual)">
        <Table
          head={["Surface", "Verification Mechanism"]}
          rows={[
            [
              <strong>API Keys (even on cache hits)</strong>,
              <>
                Peppered SHA-256 digest compared via <code>crypto.timingSafeEqual</code> on every
                single request, including LRU cache hits (<code>MAX_API_KEY_LENGTH = 256</code>).
              </>,
            ],
            [
              <strong>JWTs &amp; Session Tokens</strong>,
              <>
                Strict algorithm pinning (<code>HS256</code> for sessions / test JWTs,{" "}
                <code>EdDSA</code> / JWKS allowlist for end-user tokens), <code>iss</code>/
                <code>aud</code>/<code>nbf</code>/<code>exp</code> validation, and{" "}
                <code>crypto.timingSafeEqual</code> signature verification.
              </>,
            ],
            [
              <strong>TOTP MFA &amp; Recovery Codes</strong>,
              <>
                Recovery codes are HMAC-SHA256 hashed with a server pepper and verified with{" "}
                <code>crypto.timingSafeEqual</code>.
              </>,
            ],
            [
              <strong>Webhooks &amp; Audit Hash Chain</strong>,
              <>
                Webhook signatures and HKDF-derived HMAC-SHA256 audit chain links verify digests via{" "}
                <code>timingSafeEqual</code> without leaking secret length.
              </>,
            ],
            [
              <strong>Opaque Query Cursors</strong>,
              <>
                Both the 64-char hex HMAC-SHA256 signature and <code>qHash</code> use{" "}
                <code>crypto.timingSafeEqual</code>.
              </>,
            ],
          ]}
        />
      </Section>

      <Section id="ast-and-payload-guards" title="AST 256-step budget &amp; prototype-pollution guards">
        <P>
          Security rules evaluate deterministically in a sandboxed AST interpreter with strict
          resource budgets:
        </P>
        <UL
          items={[
            <>
              <strong>AST execution cap:</strong> <code>MAX_EVAL_STEPS = 256</code> (also enforced
              in the DSL simulator via <code>MAX_SIM_EVAL_STEPS = 256</code>),{" "}
              <code>MAX_IN_OPERAND_ELEMENTS = 256</code>, <code>RULES_AST_MAX_DEPTH = 10</code>, and{" "}
              <code>RULES_AST_MAX_NODES = 100</code>.
            </>,
            <>
              <strong>Prototype-pollution defense:</strong> <code>__proto__</code>,{" "}
              <code>constructor</code>, and <code>prototype</code> are rejected in{" "}
              <code>payload-guard</code> (including non-enumerable own properties),{" "}
              <code>query-cost-guard</code>, <code>query-engine</code> field paths,{" "}
              <code>rules-ast</code> path bindings / <code>hasKey</code> checks, and{" "}
              <code>cursor</code> decoding.
            </>,
          ]}
        />
      </Section>

      <Section id="network-and-http-hardening" title="SSRF, chunked body limits, IP extraction &amp; open-redirect guards">
        <Table
          head={["Guard", "Enforcement Detail"]}
          rows={[
            [
              <strong>SSRF IPv4 / IPv6 Guard</strong>,
              <>
                Blocks loopback, RFC1918 (<code>10/8</code>, <code>172.16/12</code>,{" "}
                <code>192.168/16</code>), link-local &amp; cloud metadata (<code>169.254/16</code>),
                CGNAT (<code>100.64/10</code>), multicast/reserved ranges, IPv6 zone-ID bypasses (
                <code>fe80::1%eth0</code>), and IPv4-mapped IPv6 literals (<code>::ffff:...</code>{" "}
                in both dotted and hex form).
              </>,
            ],
            [
              <strong>Chunked body-limit enforcement</strong>,
              <>
                <code>bodyLimit</code> &amp; Fortress enforce both <code>Content-Length</code> and
                actual streamed bytes (1 MiB standard, 5 MiB for <code>batchWrite</code> / imports),
                preventing chunked transfer-encoding bypasses when <code>Content-Length</code> is
                omitted.
              </>,
            ],
            [
              <strong>Spoof-resistant IP extraction</strong>,
              <>
                <code>extractClientIp</code> uses <code>hops[hops.length - trustedProxyHops]</code>{" "}
                (rightmost untrusted hop) when <code>trustedProxyHops &gt; 0</code> instead of the
                client-controlled leftmost <code>X-Forwarded-For</code> entry; when{" "}
                <code>trustedProxyHops === 0</code>, it ignores forwarded headers and reads the
                socket-level <code>x-vellum-remote-addr</code> injected by <code>node-server.ts</code>.
              </>,
            ],
            [
              <strong>Open-redirect &amp; strict CORS validation</strong>,
              "Strict origin normalization rejects malformed origins, credentialed wildcards, and external/protocol-relative redirect targets.",
            ],
            [
              <strong>Automated Threat Detector</strong>,
              "Sliding-window tracking automatically blocks abusive IPs on repeated prototype-pollution or SSRF attempts (60-minute block).",
            ],
          ]}
        />

        <Callout tone="info" title="Continue hardening">
          Pair these runtime defenses with our{" "}
          <PageLink slug="security-rules-dsl">Security Rules DSL</PageLink> and{" "}
          <PageLink slug="production-checklist">Production Checklist</PageLink>.
        </Callout>
      </Section>
    </Doc>
  );
}
