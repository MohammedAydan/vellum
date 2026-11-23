import { describe, expect, it } from "vitest";
import { DataPlaneStore } from "../memory-adapter.js";
import { encodeUserCursor, decodeUserCursor } from "../auth-store.js";

const ctx = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("storage / end-user auth operations", () => {
  it("creates, finds (case-insensitive), updates and lists users", async () => {
    const store = new DataPlaneStore();
    const created = await store.createAuthUser(ctx, {
      email: "Alice@Example.COM",
      displayName: "Alice",
      passwordHash: "scrypt$1",
    });
    expect(created.email).toBe("Alice@Example.COM");
    expect((await store.getAuthUserByEmail(ctx, "alice@example.com"))?.id).toBe(created.id);
    expect((await store.getAuthUserById(ctx, created.id))?.displayName).toBe("Alice");

    await store.updateAuthUser(ctx, created.id, { emailVerified: true, customClaims: { role: "editor" } });
    const updated = await store.getAuthUserById(ctx, created.id);
    expect(updated?.emailVerified).toBe(true);
    expect(updated?.customClaims).toEqual({ role: "editor" });

    await store.createAuthUser(ctx, { email: "bob@example.com", displayName: "Bob", isDisabled: true });
    expect((await store.listAuthUsers(ctx)).users).toHaveLength(2);
    expect((await store.listAuthUsers(ctx, { search: "ali" })).users).toHaveLength(1);
    expect((await store.listAuthUsers(ctx, { isDisabled: true })).users).toHaveLength(1);
    expect(await store.countAuthUsers(ctx)).toBe(2);
  });

  it("enforces tenant isolation on auth records", async () => {
    const store = new DataPlaneStore();
    const other = { projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const user = await store.createAuthUser(ctx, { email: "tenant@example.com" });
    expect(await store.getAuthUserById(other, user.id)).toBeNull();
    expect(await store.countAuthUsers(other)).toBe(0);
  });

  it("finds a session by either current or previous refresh hash", async () => {
    const store = new DataPlaneStore();
    const user = await store.createAuthUser(ctx, { email: "session@example.com" });
    const session = await store.createAuthSession(ctx, {
      userId: user.id,
      refreshTokenHash: "hash_new",
      previousRefreshTokenHash: "hash_old",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await store.getAuthSessionByTokenHash(ctx, "hash_new"))?.id).toBe(session.id);
    expect((await store.getAuthSessionByTokenHash(ctx, "hash_old"))?.id).toBe(session.id);

    const rotated = await store.rotateAuthSession(ctx, session.id, "hash_new", "hash_newer", new Date(Date.now() + 120_000).toISOString());
    expect(rotated.previousRefreshTokenHash).toBe("hash_new");
    expect(rotated.rotationCounter).toBe(1);

    expect(await store.revokeAllUserSessions(ctx, user.id, "refresh_token_replay_detected")).toBe(1);
    expect((await store.getAuthSessionByTokenHash(ctx, "hash_newer"))?.revoked).toBe(true);
  });

  it("sets rotatedAt only after a refresh-token rotation", async () => {
    const store = new DataPlaneStore();
    const user = await store.createAuthUser(ctx, { email: "rotated@example.com" });
    const created = await store.createAuthSession(ctx, {
      userId: user.id,
      refreshTokenHash: "hash_rot_a",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(created.rotatedAt).toBeNull();

    const rotated = await store.rotateAuthSession(
      ctx,
      created.id,
      "hash_rot_a",
      "hash_rot_b",
      new Date(Date.now() + 120_000).toISOString()
    );
    expect(typeof rotated.rotatedAt).toBe("string");
    expect(Date.parse(String(rotated.rotatedAt))).not.toBeNaN();
    expect(rotated.previousRefreshTokenHash).toBe("hash_rot_a");
  });

  it("consumes an action token atomically (second consume fails)", async () => {
    const store = new DataPlaneStore();
    const user = await store.createAuthUser(ctx, { email: "token@example.com" });
    await store.saveAuthToken(ctx, {
      userId: user.id,
      tokenHash: "tok_hash",
      tokenType: "password_reset",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await store.consumeAuthToken(ctx, "tok_hash", "password_reset")).tokenHash).toBe("tok_hash");
    await expect(store.consumeAuthToken(ctx, "tok_hash", "password_reset")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("round-trips keyset cursors", () => {
    const cursor = encodeUserCursor("2026-11-17T10:00:00.000Z", "user-123");
    expect(decodeUserCursor(cursor)).toEqual({
      createdAt: "2026-11-17T10:00:00.000Z",
      id: "user-123",
    });
    expect(() => decodeUserCursor("not-a-cursor")).toThrow();
  });
});
