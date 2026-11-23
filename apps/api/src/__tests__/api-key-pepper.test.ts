import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authorization from '@vellum/authorization';
import { createVellumPlatform } from '../index.js';

vi.mock('@vellum/authorization', async (importOriginal) => {
  const original = await importOriginal<typeof authorization>();
  return { ...original, generateProjectApiKey: vi.fn(original.generateProjectApiKey) };
});

const pepper = 'fixture-platform-specific-pepper-not-the-environment';
const post = (path: string, body: unknown, token?: string) => new Request(`http://localhost${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
afterEach(() => vi.clearAllMocks());

describe('API key issuance uses the platform pepper', () => {
  it('issues usable keys through the legacy control route', async () => {
    const platform = createVellumPlatform({ apiKeyPepper: pepper });
    const org = await platform.controlStore.createOrganization({ name: 'Pepper', slug: 'pepper', billingEmail: 'fixture@example.invalid' });
    const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: 'Pepper', slug: 'pepper' });
    const response = await platform.fetch(post(`/v1/projects/${project.id}/api-keys`, { name: 'Fixture', keyType: 'secret' }));
    expect(response.status).toBe(201);
    const { rawKey } = await response.json();
    expect(authorization.verifyApiKey(rawKey, platform.controlStore, pepper).projectId).toBe(project.id);
  });

  it('authenticates realtime sessions with the configured platform pepper', async () => {
    const platform = createVellumPlatform({ apiKeyPepper: pepper });
    const org = await platform.controlStore.createOrganization({ name: 'WS Pepper', slug: 'ws-pepper', billingEmail: 'fixture@example.invalid' });
    const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: 'Pepper', slug: 'pepper' });
    const response = await platform.fetch(post(`/v1/projects/${project.id}/api-keys`, { name: 'Fixture', keyType: 'secret' }));
    const { rawKey } = await response.json();
    const frames: unknown[] = [];
    const session = platform.realtimeHub.createConnectionSession((frame) => frames.push(frame));
    await session.handleClientFrame({ type: 'auth', projectId: project.id, apiKey: rawKey });
    expect(frames).toContainEqual(expect.objectContaining({ type: 'auth_ack', status: 'authenticated' }));
    session.close();
  });

  it('uses the platform pepper for the signup default key', async () => {
    const platform = createVellumPlatform({ apiKeyPepper: pepper });
    const response = await platform.fetch(post('/v1/auth/sign-up/email', { name: 'Fixture', email: 'signup-pepper@example.invalid', password: 'FixtureOnly123!' }));
    expect(response.status).toBe(201);
    expect(authorization.generateProjectApiKey).toHaveBeenCalledWith({ keyType: 'server', pepper });
  });

  it('issues usable keys through the authenticated console route', async () => {
    const platform = createVellumPlatform({ apiKeyPepper: pepper });
    const signup = await platform.fetch(post('/v1/auth/sign-up/email', { name: 'Fixture', email: 'console-pepper@example.invalid', password: 'FixtureOnly123!' }));
    expect(signup.status).toBe(201);
    const { token, project } = await signup.json();
    const response = await platform.fetch(post(`/v1/console/projects/${project.id}/api-keys`, { name: 'Fixture', keyType: 'secret' }, token));
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(authorization.verifyApiKey(data.rawKey, platform.controlStore, pepper).projectId).toBe(project.id);
  });
});
