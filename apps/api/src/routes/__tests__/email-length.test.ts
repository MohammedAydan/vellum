import { describe, expect, it } from 'vitest';
import { SignUpEmailRequestSchema } from '@vellum/api-contract';
import { createVellumPlatform } from '../../index.js';

describe('email length cap', () => {
  const longEmail = `${'a'.repeat(250)}@example.com`;
  it('end-user schema rejects an address over 254 characters and accepts one at the limit', () => {
    expect(SignUpEmailRequestSchema.safeParse({ email: longEmail, password: 'Valid-pass-1234!' }).success).toBe(false);
    const atLimit = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}.com`;
    expect(atLimit.length).toBeLessThanOrEqual(254);
    expect(SignUpEmailRequestSchema.safeParse({ email: atLimit, password: 'Valid-pass-1234!' }).success).toBe(true);
  });
  it('console sign-up rejects an address over 254 characters', async () => {
    const platform = createVellumPlatform({});
    const res = await platform.fetch(new Request('http://localhost/v1/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Long Email', email: longEmail, password: 'FixtureOnly123!' }),
    }));
    expect(res.status).toBe(400);
  });
});
