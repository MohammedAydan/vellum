import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared Node QA helper.
import { displayedRulesExamples } from '../../../../scripts/qa/verify-docs-requests.mjs';
// @ts-expect-error Shared Node snippet extractor.
import { extractSnippets } from '../../../../scripts/qa/doc-snippets.mjs';
import { resolve } from 'node:path';

describe('current displayed Rules examples', () => {
  for (const lang of ['en', 'ar']) {
    it(`extracts ${lang} DSL and owner simulation without obsolete curl blocks`, () => {
      const blocks = extractSnippets(resolve(import.meta.dirname, '../../../..'))
        .filter((snippet: { file: string }) => snippet.file.endsWith(`/pages/${lang}/security-rules-dsl.tsx`))
        .map((snippet: { code: string }) => snippet.code);
      const examples = displayedRulesExamples(blocks.map((code: string) => code.replaceAll(' ', '\u00a0')));
      expect(examples.source).toContain('function ownsNamespace()');
      expect(examples.simulation.auth.uid).toBe('alice');
      expect(examples.simulation.rulesAst.version).toBe(1);
    });
  }
  it('fails closed when either displayed example is missing', () => {
    expect(() => displayedRulesExamples([])).toThrow('Missing displayed');
  });
});
