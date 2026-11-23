import { SdkEndpointNote } from "../../sdk-endpoint-note";
import { quickstartTypeScript, quickstartDart } from "../../quickstart-examples";
import { betaJavaScriptInstall, betaDartInstall } from "../../beta-install";
import {
  Callout,
  Code,
  CodeTabs,
  Doc,
  P,
  PageLink,
  Section,
  Steps,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Get started"
      title="Quickstart"
      description="Verify your API instance, install @vellumdb/sdk-js or vellum_flutter, run your first document writes and queries, and clean up client resources safely."
    >

      <SdkEndpointNote />
      <Section id="beta-install" title="Beta installation">
        <P>Version 0.0.2 is available on npm and pub.dev. Install the published Beta packages below. Repository access is not required.</P>
        <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
        <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
      </Section>
      <Section id="verify-health" title="1. Verify API liveness &amp; readiness">
        <P>
          Before connecting an SDK, confirm that your VELLUM API process is live and that both the
          Control Plane and Data Plane PostgreSQL pools are reachable. VELLUM exposes separate
          liveness and readiness probes at both the root path and under <code>/v1/health/*</code>.
        </P>

        <Table
          head={["Endpoint", "Touches PG?", "Behavior During Drain", "Intended Consumer"]}
          rows={[
            [
              <code>GET /health</code>,
              "No (fast process check)",
              "Returns 200 while process is alive",
              "Container liveness probes & uptime pingers",
            ],
            [
              <code>GET /ready</code>,
              "Yes (real SQL probes)",
              <>
                Immediately returns <code>503</code> with <code>{`{ "status": "draining", "ready": false }`}</code>
              </>,
              "Load balancers & Kubernetes readiness gates",
            ],
            [
              <code>GET /v1/health/live</code>,
              "No",
              "Returns 200 while process is alive",
              "Versioned liveness checks & Docker HEALTHCHECK",
            ],
            [
              <code>GET /v1/health/ready</code>,
              "Yes (Control + Data planes)",
              <>
                Returns <code>503</code> (<code>status: &quot;draining&quot;</code>) during graceful shutdown
              </>,
              "API gateway & CI smoke tests",
            ],
            [
              <code>GET /v1/health</code>,
              "Yes (legacy summary)",
              "Prefer /v1/health/live + /v1/health/ready for new integrations",
              "Backwards-compatible OpenAPI checks",
            ],
          ]}
        />

        <Code
          lang="bash"
          title="Check liveness and readiness"
          code={`curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8080/ready
curl -fsS http://localhost:8080/v1/health/live
curl -fsS http://localhost:8080/v1/health/ready`}
        />
      </Section>

      <Section id="install" title="2. Install an SDK">
        <CodeTabs
          tabs={[
            {
              label: "TypeScript / Node / Browser",
              lang: "bash",
              code: betaJavaScriptInstall,
            },
            {
              label: "Flutter / Dart",
              lang: "yaml",
              code: betaDartInstall,
            },
          ]}
        />
      </Section>

      <Section id="first-operations" title="3. Write, read, query, and delete">
        <P>
          Initialize a client with your API endpoint, project UUID, and scoped API key. Use a{" "}
          <code>sk_...</code> server key in trusted backend services, or a <code>pk_...</code>{" "}
          publishable key paired with end-user authentication in browser and mobile apps.
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (@vellumdb/sdk-js)",
              lang: "ts",
              code: quickstartTypeScript,
            },
            {
              label: "Flutter / Dart (vellum_flutter)",
              lang: "dart",
              code: quickstartDart,
            },
          ]}
        />
      </Section>

      <Section id="operators-at-a-glance" title="4. All 13 query operators at a glance">
        <P>
          Both SDKs and the REST <code>POST /query</code> endpoint support the exact same 13
          parameterized SQL operators—never silently degrading any operator to a no-op:
        </P>
        <UL
          items={[
            <>
              <strong>Equality &amp; comparison (6):</strong> <code>==</code>, <code>!=</code>,{" "}
              <code>&lt;</code>, <code>&lt;=</code>, <code>&gt;</code>, <code>&gt;=</code>
            </>,
            <>
              <strong>Set membership (2):</strong> <code>in</code>, <code>not-in</code> (up to 30
              values each)
            </>,
            <>
              <strong>Array membership (2):</strong> <code>array-contains</code>,{" "}
              <code>array-contains-any</code> (up to 30 values; max 120 total expansions per query)
            </>,
            <>
              <strong>Text search (3):</strong> <code>contains_ci</code>,{" "}
              <code>starts_with_ci</code>, <code>text_search</code> (string operand capped at 1,024
              characters)
            </>,
          ]}
        />
        <P>
          See the <PageLink slug="query">Query Engine guide</PageLink> for SQL compilation details,
          disjunctive <code>or</code> groups, and field projection limits.
        </P>
      </Section>

      <Section id="dispose-best-practices" title="5. Client lifecycle &amp; dispose() best practices">
        <Callout tone="warning" title="Always call dispose() when tearing down a client">
          Both <code>@vellumdb/sdk-js</code> and <code>vellum_flutter</code> manage proactive JWT
          refresh timers, WebSocket realtime transports, and in-memory read caches. In CLI scripts,
          serverless handlers, widget <code>State.dispose()</code> hooks, or test suites, always
          call <code>db.dispose()</code> (or <code>db.close()</code> in Flutter) so open timers and
          sockets do not leak or prevent process exit.
        </Callout>

        <Steps
          items={[
            {
              title: "Long-lived apps (SPAs, Flutter, API servers)",
              body: "Create a single VellumClient instance at startup, share it via dependency injection or React/Riverpod providers, and call db.dispose() on SIGTERM or root widget teardown.",
            },
            {
              title: "Short-lived jobs & integration tests",
              body: "Wrap client usage in a try { ... } finally { db.dispose(); } block to guarantee cleanup even when a query or transaction throws.",
            },
            {
              title: "Next steps",
              body: (
                <>
                  Explore <PageLink slug="pagination">cursor pagination</PageLink>,{" "}
                  <PageLink slug="realtime">realtime subscriptions</PageLink>, and the{" "}
                  <PageLink slug="production-checklist">production checklist</PageLink>.
                </>
              ),
            },
          ]}
        />
      </Section>
    </Doc>
  );
}
