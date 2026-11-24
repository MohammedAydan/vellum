import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { htmlToMarkdown } from "../../scripts/html-to-md.mjs";
import { buildAgentPrompt } from "../agent-prompt";

describe("html to markdown", () => {
  it("converts headings, inline code, links, lists and tables", () => {
    const md = htmlToMarkdown(
      '<h2 id="a"><a class="doc-anchor" href="#a">#</a>Title</h2><p>Use <code>x</code> and <a href="/docs/query/#f">query</a>.</p><ul><li>one</li><li>two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      { baseUrl: "https://o.example" },
    );
    expect(md).toContain("## Title");
    expect(md).toContain("Use `x` and [query](https://o.example/docs/query.md#f).");
    expect(md).toContain("- one\n- two");
    expect(md).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("keeps code block line breaks", () => {
    const md = htmlToMarkdown('<pre><code><span class="flex"><span>a</span></span><span class="flex"><span>b</span></span></code></pre>');
    expect(md).toContain("```\na\nb\n```");
  });
});

describe("agent prompt", () => {
  it("points at the machine-readable docs and never mentions MCP or console features", () => {
    const prompt = buildAgentPrompt("https://docs.example");
    expect(prompt).toContain("https://docs.example/docs/llms.txt");
    expect(prompt).toContain("https://docs.example/docs/openapi.json");
    expect(prompt).not.toMatch(/\bmcp\b|console|admin/i);
  });
});
