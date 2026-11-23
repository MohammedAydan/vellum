/**
 * @vellum/core - Canonical Recursive JSON Types & Runtime Type Guards
 *
 * Single source of truth for JSON-compatible values across packages.
 */

import { SYSTEM_LIMITS } from "../limits.js";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

const DEFAULT_MAX_JSON_DEPTH = SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkJsonValue(value: unknown, depth: number, maxDepth: number): boolean {
  if (depth > maxDepth) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!checkJsonValue(value[i], depth + 1, maxDepth)) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(value)) {
    for (const val of Object.values(value)) {
      if (!checkJsonValue(val, depth + 1, maxDepth)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Runtime type guard verifying that `value` is a valid recursive `JsonValue`
 * within `maxDepth` nesting levels (defaulting to `SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH`).
 * Rejects non-finite numbers (`NaN`, `Infinity`), `undefined`, functions, symbols,
 * bigints, non-plain objects, and excessively deep or cyclic graphs.
 */
export function isJsonValue(
  value: unknown,
  maxDepth: number = DEFAULT_MAX_JSON_DEPTH
): value is JsonValue {
  return checkJsonValue(value, 0, maxDepth);
}

/**
 * Runtime type guard verifying that `value` is a plain JSON object whose own
 * enumerable values are valid `JsonValue`s within `maxDepth` nesting levels.
 */
export function isJsonObject(
  value: unknown,
  maxDepth: number = DEFAULT_MAX_JSON_DEPTH
): value is JsonObject {
  return isPlainObject(value) && checkJsonValue(value, 0, maxDepth);
}
