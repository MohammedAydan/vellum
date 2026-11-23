/**
 * @vellum/api - Session authentication middleware 
 *
 * All session verification delegates to the single shared
 * `createSessionService` implementation in `@vellum/authorization`.
 */

import type { Context, MiddlewareHandler } from "hono";
import { VellumError, type BoundedCachePolicy } from "@vellum/core";
import type { Role, SessionClaims, SessionService } from "@vellum/authorization";
import type { ControlPlaneRepository, ProjectRecord } from "@vellum/database-control";

declare module "hono" {
  interface ContextVariableMap {
    session: SessionClaims;
  }
}

const PLATFORM_OPERATOR_ROLES: ReadonlySet<string> = new Set<Role>(["owner", "admin"]);

export const PG_MEMBERSHIP_CACHE_POLICY: BoundedCachePolicy = Object.freeze({
  name: "api.pg-org-membership",
  scope: "tenant",
  maxEntries: 10_000,
  ttlMs: 15_000,
});

interface MembershipCacheEntry {
  memberships: OrgMembership[];
  expiresAt: number;
}

const pgMembershipCache = new Map<string, MembershipCacheEntry>();

function evictMembershipCacheIfNeeded(now: number): void {
  const { maxEntries } = PG_MEMBERSHIP_CACHE_POLICY;
  if (pgMembershipCache.size < maxEntries) return;
  for (const [key, entry] of pgMembershipCache) {
    if (entry.expiresAt <= now) {
      pgMembershipCache.delete(key);
    }
  }
  while (pgMembershipCache.size >= maxEntries) {
    const oldestKey = pgMembershipCache.keys().next().value;
    if (oldestKey === undefined) break;
    pgMembershipCache.delete(oldestKey);
  }
}

/** Invalidate cached PostgreSQL organization memberships for a user (or all users if omitted). */
export function invalidateUserOrgMembershipsCache(userId?: string): void {
  if (userId === undefined) {
    pgMembershipCache.clear();
  } else {
    pgMembershipCache.delete(userId);
  }
}

/** Extract a Bearer token; returns null when the header is absent. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  return raw.length > 0 ? raw : null;
}

function verifyOrThrow(sessionService: SessionService, token: string): SessionClaims {
  try {
    return sessionService.verifyAccess(token);
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
  }
}

/**
 * Strict session middleware. A missing, malformed, expired, or revoked token
 * always yields 401. `allowedRoles` is checked against the session role.
 */
export function requireSession(
  sessionService: SessionService,
  allowedRoles?: readonly Role[]
): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) throw new VellumError("UNAUTHENTICATED", "Missing session Bearer token");
    const claims = verifyOrThrow(sessionService, token);
    if (allowedRoles && !allowedRoles.includes(claims.role)) {
      throw new VellumError("PERMISSION_DENIED", "Your session role is not permitted for this operation", {
        role: claims.role,
      });
    }
    c.set("session", claims);
    await next();
  };
}

/**
 * Backward-compatible middleware for the legacy `/v1/*` control-plane routes:
 * an absent token keeps legacy behavior, but a *present* token must be valid.
 * Strict session auth lives on `/v1/console/*` and `/v1/admin/*`.
 */
export function optionalSession(sessionService: SessionService): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token) {
      const claims = verifyOrThrow(sessionService, token);
      c.set("session", claims);
    }
    await next();
  };
}

/**
 * Optional session guard for shared control-plane metadata routes.
 *
 * These read-only routes are legitimately called by both realm frontends:
 * the Customer Console (console realm) and the Super Admin Console. A token
 * from either realm is accepted; a present token that fails BOTH verifiers is
 * rejected (fail closed). Customer document payloads are never exposed here.
 */
export function optionalRealmSession(
  consoleService: SessionService,
  superAdminService: SessionService
): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token) {
      let claims: SessionClaims | undefined;
      try {
        claims = consoleService.verifyAccess(token);
      } catch {
        try {
          claims = superAdminService.verifyAccess(token);
        } catch {
          throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
        }
      }
      c.set("session", claims);
    }
    await next();
  };
}

/**
 * Strict realm guard for control-plane mutation routes: a session token from
 * either realm is REQUIRED. Unlike `optionalRealmSession`, an absent token is
 * rejected instead of silently passing through.
 */
export function requireRealmSession(
  consoleService: SessionService,
  superAdminService?: SessionService
): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) throw new VellumError("UNAUTHENTICATED", "Missing session Bearer token");
    let claims: SessionClaims | undefined;
    try {
      claims = consoleService.verifyAccess(token);
    } catch {
      if (!superAdminService) {
        throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
      }
      try {
        claims = superAdminService.verifyAccess(token);
      } catch {
        throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
      }
    }
    c.set("session", claims);
    await next();
  };
}

export function getSession(c: Context): SessionClaims | undefined {
  return c.get("session");
}

export interface OrgMembership {
  organizationId: string;
  role: string;
}

interface OrgMemberRecord {
  organizationId: string;
  userId: string;
  role: string;
}

interface ControlStoreWithMembers {
  organizationMembers: Map<string, OrgMemberRecord>;
}

interface ControlStoreWithPool {
  pool: { query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
}

function hasOrganizationMembers(store: object): store is ControlStoreWithMembers {
  return "organizationMembers" in store && store.organizationMembers instanceof Map;
}

function hasQueryPool(store: object): store is ControlStoreWithPool {
  if (!("pool" in store)) return false;
  const candidate = store.pool;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "query" in candidate &&
    typeof candidate.query === "function"
  );
}

/**
 * Resolve a user's organization memberships from in-memory or PostgreSQL control store.
 * PostgreSQL lookups are short-TTL cached (15s, bounded) to avoid redundant DB
 * round-trips on hot console/admin paths.
 */
export async function getUserOrgMemberships(
  controlStore: ControlPlaneRepository,
  userId: string
): Promise<OrgMembership[]> {
  if (hasOrganizationMembers(controlStore)) {
    return Array.from(controlStore.organizationMembers.values())
      .filter((m) => m.userId === userId)
      .map((m) => ({ organizationId: m.organizationId, role: m.role }));
  }

  if (hasQueryPool(controlStore)) {
    const now = Date.now();
    const cached = pgMembershipCache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.memberships;
    }

    const res = await controlStore.pool.query(
      "SELECT organization_id AS \"organizationId\", role FROM organization_members WHERE user_id = $1",
      [userId]
    );
    const memberships = res.rows
      .filter((row): row is Record<string, unknown> & { organizationId: string; role: string } =>
        typeof row["organizationId"] === "string" && typeof row["role"] === "string"
      )
      .map((row) => ({ organizationId: row["organizationId"], role: row["role"] }));

    if (!pgMembershipCache.has(userId)) {
      evictMembershipCacheIfNeeded(now);
    }
    pgMembershipCache.set(userId, {
      memberships,
      expiresAt: now + PG_MEMBERSHIP_CACHE_POLICY.ttlMs,
    });
    return memberships;
  }

  return [];
}

export async function getUserOrgIds(controlStore: ControlPlaneRepository, userId: string): Promise<string[]> {
  return (await getUserOrgMemberships(controlStore, userId)).map((m) => m.organizationId);
}

export interface OrgAccessOptions {
  /** Require a write-capable role (org owner/admin, or a platform operator). */
  write?: boolean;
}

/**
 * Assert session access to an organization. Platform operators (owner/admin)
 * may act across organizations; support_readonly is read-only everywhere;
 * customers must hold an actual membership with an appropriate role.
 */
export async function assertOrgAccess(
  controlStore: ControlPlaneRepository,
  claims: SessionClaims,
  organizationId: string,
  options: OrgAccessOptions = {}
): Promise<OrgMembership | null> {
  const isOperator = PLATFORM_OPERATOR_ROLES.has(claims.role);
  if (claims.role === "support_readonly" && options.write) {
    throw new VellumError("PERMISSION_DENIED", "Read-only sessions cannot perform mutations");
  }

  const membership = (await getUserOrgMemberships(controlStore, claims.uid)).find(
    (m) => m.organizationId === organizationId
  );

  if (!membership && !isOperator) {
    throw new VellumError("PERMISSION_DENIED", "You are not a member of the requested organization", {
      organizationId,
    });
  }

  if (options.write && membership && !isOperator && !["owner", "admin"].includes(membership.role)) {
    throw new VellumError("PERMISSION_DENIED", "Your organization role cannot perform this mutation", {
      organizationId,
      membershipRole: membership.role,
    });
  }

  return membership ?? null;
}

/** Assert session access to a project by resolving its owning organization. */
export async function assertProjectAccess(
  controlStore: ControlPlaneRepository,
  claims: SessionClaims,
  projectId: string,
  options: OrgAccessOptions = {}
): Promise<ProjectRecord> {
  let project = controlStore.projects.get(projectId);
  if (!project && typeof controlStore.refresh === "function") {
    // The projects map is a process-local mirror; on a cold serverless
    // instance it may not be hydrated yet. Refresh once before declaring
    // the project missing.
    await controlStore.refresh();
    project = controlStore.projects.get(projectId);
  }
  if (!project) {
    throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
  }
  await assertOrgAccess(controlStore, claims, project.organizationId, options);
  return project;
}
