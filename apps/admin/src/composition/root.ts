/**
 * @vellum/admin - Single Explicit Composition Root
 *
 * Exposes the typed `AdminApiPort` adapter wired to `src/lib/api.ts`,
 * preserving `assertPrivacySafeEndpoint` and `assertNoCustomerPayload` intact.
 */

import {
  adminFetch,
  assertNoCustomerPayload,
  assertPrivacySafeEndpoint,
  getApiBaseUrl,
  refreshAdminSessionToken,
  resetAdminApiClientState,
  sanitizeErrorMessage,
  type AdminFetchOptions,
} from "../lib/api.js";

export interface AdminApiPort {
  readonly getApiBaseUrl: () => string;
  readonly adminFetch: <T>(endpoint: string, options?: AdminFetchOptions) => Promise<T>;
  readonly assertPrivacySafeEndpoint: (endpoint: string) => void;
  readonly assertNoCustomerPayload: (obj: unknown, depth?: number) => void;
  readonly refreshAdminSessionToken: () => Promise<string | null>;
  readonly resetAdminApiClientState: () => void;
  readonly sanitizeErrorMessage: (message: string) => string;
}

export interface AdminCompositionRoot {
  readonly api: AdminApiPort;
}

export function createAdminApiPort(): AdminApiPort {
  return Object.freeze({
    getApiBaseUrl,
    adminFetch,
    assertPrivacySafeEndpoint,
    assertNoCustomerPayload,
    refreshAdminSessionToken,
    resetAdminApiClientState,
    sanitizeErrorMessage,
  });
}

export function createAdminCompositionRoot(
  overrides?: Partial<AdminApiPort>
): AdminCompositionRoot {
  const api: AdminApiPort = Object.freeze({
    ...createAdminApiPort(),
    ...overrides,
  });
  return Object.freeze({ api });
}

export const adminApiPort: AdminApiPort = createAdminApiPort();

export const adminCompositionRoot: AdminCompositionRoot = Object.freeze({
  api: adminApiPort,
});
