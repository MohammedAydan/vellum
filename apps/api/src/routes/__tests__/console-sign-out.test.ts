import { describe, expect, it } from 'vitest';
import { createVellumPlatform } from '../../index.js';

const call = (platform: ReturnType<typeof createVellumPlatform>, method: string, path: string, token?: string, body?: unknown) =>
  platform.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

async function signup(platform: ReturnType<typeof createVellumPlatform>, tag: string) {
  const res = await call(platform, 'POST', '/v1/auth/sign-up/email', undefined, {
    name: `Tenant ${tag}`, email: `${tag}@example.invalid`, password: 'FixtureOnly123!',
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; refreshToken: string };
}

const refresh = (platform: ReturnType<typeof createVellumPlatform>, refreshToken: string) =>
  call(platform, 'POST', '/v1/console/auth/refresh', undefined, { refreshToken });

describe('console sign-out ends the session', () => {
  it('rejects the access token and the refresh token after sign-out with the access token', async () => {
    const platform = createVellumPlatform({});
    const s = await signup(platform, 'so-access');
    expect((await call(platform, 'GET', '/v1/auth/session', s.token)).status).toBe(200);
    expect((await call(platform, 'POST', '/v1/auth/sign-out', s.token)).status).toBe(200);
    expect((await call(platform, 'GET', '/v1/auth/session', s.token)).status).toBe(401);
    expect((await refresh(platform, s.refreshToken)).status).toBe(401);
  });

  it('kills the refresh token when only the refresh token is sent in the body', async () => {
    const platform = createVellumPlatform({});
    const s = await signup(platform, 'so-refresh');
    expect((await call(platform, 'POST', '/v1/auth/sign-out', undefined, { refreshToken: s.refreshToken })).status).toBe(200);
    expect((await refresh(platform, s.refreshToken)).status).toBe(401);
    // The access token is not named by the refresh token, so it lives until its 15 minute expiry.
    // Clients that hold both send both (the dashboard does), which is covered above.
  });

  it('a refresh inside the grace window still works before sign-out, and the rotated pair dies with it', async () => {
    const platform = createVellumPlatform({});
    const s = await signup(platform, 'so-grace');
    const r = await refresh(platform, s.refreshToken);
    expect(r.status).toBe(200);
    const next = (await r.json()) as { accessToken?: string; token?: string; refreshToken: string };
    const nextAccess = (next.accessToken ?? next.token) as string;
    expect((await call(platform, 'POST', '/v1/auth/sign-out', nextAccess)).status).toBe(200);
    expect((await refresh(platform, next.refreshToken)).status).toBe(401);
    expect((await call(platform, 'GET', '/v1/auth/session', nextAccess)).status).toBe(401);
  });

  it('does not end another user\'s session and ignores garbage tokens', async () => {
    const platform = createVellumPlatform({});
    const a = await signup(platform, 'so-a');
    const b = await signup(platform, 'so-b');
    expect((await call(platform, 'POST', '/v1/auth/sign-out', 'not-a-token')).status).toBe(200);
    expect((await call(platform, 'POST', '/v1/auth/sign-out')).status).toBe(200);
    expect((await call(platform, 'POST', '/v1/auth/sign-out', a.token)).status).toBe(200);
    expect((await call(platform, 'GET', '/v1/auth/session', b.token)).status).toBe(200);
    expect((await refresh(platform, b.refreshToken)).status).toBe(200);
  });
});
