/**
 * @vellum/realtime - PostgreSQL realtime infrastructure composition root.
 *
 * The API delivery adapter only needs to call `start()` after the data plane
 * and gateway hub are ready, and `stop()` during graceful shutdown. No external
 * broker, cache service, or second database.
 */

import type { StorageAdapter } from "@vellum/storage";
import type { RealtimeGatewayHub } from "./hub.js";
import {
  createPgNotifyBus,
  PG_OUTBOX_CHANNEL,
  type PgNotifyBus,
  type PgNotifyBusOptions,
} from "./pg-notify-pubsub.js";
import { OutboxPoller, type OutboxPollerOptions } from "./outbox-poller.js";

export interface PgRealtimeInfrastructureOptions {
  connectionString: string;
  dataStore: StorageAdapter;
  hub: RealtimeGatewayHub;
  channels?: string[] | undefined;
  pollIntervalMs?: number | undefined;
  batchSize?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface PgRealtimeInfrastructure {
  readonly bus: PgNotifyBus;
  readonly poller: OutboxPoller;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPgRealtimeInfrastructure(
  options: PgRealtimeInfrastructureOptions
): PgRealtimeInfrastructure {
  if (!options || typeof options.connectionString !== "string" || options.connectionString.length === 0) {
    throw new Error("createPgRealtimeInfrastructure requires a connectionString");
  }
  if (!options.dataStore) {
    throw new Error("createPgRealtimeInfrastructure requires a dataStore");
  }
  if (!options.hub) {
    throw new Error("createPgRealtimeInfrastructure requires a hub");
  }

  const busOptions: PgNotifyBusOptions = {
    connectionString: options.connectionString,
    channels: options.channels ?? [PG_OUTBOX_CHANNEL],
  };
  if (options.onError) busOptions.onError = options.onError;

  const bus = createPgNotifyBus(busOptions);
  const pollerOptions: OutboxPollerOptions = {
    bus,
    dataStore: options.dataStore,
    sink: options.hub,
    channel: PG_OUTBOX_CHANNEL,
    batchSize: options.batchSize ?? 500,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
  };
  if (options.onError) pollerOptions.onError = options.onError;
  const poller = new OutboxPoller(pollerOptions);

  let stopPromise: Promise<void> | null = null;

  return {
    bus,
    poller,
    async start(): Promise<void> {
      await poller.start();
    },
    async stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          await poller.stop();
        } finally {
          await bus.close();
        }
      })();
      return stopPromise;
    },
  };
}
