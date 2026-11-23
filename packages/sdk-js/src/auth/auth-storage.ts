/**
 * @vellum/sdk-js - Pluggable end-user auth session storage.
 *
 * Session material (access + refresh tokens) is sensitive. Stores are allowed
 * to persist it when the host platform offers a suitable secured location, but
 * no store ever logs, serializes to telemetry, or exposes tokens to anything
 * other than the SDK's own auth state machine.
 */

import { safeJsonParse, sanitizeAndClone } from "../core/safe-json.js";
import type { AuthState } from "../types.js";
import { isRecord, parseAuthUser, requiredString } from "./jwt-utils.js";

/** Minimal synchronous key/value surface shared by `localStorage` and test doubles. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Contract for persisting the signed-in session across client instances. */
export interface AuthStorage {
  /** Return a validated session, or `null` when nothing usable is stored. */
  load(): AuthState | null;
  /** Persist a freshly issued or refreshed session. */
  save(session: AuthState): void;
  /** Remove all persisted session material (called on sign-out). */
  clear(): void;
}

export const DEFAULT_AUTH_STORAGE_KEY = "vellum.auth.session.v1";

/**
 * Persisted sessions are the flattened `AuthState` shape (public user fields at
 * the top level), not the `{ user, ... }` network response shape. Validate them
 * with the same field parsers used at the network boundary before trusting them.
 */
function parseStoredSession(value: unknown): AuthState {
  if (!isRecord(value)) throw new Error("@vellum/sdk-js: invalid stored session");
  const user = parseAuthUser(value);
  return {
    ...user,
    accessToken: requiredString(value["accessToken"], "accessToken"),
    refreshToken: requiredString(value["refreshToken"], "refreshToken"),
    tokenType: typeof value["tokenType"] === "string" ? value["tokenType"] : "Bearer",
    sessionId: typeof value["sessionId"] === "string" ? value["sessionId"] : "",
    expiresAt: typeof value["expiresAt"] === "string" ? value["expiresAt"] : "",
  };
}

function isStorageLike(value: unknown): value is StorageLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as StorageLike;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function"
  );
}

/**
 * Resolve the browser's `window.localStorage` without throwing in restricted
 * browser contexts (privacy modes, sandboxed iframes, SSR).
 */
export function resolveBrowserLocalStorage(): StorageLike | null {
  try {
    const scope = globalThis as { window?: { localStorage?: unknown } };
    const candidate: unknown = scope.window?.localStorage;
    return isStorageLike(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Process-local default. Used in Node and whenever browser storage is absent. */
export class MemoryAuthStorage implements AuthStorage {
  private readonly box: { session: AuthState | null } = { session: null };

  public constructor() {
    Object.freeze(this);
  }

  public load(): AuthState | null {
    return this.box.session ? sanitizeAndClone(this.box.session) : null;
  }

  public save(session: AuthState): void {
    this.box.session = sanitizeAndClone(session);
  }

  public clear(): void {
    this.box.session = null;
  }

  public toJSON(): { type: "memory"; hasSession: boolean } {
    return { type: "memory", hasSession: this.box.session !== null };
  }

  public toString(): string {
    return `MemoryAuthStorage(hasSession=${String(this.box.session !== null)})`;
  }
}

/** Browser `localStorage` store with an in-memory fallback for restricted contexts. */
export class BrowserLocalStorage implements AuthStorage {
  private readonly fallback = new MemoryAuthStorage();

  public constructor(
    private readonly key: string = DEFAULT_AUTH_STORAGE_KEY,
    private readonly storage: StorageLike | null = resolveBrowserLocalStorage()
  ) {
    Object.freeze(this);
  }

  public load(): AuthState | null {
    const storage = this.storage;
    if (!storage) return this.fallback.load();
    try {
      const raw = storage.getItem(this.key);
      if (raw === null || raw.length === 0) return null;
      // Never trust persisted data: re-validate through the same field
      // parsers used at the network boundary before it becomes the session.
      return parseStoredSession(safeJsonParse<unknown>(raw));
    } catch {
      try {
        storage.removeItem(this.key);
      } catch {
        // Best effort: a corrupt entry is simply ignored.
      }
      return null;
    }
  }

  public save(session: AuthState): void {
    const safeSession = sanitizeAndClone(session);
    const storage = this.storage;
    if (!storage) {
      this.fallback.save(safeSession);
      return;
    }
    try {
      storage.setItem(this.key, JSON.stringify(safeSession));
    } catch {
      // Quota / privacy-mode failures must not break sign-in; keep the session
      // for the lifetime of this client instance instead.
      this.fallback.save(safeSession);
    }
  }

  public clear(): void {
    this.fallback.clear();
    const storage = this.storage;
    if (!storage) return;
    try {
      storage.removeItem(this.key);
    } catch {
      // Best effort: local state is cleared regardless.
    }
  }

  public toJSON(): { type: "browser_local_storage"; key: string } {
    return { type: "browser_local_storage", key: this.key };
  }

  public toString(): string {
    return `BrowserLocalStorage(key=${this.key})`;
  }
}

/** Alias of `BrowserLocalStorage` matching the modular auth storage naming convention. */
export const BrowserLocalAuthStorage = BrowserLocalStorage;
export type BrowserLocalAuthStorage = BrowserLocalStorage;

/** Choose an explicit store, browser storage when available, or memory. */
export function resolveAuthStorage(explicit: AuthStorage | null | undefined): AuthStorage {
  if (explicit) return explicit;
  return resolveBrowserLocalStorage() === null ? new MemoryAuthStorage() : new BrowserLocalStorage();
}
