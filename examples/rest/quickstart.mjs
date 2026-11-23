/**
 * Quickstart (REST) — verify the API and run one full document lifecycle
 * with nothing but fetch.
 *
 * What you'll build: the same status-page hit counter as the SDK quickstart.
 * Real-world scenario: confirm the API is alive and that a document can be
 * created, read, patched and deleted using plain HTTP + x-project-key.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("quickstart");
const docPath = `${h.prefix}/status-page`;

try {
  h.log("=== Quickstart ===");

  const live = await h.api.raw("GET", "/v1/health/live");
  const ready = await h.api.raw("GET", "/v1/health/ready");
  check(live.ok && live.body.status === "alive", "live health probe");
  check(ready.ok && ready.body.ready === true, "ready health probe");
  h.log({ live: live.body.status, ready: ready.body.ready });

  const created = await h.api.data("POST", `/documents/${docPath}`, {
    data: { service: "checkout-api", status: "operational", views: 0 },
  });
  check(created.status === 201, "POST created the service document");

  const got = await h.api.data("GET", `/documents/${docPath}`);
  check(got.ok && got.body.version === 1, "GET returned version 1");
  h.log({ id: got.body.documentId, version: got.body.version, data: got.body.data });

  const patched = await h.api.data("PATCH", `/documents/${docPath}`, { data: { views: 1 } });
  check(patched.ok && patched.body.version === 2, "PATCH advanced the version");
  const after = await h.api.data("GET", `/documents/${docPath}`);
  h.log({ viewsAfterUpdate: after.body.data.views, version: after.body.version });

  const removed = await h.api.data("DELETE", `/documents/${docPath}`);
  check(removed.ok, "DELETE succeeded");
  h.log({ deleted: true });
} finally {
  await h.cleanup();
}
