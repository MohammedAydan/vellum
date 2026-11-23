/**
 * Shared bootstrap for the runnable Vellum examples.
 *
 * Every example calls `harness(<id>)` once, uses the returned `sdk` / `api`
 * helpers, and calls `await cleanup()` in a `finally` block. The harness signs
 * in with the local QA account, mints a short-lived server API key, and gives
 * each run a unique collection-path prefix so repeated runs never collide.
 *
 * NOTHING here prints emails, passwords, tokens, API keys, or database URLs.
 * `log()` additionally scrubs all of those from any output it is given.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type VellumClient } from "../../packages/sdk-js/src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/** Minimal, dependency-free `.env` loader (only fills variables that are unset). */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, ".env.phase5.local"));

const BASE = process.env["VELLUM_API_BASE"] ?? "http://127.0.0.1:8080";
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for a disposable test project`);
  return value;
}
const EMAIL = requiredEnv("VELLUM_EMAIL");
const PASSWORD = requiredEnv("VELLUM_PASSWORD");
const PROJECT_ID = requiredEnv("VELLUM_PROJECT_ID");

export interface ApiReply<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export interface SignInResult {
  success: boolean;
  token: string;
  expiresAt: string;
  user: Record<string, unknown>;
}

export interface Api {
  /** Data-plane call. `relativePath` must start with `/` and is appended to /v1/projects/:pid. */
  data<T = unknown>(
    method: string,
    relativePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<ApiReply<T>>;
  /** Session-authenticated Console call. `relativePath` is appended to /v1/console. */
  console<T = unknown>(
    method: string,
    relativePath: string,
    body?: unknown
  ): Promise<ApiReply<T>>;
  /** Fully raw call against the API base. `fullPath` must start with `/`. */
  raw<T = unknown>(
    method: string,
    fullPath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<ApiReply<T>>;
  /** Fresh email/password sign-in (used by the `auth` example). Never log the token. */
  signIn(email?: string, password?: string): Promise<SignInResult>;
}

export interface Harness {
  api: Api;
  sdk: VellumClient;
  base: string;
  projectId: string;
  apiKey: string;
  prefix: string;
  /** Delete every document/index this run created and revoke the minted key. */
  cleanup(): Promise<void>;
  /** Print deterministic, fully redacted output. */
  log(value: unknown): void;
  /** Turn a run-specific document path into a stable, printable label. */
  label(documentPath: string): string;
}

/** Tiny assertion helper so examples exit non-zero on any unexpected result. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`example assertion failed: ${message}`);
}

async function fetchJson<T>(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string>
): Promise<ApiReply<T>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
}

export async function harness(id = "example"): Promise<Harness> {
  const token = await fetchJson<SignInResult>(
    `${BASE}/v1/auth/sign-in/email`,
    "POST",
    { email: EMAIL, password: PASSWORD },
    {}
  );
  if (!token.ok || !token.body.token) {
    throw new Error(`harness: sign-in failed with HTTP ${token.status}`);
  }
  const sessionToken = token.body.token;

  const keysBase = `/v1/console/projects/${PROJECT_ID}/api-keys`;
  const createdKey = await fetchJson<{
    apiKey?: { id?: string; keyPrefix?: string };
    rawKey?: string;
  }>(`${BASE}${keysBase}`, "POST", { name: `examples:${id}`, keyType: "server" }, {
    authorization: `Bearer ${sessionToken}`,
  });
  const apiKey = createdKey.body.rawKey;
  const createdKeyId = createdKey.body.apiKey?.id;
  if (!createdKey.ok || !apiKey || !createdKeyId) {
    throw new Error(`harness: API key creation failed with HTTP ${createdKey.status}`);
  }

  const prefix = `ex_${id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const trackedDocs = new Set<string>();
  const trackedIndexes = new Set<string>();
  const consoleHeaders = { authorization: `Bearer ${sessionToken}` };
  const dataHeaders = { "x-project-key": apiKey };

  async function raw<T>(
    method: string,
    fullPath: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<ApiReply<T>> {
    return fetchJson<T>(`${BASE}${fullPath}`, method, body, extraHeaders);
  }

  const api: Api = {
    raw,
    console: <T>(method: string, relativePath: string, body?: unknown) =>
      raw<T>(method, `/v1/console${relativePath}`, body, consoleHeaders),
    data: <T>(method: string, relativePath: string, body?: unknown, extraHeaders?: Record<string, string>) => {
      const write = method === "POST" || method === "PUT" || method === "PATCH";
      const pathPart = relativePath.split("?")[0] ?? "";
      if (write && pathPart.startsWith("/documents/")) {
        const segs = pathPart.slice("/documents/".length).split("/").filter(Boolean);
        if (segs.length % 2 === 0 && segs.length > 0) trackedDocs.add(segs.join("/"));
      }
      return raw<T>(
        method,
        `/v1/projects/${PROJECT_ID}${relativePath}`,
        body,
        { ...dataHeaders, ...(extraHeaders ?? {}) }
      ).then((reply) => {
        if (write && pathPart === "/indexes") {
          const createdId = (reply.body as { id?: string } | null)?.id;
          if (createdId) trackedIndexes.add(createdId);
        }
        return reply;
      });
    },
    signIn: async (email = EMAIL, password = PASSWORD) => {
      const reply = await raw<SignInResult>("POST", "/v1/auth/sign-in/email", { email, password });
      if (!reply.ok || !reply.body.token) {
        throw new Error(`signIn: failed with HTTP ${reply.status}`);
      }
      return reply.body;
    },
  };

  const sdk = createClient({
    projectId: PROJECT_ID,
    apiKey,
    endpoint: BASE,
  });

  const secrets: Array<[string, string]> = [
    [apiKey, "<api-key>"],
    [sessionToken, "<session-token>"],
    [EMAIL, "<email>"],
    [PASSWORD, "<password>"],
    [prefix, "<run>"],
  ];

  function scrub(text: string): string {
    let out = text;
    for (const [secret, replacement] of secrets) {
      if (secret) out = out.split(secret).join(replacement);
    }
    return out;
  }

  function log(value: unknown): void {
    if (typeof value === "string") {
      console.log(scrub(value));
      return;
    }
    const json = JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "string" ? scrub(nested) : nested
    );
    console.log(json ?? "null");
  }

  function label(documentPath: string): string {
    return scrub(documentPath);
  }

  async function cleanup(): Promise<void> {
    for (const docPath of trackedDocs) {
      try {
        await api.data("DELETE", `/documents/${docPath}`);
      } catch {
        // Best effort: a doc may already have been deleted by the example.
      }
    }
    for (const indexId of trackedIndexes) {
      try {
        await api.data("DELETE", `/indexes/${indexId}`);
      } catch {
        // Best effort.
      }
    }
    try {
      await api.console("DELETE", `${keysBase}/${createdKeyId}`);
    } catch {
      // Best effort.
    }
  }

  try {
    return {
      api,
      sdk,
      base: BASE,
      projectId: PROJECT_ID,
      apiKey,
      prefix,
      cleanup,
      log,
      label,
    };
  } catch (error: unknown) {
    // Bootstrap succeeded far enough to mint a key: do not leak it.
    try {
      await fetchJson(`${BASE}${keysBase}/${createdKeyId}`, "DELETE", undefined, consoleHeaders);
    } catch {
      // Best effort.
    }
    throw error;
  }
}
