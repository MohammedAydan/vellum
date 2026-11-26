import { describe, expect, it } from 'vitest';
import { validateAndNormalizeQuery } from '../index.js';

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
};

describe('query validation error codes', () => {
  it('limit(0) and non-integer limits are INVALID_ARGUMENT, too-large is LIMIT_EXCEEDED', () => {
    expect(code(() => validateAndNormalizeQuery({ collectionPath: 'c', limit: 0 }))).toBe('INVALID_ARGUMENT');
    expect(code(() => validateAndNormalizeQuery({ collectionPath: 'c', limit: 2.5 }))).toBe('INVALID_ARGUMENT');
    expect(code(() => validateAndNormalizeQuery({ collectionPath: 'c', limit: 100000 }))).toBe('LIMIT_EXCEEDED');
  });
  it('an empty in list is INVALID_ARGUMENT with a clear message, an oversized one stays QUERY_TOO_COMPLEX', () => {
    const where = (value: unknown[]) => ({ collectionPath: 'c', where: [{ field: 'a', op: 'in', value }] });
    expect(code(() => validateAndNormalizeQuery(where([]) as never))).toBe('INVALID_ARGUMENT');
    expect(code(() => validateAndNormalizeQuery(where(Array.from({ length: 100 }, (_, i) => i)) as never))).toBe('QUERY_TOO_COMPLEX');
  });
});
