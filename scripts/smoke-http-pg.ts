import path from "node:path";
import { loadEnvFiles } from "../packages/database-control/src/index.js";

loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
const { startNodeApiServer } = await import("../apps/api/src/node-server.js");

/** Fail loudly: a non-2xx smoke response must never exit as a success. */
const assertOk = (label: string, response: Response): void => {
  if (!response.ok) {
    throw new Error(`[smoke] ${label} failed with HTTP ${response.status}`);
  }
};

const server = await startNodeApiServer({ port: 0 });
try {
  console.log(`PORT ${server.port}`);
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
  console.log(`HEALTH ${response.status} ${await response.text()}`);
  assertOk("HEALTH", response);

  const orgResponse = await fetch(`http://127.0.0.1:${server.port}/v1/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Phase 5 HTTP Smoke", slug: `smoke-${Date.now()}`, planTier: "free" }),
  });
  const org = (await orgResponse.json()) as { id: string };
  console.log(`ORG ${orgResponse.status} ${org.id}`);
  assertOk("ORG", orgResponse);

  const projectResponse = await fetch(`http://127.0.0.1:${server.port}/v1/organizations/${org.id}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Phase 5 HTTP Smoke Project", slug: `smoke-project-${Date.now()}` }),
  });
  const projectBody = (await projectResponse.json()) as { project: { id: string } };
  console.log(`PROJECT ${projectResponse.status} ${projectBody.project.id}`);
  assertOk("PROJECT", projectResponse);

  const keyResponse = await fetch(`http://127.0.0.1:${server.port}/v1/projects/${projectBody.project.id}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Phase 5 Smoke Key", keyType: "secret" }),
  });
  const keyBody = (await keyResponse.json()) as { rawKey: string };
  console.log(`KEY ${keyResponse.status} ${keyBody.rawKey.slice(0, 10)}...`);
  assertOk("KEY", keyResponse);

  const documentUrl = `http://127.0.0.1:${server.port}/v1/projects/${projectBody.project.id}/documents/phase5-smoke/doc_1`;
  const writeResponse = await fetch(documentUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-project-key": keyBody.rawKey },
    body: JSON.stringify({ data: { persisted: true, source: "real-postgres" } }),
  });
  console.log(`WRITE ${writeResponse.status} ${await writeResponse.text()}`);
  assertOk("WRITE", writeResponse);

  const readResponse = await fetch(documentUrl, { headers: { "x-project-key": keyBody.rawKey } });
  console.log(`READ ${readResponse.status} ${await readResponse.text()}`);
  assertOk("READ", readResponse);

  console.log("[smoke] PASS: health, org, project, key, document write and read all succeeded.");
} finally {
  await server.stop();
}
