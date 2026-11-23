import { QueryClient } from "@tanstack/react-query";

const NON_RETRYABLE_PATTERNS = [
  "session expired",
  "unauthorized",
  "forbidden",
  "bad request",
  "not found",
  "conflict",
  "unprocessable",
  "privacy invariant",
];

function extractHttpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b([45]\d{2})\b/);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

/**
 * Bounded retry predicate: never retry 4xx client errors (except 408/429),
 * privacy invariant violations, or auth/session failures; cap retries at 2.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  const status = extractHttpStatus(error);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern))) {
      return false;
    }
  }
  return true;
}

/** Bounded exponential backoff between React Query retries (max 10 s). */
export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attemptIndex), 10_000);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30 seconds
      gcTime: 1000 * 60 * 5, // 5 minutes
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      throwOnError: false,
    },
    mutations: {
      retry: false,
      throwOnError: false,
    },
  },
});
