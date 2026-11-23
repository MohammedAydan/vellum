/**
 * Quickstart — verify the local API and run one full document lifecycle.
 *
 * What you'll build: a tiny status-page service record that counts views.
 * Real-world scenario: before wiring up an app, confirm the API is alive and
 * that a single document can be created, read, patched and removed safely.
 * Every run uses a unique path prefix and cleans up after itself.
 */
import { harness, check } from "./_harness.js";

const h = await harness("quickstart");
const doc = h.sdk.collection(h.prefix).doc("status-page");

try {
  h.log("=== Quickstart ===");

  const live = await h.api.raw<{ status: string }>("GET", "/v1/health/live");
  const ready = await h.api.raw<{ ready: boolean }>("GET", "/v1/health/ready");
  check(live.ok && live.body.status === "alive", "live health probe");
  check(ready.ok && ready.body.ready === true, "ready health probe");
  h.log({ live: live.body.status, ready: ready.body.ready });

  await doc.set({ service: "checkout-api", status: "operational", views: 0 });
  const created = await doc.get();
  check(created.exists && created.version === 1, "service document created at version 1");
  h.log({
    id: created.id,
    version: created.version,
    data: created.data(),
  });

  await doc.update({ views: 1 });
  const updated = await doc.get();
  check(updated.version === 2, "view increment advanced the version");
  h.log({ viewsAfterUpdate: (updated.data() as { views: number }).views, version: updated.version });

  await doc.delete();
  h.log({ deleted: true });
} finally {
  await h.cleanup();
}
