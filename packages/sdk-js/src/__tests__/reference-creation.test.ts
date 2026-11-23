import { describe, expect, it } from "vitest";
import { createClient, reference } from "../index.js";

const invalidPaths = [
  "", "users", " users/u1", "users/u1 ", "/users/u1", "users/u1/", "users//u1", "users/..",
  "users/%2e%2e", "users/x%2e%2ex", "users/%3f", "users/%23", "users/%2fother", "users/u?x", "users/u#x", "users/u\\x",
  "users/u\u0000", "users/__reserved__", "users/" + "x".repeat(1501),
  "a/b/c/d/e/f/g/h/i/j/k/l", "users/" + "界".repeat(501),
  "a/" + "x".repeat(1200) + "/b/" + "y".repeat(850),
];

describe("reference creation", () => {
  it.each(["users/u1", "teams/t1/members/u1", "users/محمد", "users/space name"])(
    "creates a canonical, immutable value for %s", (path) => {
      const value = reference(path);
      expect(value).toEqual({ $t: "ref", $v: path });
      expect(Object.isFrozen(value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    },
  );
  it.each(invalidPaths)("rejects invalid path %s", (path) => {
    expect(() => reference(path)).toThrow();
  });
  it("does not silently coerce non-string runtime values", () => {
    expect(() => reference(null as unknown as string)).toThrow();
  });
  it("accepts boundary path lengths permitted by the contract", () => {
    const path = `a/${"x".repeat(1020)}/b/${"y".repeat(1023)}`;
    expect(path.length).toBe(2048);
    expect(reference(path).$v).toBe(path);
  });
  it("serializes references through create and update without encoding their values", async () => {
    const bodies: unknown[] = [];
    const db = createClient({
      projectId: "project", apiKey: "pk_test_reference_creation",
      customFetch: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ path: "posts/p1", documentId: "p1", version: 1, data: {} }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await db.doc("posts/p1").create({ author: reference("users/محمد"), readers: [reference("users/u2")] });
    await db.doc("posts/p1").update({ author: reference("users/u2") });
    expect(bodies[0]).toMatchObject({ data: { author: { $t: "ref", $v: "users/محمد" }, readers: [{ $t: "ref", $v: "users/u2" }] } });
    expect(bodies[1]).toMatchObject({ data: { author: { $t: "ref", $v: "users/u2" } } });
  });
});
