import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error Shared dependency-free converter has no declaration file.
import { htmlToMarkdown } from '../../scripts/html-to-md.mjs';
import { ALL_PAGES, NAV_GROUPS } from '../nav';

// D4 drift guard: llms.txt / llms-full.txt / <slug>.md are GENERATED from the
// pages at build time (scripts/build-ai-docs.mjs). This test re-runs the same
// render pipeline so a page that cannot render, renders empty, or is missing
// from the llms index fails CI instead of silently drifting.

const pages = import.meta.glob('../pages/**/*.tsx');

describe('generated AI docs stay in sync with the pages', () => {
  it('every registry page renders to non-trivial Markdown in both languages', async () => {
    for (const lang of ['en', 'ar']) {
      for (const page of ALL_PAGES) {
        const load = pages[`../pages/${lang}/${page.slug}.tsx`];
        expect(load, `${lang}/${page.slug}.tsx exists`).toBeTypeOf('function');
        const mod = (await load!()) as { default: React.ComponentType };
        const html = renderToStaticMarkup(createElement(mod.default));
        const markdown = htmlToMarkdown(html, { baseUrl: 'https://vellum-console.vercel.app' }) as string;
        expect(markdown.length, `${lang}/${page.slug} renders content`).toBeGreaterThan(100);
      }
    }
  }, 180_000);

  it('the llms.txt index lists every nav page exactly as build-ai-docs generates it', () => {
    // Mirror of the index loop in scripts/build-ai-docs.mjs.
    const lines: string[] = [];
    for (const group of NAV_GROUPS) {
      if (group.title.en === 'Legal') continue;
      for (const p of group.items) {
        lines.push(`- [${p.title.en}](https://vellum-console.vercel.app/docs/${p.slug}.md): ${p.desc.en}`);
      }
    }
    const indexed = new Set(NAV_GROUPS.filter((g) => g.title.en !== 'Legal').flatMap((g) => g.items.map((i) => i.slug)));
    for (const page of ALL_PAGES) {
      if (['privacy', 'terms'].includes(page.slug)) continue; // Legal group is excluded by design
      expect(indexed.has(page.slug), `${page.slug} appears in the llms.txt index`).toBe(true);
    }
    expect(lines.length).toBeGreaterThan(0);
  });
});
