/**
 * Shared bootstrap for the runnable *REST* Vellum examples.
 *
 * Standalone, ESM, and fetch-only (Node 20+): it does not import the TypeScript
 * harness or any SDK. Each example calls `harness(<id>)`, uses the returned
 * `api` helpers, and calls `await cleanup()` in a `finally` block. The harness
 * signs in with the local QA account, mints a short-lived server API key, and
 * gives each run a unique path prefix so repeated runs never collide.
 *
 * NOTHING here prints emails, passwords, tokens, API keys, or database URLs.
 * `log()` scrubs all of those from any value it is given.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/** Minimal, dependency-free `.env` loader (only fills variables that are unset). */
function loadDotEnv(file) {
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
const EMAIL = "visual@vellum.dev";
const PASSWORD = "visual123";
const PROJECT_ID =
  process.env["VELLUM_PROJECT_ID"] ?? "1382468e-5dc0-44a8-9b68-5427a5b6ea5c";

/** Tiny assertion helper so examples exit non-zero on any unexpected result. */
export function check(condition, message) {
  if (!condition) throw new Error(`example assertion failed: ${message}`);
}

async function fetchJson(url, method, body, headers) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/**
 * Sign in, mint a short-lived server key, and build fetch-backed API helpers.
 * Returns { api, base, projectId, apiKey, prefix, cleanup, log, label }.
 */
export async function harness(id = "example") {
  const token = await fetchJson(
    `${BASE}/v1/auth/sign-in/email`,
    "POST",
    { email: EMAIL, password: PASSWORD },
    {}
  );
  if (!token.ok || !token.body?.token) {
    throw new Error(`harness: sign-in failed with HTTP ${token.status}`);
  }
  const sessionToken = token.body.token;

  const keysBase = `/v1/console/projects/${PROJECT_ID}/api-keys`;
  const createdKey = await fetchJson(
    `${BASE}${keysBase}`,
    "POST",
    { name: `examples:rest:${id}`, keyType: "server" },
    { authorization: `Bearer ${sessionToken}` }
  );
  const apiKey = createdKey.body?.rawKey;
  const createdKeyId = createdKey.body?.apiKey?.id;
  if (!createdKey.ok || !apiKey || !createdKeyId) {
    throw new Error(`harness: API key creation failed with HTTP ${createdKey.status}`);
  }

  const prefix = `ex_rest_${id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const trackedDocs = new Set();
  const trackedIndexes = new Set();
  const consoleHeaders = { authorization: `Bearer ${sessionToken}` };
  const dataHeaders = { "x-project-key": apiKey };

  async function raw(method, fullPath, body, extraHeaders = {}) {
    return fetchJson(`${BASE}${fullPath}`, method, body, extraHeaders);
  }

  const api = {
    raw,
    console: (method, relativePath, body) =>
      raw(method, `/v1/console${relativePath}`, body, consoleHeaders),
    data: (method, relativePath, body, extraHeaders) => {
      const write = method === "POST" || method === "PUT" || method === "PATCH";
      const pathPart = relativePath.split("?")[0] ?? "";
      if (write && pathPart.startsWith("/documents/")) {
        const segs = pathPart.slice("/documents/".length).split("/").filter(Boolean);
        if (segs.length % 2 === 0 && segs.length > 0) trackedDocs.add(segs.join("/"));
      }
      return raw(
        method,
        `/v1/projects/${PROJECT_ID}${relativePath}`,
        body,
        { ...dataHeaders, ...(extraHeaders ?? {}) }
      ).then((reply) => {
        if (write && pathPart === "/indexes") {
          const createdId = reply.body?.id;
          if (createdId) trackedIndexes.add(createdId);
        }
        return reply;
      });
    },
    signIn: async (email = EMAIL, password = PASSWORD) => {
      const reply = await raw("POST", "/v1/auth/sign-in/email", { email, password });
      if (!reply.ok || !reply.body?.token) {
        throw new Error(`signIn: failed with HTTP ${reply.status}`);
      }
      return reply.body;
    },
  };

  const secrets = [
    [apiKey, "<api-key>"],
    [sessionToken, "<session-token>"],
    [EMAIL, "<email>"],
    [PASSWORD, "<password>"],
    [prefix, "<run>"],
  ];

  function scrub(text) {
    let out = text;
    for (const [secret, replacement] of secrets) {
      if (secret) out = out.split(secret).join(replacement);
    }
    return out;
  }

  function log(value) {
    if (typeof value === "string") {
      console.log(scrub(value));
      return;
    }
    const json = JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? scrub(nested) : nested
    );
    console.log(json ?? "null");
  }

  function label(documentPath) {
    return scrub(documentPath);
  }

  async function cleanup() {
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

  return {
    api,
    base: BASE,
    projectId: PROJECT_ID,
    apiKey,
    prefix,
    cleanup,
    log,
    label,
  };
}
