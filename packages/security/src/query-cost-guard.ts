/**
 * @vellum/security - Query cost / complexity guard.
 *
 * Enforces hard ceilings on the shapes that can turn a query into a
 * database-bound denial of service. Accepts a normalized (unknown) query
 * object and handles malformed or hostile shapes without ever throwing.
 */

import type { GuardOutcome } from "./payload-guard.js";

export const QUERY_COST_LIMITS: Readonly<{
  MAX_WHERE_CLAUSES: 15;
  MAX_OR_BRANCHES: 10;
  MAX_IN_ARRAY_SIZE: 50;
  MAX_INCLUDE_DEPTH: 3;
  MAX_INCLUDE_TOTAL_DOCS: 100;
  MAX_QUERY_LIMIT: 500;
  MAX_TEXT_SEARCH_LENGTH: 200;
  MAX_LIKE_WILDCARDS: 5;
}> = Object.freeze({
  MAX_WHERE_CLAUSES: 15,
  MAX_OR_BRANCHES: 10,
  MAX_IN_ARRAY_SIZE: 50,
  MAX_INCLUDE_DEPTH: 3,
  MAX_INCLUDE_TOTAL_DOCS: 100,
  MAX_QUERY_LIMIT: 500,
  MAX_TEXT_SEARCH_LENGTH: 200,
  MAX_LIKE_WILDCARDS: 5,
});

const OK: GuardOutcome = { ok: true };
const MAX_INSPECT_DEPTH = 32;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function breach(message: string): GuardOutcome {
  return { ok: false, code: "QUERY_TOO_COMPLEX", message };
}

/**
 * Validate the estimated cost of a normalized query object.
 *
 * Returns `QUERY_TOO_COMPLEX` on the first breached ceiling; unknown or
 * non-object inputs are ignored (validation of shape belongs elsewhere).
 */
export function assertQueryCost(query: unknown): GuardOutcome {
  let whereClauses = 0;
  let likeWildcards = 0;
  const visited = new WeakSet<object>();
  const includeVisited = new WeakSet<object>();

  const checkInclude = (node: unknown, nesting: number): GuardOutcome => {
    if (nesting > QUERY_COST_LIMITS.MAX_INCLUDE_DEPTH + 1) {
      return breach(`include nesting exceeds ${QUERY_COST_LIMITS.MAX_INCLUDE_DEPTH}`);
    }
    if (node === null || typeof node !== "object") {
      return OK;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const outcome = checkInclude(item, nesting);
        if (!outcome.ok) {
          return outcome;
        }
      }
      return OK;
    }
    if (includeVisited.has(node)) {
      return OK;
    }
    includeVisited.add(node);

    const spec = node as Record<string, unknown>;
    const depth = spec["depth"];
    if (typeof depth === "number" && (!Number.isFinite(depth) || depth < 0 || depth > QUERY_COST_LIMITS.MAX_INCLUDE_DEPTH)) {
      return breach(`include.depth exceeds ${QUERY_COST_LIMITS.MAX_INCLUDE_DEPTH}`);
    }
    const totalDocs = spec["totalDocs"];
    if (
      typeof totalDocs === "number" &&
      (!Number.isFinite(totalDocs) || totalDocs < 0 || totalDocs > QUERY_COST_LIMITS.MAX_INCLUDE_TOTAL_DOCS)
    ) {
      return breach(`include.totalDocs exceeds ${QUERY_COST_LIMITS.MAX_INCLUDE_TOTAL_DOCS}`);
    }
    const nested = spec["include"];
    if (nested !== undefined) {
      return checkInclude(nested, nesting + 1);
    }
    return OK;
  };

  const inspect = (node: unknown, depth: number): GuardOutcome => {
    if (depth > MAX_INSPECT_DEPTH) {
      return breach(`query nesting exceeds ${MAX_INSPECT_DEPTH}`);
    }
    if (node === null || typeof node !== "object") {
      return OK;
    }
    if (visited.has(node)) {
      return OK;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const outcome = inspect(item, depth + 1);
        if (!outcome.ok) {
          return outcome;
        }
      }
      return OK;
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return {
          ok: false,
          code: "INVALID_ARGUMENT",
          message: `Forbidden key '${key}' in query`,
          threatCategory: "prototype_pollution",
        };
      }
    }

    const obj = node as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
      if (key === "where" && Array.isArray(value)) {
        whereClauses += value.length;
        if (whereClauses > QUERY_COST_LIMITS.MAX_WHERE_CLAUSES) {
          return breach(`where clauses exceed ${QUERY_COST_LIMITS.MAX_WHERE_CLAUSES}`);
        }
      }
      if (key === "or" && Array.isArray(value) && value.length > QUERY_COST_LIMITS.MAX_OR_BRANCHES) {
        return breach(`or branches exceed ${QUERY_COST_LIMITS.MAX_OR_BRANCHES}`);
      }
      if (key === "in" && Array.isArray(value) && value.length > QUERY_COST_LIMITS.MAX_IN_ARRAY_SIZE) {
        return breach(`in array exceeds ${QUERY_COST_LIMITS.MAX_IN_ARRAY_SIZE} values`);
      }
      if (
        key === "values" &&
        obj["op"] === "in" &&
        Array.isArray(value) &&
        value.length > QUERY_COST_LIMITS.MAX_IN_ARRAY_SIZE
      ) {
        return breach(`in values exceed ${QUERY_COST_LIMITS.MAX_IN_ARRAY_SIZE} values`);
      }
      if (key === "include") {
        const outcome = checkInclude(value, 1);
        if (!outcome.ok) {
          return outcome;
        }
      }
      if (key === "limit" && typeof value === "number") {
        if (!Number.isFinite(value) || value > QUERY_COST_LIMITS.MAX_QUERY_LIMIT) {
          // Preserve the canonical public-query error code: the engine already
          // reports LIMIT_EXCEEDED for this same ceiling, so the ingress guard
          // must not mask it as a generic complexity failure.
          return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            message: `limit exceeds ${QUERY_COST_LIMITS.MAX_QUERY_LIMIT}`,
          };
        }
      }
      if (
        (key === "search" || key === "textSearch") &&
        typeof value === "string" &&
        value.length > QUERY_COST_LIMITS.MAX_TEXT_SEARCH_LENGTH
      ) {
        return breach(`text search exceeds ${QUERY_COST_LIMITS.MAX_TEXT_SEARCH_LENGTH} characters`);
      }
      if (key === "like" && typeof value === "string") {
        for (let i = 0; i < value.length; i++) {
          const char = value[i];
          if (char === "%" || char === "_") {
            likeWildcards += 1;
            if (likeWildcards > QUERY_COST_LIMITS.MAX_LIKE_WILDCARDS) {
              return breach(`LIKE wildcards exceed ${QUERY_COST_LIMITS.MAX_LIKE_WILDCARDS}`);
            }
          }
        }
      }

      const outcome = inspect(value, depth + 1);
      if (!outcome.ok) {
        return outcome;
      }
    }

    return OK;
  };

  return inspect(query, 0);
}
