/**
 * @vellum/api - Realm-bound session middleware.
 *
 * Enforces that a control-plane token is not accepted by the other realm:
 *  - `/v1/console/*` requires a `customer_console` realm access token.
 *  - `/v1/admin/*` requires a `super_admin` realm access token whose user is a
 *    platform super administrator in the control store.
 *
 * Both guards emit `x-refreshed-session-token` (sliding renewal) when the
 * verified access token expires within 24 hours.
 */

import type { Context, MiddlewareHandler } from "hono";
import { VellumError } from "@vellum/core";
import type { RealmSessionClaims } from "@vellum/auth";
import type { Role, SessionService } from "@vellum/authorization";
import type { VellumPlatformContext } from "../app.js";
import { assertOrgAccess, assertProjectAccess, extractBearerToken } from "./session.js";

const SLIDING_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

async function verifyOrThrow(service: SessionService, token: string): Promise<RealmSessionClaims> {
  try {
    // The structural SessionService type has no `realm`, but the realm services
    // wired into the platform always return it; verifyAccess has already
    // enforced the realm bound to the service's secret/key.
    return (await service.verifyAccessChecked(token)) as RealmSessionClaims;
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
  }
}

/** Mint a fresh access token with the same claims when nearing expiry. */
function maybeRenew(c: Context, service: SessionService, claims: RealmSessionClaims): void {
  if (claims.exp * 1000 - Date.now() > SLIDING_RENEWAL_WINDOW_MS) return;
  const refreshed = service.signAccess({
    sub: claims.sub,
    uid: claims.uid,
    role: claims.role,
    orgIds: claims.orgIds,
  });
  c.header("x-refreshed-session-token", refreshed);
}

/**
 * Guard for the Customer Console realm. `excludePaths` lets the app exempt
 * public endpoints (e.g. the console refresh endpoint) from verification.
 */
export function requireCustomerConsoleSession(
  platform: VellumPlatformContext,
  allowedRoles?: readonly Role[],
  excludePaths?: readonly string[]
): MiddlewareHandler {
  return async (c, next) => {
    if (excludePaths?.includes(c.req.path)) return next();

    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) throw new VellumError("UNAUTHENTICATED", "Missing session Bearer token");

    const claims = await verifyOrThrow(platform.consoleSessionService, token);
    if (claims.realm !== "customer_console") {
      throw new VellumError("UNAUTHENTICATED", "Invalid session realm");
    }

    const orgId = c.req.param("orgId");
    if (orgId) await assertOrgAccess(platform.controlStore, claims, orgId);
    const projectId = c.req.param("projectId");
    if (projectId) await assertProjectAccess(platform.controlStore, claims, projectId);

    if (allowedRoles && !allowedRoles.includes(claims.role)) {
      throw new VellumError("PERMISSION_DENIED", "Your session role is not permitted for this operation", {
        role: claims.role,
      });
    }

    maybeRenew(c, platform.consoleSessionService, claims);
    c.set("session", claims);
    await next();
  };
}

/**
 * Guard for the Platform Super Admin realm. In addition to realm binding it
 * requires a matching control-store user flagged `isPlatformSuperAdmin`.
 */
export function requireSuperAdminSession(
  platform: VellumPlatformContext,
  allowedRoles?: readonly Role[],
  excludePaths?: readonly string[]
): MiddlewareHandler {
  return async (c, next) => {
    if (excludePaths?.includes(c.req.path)) return next();

    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) throw new VellumError("UNAUTHENTICATED", "Missing session Bearer token");

    const claims = await verifyOrThrow(platform.superAdminSessionService, token);
    if (claims.realm !== "super_admin") {
      throw new VellumError("UNAUTHENTICATED", "Invalid session realm");
    }

    const user = platform.controlStore.users.get(claims.uid);
    if (!user || user.isPlatformSuperAdmin !== true) {
      throw new VellumError("PERMISSION_DENIED", "Platform Super Admin privileges required");
    }

    if (allowedRoles && !allowedRoles.includes(claims.role)) {
      throw new VellumError("PERMISSION_DENIED", "Your session role is not permitted for this operation", {
        role: claims.role,
      });
    }

    maybeRenew(c, platform.superAdminSessionService, claims);
    c.set("session", claims);
    await next();
  };
}
