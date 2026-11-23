/**
 * Document CRUD & optimistic concurrency (REST) — manage a versioned profile.
 *
 * What you'll build: a user profile created with POST, merged with PUT,
 * replaced with PUT, conditionally patched with PATCH and deleted with
 * ifVersion. A second, stale PATCH is rejected with FAILED_PRECONDITION.
 * Real-world scenario: a settings screen avoids lost updates by guarding writes
 * with the version it last read.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("crud");
const docPath = `${h.prefix}/user-profile`;
const codeOf = (reply) => reply.body?.error?.code ?? "UNKNOWN";

try {
  h.log("=== Document CRUD & Optimistic Concurrency ===");

  const created = await h.api.data("POST", `/documents/${docPath}`, {
    data: {
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      status: "active",
      loginCount: 0,
      note: "imported",
    },
  });
  check(created.status === 201, "create profile");
  const first = await h.api.data("GET", `/documents/${docPath}`);
  check(first.body.version === 1, "create starts at version 1");
  h.log({ operation: "create profile", version: first.body.version, data: first.body.data });

  const merged = await h.api.data("PUT", `/documents/${docPath}`, {
    data: { status: "verified" },
    merge: true,
  });
  check(merged.ok && merged.body.version === 2, "merge advanced the version");
  const afterMerge = await h.api.data("GET", `/documents/${docPath}`);
  check(afterMerge.body.data.note === "imported", "merge preserves other fields");
  h.log({ operation: "set(merge) verify status", version: afterMerge.body.version, data: afterMerge.body.data });

  const replaced = await h.api.data("PUT", `/documents/${docPath}`, {
    data: { displayName: "Ada L." },
    merge: false,
  });
  check(replaced.ok && replaced.body.version === 3, "replace advanced the version");
  const afterReplace = await h.api.data("GET", `/documents/${docPath}`);
  check(Object.keys(afterReplace.body.data).length === 1, "replace dropped all other fields");
  h.log({ operation: "set(replace) minimal profile", version: afterReplace.body.version, data: afterReplace.body.data });

  const patched = await h.api.data("PATCH", `/documents/${docPath}`, {
    data: { loginCount: 7 },
    ifVersion: 3,
  });
  check(patched.ok && patched.body.version === 4, "conditional patch applied");
  h.log({ operation: "update(ifVersion=3) loginCount", version: patched.body.version, loginCount: patched.body.data.loginCount });

  const stale = await h.api.data("PATCH", `/documents/${docPath}`, {
    data: { loginCount: 99 },
    ifVersion: 3,
  });
  check(stale.status === 412 && codeOf(stale) === "FAILED_PRECONDITION", "stale patch rejected");
  h.log({ operation: "update(ifVersion=3) from stale tab", code: codeOf(stale), status: stale.status });

  const removed = await h.api.data("DELETE", `/documents/${docPath}?ifVersion=4`);
  check(removed.ok, "delete applied");
  const missing = await h.api.data("GET", `/documents/${docPath}`);
  check(missing.status === 404, "deleted profile is gone");
  h.log({ operation: "delete(ifVersion=4)", status: missing.status, code: codeOf(missing) });
} finally {
  await h.cleanup();
}
