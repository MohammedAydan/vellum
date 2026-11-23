/**
 * @vellum/document-engine - Tiny non-blocking circuit breaker for optional sinks.
 *
 * Realtime / metering / audit are best-effort. A failing sink must never stall
 * or fail an already-committed request, so every call is fire-and-forget:
 *
 *   - opens after 5 consecutive failures,
 *   - stays open for 30s, then allows ONE half-open probe,
 *   - a successful probe closes the breaker; a failed probe reopens it,
 *   - stale async settlements from prior generations cannot corrupt half-open
 *     or closed state,
 *   - a hung half-open probe expires automatically after `probeTimeoutMs`
 *     (timer-free, checked on subsequent calls) so the breaker can never wedge.
 *
 * No timers, no background handles, no external dependencies. State is
 * per-breaker and entirely in-process (this is a resilience helper, not state).
 */

/** Best-effort sink signature: may be synchronous or return a promise. */
export type GuardedSink<TArgs extends unknown[]> = (...args: TArgs) => Promise<void> | void;

export interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. Default 5. */
  failureThreshold?: number | undefined;
  /** Milliseconds to stay open before one half-open probe. Default 30_000. */
  cooldownMs?: number | undefined;
  /**
   * Maximum milliseconds a half-open probe may stay in flight before being
   * treated as timed out so a never-settling promise cannot wedge the breaker.
   * Defaults to `Math.max(cooldownMs, 5_000)`.
   */
  probeTimeoutMs?: number | undefined;
}

export interface CircuitBreaker<TArgs extends unknown[]> {
  /** Fire-and-forget invocation. Drops the call silently when open. */
  call(...args: TArgs): void;
  /** True when open and not yet eligible for a half-open probe. */
  readonly isOpen: boolean;
}

function normalizePositiveInt(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored < min ? min : floored;
}

/** Wraps a best-effort sink in a non-blocking circuit breaker. */
export function createCircuitBreaker<TArgs extends unknown[]>(
  sink: GuardedSink<TArgs>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<TArgs> {
  const threshold = normalizePositiveInt(options.failureThreshold, 5, 1);
  const cooldown = normalizePositiveInt(options.cooldownMs, 30_000, 0);
  const probeTimeout = normalizePositiveInt(
    options.probeTimeoutMs,
    Math.max(cooldown, 5_000),
    1
  );

  let consecutiveFailures = 0;
  let openedAtMs = 0;
  let halfOpenInFlight = false;
  let halfOpenStartedAtMs = 0;
  /** Monotonic state epoch: stale async settlements from older epochs are ignored. */
  let generation = 0;

  const isProbeTimedOut = (now: number): boolean =>
    halfOpenInFlight && now - halfOpenStartedAtMs >= probeTimeout;

  const onSuccess = (callGeneration: number, isProbe: boolean): void => {
    if (callGeneration !== generation) {
      return;
    }
    consecutiveFailures = 0;
    openedAtMs = 0;
    halfOpenInFlight = false;
    halfOpenStartedAtMs = 0;
    if (isProbe) {
      generation += 1;
    }
  };

  const onFailure = (callGeneration: number, isProbe: boolean): void => {
    if (callGeneration !== generation) {
      return;
    }
    if (isProbe) {
      consecutiveFailures = threshold;
      openedAtMs = Date.now();
      halfOpenInFlight = false;
      halfOpenStartedAtMs = 0;
      generation += 1;
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= threshold) {
      openedAtMs = Date.now();
      halfOpenInFlight = false;
      halfOpenStartedAtMs = 0;
      generation += 1;
    }
  };

  return {
    get isOpen(): boolean {
      if (openedAtMs === 0) return false;
      const now = Date.now();
      if (now - openedAtMs < cooldown) return true;
      if (halfOpenInFlight && !isProbeTimedOut(now)) return true;
      return false;
    },

    call(...args: TArgs): void {
      let isProbe = false;
      if (openedAtMs !== 0) {
        const now = Date.now();
        if (now - openedAtMs < cooldown) return;
        if (halfOpenInFlight) {
          if (!isProbeTimedOut(now)) return;
          // Previous probe hung past probeTimeout: advance generation so its
          // eventual late settlement is ignored, and allow a fresh probe.
          generation += 1;
        }
        halfOpenInFlight = true;
        halfOpenStartedAtMs = now;
        isProbe = true;
      }

      const callGeneration = generation;
      try {
        const result = sink(...args);
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).then(
            () => onSuccess(callGeneration, isProbe),
            () => onFailure(callGeneration, isProbe)
          );
        } else {
          onSuccess(callGeneration, isProbe);
        }
      } catch {
        onFailure(callGeneration, isProbe);
      }
    },
  };
}
