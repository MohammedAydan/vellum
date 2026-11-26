import { beforeEach, describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Guard Org",
    slug: "guard-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Guard App",
    slug: "guard-app",
  });
  const issue = async (keyType: "public" | "server") => {
    const key = generateProjectApiKey({ keyType });
    await platform.controlStore.registerApiKey({
      projectId: project.id,
      name: `${keyType} key`,
      keyType,
      keyPrefix: key.keyPrefix,
      secretHash: key.secretHash,
    });
    return key.fullKey;
  };
  const apiKey = await issue("public");
  const serverKey = await issue("server");
  const base = `/v1/projects/${project.id}/auth`;

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    platform.fetch(
      new Request(`http://localhost${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const signUp = (email: string, password = "Password123!") =>
    post(`${base}/sign-up/email`, { email, password, displayName: "Ada" }, { "x-vellum-api-key": apiKey });
  const signIn = (email: string, password = "Password123!") =>
    post(`${base}/sign-in/email`, { email, password }, { "x-vellum-api-key": apiKey });
  const patchConfig = (patch: { maxUsersQuota?: number; maxSignupsPerHour?: number }) => {
    const cfg = platform.controlStore.getAuthConfig(project.id)!;
    return platform.controlStore.upsertAuthConfig({
      projectId: project.id,
      jwtKeyId: cfg.jwtKeyId,
      jwtPublicKeyPem: cfg.jwtPublicKeyPem,
      jwtPrivateKeyEncrypted: cfg.jwtPrivateKeyEncrypted,
      ...patch,
    });
  };
  return { platform, project, base, apiKey, serverKey, post, signUp, signIn, patchConfig };
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

describe("end-user auth guards", () => {
  beforeEach(() => {
  });

  it("keeps existing users signing in after the user quota is reached, but blocks new sign-ups", async () => {
    const f = await fixture();
    expect((await f.signUp("a@example.com")).status).toBe(201);
    await f.patchConfig({ maxUsersQuota: 1 });

    expect((await f.signIn("a@example.com")).status).toBe(200);
    const blocked = await f.signUp("b@example.com");
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe("QUOTA_EXCEEDED");
  });

  it("enforces maxSignupsPerHour on sign-up but never on sign-in", async () => {
    const f = await fixture();
    expect((await f.signUp("a@example.com")).status).toBe(201);
    await f.patchConfig({ maxSignupsPerHour: 1 });

    const blocked = await f.signUp("b@example.com");
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe("TOO_MANY_REQUESTS");
    expect((await f.signIn("a@example.com")).status).toBe(200);
  });

  it("lets exactly one of many parallel sign-ups use the last hourly slot", async () => {
    const f = await fixture();
    expect((await f.signUp("seed@example.com")).status).toBe(201);
    await f.patchConfig({ maxSignupsPerHour: 2 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => f.signUp(`parallel${i}@example.com`))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it("does not spend an hourly slot on rejected sign-ups", async () => {
    const f = await fixture();
    // The first request also initializes the project auth config.
    expect((await f.signUp("weak@example.com", "x")).status).toBe(400);
    await f.patchConfig({ maxSignupsPerHour: 1 });
    expect((await f.signUp("weak2@example.com", "x")).status).toBe(400);
    expect((await f.signUp("ok@example.com")).status).toBe(201);
  });

  it("throttles repeated failed end-user sign-ins and refuses even the correct password while locked", async () => {
    const f = await fixture();
    expect((await f.signUp("a@example.com")).status).toBe(201);
    for (let i = 0; i < 10; i += 1) {
      expect((await f.signIn("a@example.com", "wrong-password")).status).toBe(401);
    }
    const locked = await f.signIn("a@example.com", "Password123!");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBeTruthy();
  });

  it("accepts an empty JSON-typed POST on body-optional routes (SDK clearCollection)", async () => {
    const f = await fixture();
    const res = await f.post(
      `/v1/projects/${f.project.id}/collections/things/clear`,
      undefined,
      { "x-vellum-api-key": f.serverKey }
    );
    // The collection does not exist: any engine-level answer is fine, but the
    // transport must not reject the empty body as malformed JSON.
    expect(await errorCode(res)).not.toBe("INVALID_ARGUMENT");
  });

  it("still rejects malformed JSON on body-optional routes", async () => {
    const f = await fixture();
    const res = await f.platform.fetch(
      new Request(`http://localhost/v1/projects/${f.project.id}/collections/things/clear`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vellum-api-key": f.serverKey },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("names the wrong auth tier when an end-user sign-up reaches the console endpoint", async () => {
    const f = await fixture();
    const res = await f.post(
      "/v1/auth/sign-up/email",
      { email: "a@example.com", password: "Password123!", displayName: "Ada" },
      { "x-vellum-api-key": f.apiKey }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details?: { guardCode?: string } } };
    expect(body.error.message).toContain("/v1/projects/{projectId}/auth/sign-up/email");
    expect(body.error.details?.guardCode).toBe("WRONG_AUTH_TIER");
  });
});

describe("collection registry reads", () => {
  it("are refused for a publishable key and allowed for a server key", async () => {
    const f = await fixture();
    const get = (path: string, key: string) =>
      f.platform.fetch(new Request(`http://localhost/v1/projects/${f.project.id}${path}`, { headers: { "x-vellum-api-key": key } }));
    for (const path of ["/collections", "/collections/things"]) {
      const denied = await get(path, f.apiKey);
      expect(denied.status).toBe(403);
      expect(await errorCode(denied)).toBe("PERMISSION_DENIED");
    }
    expect((await get("/collections", f.serverKey)).status).toBe(200);
  });
});

describe("sign-in lockout scope", () => {
  it("one account's failures do not lock out a different account from the same IP", async () => {
    const f = await fixture();
    expect((await f.signUp("real@example.com")).status).toBe(201);
    for (let i = 0; i < 11; i += 1) await f.signIn("ghost@example.com", "wrong-password");
    expect((await f.signIn("ghost@example.com", "wrong-password")).status).toBe(429);
    expect((await f.signIn("real@example.com")).status).toBe(200);
  });
});
