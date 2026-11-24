/**
 * Byte-bounded LRU document store used for offline reads and cache policies.
 *
 * - `MemoryDocStore`: works everywhere (Node, edge/serverless, React Native, browsers).
 * - `IndexedDbDocStore`: browsers with IndexedDB. Payloads live on disk; only a
 *   small metadata index (key, size, recency) is kept in memory, so large
 *   caches do not hold documents in RAM. Any IndexedDB failure silently falls
 *   back to the memory store, so reads never break because storage is missing.
 * - `createDefaultDocStore`: picks the best available store with no config.
 */

import { sanitizeAndClone } from "../core/safe-json.js";

export interface StoredDoc {
  readonly path: string;
  readonly value: unknown;
  /** Epoch ms when the entry was written (used for TTL checks). */
  readonly storedAt: number;
}

export interface DocStore {
  get(key: string): Promise<StoredDoc | undefined>;
  set(key: string, entry: StoredDoc): Promise<void>;
  /** Remove every entry for a document path (all select/include variants and users). */
  deletePath(path: string): Promise<void>;
  /** Remove every entry whose path starts with `prefix` (collection invalidation). */
  deletePrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
}

export const DEFAULT_MAX_CACHE_SIZE_BYTES = 100 * 1024 * 1024;

function estimateBytes(key: string, entry: StoredDoc): number {
  let json: string;
  try {
    json = JSON.stringify(entry.value) ?? "";
  } catch {
    json = "";
  }
  // UTF-16 worst case plus fixed overhead.
  return (json.length + key.length + entry.path.length) * 2 + 64;
}

interface MetaEntry {
  path: string;
  size: number;
}

/** LRU bookkeeping shared by both stores (insertion-ordered Map = recency). */
class LruIndex {
  private readonly entries = new Map<string, MetaEntry>();
  private bytes = 0;
  public constructor(private readonly maxBytes: number) {}

  public touch(key: string): void {
    const meta = this.entries.get(key);
    if (meta) {
      this.entries.delete(key);
      this.entries.set(key, meta);
    }
  }
  public has(key: string): boolean {
    return this.entries.has(key);
  }
  /** Adds the entry and returns keys that were evicted to stay under budget. */
  public add(key: string, meta: MetaEntry): string[] {
    this.remove(key);
    this.entries.set(key, meta);
    this.bytes += meta.size;
    const evicted: string[] = [];
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.remove(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }
  public remove(key: string): void {
    const meta = this.entries.get(key);
    if (meta) {
      this.bytes -= meta.size;
      this.entries.delete(key);
    }
  }
  public keysWhere(predicate: (path: string) => boolean): string[] {
    const out: string[] = [];
    for (const [key, meta] of this.entries) if (predicate(meta.path)) out.push(key);
    return out;
  }
  public clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
  public get totalBytes(): number {
    return this.bytes;
  }
  public get size(): number {
    return this.entries.size;
  }
}

export class MemoryDocStore implements DocStore {
  private readonly lru: LruIndex;
  private readonly data = new Map<string, StoredDoc>();

  public constructor(maxCacheSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES) {
    this.lru = new LruIndex(maxCacheSizeBytes);
  }

  public get size(): number {
    return this.lru.size;
  }
  public get sizeBytes(): number {
    return this.lru.totalBytes;
  }

  public async get(key: string): Promise<StoredDoc | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    this.lru.touch(key);
    return { ...entry, value: sanitizeAndClone(entry.value) };
  }

  public async set(key: string, entry: StoredDoc): Promise<void> {
    const stored: StoredDoc = { path: entry.path, storedAt: entry.storedAt, value: sanitizeAndClone(entry.value) };
    this.data.set(key, stored);
    for (const evicted of this.lru.add(key, { path: entry.path, size: estimateBytes(key, stored) })) {
      this.data.delete(evicted);
    }
  }

  public async deletePath(path: string): Promise<void> {
    for (const key of this.lru.keysWhere((p) => p === path)) this.drop(key);
  }

  public async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.lru.keysWhere((p) => p.startsWith(prefix))) this.drop(key);
  }

  public async clear(): Promise<void> {
    this.data.clear();
    this.lru.clear();
  }

  private drop(key: string): void {
    this.data.delete(key);
    this.lru.remove(key);
  }
}

/* ------------------------------------------------------------------------ */
/* IndexedDB                                                                 */
/* ------------------------------------------------------------------------ */

interface IdbRequestLike<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function idb<T>(req: unknown): Promise<T> {
  const r = req as IdbRequestLike<T>;
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const IDB_STORE = "docs";

interface IdbStoreLike {
  get(key: string): unknown;
  put(row: unknown): unknown;
  delete(key: string): unknown;
  clear(): unknown;
}
interface IdbTxLike {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
  objectStore(name: string): IdbStoreLike;
}

export class IndexedDbDocStore implements DocStore {
  private readonly lru: LruIndex;
  private readonly fallback: MemoryDocStore;
  private dbPromise: Promise<unknown> | null = null;
  private broken = false;

  public constructor(
    private readonly dbName: string,
    maxCacheSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
    private readonly factory: unknown = (globalThis as { indexedDB?: unknown }).indexedDB
  ) {
    this.lru = new LruIndex(maxCacheSizeBytes);
    this.fallback = new MemoryDocStore(maxCacheSizeBytes);
  }

  private open(): Promise<unknown> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const factory = this.factory as { open(name: string, version: number): unknown };
        const request = factory.open(this.dbName, 1) as IdbRequestLike<unknown> & {
          onupgradeneeded: (() => void) | null;
        };
        request.onupgradeneeded = () => {
          const db = request.result as { createObjectStore(n: string, o: { keyPath: string }): unknown };
          db.createObjectStore(IDB_STORE, { keyPath: "key" });
        };
        const db = await idb<unknown>(request);
        // Load the metadata index only (cursor over keys + sizes); payloads stay on disk.
        const tx = (db as { transaction(n: string, m: string): { objectStore(n: string): unknown } }).transaction(
          IDB_STORE,
          "readonly"
        );
        const all = await idb<Array<{ key: string; path: string; size: number; at: number }>>(
          (tx.objectStore(IDB_STORE) as { getAll(): unknown }).getAll()
        );
        all.sort((a, b) => a.at - b.at);
        for (const row of all) this.lru.add(row.key, { path: row.path, size: row.size });
        return db;
      })();
    }
    return this.dbPromise;
  }

  private async run<T>(op: (db: unknown) => Promise<T>, fb: () => Promise<T>): Promise<T> {
    if (this.broken) return fb();
    try {
      return await op(await this.open());
    } catch {
      this.broken = true;
      return fb();
    }
  }

  private store(db: unknown, mode: "readonly" | "readwrite"): { s: IdbStoreLike; done: Promise<void> } {
    const tx = (db as { transaction(n: string, m: string): IdbTxLike }).transaction(IDB_STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return { s: tx.objectStore(IDB_STORE), done };
  }

  public get(key: string): Promise<StoredDoc | undefined> {
    return this.run(
      async (db) => {
        if (!this.lru.has(key)) return undefined;
        const { s } = this.store(db, "readonly");
        const row = await idb<{ path: string; value: unknown; storedAt: number } | undefined>(s.get(key));
        if (!row) return undefined;
        this.lru.touch(key);
        return { path: row.path, value: row.value, storedAt: row.storedAt };
      },
      () => this.fallback.get(key)
    );
  }

  public set(key: string, entry: StoredDoc): Promise<void> {
    return this.run(
      async (db) => {
        const value = sanitizeAndClone(entry.value);
        const size = estimateBytes(key, { ...entry, value });
        const evicted = this.lru.add(key, { path: entry.path, size });
        const { s, done } = this.store(db, "readwrite");
        s.put({ key, path: entry.path, value, storedAt: entry.storedAt, size, at: Date.now() });
        for (const k of evicted) s.delete(k);
        await done;
      },
      () => this.fallback.set(key, entry)
    );
  }

  private removeKeys(keys: string[]): Promise<void> {
    return this.run(
      async (db) => {
        if (keys.length === 0) return;
        for (const k of keys) this.lru.remove(k);
        const { s, done } = this.store(db, "readwrite");
        for (const k of keys) s.delete(k);
        await done;
      },
      async () => undefined
    );
  }

  public async deletePath(path: string): Promise<void> {
    await this.fallback.deletePath(path);
    await this.removeKeys(this.lru.keysWhere((p) => p === path));
  }

  public async deletePrefix(prefix: string): Promise<void> {
    await this.fallback.deletePrefix(prefix);
    await this.removeKeys(this.lru.keysWhere((p) => p.startsWith(prefix)));
  }

  public async clear(): Promise<void> {
    await this.fallback.clear();
    await this.run(
      async (db) => {
        this.lru.clear();
        const { s, done } = this.store(db, "readwrite");
        s.clear();
        await done;
      },
      async () => undefined
    );
  }
}

/** IndexedDB when available (browsers, web workers), otherwise an in-memory LRU. */
export function createDefaultDocStore(name: string, maxCacheSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES): DocStore {
  const hasIdb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined";
  return hasIdb ? new IndexedDbDocStore(`vellum-cache:${name}`, maxCacheSizeBytes) : new MemoryDocStore(maxCacheSizeBytes);
}
