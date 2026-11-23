import {
  Callout,
  Code,
  Doc,
  OL,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Operations"
      title="Production Checklist"
      description="Pre-launch verification across dual PostgreSQL planes, 12-table RLS, distinct cryptographic secrets, health & drain probes, container hardening, and backup drills."
    >
      <P>
        Use this checklist before promoting a VELLUM deployment to production. Every item corresponds
        directly to an enforced runtime invariant in the hardened codebase.
      </P>

      <Section id="secrets-and-planes" title="1. Secrets, realms &amp; dual PostgreSQL planes">
        <Table
          head={["Requirement", "Verification"]}
          rows={[
            [
              <strong>Distinct PostgreSQL databases</strong>,
              <>
                Set <code>DATABASE_MODE=postgres</code> with separate{" "}
                <code>CONTROL_DATABASE_URL</code> and <code>DATA_DATABASE_URL</code> connection
                strings (TLS enabled). No Redis or external broker is required.
              </>,
            ],
            [
              <strong>Distinct per-realm signing secrets</strong>,
              <>
                Provision unique, high-entropy values for <code>BETTER_AUTH_SECRET</code>,{" "}
                <code>JWT_SECRET</code>, <code>CONSOLE_JWT_SECRET</code>,{" "}
                <code>SUPER_ADMIN_JWT_SECRET</code>, <code>API_KEY_PEPPER</code>,{" "}
                <code>CURSOR_HMAC_SECRET</code>, <code>SESSION_COOKIE_SECRET</code>, and{" "}
                <code>MASTER_ENCRYPTION_KEY</code>. Never reuse secrets across realms.
              </>,
            ],
            [
              <strong>Least-privilege DB role &amp; 12-table RLS</strong>,
              <>
                Connect the Data Plane runtime as a non-superuser role (<code>vellum_app</code>,{" "}
                <code>NOBYPASSRLS</code>). Verify <code>FORCE ROW LEVEL SECURITY</code> is active
                on all 12 tables in <code>RLS_TENANT_TABLES</code>.
              </>,
            ],
            [
              <strong>Strict CORS &amp; proxy hops</strong>,
              <>
                Configure explicit <code>CORS_ALLOWED_ORIGINS</code> (never wildcard with
                credentials) and set trusted proxy hops accurately so{" "}
                <code>extractClientIp</code> resolves the rightmost untrusted hop from{" "}
                <code>X-Forwarded-For</code>.
              </>,
            ],
          ]}
        />
      </Section>

      <Section id="probes-and-drain" title="2. Health probes &amp; graceful draining shutdown">
        <UL
          items={[
            <>
              <strong>Liveness probe:</strong> Point container health checks to{" "}
              <code>GET /health</code> or <code>GET /v1/health/live</code> (never touches
              PostgreSQL, preventing cascading restarts during transient DB hiccups).
            </>,
            <>
              <strong>Readiness probe:</strong> Point load balancers to <code>GET /ready</code> or{" "}
              <code>GET /v1/health/ready</code> (runs real SQL probes against both Control and Data
              planes).
            </>,
            <>
              <strong>Graceful SIGTERM draining:</strong> On <code>SIGTERM</code>,{" "}
              <code>node-server.ts</code> immediately sets <code>setShuttingDown(true)</code> so{" "}
              <code>/ready</code> and <code>/v1/health/ready</code> return <code>503</code> (
              <code>status: &quot;draining&quot;</code>), stops background maintenance ticks, flushes
              pending metering deltas (<code>flushOnShutdown()</code>), and drains in-flight HTTP
              requests up to the configured drain timeout (default 10 s; Docker{" "}
              <code>stop_grace_period: 30s</code>) before closing sockets.
            </>,
          ]}
        />
      </Section>

      <Section id="container-and-edge" title="3. Container &amp; edge security posture">
        <UL
          items={[
            <>
              <strong>Hardened Docker runtime:</strong> Run as non-root user (<code>vellum</code> UID
              1001) under <code>/sbin/tini</code>, with <code>read_only: true</code>,{" "}
              <code>cap_drop: [ALL]</code>, <code>no-new-privileges:true</code>, and{" "}
              <code>/tmp:rw,noexec,nosuid,size=64m</code>.
            </>,
            <>
              <strong>Loopback-only app ports:</strong> Bind internal API and frontend ports to{" "}
              <code>127.0.0.1:8080</code> and <code>127.0.0.1:3000</code> so only Caddy (or your
              TLS ingress) is exposed publicly on <code>80</code>/<code>443</code>.
            </>,
            <>
              <strong>Edge security headers:</strong> Confirm HSTS (
              <code>max-age=63072000; includeSubDomains; preload</code>),{" "}
              <code>X-Content-Type-Options: nosniff</code>, <code>X-Frame-Options: DENY</code>,{" "}
              <code>Referrer-Policy: strict-origin-when-cross-origin</code>, and{" "}
              <code>Content-Security-Policy: frame-ancestors &apos;none&apos;; object-src &apos;none&apos;; base-uri &apos;self&apos;</code>.
            </>,
          ]}
        />
      </Section>

      <Section id="backups-and-verification" title="4. Backups, audit chain &amp; SDK hygiene">
        <OL
          items={[
            <>
              Enable point-in-time recovery (PITR) on both Control Plane and Data Plane PostgreSQL
              clusters and rehearse a restore into a staging database.
            </>,
            <>
              Schedule periodic <code>verify-chain</code> checks against the hash-chained audit log
              and billing ledger.
            </>,
            <>
              Verify all production services call <code>db.dispose()</code> on shutdown and silence
              console index warnings (<code>warnOnMissingIndexes: false</code>) while routing{" "}
              <code>onIndexSuggestion</code> to structured telemetry.
            </>,
          ]}
        />

        <Code
          lang="bash"
          title="Quick post-deploy smoke test"
          code={`curl -fsS https://api.example.com/health
curl -fsS https://api.example.com/ready
curl -fsS -I https://example.com/ | grep -iE 'strict-transport-security|content-security-policy|x-frame-options'`}
        />

        <Callout tone="success" title="Ready to deploy?">
          Follow the step-by-step <PageLink slug="deployment">Deployment &amp; Hosting guide</PageLink>{" "}
          for production Docker Compose, Caddy, and Vercel configurations.
        </Callout>
      </Section>
    </Doc>
  );
}
