/**
 * @vellumdb/sdk-js - Optional persistent write outbox (offline writes)
 *
 * Opt-in via `offlineWrites` in the client config. When a mutating request
 * fails on a transient fault (network down, timeout, 429/5xx after retries),
 * the operation is persisted locally with a stable Idempotency-Key and
 * replayed IN ORDER once connectivity returns. A cross-tab localStorage lock
 * makes sure only one tab flushes at a time; the Idempotency-Key makes a
 * double flush safe anyway. Operations rejected permanently (4xx) are dropped
 * through the dead-letter callback, never silently.
 *
 * Storage: IndexedDB when available, localStorage otherwise, in-memory as the
 * last resort (edge runtimes; the outbox then lives only as long as the page).
 */

import type { StoredWriteOp } from "../types.js";

export type { StoredWriteOp };

export interface OutboxStore {
  put(op: StoredWriteOp): Promise<void>;
  /** All ops in insertion order (oldest first). */
  all(): Promise<StoredWriteOp[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

export interface PersistentOutboxOptions {
  /** Namespace isolating projects/endpoints sharing one origin. */
  namespace: string;
  storage?: "auto" | "indexeddb" | "localstorage" | "memory";
  /** Hard cap; enqueueing beyond it rejects with OUTBOX_FULL. Defaults to 500. */
  maxOps?: number;
  /** Permanent-failure sink. The op is removed after this callback runs. */
  onDeadLetter?: ((op: StoredWriteOp, error: unknown) => void) | null;
  /** Cross-tab lock lease. Defaults to 15s, renewed while flushing. */
  lockTtlMs?: number;
}

const LOCK_KEY_SUFFIX = ":lock";
const LS_KEY_SUFFIX = ":writes";

function autoId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (typeof status !== "number") return false;
  return status >= 400 && status < 500 && status !== 429;
}

/* ----------------------------------------------------------------------- */
/* Stores                                                                   */
/* ----------------------------------------------------------------------- */

class MemoryOutboxStore implements OutboxStore {
  private readonly ops = new Map<string, StoredWriteOp>();
  public async put(op: StoredWriteOp): Promise<void> {
    this.ops.set(op.id, { ...op });
  }
  public async all(): Promise<StoredWriteOp[]> {
    return [...this.ops.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  public async delete(id: string): Promise<void> {
    this.ops.delete(id);
  }
  public async count(): Promise<number> {
    return this.ops.size;
  }
}

class LocalStorageOutboxStore implements OutboxStore {
  public constructor(private readonly key: string, private readonly ls: Storage) {}
  private read(): StoredWriteOp[] {
    try {
      const raw = this.ls.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredWriteOp[]) : [];
    } catch {
      return [];
    }
  }
  private write(ops: StoredWriteOp[]): void {
    this.ls.setItem(this.key, JSON.stringify(ops));
  }
  public async put(op: StoredWriteOp): Promise<void> {
    const ops = this.read().filter((o) => o.id !== op.id);
    ops.push({ ...op });
    this.write(ops);
  }
  public async all(): Promise<StoredWriteOp[]> {
    return this.read().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  public async delete(id: string): Promise<void> {
    this.write(this.read().filter((o) => o.id !== id));
  }
  public async count(): Promise<number> {
    return this.read().length;
  }
}

class IdbOutboxStore implements OutboxStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  public constructor(private readonly dbName: string) {}
  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("writes")) {
            db.createObjectStore("writes", { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      });
    }
    return this.dbPromise;
  }
  private tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.db().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const t = db.transaction("writes", mode);
          const req = run(t.objectStore("writes"));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
        })
    );
  }
  public async put(op: StoredWriteOp): Promise<void> {
    await this.tx("readwrite", (store) => store.put({ ...op }));
  }
  public async all(): Promise<StoredWriteOp[]> {
    const rows = await this.tx("readonly", (store) => store.getAll() as IDBRequest<StoredWriteOp[]>);
    return rows.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  public async delete(id: string): Promise<void> {
    await this.tx("readwrite", (store) => store.delete(id));
  }
  public async count(): Promise<number> {
    return this.tx("readonly", (store) => store.count());
  }
}

export function createOutboxStore(options: PersistentOutboxOptions): OutboxStore {
  const kind = options.storage ?? "auto";
  const hasIdb = typeof indexedDB !== "undefined";
  const ls = resolveLocalStorage();
  if (kind === "memory") return new MemoryOutboxStore();
  if (kind === "indexeddb" || (kind === "auto" && hasIdb)) {
    if (hasIdb) return new IdbOutboxStore(`vellum-outbox:${options.namespace}`);
    if (kind === "indexeddb") return new MemoryOutboxStore();
  }
  if (kind === "localstorage" || (kind === "auto" && ls)) {
    if (ls) return new LocalStorageOutboxStore(`vellum-outbox:${options.namespace}${LS_KEY_SUFFIX}`, ls);
  }
  return new MemoryOutboxStore();
}

function resolveLocalStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const probe = "__vellum_outbox_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------- */
/* Outbox                                                                   */
/* ----------------------------------------------------------------------- */

export class PersistentWriteOutbox {
  private readonly store: OutboxStore;
  private readonly maxOps: number;
  private readonly onDeadLetter: ((op: StoredWriteOp, error: unknown) => void) | null;
  private readonly lockTtlMs: number;
  private readonly lockKey: string | null;
  private readonly tabId = autoId();
  private flushing = false;

  public constructor(options: PersistentOutboxOptions) {
    this.store = createOutboxStore(options);
    this.maxOps = options.maxOps ?? 500;
    this.onDeadLetter = options.onDeadLetter ?? null;
    this.lockTtlMs = options.lockTtlMs ?? 15_000;
    const ls = resolveLocalStorage();
    this.lockKey = ls ? `vellum-outbox:${options.namespace}${LOCK_KEY_SUFFIX}` : null;
  }

  /** Exposed for tests and introspection. */
  public async size(): Promise<number> {
    return this.store.count();
  }

  public async list(): Promise<StoredWriteOp[]> {
    return this.store.all();
  }

  public async enqueue(input: Omit<StoredWriteOp, "id" | "enqueuedAt" | "attempts"> & { id?: string }): Promise<StoredWriteOp> {
    const count = await this.store.count();
    if (count >= this.maxOps) {
      throw Object.assign(new Error(`@vellumdb/sdk-js: offline write outbox is full (${this.maxOps} ops)`), {
        code: "OUTBOX_FULL",
      });
    }
    const op: StoredWriteOp = {
      ...input,
      id: input.id ?? autoId(),
      enqueuedAt: Date.now(),
      attempts: 0,
    };
    await this.store.put(op);
    return op;
  }

  /**
   * Cross-tab leadership: the lock record carries the owner tab and an expiry.
   * A stale lock (tab closed mid-flush) is taken over. Without localStorage
   * there is nothing to coordinate, so every context leads its own (single)
   * flush.
   */
  public tryAcquireLock(): boolean {
    if (!this.lockKey) return true;
    const ls = resolveLocalStorage();
    if (!ls) return true;
    try {
      const raw = ls.getItem(this.lockKey);
      if (raw) {
        const rec = JSON.parse(raw) as { tabId?: string; expiresAt?: number };
        if (rec.tabId !== this.tabId && typeof rec.expiresAt === "number" && rec.expiresAt > Date.now()) {
          return false;
        }
      }
      ls.setItem(this.lockKey, JSON.stringify({ tabId: this.tabId, expiresAt: Date.now() + this.lockTtlMs }));
      return true;
    } catch {
      return true;
    }
  }

  private renewLock(): void {
    if (!this.lockKey) return;
    const ls = resolveLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(this.lockKey, JSON.stringify({ tabId: this.tabId, expiresAt: Date.now() + this.lockTtlMs }));
    } catch {
      // best effort
    }
  }

  /**
   * Replay queued ops oldest-first through `send`. A transient failure stops
   * the flush (order is preserved); a permanent 4xx goes to the dead-letter
   * callback and is removed so later ops still flush. Returns the number of
   * ops successfully replayed.
   */
  public async flush(send: (op: StoredWriteOp) => Promise<void>): Promise<number> {
    if (this.flushing) return 0;
    if (!this.tryAcquireLock()) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      const ops = await this.store.all();
      for (const op of ops) {
        this.renewLock();
        try {
          await send(op);
          await this.store.delete(op.id);
          sent += 1;
        } catch (error) {
          if (isPermanentFailure(error)) {
            await this.store.delete(op.id);
            try {
              this.onDeadLetter?.(op, error);
            } catch {
              // dead-letter listeners must not break the flush
            }
            continue;
          }
          const next: StoredWriteOp = { ...op, attempts: op.attempts + 1 };
          await this.store.put(next);
          break;
        }
      }
      return sent;
    } finally {
      this.flushing = false;
    }
  }
}
