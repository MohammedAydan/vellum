import { applyCacheInvalidation, type CacheInvalidationMessage } from "@vellum/storage";

/** Named-cache eviction alone does not update the engine's synchronous mirror. */
export function createControlInvalidationHandler(
  store: { refresh(): Promise<void> },
  onError: (error: unknown) => void = () => undefined
): (message: CacheInvalidationMessage) => void {
  return (message) => {
    applyCacheInvalidation(message);
    if (message.kind === "relation_rules" || message.kind === "all") {
      void store.refresh().catch(onError);
    }
  };
}
