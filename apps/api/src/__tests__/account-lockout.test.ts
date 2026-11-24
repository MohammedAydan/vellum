import { describe, expect, it } from 'vitest';
import { createVellumPlatform } from '../index.js';

describe('per-account sign-in throttle', () => {

  it('limits failed console sign-ins per account even when the apparent client IP changes', async () => {
    const platform = createVellumPlatform();
    const signup = await platform.fetch(new Request('http://localhost/v1/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Victim', email: 'victim-lockout@example.invalid', password: 'FixtureOnly123!' }),
    }));
    expect(signup.status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const res = await platform.fetch(new Request('http://localhost/v1/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` },
        body: JSON.stringify({ email: 'victim-lockout@example.invalid', password: `wrong-${i}` }),
      }));
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(50);
    expect(statuses.at(-1)).toBe(429);
    // The correct password is also refused while the account is locked out.
    const good = await platform.fetch(new Request('http://localhost/v1/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.250' },
      body: JSON.stringify({ email: 'victim-lockout@example.invalid', password: 'FixtureOnly123!' }),
    }));
    expect(good.status).toBe(429);
  });
});
