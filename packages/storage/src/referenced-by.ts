import type { DocumentRecord } from "./types.js";

export interface ReferencedByPageRequest {
  targetPath: string;
  collection?: string | undefined;
  field?: string | undefined;
  afterPath?: string | null | undefined;
  limit: number;
}

/** Build a parameterized JSONPath, quoting every field segment and value. */
export function referenceMatchJsonPath(targetPath: string, field?: string): string {
  const base = field ? "$" + field.split(".").map((part) => `.${JSON.stringify(part)}`).join("") : "$";
  return `strict ${base}.** ? (@ == ${JSON.stringify(targetPath)})`;
}

/** Same exact-path scalar semantics as PostgreSQL JSONPath, including arrays/tags. */
export function documentReferencesPath(data: Record<string, unknown>, targetPath: string, field?: string): boolean {
  let root: unknown = data;
  if (field) {
    for (const part of field.split(".")) {
      if (!root || typeof root !== "object" || !Object.prototype.hasOwnProperty.call(root, part)) return false;
      root = (root as Record<string, unknown>)[part];
    }
  }
  const pending: unknown[] = [root];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value === targetPath) return true;
    if (value && typeof value === "object" && !visited.has(value)) {
      visited.add(value);
      pending.push(...Object.values(value));
    }
  }
  return false;
}

export function compareReferencePaths(a: DocumentRecord, b: DocumentRecord): number {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}
