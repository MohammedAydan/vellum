/**
 * Wildcard collection-path templates for composite indexes (P1-3 / ADR-006).
 *
 * A template has the shape `chats/{*}/messages` (with a literal asterisk
 * segment): every document-id position (odd-indexed segment) may be `*`, which matches exactly
 * one segment of a concrete collection path. Collection positions (even-indexed
 * segments) are always literals. Root collections (`messages`) have no
 * document-id positions, so they are never templates.
 */

import { VellumError } from "./errors.js";
import { parseCollectionPath } from "./paths.js";

const TEMPLATE_WILDCARD = "*";

/** True when the path carries `*` at one or more document-id positions. */
export function isTemplateCollectionPath(collectionPath: string): boolean {
  const segments = collectionPath.split("/");
  for (let i = 1; i < segments.length; i += 2) {
    if (segments[i] === TEMPLATE_WILDCARD) return true;
  }
  return false;
}

/**
 * Derives the template for a concrete collection path by replacing every
 * document-id segment with `*`. Returns the input unchanged for root
 * collections and for paths that already are templates (idempotent).
 */
export function canonicalizeCollectionPathToTemplate(collectionPath: string): string {
  const segments = collectionPath.split("/");
  if (segments.length < 3) return collectionPath;
  let changed = false;
  for (let i = 1; i < segments.length; i += 2) {
    if (segments[i] !== TEMPLATE_WILDCARD) {
      segments[i] = TEMPLATE_WILDCARD;
      changed = true;
    }
  }
  return changed ? segments.join("/") : collectionPath;
}

/**
 * True when `indexPath` (an index record's collectionPath, concrete or
 * template) covers `queryPath` (always concrete). Concrete index records keep
 * exact-match semantics; a template matches segment-wise with `*` matching
 * exactly one segment. Pure and deterministic; no SQL wildcards ever reach
 * the compiler from this check.
 */
export function indexCollectionPathCovers(indexPath: string, queryPath: string): boolean {
  if (indexPath === queryPath) return true;
  if (!isTemplateCollectionPath(indexPath)) return false;
  const indexSegments = indexPath.split("/");
  const querySegments = queryPath.split("/");
  if (indexSegments.length !== querySegments.length) return false;
  for (let i = 0; i < indexSegments.length; i += 1) {
    const indexSegment = indexSegments[i]!;
    if (i % 2 === 1 && indexSegment === TEMPLATE_WILDCARD) continue;
    if (indexSegment !== querySegments[i]) return false;
  }
  return true;
}

/**
 * Validates an index record's collection path: a normal collection path, with
 * `*` additionally allowed only at document-id positions (odd-indexed
 * segments). A `*` anywhere else, or as part of a larger segment, is rejected.
 */
export function parseIndexCollectionPath(rawCollectionPath: string): void {
  parseCollectionPath(rawCollectionPath.split("/").map((segment, i) => (
    i % 2 === 1 && segment === TEMPLATE_WILDCARD ? "wildcard_placeholder" : segment
  )).join("/"));
  const segments = rawCollectionPath.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i]!.includes(TEMPLATE_WILDCARD) && !(i % 2 === 1 && segments[i] === TEMPLATE_WILDCARD)) {
      throw new VellumError(
        "INVALID_DOCUMENT_PATH",
        `Wildcard '*' is only allowed as a whole document-id segment in an index collection path: '${rawCollectionPath}'`,
        { path: rawCollectionPath, segment: segments[i] }
      );
    }
  }
}
