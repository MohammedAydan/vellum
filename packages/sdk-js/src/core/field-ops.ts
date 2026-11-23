/**
 * @vellum/sdk-js - Declarative Atomic Field Operations
 * Specification Section 12.1
 *
 * Both the `fieldOp` helper namespace and every returned sentinel object are
 * deeply frozen (`Object.freeze`) so callers cannot tamper with wire sentinels.
 */

import type { FieldTransformSentinel } from "../types.js";
import { sanitizeAndClone } from "./safe-json.js";

const SERVER_TIMESTAMP_SENTINEL: FieldTransformSentinel = Object.freeze({
  $op: "serverTimestamp",
});

const DELETE_FIELD_SENTINEL: FieldTransformSentinel = Object.freeze({
  $op: "deleteField",
});

function normalizeElements(elements: unknown[]): readonly unknown[] {
  const raw = elements.length === 1 && Array.isArray(elements[0]) ? elements[0] : elements;
  return Object.freeze(raw.map((item) => sanitizeAndClone(item)));
}

export const fieldOp = Object.freeze({
  serverTimestamp: (): FieldTransformSentinel => SERVER_TIMESTAMP_SENTINEL,
  increment: (by = 1): FieldTransformSentinel => Object.freeze({ $op: "inc", by }),
  arrayUnion: (...elements: unknown[]): FieldTransformSentinel =>
    Object.freeze({
      $op: "arrayUnion",
      elements: normalizeElements(elements),
    }),
  arrayRemove: (...elements: unknown[]): FieldTransformSentinel =>
    Object.freeze({
      $op: "arrayRemove",
      elements: normalizeElements(elements),
    }),
  deleteField: (): FieldTransformSentinel => DELETE_FIELD_SENTINEL,
});
