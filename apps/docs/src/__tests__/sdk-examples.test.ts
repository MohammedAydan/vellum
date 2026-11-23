import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared dependency-free source extractor has no declaration file.
import { extractSnippets } from '../../../../scripts/qa/doc-snippets.mjs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
describe('displayed SDK consumer examples', () => {
  it('extracts both language versions and shared Quickstart source', () => {
    const snippets = extractSnippets(root) as { file: string; lang: string; code: string }[];
    for (const lang of ['en', 'ar']) {
      expect(snippets.filter(s => s.file.includes(`/pages/${lang}/`)).length).toBeGreaterThan(100);
      expect(snippets.find(s => s.file.includes(`/pages/${lang}/quickstart`) && s.lang === 'ts')?.code).toContain('finally');
      expect(snippets.find(s => s.file.includes(`/pages/${lang}/quickstart`) && s.lang === 'dart')?.code).toContain('db.dispose()');
    }
  });
  it('does not regress known SDK signature errors', () => {
    for (const lang of ['en', 'ar']) {
      const js = read(`apps/docs/src/pages/${lang}/sdks/javascript.tsx`);
      expect(js).not.toContain('readCache:');
      expect(js).not.toContain('onChunkComplete');
      expect(js).not.toContain('toVellum(');
      const realtime = read(`apps/docs/src/pages/${lang}/realtime.tsx`);
      expect(realtime).not.toContain('snap.doc.included');
      expect(realtime).toContain('snap.changes');
    }
    expect(read('apps/docs/src/pages/ar/sdks/flutter.tsx')).not.toContain('maxDocuments:');
  });
  it('requires explicit disposable fixture credentials in the runnable harnesses', () => {
    for (const file of ['examples/ts/_harness.ts', 'examples/rest/_harness.mjs']) {
      const code = read(file);
      for (const name of ['VELLUM_EMAIL', 'VELLUM_PASSWORD', 'VELLUM_PROJECT_ID']) expect(code).toContain(name);
      expect(code).not.toContain('visual@vellum.dev');
    }
  });
});
