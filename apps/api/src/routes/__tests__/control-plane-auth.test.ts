import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return (await res.json()) as { token: string; organization: { id: string }; project: { id: string } };
}

const ruleset = { rulesAst: { version: 1, rules: [{ match: 'x/{id}', allow: { read: false } }] } };

afterEach(() => vi.unstubAllEnvs());

describe('control-plane routes require a session in production', () => {
  it('rejects anonymous callers on every legacy control-plane route', async () => {
    const platform = createVellumPlatform({});
    const victim = await signup(platform, 'victim-anon');
    // The guard reads NODE_ENV per request, so flip it after fixture setup.
    vi.stubEnv('NODE_ENV', 'production');
    const p = victim.project.id;
    const o = victim.organization.id;
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/v1/organizations'],
      ['POST', '/v1/organizations', { name: 'Evil', slug: 'evil-org', planTier: 'free' }],
      ['GET', `/v1/organizations/${o}/projects`],
      ['POST', `/v1/organizations/${o}/projects`, { name: 'Evil', slug: 'evil-proj' }],
      ['GET', `/v1/projects/${p}/api-keys`],
      ['POST', `/v1/projects/${p}/api-keys`, { name: 'k', keyType: 'secret' }],
      ['GET', `/v1/projects/${p}/rulesets`],
      ['POST', `/v1/projects/${p}/rulesets`, ruleset],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(platform, method, path, undefined, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // No key was minted by the rejected anonymous calls.
    expect(Array.from(platform.controlStore.apiKeysById.values()).filter((k) => k.projectId === p)).toHaveLength(1);
  });

  it('stays anonymous-friendly outside production (local dev and examples)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const platform = createVellumPlatform({});
    expect((await call(platform, 'GET', '/v1/organizations')).status).toBe(200);
  });
});

describe('control-plane routes enforce organization membership', () => {
  it('blocks a tenant from reading or changing another tenant\'s project', async () => {
    const platform = createVellumPlatform({});
    const a = await signup(platform, 'tenant-a');
    const b = await signup(platform, 'tenant-b');
    const pb = b.project.id;
    const cases: Array<[string, string, unknown?]> = [
      ['GET', `/v1/projects/${pb}/api-keys`],
      ['POST', `/v1/projects/${pb}/api-keys`, { name: 'k', keyType: 'secret' }],
      ['GET', `/v1/projects/${pb}/rulesets`],
      ['POST', `/v1/projects/${pb}/rulesets`, ruleset],
      ['POST', `/v1/organizations/${b.organization.id}/projects`, { name: 'Evil', slug: 'evil-proj' }],
      ['GET', `/v1/organizations/${b.organization.id}/projects`],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(platform, method, path, a.token, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(Array.from(platform.controlStore.apiKeysById.values()).filter((k) => k.projectId === pb)).toHaveLength(1);
    // The owner still works and never receives the stored secret digest.
    const own = await call(platform, 'POST', `/v1/projects/${a.project.id}/api-keys`, a.token, { name: 'k', keyType: 'secret' });
    expect(own.status).toBe(201);
    const created = await own.json() as { apiKey: Record<string, unknown>; rawKey: string };
    expect(created.rawKey).toMatch(/^sk_/);
    expect(created.apiKey).not.toHaveProperty('secretHash');
  });
});
