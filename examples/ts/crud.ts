/**
 * Document CRUD & optimistic concurrency — manage a user profile with
 * versioned writes.
 *
 * What you'll build: a single user profile that is created, merged, replaced,
 * conditionally patched and finally deleted.
 * Real-world scenario: a settings screen does a partial "verify email" merge,
 * a full profile replacement, and a guarded login-count bump. A second,
 * stale write from an old tab is rejected with FAILED_PRECONDITION instead of
 * silently overwriting newer data.
 */
import { harness, check } from "./_harness.js";

const h = await harness("crud");
const ref = h.sdk.collection(h.prefix).doc("user-profile");

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? "UNKNOWN";
}

try {
  h.log("=== Document CRUD & Optimistic Concurrency ===");

  await ref.create({
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    status: "active",
    loginCount: 0,
    note: "imported",
  });
  const first = await ref.get();
  check(first.version === 1, "create starts at version 1");
  h.log({ operation: "create profile", version: first.version, data: first.data() });

  // Partial update: verifying the email must not drop the other fields.
  await ref.set({ status: "verified" }, { merge: true });
  const merged = await ref.get();
  check(merged.version === 2 && (merged.data() as { note: string }).note === "imported", "merge preserves other fields");
  h.log({ operation: "set(merge) verify status", version: merged.version, data: merged.data() });

  // Full replacement: the client intentionally sends only the final shape.
  await ref.set({ displayName: "Ada L." }, { merge: false });
  const replaced = await ref.get();
  check(replaced.version === 3 && Object.keys(replaced.data()).length === 1, "set replaces the whole document");
  h.log({ operation: "set(replace) minimal profile", version: replaced.version, data: replaced.data() });

  // Guarded patch: only apply the login bump if nobody else changed the doc.
  await ref.update({ loginCount: 7 }, { ifVersion: 3 });
  const patched = await ref.get();
  check(patched.version === 4 && (patched.data() as { loginCount: number }).loginCount === 7, "conditional update applied");
  h.log({ operation: "update(ifVersion=3) loginCount", version: patched.version, loginCount: (patched.data() as { loginCount: number }).loginCount });

  try {
    await ref.update({ loginCount: 99 }, { ifVersion: 3 });
    throw new Error("stale update should have been rejected");
  } catch (error: unknown) {
    check(errorCode(error) === "FAILED_PRECONDITION", "stale ifVersion returns FAILED_PRECONDITION");
    h.log({ operation: "update(ifVersion=3) from stale tab", code: errorCode(error), status: (error as { status?: number }).status });
  }

  await ref.delete({ ifVersion: 4 });
  const missing = await h.api.data("GET", `/documents/${h.prefix}/user-profile`);
  check(missing.status === 404, "deleted profile is gone");
  h.log({ operation: "delete(ifVersion=4)", status: missing.status, code: (missing.body as { error?: { code?: string } })?.error?.code });
} finally {
  await h.cleanup();
}
