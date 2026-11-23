/**
 * Atomic field transforms — apply engagement updates in one server-side PATCH.
 *
 * What you'll build: a social post whose likes, tags, moderation history and
 * last-modified stamp are updated atomically, with a scratch field removed.
 * Real-world scenario: two readers "like" and tag a post at the same time.
 * Sending $op sentinels (instead of client-side read/modify/write) avoids lost
 * updates. The serverTimestamp value is logged by its wire type, never its clock.
 */
import { fieldOp } from "../../packages/sdk-js/src/index.js";
import { harness, check } from "./_harness.js";

const h = await harness("field-transforms");
const ref = h.sdk.collection(h.prefix).doc("social-post");

try {
  h.log("=== Atomic Field Transforms ===");

  await ref.set({ likes: 10, tags: ["launch"], history: ["featured"], scratch: "temporary" });
  const before = await ref.get();
  h.log({ before: before.data() });

  await ref.update({
    likes: fieldOp.increment(5),
    tags: fieldOp.arrayUnion("release", "news"),
    history: fieldOp.arrayRemove("featured"),
    updatedAt: fieldOp.serverTimestamp(),
    scratch: fieldOp.deleteField(),
  });

  const after = (await ref.get()).data() as Record<string, unknown>;
  check(after.likes === 15, "increment applied");
  check(Array.isArray(after.tags) && after.tags.length === 3, "arrayUnion appended two tags");
  check(!("scratch" in after), "deleteField removed the scratch key");
  const stamp = after.updatedAt as { $t?: string };
  check(stamp?.$t === "ts", "serverTimestamp uses the tagged ts wire type");
  h.log({
    likes: after.likes,
    tags: after.tags,
    removedFieldAbsent: !("scratch" in after),
    serverTimestampWireType: stamp.$t,
  });
} finally {
  await h.cleanup();
}
