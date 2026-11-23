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
      eyebrow="Operations"
      title="Deployment &amp; Hosting"
      description="Production deployment blueprints for hardened Docker containers (tini, cap_drop: ALL, read_only, 127.0.0.1), Caddy automatic HTTPS with HSTS+CSP, Vercel single-origin routing, and graceful draining."
    >
      <P>
        Because VELLUM follows the Zero-Redis doctrine, a complete production stack consists of just
        your stateless API container, the unified frontend gateway (Dashboard at <code>/</code>,
        Admin Console at <code>/admin/</code>, Docs at <code>/docs/</code>), a TLS reverse proxy
        (Caddy or Vercel), and external PostgreSQL (e.g. Neon, RDS, or Cloud SQL) for the Control
        and Data planes.
      </P>

      <Section id="hardened-docker" title="Hardened Docker &amp; Docker Compose">
        <P>
          <code>deploy/docker/Dockerfile.api</code> builds on <code>node:22-alpine</code>, runs as
          non-root <code>vellum</code> (UID 1001), uses <code>/sbin/tini</code> as PID 1 for clean
          signal forwarding (<code>STOPSIGNAL SIGTERM</code>), and probes{" "}
          <code>http://127.0.0.1:8080/v1/health/live</code>.
        </P>

        <Code
          lang="yaml"
          title="deploy/docker/docker-compose.prod.yml (key hardening flags)"
          code={`services:
  api:
    build:
      context: \${VELLUM_REPO_ROOT:-../..}
      dockerfile: deploy/docker/Dockerfile.api
    restart: unless-stopped
    init: true
    stop_grace_period: 30s
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    env_file:
      - \${VELLUM_REPO_ROOT:-../..}/.env
    ports:
      - "127.0.0.1:8080:8080"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:8080/v1/health/live"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 15s`}
        />

        <Code
          lang="bash"
          title="Launch the production stack"
          code={`VELLUM_DOMAIN=example.com docker compose -f deploy/docker/docker-compose.prod.yml up -d --build`}
        />

        <UL
          items={[
            <>
              <strong>Zero Linux capabilities:</strong> Both <code>api</code> and{" "}
              <code>frontend</code> drop all capabilities (<code>cap_drop: [ALL]</code>), mount
              their root filesystems <code>read_only: true</code>, and disallow privilege escalation
              (<code>no-new-privileges:true</code>).
            </>,
            <>
              <strong>Loopback port binding:</strong> Internal ports bind strictly to{" "}
              <code>127.0.0.1:8080</code> and <code>127.0.0.1:3000</code> so the containers cannot
              be reached directly from the public internet.
            </>,
            <>
              <strong>Caddy least privilege:</strong> Only Caddy binds public ports{" "}
              <code>80</code> and <code>443</code> with <code>cap_drop: [ALL]</code> +{" "}
              <code>cap_add: [NET_BIND_SERVICE]</code>.
            </>,
          ]}
        />
      </Section>

      <Section id="caddy-and-vercel" title="Caddy &amp; Vercel HSTS + CSP headers">
        <P>
          Both <code>deploy/caddy/Caddyfile</code> and the repository root <code>vercel.json</code>{" "}
          enforce identical security headers and single-origin routing (including WebSocket upgrades
          on <code>/v1/*</code>):
        </P>

        <Code
          lang="caddyfile"
          title="deploy/caddy/Caddyfile"
          code={`{$VELLUM_DOMAIN} {
  header {
    -Server
    Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    X-Permitted-Cross-Domain-Policies none
    Content-Security-Policy "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
  }

  handle /v1/* {
    reverse_proxy api:8080
  }

  handle {
    reverse_proxy frontend:3000
  }
}`}
        />

        <Table
          head={["Platform", "Build / Entrypoint", "Static Assets &amp; Routing"]}
          rows={[
            [
              <strong>Docker + Caddy</strong>,
              <code>deploy/docker/docker-compose.prod.yml</code>,
              "Automatic ACME TLS on apex + api subdomain; /v1/* proxies HTTP & WebSocket upgrades to api:8080.",
            ],
            [
              <strong>Vercel</strong>,
              <><code>corepack pnpm build:frontend</code> → <code>dist-frontend</code></>,
              "Immutable 1-year Cache-Control on /assets/*, HSTS + CSP + COOP headers, and rewrites for /admin, /docs, and /v1/*.",
            ],
          ]}
        />
      </Section>

      <Section id="graceful-shutdown" title="Graceful draining shutdown &amp; probes">
        <P>
          During rolling deploys, orchestrators send <code>SIGTERM</code> to the{" "}
          <code>tini</code> entrypoint, which forwards it to <code>node-server.ts</code>:
        </P>
        <UL
          items={[
            <>
              <strong>Immediate 503 on readiness:</strong> <code>GET /ready</code> and{" "}
              <code>GET /v1/health/ready</code> immediately return <code>503</code> (
              <code>{`{ "status": "draining", "ready": false }`}</code>) so load balancers stop
              routing new traffic.
            </>,
            <>
              <strong>Liveness stays 200:</strong> <code>GET /health</code> and{" "}
              <code>GET /v1/health/live</code> stay green while in-flight requests drain so the
              container is not killed mid-flight.
            </>,
            <>
              <strong>Metering flush &amp; bounded drain:</strong> Pending in-memory metering deltas
              are flushed to PostgreSQL, in-flight HTTP requests drain up to the drain timeout
              (default 10 s within Docker&apos;s 30 s <code>stop_grace_period</code>), and open
              PostgreSQL pools close cleanly.
            </>,
          ]}
        />

        <Callout tone="warning" title="Never bake secrets into images">
          Supply <code>.env</code> via <code>env_file</code> or your platform secret manager—never
          commit <code>CONTROL_DATABASE_URL</code>, <code>DATA_DATABASE_URL</code>, or signing keys
          into Dockerfiles or <code>vercel.json</code>. Review the{" "}
          <PageLink slug="production-checklist">Production Checklist</PageLink> before cutover.
        </Callout>
      </Section>
    </Doc>
  );
}
