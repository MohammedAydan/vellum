/**
 * @vellum/dashboard - Single Explicit Composition Root
 *
 * Exposes the typed `DashboardApiPort` adapter wired to `src/lib/api.ts` so
 * UI routes, providers, and tests depend on a single explicit port contract.
 */

import type { VellumClient } from "@vellumdb/sdk-js";
import {
  apiFetch,
  compileProjectRules,
  consoleFetch,
  consoleProjectsBase,
  getApiBaseUrl,
  getVellumClient,
  refreshSessionToken,
  resetApiClientState,
  type ApiFetchOptions,
  type CompileRulesResult,
} from "../lib/api.js";

export interface DashboardApiPort {
  readonly getApiBaseUrl: () => string;
  readonly apiFetch: <T>(endpoint: string, options?: ApiFetchOptions) => Promise<T>;
  readonly consoleFetch: <T>(endpoint: string, options?: ApiFetchOptions) => Promise<T>;
  readonly consoleProjectsBase: (projectId: string) => string;
  readonly compileProjectRules: (
    endpoint: string,
    source: string,
    options?: Omit<ApiFetchOptions, "method" | "body">
  ) => Promise<CompileRulesResult>;
  readonly getVellumClient: (projectId: string, apiKey: string) => VellumClient;
  readonly refreshSessionToken: () => Promise<string | null>;
  readonly resetApiClientState: () => void;
}

export interface DashboardCompositionRoot {
  readonly api: DashboardApiPort;
}

export function createDashboardApiPort(): DashboardApiPort {
  return Object.freeze({
    getApiBaseUrl,
    apiFetch,
    consoleFetch,
    consoleProjectsBase,
    compileProjectRules,
    getVellumClient,
    refreshSessionToken,
    resetApiClientState,
  });
}

export function createDashboardCompositionRoot(
  overrides?: Partial<DashboardApiPort>
): DashboardCompositionRoot {
  const api: DashboardApiPort = Object.freeze({
    ...createDashboardApiPort(),
    ...overrides,
  });
  return Object.freeze({ api });
}

export const dashboardApiPort: DashboardApiPort = createDashboardApiPort();

export const dashboardCompositionRoot: DashboardCompositionRoot = Object.freeze({
  api: dashboardApiPort,
});
