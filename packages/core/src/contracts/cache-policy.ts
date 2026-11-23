/**
 * @vellum/core - Bounded In-Process Cache Policy Contract
 *
 * Preserves the Zero-Redis doctrine: in-process caches are explicitly
 * permitted ONLY when bounded by both `maxEntries` and `ttlMs` and declared
 * through this contract.
 */

export type CacheScope = "process" | "tenant" | "client";

export interface BoundedCachePolicy {
  readonly name: string;
  readonly scope: CacheScope;
  readonly maxEntries: number;
  readonly ttlMs: number;
}

export const CANONICAL_CACHE_POLICIES: Readonly<Record<string, BoundedCachePolicy>> = Object.freeze({
  corePathParse: Object.freeze({
    name: "core.path-parse",
    scope: "process",
    maxEntries: 2_048,
    ttlMs: 300_000,
  }),
  queryIndexHash: Object.freeze({
    name: "query-engine.index-def-hash",
    scope: "process",
    maxEntries: 512,
    ttlMs: 300_000,
  }),
  storageApiKey: Object.freeze({
    name: "storage.api-key",
    scope: "tenant",
    maxEntries: 5_000,
    ttlMs: 30_000,
  }),
  storageRuleset: Object.freeze({
    name: "storage.ruleset",
    scope: "tenant",
    maxEntries: 2_000,
    ttlMs: 60_000,
  }),
  storageProject: Object.freeze({
    name: "storage.project",
    scope: "tenant",
    maxEntries: 2_000,
    ttlMs: 60_000,
  }),
  sdkReadCache: Object.freeze({
    name: "sdk-js.bounded-read-cache",
    scope: "client",
    maxEntries: 1_000,
    ttlMs: 30_000,
  }),
});
