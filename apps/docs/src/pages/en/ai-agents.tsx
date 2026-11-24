import { buildAgentPrompt, DEFAULT_DOCS_ORIGIN } from "../../agent-prompt";
import { Callout, Code, Doc, P, Section, Table, UL } from "../../ui";

export default function Page() {
  const origin = typeof window === "undefined" ? DEFAULT_DOCS_ORIGIN : window.location.origin;
  return (
    <Doc
      eyebrow="Get started"
      title="Use VELLUM with AI agents"
      description="Give an AI coding assistant what it needs to understand the platform and use the SDKs correctly: plain-Markdown docs, an index file and a ready prompt."
    >
      <Section id="prompt" title="Ready-made prompt">
        <P>
          Paste this into your assistant before you ask it to build something. It points the assistant at the
          Markdown docs and lists the rules that prevent the most common mistakes. You can also save it as
          <code> AGENTS.md</code> in your project; the same text is served at <code>/docs/AGENTS.md</code>.
        </P>
        <Code lang="markdown" title="Agent prompt" code={buildAgentPrompt(origin)} />
      </Section>

      <Section id="markdown" title="Docs as Markdown">
        <P>Every documentation page is also available as plain Markdown, without the site chrome.</P>
        <Table
          head={["What", "Where"]}
          rows={[
            ["Index of every page", <code>/docs/llms.txt</code>],
            ["All pages in one file", <code>/docs/llms-full.txt</code>],
            ["A single page", <>Add <code>.md</code> to its URL, for example <code>/docs/query.md</code></>],
            ["Arabic pages", <><code>/docs/ar/llms.txt</code> and <code>/docs/ar/query.md</code></>],
            ["HTTP API description", <><code>/docs/openapi.json</code> (OpenAPI 3.1)</>],
          ]}
        />
        <P>
          On any page, the Copy page menu copies that page as Markdown, opens the Markdown file, or opens the page in
          ChatGPT or Claude with a prompt that links to it.
        </P>
      </Section>

      <Section id="tips" title="Getting good results">
        <UL
          items={[
            "Tell the assistant which SDK you use, TypeScript or Flutter.",
            "Give it the endpoint, project id and key through environment variables. Never paste a secret key into a chat.",
            "Ask it to cite the docs pages it used, and run the code against a test project before you trust it.",
          ]}
        />
        <Callout tone="info" title="Keys">
          Use a publishable <code>pk_</code> key in browser and mobile apps, together with end-user sign-in. Keep{" "}
          <code>sk_</code> keys on your server.
        </Callout>
      </Section>
    </Doc>
  );
}
