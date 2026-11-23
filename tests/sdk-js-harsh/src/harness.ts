/**
 * Test harness: provisions a disposable org + project + keys on a LOCAL Vellum API.
 * Refuses to run against anything that looks like production.
 */
import { createClient, type ClientConfig } from "@vellumdb/sdk-js";
import { WebSocket } from "ws";

export const ENDPOINT = (process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080").replace(/\/$/, "");

const host = new URL(ENDPOINT).hostname;
if (!/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(host)) {
  throw new Error(`Refusing to run the harsh suite against non-local endpoint ${ENDPOINT}`);
}

let counter = 0;
export function uid(prefix = "t"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 6)}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label ?? ""} ${last instanceof Error ? last.message : ""}`);
    await sleep(opts.intervalMs ?? 50);
  }
}

async function http(path: string, init: RequestInit & { token?: string; key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  if (init.key) headers["x-vellum-api-key"] = init.key;
  const res = await fetch(`${ENDPOINT}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
export { http };

export interface Env {
  projectId: string;
  organizationId: string;
  secretKey: string;
  publishableKey: string;
  consoleToken: string;
  secret(cfg?: Partial<ClientConfig>): ReturnType<typeof createClient>;
  pub(cfg?: Partial<ClientConfig>): ReturnType<typeof createClient>;
  setRulesDsl(source: string): Promise<{ status: number; body: any }>;
  setRulesAst(rulesAst: unknown): Promise<{ status: number; body: any }>;
  setRelationRules(rules: Array<{ collection: string; field: string; onDelete: string; targetCollection?: string }>): Promise<{ status: number; body: any }>;
  createIndex(collectionPath: string, fields: Array<{ path: string; direction?: string }> | any[]): Promise<{ status: number; body: any }>;
  waitForIndexReady(collectionPath: string, fields: Array<{ path: string; direction?: string }> | any[], timeoutMs?: number): Promise<void>;
  authConfig(patch: Record<string, unknown>): Promise<{ status: number; body: any }>;
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  clients: Array<{ dispose?: () => void }>;
  cleanup(): void;
}

export async function provision(label = "harsh"): Promise<Env> {
  const email = `${uid("c")}@harsh.test`;
  const su = await http("/v1/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: "Harsh Console", password: "Passw0rd!xyz1" }),
  });
  if (su.status >= 300) throw new Error(`console signup failed ${su.status} ${JSON.stringify(su.body)}`);
  const consoleToken: string = su.body.accessToken ?? su.body.token;
  const organizationId: string = su.body.organization.id;
  const proj = await http(`/v1/organizations/${organizationId}/projects`, {
    method: "POST",
    token: consoleToken,
    body: JSON.stringify({ name: label, slug: `${label}-${uid("p")}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) }),
  });
  if (proj.status >= 300) throw new Error(`project create failed ${proj.status} ${JSON.stringify(proj.body)}`);
  const projectId: string = proj.body.project.id;
  const mk = async (keyType: string) => {
    const r = await http(`/v1/projects/${projectId}/api-keys`, { method: "POST", token: consoleToken, body: JSON.stringify({ name: keyType, keyType }) });
    if (r.status >= 300) throw new Error(`key create failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.rawKey as string;
  };
  const secretKey = await mk("secret");
  const publishableKey = await mk("publishable");
  const clients: Array<{ dispose?: () => void }> = [];
  const make = (apiKey: string, cfg: Partial<ClientConfig> = {}) => {
    const c = createClient({
      projectId,
      apiKey,
      endpoint: ENDPOINT,
      maxRetries: 0,
      timeoutMs: 15_000,
      webSocketFactory: ((url: string) => new WebSocket(url)) as any,
      ...cfg,
    } as ClientConfig);
    clients.push(c as any);
    return c;
  };
  return {
    projectId,
    organizationId,
    secretKey,
    publishableKey,
    consoleToken,
    secret: (cfg) => make(secretKey, cfg),
    pub: (cfg) => make(publishableKey, cfg),
    clients,
    setRulesDsl: async (source) => {
      const c = await http(`/v1/projects/${projectId}/rules/compile`, { method: "POST", token: consoleToken, body: JSON.stringify({ source }) });
      if (c.status !== 200) return c;
      return http(`/v1/projects/${projectId}/rulesets`, { method: "POST", token: consoleToken, body: JSON.stringify({ rulesAst: c.body.ast }) });
    },
    setRulesAst: (rulesAst) => http(`/v1/projects/${projectId}/rulesets`, { method: "POST", token: consoleToken, body: JSON.stringify({ rulesAst }) }),
    setRelationRules: (rules) => http(`/v1/projects/${projectId}/relation-rules`, { method: "PUT", token: consoleToken, body: JSON.stringify({ rules }) }),
    createIndex: (collectionPath, fields) => http(`/v1/projects/${projectId}/indexes`, { method: "POST", key: secretKey, body: JSON.stringify({ collectionPath, fields }) }),
    // Composite indexes are built asynchronously by the index-builder worker
    // (status 'building' -> 'ready'); a query that needs one must wait for
    // readiness rather than assume a fixed delay.
    waitForIndexReady: async (collectionPath, fields, timeoutMs = 15_000) => {
      const want = JSON.stringify(fields.map((f: any) => ({ path: f.path, direction: f.direction ?? f.dir ?? "asc" })));
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await http(`/v1/projects/${projectId}/indexes`, { key: secretKey });
        const match = (r.body?.indexes ?? []).find((i: any) => i.collectionPath === collectionPath &&
          JSON.stringify((i.fields ?? []).map((f: any) => ({ path: f.path, direction: f.direction ?? f.dir ?? "asc" }))) === want);
        if (match?.status === "ready") return;
        if (match?.status === "failed") throw new Error(`index build failed: ${JSON.stringify(match)}`);
        if (Date.now() > deadline) throw new Error(`index on '${collectionPath}' still ${match?.status ?? "missing"} after ${timeoutMs}ms`);
        await new Promise((r2) => setTimeout(r2, 250));
      }
    },
    authConfig: (patch) => http(`/v1/projects/${projectId}/auth/admin/config`, { method: "PATCH", key: secretKey, body: JSON.stringify(patch) }),
    admin: (method, path, body) => http(`/v1/projects/${projectId}/auth/admin${path}`, { method, key: secretKey, body: body === undefined ? undefined : JSON.stringify(body) }),
    cleanup() {
      for (const c of clients) try { c.dispose?.(); } catch {}
    },
  };
}

/** RFC 6238 TOTP (SHA1, 6 digits, 30s) for MFA tests. */
import { createHmac } from "node:crypto";
export function totp(base32Secret: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", bytes).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

/** Expect a promise to reject with a Vellum API error carrying the given code/status. */
export async function expectApiError(p: Promise<unknown>, expected: { code?: string; status?: number }): Promise<any> {
  try {
    await p;
  } catch (e: any) {
    if (expected.code !== undefined && e?.code !== expected.code) throw new Error(`expected code ${expected.code} got ${e?.code} (${e?.status}): ${e?.message}`);
    if (expected.status !== undefined && e?.status !== expected.status) throw new Error(`expected status ${expected.status} got ${e?.status} (${e?.code}): ${e?.message}`);
    return e;
  }
  throw new Error(`expected rejection ${JSON.stringify(expected)} but promise resolved`);
}

