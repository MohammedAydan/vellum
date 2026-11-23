/**
 * Atomic field transforms (REST) — apply engagement updates in one PATCH.
 *
 * What you'll build: a social post whose likes, tags and moderation history
 * change via $op sentinels, with one field removed and a server stamp added.
 * Real-world scenario: concurrent readers update a counter without a
 * client-side read/modify/write race. The timestamp is logged by wire type.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("field-transforms");
const docPath = `${h.prefix}/social-post`;

try {
  h.log("=== Atomic Field Transforms ===");

  const seeded = await h.api.data("POST", `/documents/${docPath}`, {
    data: { likes: 10, tags: ["launch"], history: ["featured"], scratch: "temporary" },
  });
  check(seeded.status === 201, "seed post");
  const before = await h.api.data("GET", `/documents/${docPath}`);
  h.log({ before: before.body.data });

  const patched = await h.api.data("PATCH", `/documents/${docPath}`, {
    data: {
      likes: { $op: "inc", by: 5 },
      tags: { $op: "arrayUnion", elements: ["release", "news"] },
      history: { $op: "arrayRemove", elements: ["featured"] },
      updatedAt: { $op: "serverTimestamp" },
      scratch: { $op: "deleteField" },
    },
  });
  check(patched.ok, "transform patch applied");

  const after = (await h.api.data("GET", `/documents/${docPath}`)).body.data;
  check(after.likes === 15, "increment applied");
  check(Array.isArray(after.tags) && after.tags.length === 3, "arrayUnion appended two tags");
  check(!("scratch" in after), "deleteField removed the scratch key");
  check(after.updatedAt?.$t === "ts", "serverTimestamp uses the ts wire type");
  h.log({
    likes: after.likes,
    tags: after.tags,
    removedFieldAbsent: !("scratch" in after),
    serverTimestampWireType: after.updatedAt.$t,
  });
} finally {
  await h.cleanup();
}
