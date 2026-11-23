/**
 * The 20 live scenarios shared by the CLI runner and the HTTP dashboard.
 *
 * Every assertion hits the real API through `@vellumdb/sdk-js` or global `fetch`.
 * There are no mocks, no simulations and no skips. The only network call that
 * never reaches a server is the single-flight accounting wrapper, which merely
 * counts real `/auth/token/refresh` requests.
 *
 * No credential material is ever returned in a result or written to a log.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createClient } from "@vellumdb/sdk-js";
import type {
  AuthState,
  AuthStorage,
  CollectionInfo,
  VellumClient,
  VellumAuthUser,
  QuerySnapshot,
} from "@vellumdb/sdk-js";
import { type BootstrapResult } from "./bootstrap.js";

const ALICE_PASSWORD = "LiveTestbed1";
const NEW_PASSWORD = "LiveTestbed2";

export interface Identity {
  uid: string;
  email: string;
  password: string;
  db: VellumClient;
}

export interface ScenarioContext {
  base: BootstrapResult;
  runId: string;
  alice?: Identity;
  bob?: Identity;
  aliceTotpSecret?: string;
  /** Number of real refresh HTTP calls, keyed by logical client name. */
  refreshCalls: Map<string, number>;
  /** Memoized V2 rules publication so every V2 scenario is standalone-safe. */
  v2Rules?: Promise<{ source: string; ast: Record<string, unknown> }>;
}

export interface ScenarioResult {
  id: number;
  name: string;
  status: "PASS" | "FAIL";
  latencyMs: number;
  error?: string;
}

export interface ScenarioDefinition {
  id: number;
  name: string;
  run: (ctx: ScenarioContext) => Promise<void>;
}

export function createScenarioContext(base: BootstrapResult): ScenarioContext {
  return { base, runId: base.runId, refreshCalls: new Map() };
}

/** Redact credentials from any diagnostic text before it can be displayed. */
export function redact(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt>")
    .replace(/\b(pk|sk)_[A-Za-z0-9_-]+/g, "<api-key>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw).slice(0, 300);
}

/** Count real refresh requests without ever inspecting a token. */
function countingFetch(ctx: ScenarioContext, label: string): typeof globalThis.fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/token/refresh")) {
      ctx.refreshCalls.set(label, (ctx.refreshCalls.get(label) ?? 0) + 1);
    }
    return globalThis.fetch(input, init);
  };
  return wrapped as typeof fetch;
}

function makeDb(ctx: ScenarioContext, apiKey: string, label: string): VellumClient {
  return createClient({
    projectId: ctx.base.projectId,
    apiKey,
    endpoint: ctx.base.baseUrl,
    customFetch: countingFetch(ctx, label),
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers: deterministic identities                                          */
/* -------------------------------------------------------------------------- */

async function restoreSignedIn(db: VellumClient, identity: Identity, ctx: ScenarioContext): Promise<void> {
  if (db.currentUser) return;
  const result = await db.signInWithEmailAndPassword(identity.email, identity.password);
  if (isRecord(result) && result["mfaRequired"] === true) {
    const ticket = result["mfaTicket"];
    const secret = ctx.aliceTotpSecret;
    assert(typeof ticket === "string" && ticket.length > 0, "MFA challenge had no ticket");
    assert(typeof secret === "string" && secret.length > 0, "MFA challenge required but no TOTP secret is known");
    await db.verifyMfaChallenge(ticket, computeTotp(secret));
  }
  assert(db.currentUser !== null, "could not re-establish the signed-in session");
}

async function ensureAlice(ctx: ScenarioContext): Promise<Identity> {
  if (!ctx.alice) {
    const email = `alice-${ctx.runId}@js-testbed.example`;
    const db = makeDb(ctx, ctx.base.publicKey, "alice");
    const user = await db.signUpWithEmailAndPassword(email, ALICE_PASSWORD, {
      displayName: "Alice Testbed",
    });
    ctx.alice = { uid: user.id, email, password: ALICE_PASSWORD, db };
    return ctx.alice;
  }
  await restoreSignedIn(ctx.alice.db, ctx.alice, ctx);
  return ctx.alice;
}

async function ensureBob(ctx: ScenarioContext): Promise<Identity> {
  if (!ctx.bob) {
    const email = `bob-${ctx.runId}@js-testbed.example`;
    const db = makeDb(ctx, ctx.base.publicKey, "bob");
    const user = await db.signUpWithEmailAndPassword(email, ALICE_PASSWORD, {
      displayName: "Bob Testbed",
    });
    ctx.bob = { uid: user.id, email, password: ALICE_PASSWORD, db };
    return ctx.bob;
  }
  await restoreSignedIn(ctx.bob.db, ctx.bob, ctx);
  return ctx.bob;
}

/* -------------------------------------------------------------------------- */
/* Helpers: assertions, TOTP, JWT                                             */
/* -------------------------------------------------------------------------- */

async function expectDenied(action: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    const err = error as { code?: string; status?: number };
    assert(err.code === "PERMISSION_DENIED", `${what}: expected PERMISSION_DENIED, got ${String(err.code ?? "UNKNOWN")}`);
    assert(err.status === 403, `${what}: expected HTTP 403, got ${String(err.status)}`);
    return;
  }
  throw new Error(`${what}: expected PERMISSION_DENIED but the operation succeeded`);
}

async function expectRefreshRejected(ctx: ScenarioContext, refreshToken: string | null | undefined, what: string): Promise<void> {
  assert(typeof refreshToken === "string" && refreshToken.length > 0, `${what}: no refresh token available`);
  const response = await fetch(
    `${ctx.base.baseUrl}/v1/projects/${ctx.base.projectId}/auth/token/refresh`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-vellum-api-key": ctx.base.publicKey },
      body: JSON.stringify({ refreshToken }),
    }
  );
  assert(response.status >= 400, `${what}: refresh token was still accepted (HTTP ${response.status})`);
}

function base32Decode(secret: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 6238 TOTP: HMAC-SHA1, 6 digits, 30-second step. */
export function computeTotp(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Well-formed but already-expired JWT; used only to trigger silent refresh. */
function expiredJwt(): string {
  const encode = (value: string): string => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "expired-test" }));
  const payload = encode(
    JSON.stringify({ sub: "expired-test", exp: Math.floor(Date.now() / 1000) - 120 })
  );
  return `${header}.${payload}.${createHash("sha256").update(randomBytes(16)).digest("base64url")}`;
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

async function scenarioJwks(ctx: ScenarioContext): Promise<void> {
  const response = await fetch(
    `${ctx.base.baseUrl}/v1/projects/${ctx.base.projectId}/auth/.well-known/jwks.json`
  );
  assert(response.ok, `JWKS discovery returned HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: Array<{ kty?: string; crv?: string; alg?: string }> };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const okp = keys.filter((key) => key?.kty === "OKP" && (key.crv === "Ed25519" || key.alg === "EdDSA"));
  assert(okp.length >= 1, "JWKS did not contain an OKP/Ed25519 verification key");
}

async function scenarioSignupProjection(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const snapshot = await alice.db.doc(`users/${alice.uid}`).get();
  assert(snapshot.exists, "automatic projection document is missing");
  const data = snapshot.data();
  assert(data["uid"] === alice.uid, "projection uid does not match the signed-in user");
  assert(data["email"] === alice.email, "projection email does not match the signed-in user");
  assert(data["displayName"] === "Alice Testbed", "projection displayName is missing");
}

async function scenarioMergeAndProfile(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const path = `users/${alice.uid}`;
  await alice.db.doc(path).set({ bio: "Full-stack dev", theme: "dark" }, { merge: true });

  const updated = await alice.db.updateProfile({ displayName: "Alice Updated" });
  assert(updated.displayName === "Alice Updated", "updateProfile did not change the auth profile");

  const snapshot = await alice.db.doc(path).get();
  const data = snapshot.data();
  assert(data["bio"] === "Full-stack dev", "custom bio field was not preserved");
  assert(data["theme"] === "dark", "custom theme field was not preserved");
  assert(data["displayName"] === "Alice Updated", "projected displayName is stale after updateProfile");
}

async function scenarioEmailVerification(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const action = await alice.db.sendEmailVerification();
  assert(typeof action.devToken === "string" && action.devToken.length > 0, "verification devToken was not returned");
  await alice.db.confirmEmailVerification(action.devToken);
  const user: VellumAuthUser = await alice.db.getUser();
  assert(user.emailVerified === true, "emailVerified is still false after confirmation");
}

async function scenarioTotpMfa(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const enrollment = await alice.db.enrollTotpMfa({ issuer: "Vellum" });
  assert(enrollment.secret.length > 0, "TOTP enrollment returned no secret");
  ctx.aliceTotpSecret = enrollment.secret;

  await alice.db.confirmTotpMfa(computeTotp(enrollment.secret));
  await alice.db.signOut();

  const challenge = await alice.db.signInWithEmailAndPassword(alice.email, alice.password);
  assert(isRecord(challenge) && challenge["mfaRequired"] === true, "sign-in did not require a TOTP challenge");
  const ticket = challenge["mfaTicket"];
  assert(typeof ticket === "string" && ticket.length > 0, "MFA challenge returned no ticket");

  const secret = ctx.aliceTotpSecret;
  assert(secret !== undefined, "TOTP secret is unavailable for the challenge");
  const session = await alice.db.verifyMfaChallenge(ticket, computeTotp(secret));
  assert(session.id === alice.uid, "MFA challenge did not return the expected user");
  assert(alice.db.currentUser?.accessToken !== undefined, "MFA challenge did not establish a session");
}

async function scenarioOwnerVsStranger(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const bob = await ensureBob(ctx);
  const path = "tasks/task_1";
  await alice.db.doc(path).create({ title: "Alice private task", ownerId: alice.uid });
  await expectDenied(() => bob.db.doc(path).set({ title: "Overwritten by Bob" }), "Bob overwriting Alice's task");
  await expectDenied(() => bob.db.doc(path).delete(), "Bob deleting Alice's task");
}

async function scenarioClaimsElevation(ctx: ScenarioContext): Promise<void> {
  const bob = await ensureBob(ctx);
  const path = "admin_reports/rep_1";
  await expectDenied(() => bob.db.doc(path).set({ title: "Unauthorized report" }), "Bob writing an admin report");

  const response = await fetch(
    `${ctx.base.baseUrl}/v1/projects/${ctx.base.projectId}/auth/admin/users/${bob.uid}/claims`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vellum-api-key": ctx.base.serverKey },
      body: JSON.stringify({ claims: { role: "moderator", clearance: 3 } }),
    }
  );
  assert(response.ok, `claim grant returned HTTP ${response.status}`);

  const token = await bob.db.getIdToken(true);
  assert(typeof token === "string" && token.length > 0, "forced refresh returned no token");

  await bob.db.doc(path).set({ title: "Moderated report", updatedBy: bob.uid });
  const report = await bob.db.doc(path).get();
  assert(report.data()["title"] === "Moderated report", "moderator could not read back the report");

  const projected = await bob.db.doc(`users/${bob.uid}`).get();
  const claims = projected.data()["customClaims"];
  assert(isRecord(claims) && claims["role"] === "moderator", "projected user document has no moderator role");
}

async function scenarioQueryAndCursor(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const bucket = `q_${ctx.runId.replace(/-/g, "").slice(0, 10)}`;
  const priorities = [5, 1, 4, 2, 3];
  for (const [index, priority] of priorities.entries()) {
    await alice.db.doc(`tasks/${bucket}_${index}`).set({
      title: `Prioritized task ${priority}`,
      ownerId: alice.uid,
      bucket,
      priority,
      scheduledAt: new Date(Date.UTC(2026, 0, 1 + priority)).toISOString(),
    });
  }

  const base = alice.db
    .collection("tasks")
    .where("bucket", "==", bucket)
    .orderBy("priority", "asc")
    .limit(2);
  const collected: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 10) {
    const page: QuerySnapshot<Record<string, unknown>> = await (cursor ? base.startAfter(cursor) : base).get();
    pages += 1;
    for (const doc of page.docs) {
      const value = doc.data()["priority"];
      assert(typeof value === "number", "query result has no numeric priority");
      collected.push(value);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert(pages < 10, "cursor pagination did not terminate");
  assert(collected.length === 5, `expected 5 tasks across the pages, got ${collected.length}`);
  assert(
    JSON.stringify(collected) === JSON.stringify([1, 2, 3, 4, 5]),
    "filtered + sorted query returned the wrong order across the cursor boundary"
  );
}

async function scenarioRealtime(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const taskId = `rt_${ctx.runId.replace(/-/g, "").slice(0, 10)}`;
  const writer = makeDb(ctx, ctx.base.serverKey, "realtime-writer");

  let resolveEvent: (() => void) | null = null;
  let rejectEvent: ((error: Error) => void) | null = null;
  const event = new Promise<void>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  const timer = setTimeout(() => {
    rejectEvent?.(new Error("no realtime event for the inserted task within 2 seconds"));
  }, 2000);

  const unsubscribe = alice.db.collection("tasks").onSnapshot(
    (snapshot) => {
      if (snapshot.changes.some((change) => change.type === "added" && change.doc.id === taskId)) {
        resolveEvent?.();
      }
    },
    () => rejectEvent?.(new Error("realtime subscription reported an error"))
  );

  try {
    // Give the WebSocket auth handshake a moment to register the subscription.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writer.doc(`tasks/${taskId}`).set({ title: "Realtime task", ownerId: alice.uid, priority: 99999 });
    await event;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

async function scenarioSilentRefresh(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const session = alice.db.currentUser;
  assert(session !== null && session.refreshToken.length > 0, "no active session is available for silent refresh");

  let stored: AuthState | null = { ...session, accessToken: expiredJwt() };
  const storage: AuthStorage = {
    load: () => stored,
    save: (next) => {
      stored = next;
    },
    clear: () => {
      stored = null;
    },
  };
  const label = "silent-refresh";
  const client = createClient({
    projectId: ctx.base.projectId,
    apiKey: ctx.base.publicKey,
    endpoint: ctx.base.baseUrl,
    authStorage: storage,
    customFetch: countingFetch(ctx, label),
  });
  const before = ctx.refreshCalls.get(label) ?? 0;
  const page = await client.collection("tasks").get();
  assert(Array.isArray(page.docs), "collection read after silent refresh did not return a page");
  const after = ctx.refreshCalls.get(label) ?? 0;
  assert(after > before, "collection read succeeded without the SDK calling the refresh endpoint");

  // The temporary client rotated the shared session's refresh token. Bring the
  // main client back in sync so later scenarios do not present a stale token
  // outside the server's 15 s concurrent-refresh grace window.
  await alice.db.getIdToken(true);
}

async function scenarioParallelRefresh(ctx: ScenarioContext): Promise<void> {
  const alice = await ensureAlice(ctx);
  const before = ctx.refreshCalls.get("alice") ?? 0;
  const tokens = await Promise.all([0, 1, 2, 3, 4].map(() => alice.db.getIdToken(true)));
  assert(
    tokens.every((token): token is string => typeof token === "string" && token.length > 0),
    "one or more parallel refresh calls returned no token"
  );
  assert(new Set(tokens).size === 1, "parallel refresh calls returned divergent tokens");
  assert(alice.db.currentUser !== null, "the session was lost during parallel refresh");
  const refreshes = (ctx.refreshCalls.get("alice") ?? 0) - before;
  assert(refreshes === 1, `expected the single-flight mutex to issue one refresh, observed ${refreshes}`);
}

async function scenarioPasswordReset(ctx: ScenarioContext): Promise<void> {
  const email = `reset-${ctx.runId}@js-testbed.example`;
  const db = makeDb(ctx, ctx.base.publicKey, "password-reset");
  const signedUp = await db.signUpWithEmailAndPassword(email, ALICE_PASSWORD, { displayName: "Reset User" });

  const action = await db.sendPasswordResetEmail(email);
  assert(typeof action.devToken === "string" && action.devToken.length > 0, "password reset devToken was not returned");
  await db.confirmPasswordReset(action.devToken, NEW_PASSWORD);
  // Confirming a password reset revokes every existing session of the user.
  await expectRefreshRejected(ctx, signedUp.refreshToken, "pre-reset refresh token");

  const signedIn = await db.signInWithEmailAndPassword(email, NEW_PASSWORD);
  assert(!(isRecord(signedIn) && signedIn["mfaRequired"] === true), "unexpected MFA challenge after password reset");

  const sessionRefreshToken = db.currentUser?.refreshToken ?? null;
  await db.signOut({ allSessions: true });
  assert(db.currentUser === null, "currentUser survived signOut({ allSessions: true })");
  await expectRefreshRejected(ctx, sessionRefreshToken, "post-signout refresh token");
}

/* -------------------------------------------------------------------------- */
/* V2 live scenarios (relations, aggregates, DSL, index advisor)              */
/* -------------------------------------------------------------------------- */

/**
 * Valid v2 rules DSL. `match` paths are written with a leading slash (the DSL
 * canonical form). The compiled AST is normalized before publication because
 * the engine matches document paths without a leading slash.
 */
const V2_RULES_DSL = `rules_version = '2';

match /v2posts/{postId} {
  allow read: if auth.uid != null;
  allow write: if auth.uid != null;
}

match /v2users/{uid} {
  allow get: if auth.uid == path.uid;
}

match /v2metrics/{docId} {
  allow read: if true;
  allow write: if true;
}`;

function v2ApiPath(ctx: ScenarioContext, suffix: string): string {
  return `${ctx.base.baseUrl}/v1/projects/${ctx.base.projectId}${suffix}`;
}

async function apiJson<T>(
  url: string,
  method: "GET" | "POST" | "PUT",
  body: unknown,
  apiKey: string
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-vellum-api-key": apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: (parsed ?? {}) as T };
}

/** Strip the DSL's canonical leading slash so engine path matching succeeds. */
function engineRulesAst(ast: Record<string, unknown>): Record<string, unknown> {
  const rules = Array.isArray(ast["rules"]) ? (ast["rules"] as Array<Record<string, unknown>>) : [];
  return {
    ...ast,
    rules: rules.map((rule) => ({
      ...rule,
      match: typeof rule["match"] === "string" ? rule["match"].replace(/^\/+/, "") : rule["match"],
    })),
  };
}

async function ensureV2Rules(ctx: ScenarioContext): Promise<{ source: string; ast: Record<string, unknown> }> {
  if (!ctx.v2Rules) {
    ctx.v2Rules = (async () => {
      const compiled = await apiJson<{ ast?: Record<string, unknown>; diagnostics?: unknown[] }>(
        v2ApiPath(ctx, "/rules/compile"),
        "POST",
        { source: V2_RULES_DSL },
        ctx.base.serverKey
      );
      assert(compiled.status === 200, `rules/compile failed with HTTP ${compiled.status}`);
      const ast = compiled.body.ast;
      assert(isRecord(ast) && ast["version"] === 1, "rules/compile did not return a version 1 AST");
      assert(Array.isArray(ast["rules"]) && ast["rules"].length === 3, "rules/compile returned unexpected rules");

      // Merge with the bootstrap ruleset so earlier scenarios keep working when
      // a V2 scenario is re-run in isolation from the dashboard. The DSL emits
      // leading-slash patterns; the engine matches tenant-relative paths, so the
      // SAME normalized AST must be used for publishing and for simulation.
      const engineAst = engineRulesAst(ast);
      const published = await apiJson<{ version?: number }>(
        v2ApiPath(ctx, "/rulesets"),
        "POST",
        {
          rulesAst: {
            version: 1,
            rules: [
              ...(ctx.base.rules.rules as unknown as Array<Record<string, unknown>>),
              ...((engineAst["rules"] as Array<Record<string, unknown>>) ?? []),
            ],
          },
        },
        ctx.base.serverKey
      );
      assert(published.status === 201, `rulesets publish failed with HTTP ${published.status}`);
      return { source: V2_RULES_DSL, ast: engineAst };
    })();
  }
  return ctx.v2Rules;
}

async function scenarioV2RulesDsl(ctx: ScenarioContext): Promise<void> {
  const { source, ast } = await ensureV2Rules(ctx);
  assert(source.includes("rules_version = '2';"), "DSL source lost its version sugar");
  assert(ast["version"] === 1, "compiled rules AST is not version 1");

  const decompiled = await apiJson<{ dsl?: string }>(
    v2ApiPath(ctx, "/rules/decompile"),
    "POST",
    { rulesAst: ast },
    ctx.base.serverKey
  );
  assert(decompiled.status === 200, `rules/decompile failed with HTTP ${decompiled.status}`);
  assert(
    typeof decompiled.body.dsl === "string" && decompiled.body.dsl.includes("rules_version = '2';"),
    "decompile did not reproduce rules_version '2'"
  );

  const allowed = await apiJson<{ allowed?: boolean; matchedRule?: string; evaluationTrace?: string[] }>(
    v2ApiPath(ctx, "/rules/simulate"),
    "POST",
    {
      rulesAst: ast,
      operation: "create",
      path: "/v2posts/p1",
      auth: { uid: "user-1", claims: {} },
      incomingData: { title: "simulated" },
    },
    ctx.base.serverKey
  );
  assert(allowed.status === 200, `rules/simulate failed with HTTP ${allowed.status}`);
  assert(allowed.body.allowed === true, "simulator did not ALLOW an authenticated post create");
  assert(
    allowed.body.matchedRule === "v2posts/{postId}" || allowed.body.matchedRule === "/v2posts/{postId}",
    `simulator matched the wrong rule: ${allowed.body.matchedRule}`
  );
  assert(
    Array.isArray(allowed.body.evaluationTrace) &&
      allowed.body.evaluationTrace.some((line) => line.includes("ALLOW")),
    "simulator trace has no ALLOW decision"
  );

  const denied = await apiJson<{ allowed?: boolean; evaluationTrace?: string[] }>(
    v2ApiPath(ctx, "/rules/simulate"),
    "POST",
    {
      rulesAst: ast,
      operation: "create",
      path: "/v2posts/p1",
      auth: null,
      incomingData: { title: "simulated" },
    },
    ctx.base.serverKey
  );
  assert(denied.status === 200, `rules/simulate (anonymous) failed with HTTP ${denied.status}`);
  assert(denied.body.allowed === false, "simulator did not DENY an anonymous post create");
  assert(
    Array.isArray(denied.body.evaluationTrace) &&
      denied.body.evaluationTrace.some((line) => line.includes("DENY")),
    "simulator trace has no DENY decision"
  );
}

async function scenarioV2RelationsAndRedaction(ctx: ScenarioContext): Promise<void> {
  await ensureV2Rules(ctx);
  const alice = await ensureAlice(ctx);
  const writer = makeDb(ctx, ctx.base.serverKey, "v2-relations-writer");
  const suffix = ctx.runId.slice(0, 8);
  const visiblePath = `v2users/${alice.uid}`;
  const hiddenPath = `v2users/hidden-${suffix}`;
  const parentPath = `v2posts/relations-${suffix}`;

  await writer.doc(visiblePath).set({ uid: alice.uid, name: "Alice V2", secret: "none" });
  await writer.doc(hiddenPath).set({ uid: "someone-else", name: "Hidden User", secret: "CLASSIFIED-V2-RELATION" });
  await writer.doc(parentPath).set({ title: "V2 relations", refs: [visiblePath, hiddenPath] });

  const fetched = await alice.db.doc(parentPath).get({
    include: [{ field: "refs", collection: "v2users", as: "targets" }],
  });
  assert(Array.isArray(fetched.included?.["targets"]), "include did not return a targets array");
  const targets = fetched.included!["targets"] as Array<{ path?: string }>;
  assert(targets.length === 1, `expected 1 readable relation target, got ${targets.length}`);
  assert(targets[0]?.path === visiblePath, "include resolved the wrong relation target");
  assert(
    Array.isArray(fetched.redactedRefs) && fetched.redactedRefs.includes("targets"),
    "unauthorized relation target was not recorded in redactedRefs"
  );
  assert(!JSON.stringify(fetched).includes("CLASSIFIED-V2-RELATION"), "redacted relation leaked secret data");
}

async function scenarioV2Aggregations(ctx: ScenarioContext): Promise<void> {
  await ensureV2Rules(ctx);
  const db = makeDb(ctx, ctx.base.serverKey, "v2-aggregations");
  const bucket = `v2_${ctx.runId.replace(/-/g, "").slice(0, 10)}`;
  const rows: Array<{ team: string; score: number; title: string }> = [
    { team: "red", score: 10, title: "Scoring Sprint" },
    { team: "red", score: 20, title: "PrefixBeta" },
    { team: "blue", score: 4, title: "Scoring Marathon" },
    { team: "blue", score: 6, title: "Other" },
  ];
  for (const [i, row] of rows.entries()) {
    await db.doc(`v2metrics/${bucket}_${i}`).set({ ...row, bucket });
  }

  const base = db.collection("v2metrics").where("bucket", "==", bucket);
  const count = await base.count();
  assert(count === rows.length, `count returned ${count}, expected ${rows.length}`);
  const sum = await base.sum("score");
  assert(sum === 40, `sum returned ${sum}, expected 40`);
  const avg = await base.avg("score");
  assert(avg === 10, `avg returned ${avg}, expected 10`);
  const min = await base.min("score");
  assert(min === 4, `min returned ${min}, expected 4`);
  const max = await base.max("score");
  assert(max === 20, `max returned ${max}, expected 20`);

  const grouped = await db
    .collection("v2metrics")
    .where("bucket", "==", bucket)
    .aggregate({
      groupBy: ["team"],
      metrics: { count: { op: "count" }, sum: { op: "sum", field: "score" } },
    });
  const byTeam = new Map(grouped.map((row) => [String(row["team"]), row]));
  assert(byTeam.size === 2, `groupBy returned ${byTeam.size} groups, expected 2`);
  assert(Number(byTeam.get("red")?.["sum"]) === 30, "red group sum is wrong");
  assert(Number(byTeam.get("blue")?.["sum"]) === 10, "blue group sum is wrong");

  const ci = await db
    .collection("v2metrics")
    .where("bucket", "==", bucket)
    .where("title", "contains_ci", "SCORING")
    .get();
  assert(ci.docs.length === 2, `contains_ci matched ${ci.docs.length} docs, expected 2`);
  const orResult = await db
    .collection("v2metrics")
    .where("bucket", "==", bucket)
    // Each inner group is ANDed; groups are ORed (the locked ESR query shape).
    .or([
      [{ field: "team", op: "==", value: "red" }],
      [{ field: "score", op: "==", value: 4 }],
    ])
    .get();
  assert(orResult.docs.length === 3, `or group matched ${orResult.docs.length} docs, expected 3`);
}

interface IndexSuggestionShape {
  fingerprint?: string;
  collectionPath?: string;
  fields?: Array<{ path: string; dir: string }>;
  reason?: string;
}

async function scenarioV2IndexAdvisor(ctx: ScenarioContext): Promise<void> {
  await ensureV2Rules(ctx);
  const collected: Array<{ url: string; suggestion: unknown }> = [];
  const advisorClient = createClient({
    projectId: ctx.base.projectId,
    apiKey: ctx.base.serverKey,
    endpoint: ctx.base.baseUrl,
    warnOnMissingIndexes: false,
    onIndexSuggestion: (event) => collected.push(event),
  });
  const bucket = `adv_${ctx.runId.replace(/-/g, "").slice(0, 10)}`;
  await advisorClient.doc(`v2metrics/${bucket}_1`).set({ bucket, team: "red", kind: "ticket" });
  await advisorClient.doc(`v2metrics/${bucket}_2`).set({ bucket, team: "blue", kind: "ticket" });

  // Two equality fields with no sort make the query composite-index-worthy.
  await advisorClient
    .collection("v2metrics")
    .where("bucket", "==", bucket)
    .where("kind", "==", "ticket")
    .get();
  assert(collected.length >= 1, "SDK onIndexSuggestion callback was not invoked for the unindexed query");

  const suggestion = collected[0]!.suggestion as IndexSuggestionShape;
  assert(typeof suggestion?.fingerprint === "string" && suggestion.fingerprint.length > 0, "suggestion has no fingerprint");
  assert(suggestion.collectionPath === "v2metrics", "suggestion points at the wrong collection");
  assert(Array.isArray(suggestion.fields) && suggestion.fields.length >= 2, "suggestion has no recommended fields");

  // The PG-backed recorder buffers recommendations (<=1 flush / 5s per
  // fingerprint). Wait for the durable row BEFORE applying so the applied
  // marker cannot be written against a row that has not landed yet.
  let recorded: { fingerprint?: string; status?: string } | undefined;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const listed = await apiJson<{ recommendations?: Array<{ fingerprint?: string; status?: string }> }>(
      v2ApiPath(ctx, "/indexes/recommendations"),
      "GET",
      undefined,
      ctx.base.serverKey
    );
    assert(listed.status === 200, `listing recommendations failed with HTTP ${listed.status}`);
    recorded = (listed.body.recommendations ?? []).find(
      (row) => row.fingerprint === suggestion.fingerprint
    );
    if (recorded) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert(recorded !== undefined, "the advisor did not persist the uncovered-query recommendation");

  const created = await apiJson<{ id?: string }>(
    v2ApiPath(ctx, "/indexes"),
    "POST",
    {
      collectionPath: "v2metrics",
      fields: suggestion.fields,
      ...(suggestion.fingerprint ? { fingerprint: suggestion.fingerprint } : {}),
    },
    ctx.base.serverKey
  );
  assert(created.status === 201, `applying the index recommendation failed with HTTP ${created.status}`);

  const after = await apiJson<{ recommendations?: Array<{ fingerprint?: string; status?: string }> }>(
    v2ApiPath(ctx, "/indexes/recommendations"),
    "GET",
    undefined,
    ctx.base.serverKey
  );
  const applied = (after.body.recommendations ?? []).find(
    (row) => row.fingerprint === suggestion.fingerprint
  );
  assert(applied !== undefined, "the applied recommendation disappeared after apply");
  assert(applied!.status === "applied", `recommendation status is ${String(applied!.status)}, expected applied`);
}

/* -------------------------------------------------------------------------- */
/* Collections lifecycle (SDK + public REST, real live registry)              */
/* -------------------------------------------------------------------------- */

/** Unique, path-safe collection name for one scenario in one run. */
function collectionsName(ctx: ScenarioContext, tag: string): string {
  return `qa_${tag}_${ctx.runId.replace(/-/g, "").slice(0, 10)}`;
}

/**
 * Always request `limit=500`: the shared live registry holds more collections
 * than the API's default page of 50, so a default fetch would hide ours.
 */
async function findCollection(
  db: VellumClient,
  name: string
): Promise<CollectionInfo | undefined> {
  const page = await db.listCollections({ limit: 500, search: name });
  return page.collections.find((item) => item.name === name);
}

async function scenarioCollectionsCreateEmpty(ctx: ScenarioContext): Promise<void> {
  const db = makeDb(ctx, ctx.base.serverKey, "collections-create");
  const name = collectionsName(ctx, "empty");
  const created = await db.createCollection(name);
  assert(created.name === name, `createCollection returned the wrong name (${created.name})`);
  assert(created.documentCount === 0, `new collection has ${created.documentCount} documents`);
  const found = await findCollection(db, name);
  assert(found !== undefined, "empty collection is not visible in listCollections");
  assert(found?.documentCount === 0, "empty collection was listed with a non-zero count");
}

async function scenarioCollectionsAutoDiscover(ctx: ScenarioContext): Promise<void> {
  const db = makeDb(ctx, ctx.base.serverKey, "collections-auto");
  const name = collectionsName(ctx, "auto");
  await db.collection(name).doc("doc_auto_1").set({
    note: "written directly through the SDK",
    runId: ctx.runId,
  });
  const found = await findCollection(db, name);
  assert(found !== undefined, "direct SDK write did not auto-register the collection");
  assert(found?.documentCount === 1, `auto-registered collection has ${found?.documentCount} documents`);
}

async function scenarioCollectionsClear(ctx: ScenarioContext): Promise<void> {
  const db = makeDb(ctx, ctx.base.serverKey, "collections-clear");
  const name = collectionsName(ctx, "clear");
  await db.createCollection(name);
  await db.collection(name).doc("d1").set({ value: 1 });
  assert((await findCollection(db, name))?.documentCount === 1, "pre-clear document count is not 1");

  const cleared = await db.clearCollection(name);
  assert(cleared.deletedCount >= 1, `clearCollection deleted ${cleared.deletedCount} documents`);
  const after = await findCollection(db, name);
  assert(after !== undefined, "clearCollection removed the collection registration");
  assert(after?.documentCount === 0, "cleared collection still reports documents");
}

async function scenarioCollectionsDelete(ctx: ScenarioContext): Promise<void> {
  const db = makeDb(ctx, ctx.base.serverKey, "collections-delete");
  const name = collectionsName(ctx, "delete");
  await db.createCollection(name);
  await db.collection(name).doc("d1").set({ value: 1 });

  const dropped = await db.deleteCollection(name);
  assert(dropped.deletedCollection === true, "deleteCollection did not drop the registration");
  assert(dropped.deletedDocuments >= 1, "deleteCollection did not remove the documents");
  assert((await findCollection(db, name)) === undefined, "deleted collection is still listed");
  assert((await db.getCollectionInfo(name)) === null, "deleted collection info is not null");
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
  { id: 1, name: "JWKS discovery (OKP/Ed25519)", run: scenarioJwks },
  { id: 2, name: "Signup + user projection fields", run: scenarioSignupProjection },
  { id: 3, name: "Merge preservation + updateProfile", run: scenarioMergeAndProfile },
  { id: 4, name: "Email verification via devToken", run: scenarioEmailVerification },
  { id: 5, name: "TOTP MFA challenge + sign-in", run: scenarioTotpMfa },
  { id: 6, name: "Rules: owner vs stranger (403)", run: scenarioOwnerVsStranger },
  { id: 7, name: "Custom claims elevation (sk_ admin)", run: scenarioClaimsElevation },
  { id: 8, name: "Filtered + sorted query + cursor", run: scenarioQueryAndCursor },
  { id: 9, name: "Realtime WebSocket event < 2s", run: scenarioRealtime },
  { id: 10, name: "Silent refresh of expired access token", run: scenarioSilentRefresh },
  { id: 11, name: "Parallel refresh (5x getIdToken)", run: scenarioParallelRefresh },
  { id: 12, name: "Password reset + signOut(allSessions)", run: scenarioPasswordReset },
  { id: 13, name: "V2: Rules DSL compile -> publish -> simulate", run: scenarioV2RulesDsl },
  { id: 14, name: "V2: relations include + redaction", run: scenarioV2RelationsAndRedaction },
  { id: 15, name: "V2: aggregations + OR + CI operators", run: scenarioV2Aggregations },
  { id: 16, name: "V2: index advisor callback + apply", run: scenarioV2IndexAdvisor },
  { id: 17, name: "Collections: create empty persists in list", run: scenarioCollectionsCreateEmpty },
  { id: 18, name: "Collections: SDK write auto-registers", run: scenarioCollectionsAutoDiscover },
  { id: 19, name: "Collections: clear keeps empty collection", run: scenarioCollectionsClear },
  { id: 20, name: "Collections: delete removes collection + docs", run: scenarioCollectionsDelete },
];

export async function runScenario(ctx: ScenarioContext, definition: ScenarioDefinition): Promise<ScenarioResult> {
  const started = performance.now();
  try {
    await definition.run(ctx);
    return {
      id: definition.id,
      name: definition.name,
      status: "PASS",
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error: unknown) {
    return {
      id: definition.id,
      name: definition.name,
      status: "FAIL",
      latencyMs: Math.round(performance.now() - started),
      error: safeError(error),
    };
  }
}

/** Run every scenario in order, sharing one real session across all of them. */
export async function runAll(
  ctx: ScenarioContext,
  onResult?: (result: ScenarioResult) => void
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const definition of SCENARIOS) {
    const result = await runScenario(ctx, definition);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** Run exactly one scenario by id (used by the dashboard's per-row buttons). */
export async function runById(ctx: ScenarioContext, id: number): Promise<ScenarioResult> {
  const definition = SCENARIOS.find((item) => item.id === id);
  if (!definition) throw new Error(`unknown scenario id ${id}`);
  return runScenario(ctx, definition);
}
