import { encodeResourcePath } from "./safe-json.js";

/** A project-relative reference value stored in document data. */
export interface DocumentReferenceValue {
  readonly $t: "ref";
  readonly $v: string;
}

/**
 * Create a tagged reference for normal create/set/update data.
 * This validates the path, not target existence or read permission.
 * References always resolve inside the current client's project.
 */
export function reference(documentPath: string): DocumentReferenceValue {
  if (typeof documentPath !== "string" || documentPath.trim() !== documentPath || documentPath.length > 2048) {
    throw new Error("@vellumdb/sdk-js: invalid reference path (maximum 2048 characters)");
  }
  // Reuse the SDK's URL/traversal safety checks without encoding stored data.
  encodeResourcePath(documentPath, "reference path");
  const segments = documentPath.split("/");
  if (segments.length < 2 || segments.length > 10 || segments.length % 2 !== 0) {
    throw new Error("@vellumdb/sdk-js: a reference requires 2 to 10 document path segments, in pairs");
  }
  for (const segment of segments) {
    if (/%2e%2e|%3f|%23/i.test(segment) || /^__.*__$/.test(segment) || new TextEncoder().encode(segment).byteLength > 1500) {
      throw new Error("@vellumdb/sdk-js: invalid reference path segment (reserved or longer than 1500 bytes)");
    }
  }
  return Object.freeze({ $t: "ref", $v: documentPath });
}
