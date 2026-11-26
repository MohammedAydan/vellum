import { applyCacheInvalidation, type CacheInvalidationMessage } from "@vellum/storage";

/** Named-cache eviction alone does not update the engine's synchronous mirror. */
export function createControlInvalidationHandler(
  store: { refresh(): Promise<void>; invalidateReadCache?(): void },
  onError: (error: unknown) => void = () => undefined
): (message: CacheInvalidationMessage) => void {
  return (message) => {
    applyCacheInvalidation(message);
    // Any control-plane change drops the short-TTL read cache at once; the TTL is only the fallback.
    store.invalidateReadCache?.();
    if (message.kind === "relation_rules" || message.kind === "all") {
      void store.refresh().catch(onError);
    }
  };
}
