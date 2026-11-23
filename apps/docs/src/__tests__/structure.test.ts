import { describe, expect, it } from "vitest";
import { ALL_PAGES, NAV_GROUPS, neighbors, pageHref } from "../nav";
import { PAGES, getPage } from "../registry";

describe("documentation site structure", () => {
  it("exposes every page in exactly one navigation group", () => {
    const slugs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.slug));
    expect(slugs).toHaveLength(ALL_PAGES.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(slugs)).toEqual(new Set(Object.keys(PAGES.en)));
    expect(new Set(slugs)).toEqual(new Set(Object.keys(PAGES.ar)));
  });

  it("gives every page a title and description in both languages", () => {
    for (const page of ALL_PAGES) {
      expect(page.title.en.length, `${page.slug} en title`).toBeGreaterThan(2);
      expect(page.title.ar.length, `${page.slug} ar title`).toBeGreaterThan(2);
      expect(page.desc.en.length, `${page.slug} en description`).toBeGreaterThan(10);
      expect(page.desc.ar.length, `${page.slug} ar description`).toBeGreaterThan(10);
    }
  });

  it("registers a React component for every slug in both languages", () => {
    for (const page of ALL_PAGES) {
      expect(getPage("en", page.slug), `en:${page.slug}`).toBeDefined();
      expect(getPage("ar", page.slug), `ar:${page.slug}`).toBeDefined();
    }
  });

  it("builds canonical language-prefixed links", () => {
    expect(pageHref("query", "en")).toBe("/docs/query/");
    expect(pageHref("query", "ar")).toBe("/docs/ar/query/");
  });

  it("computes previous/next neighbours", () => {
    const first = neighbors(ALL_PAGES[0]!.slug);
    expect(first.prev).toBeUndefined();
    expect(first.next).toBe(ALL_PAGES[1]);
    const middle = neighbors(ALL_PAGES[5]!.slug);
    expect(middle.prev).toBe(ALL_PAGES[4]);
    expect(middle.next).toBe(ALL_PAGES[6]);
  });
});
