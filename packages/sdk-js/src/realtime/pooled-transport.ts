/**
 * @vellumdb/sdk-js - Pooled realtime transport
 *
 * The server accepts at most 25 subscriptions per WebSocket connection. One client therefore multiplexes
 * up to 25 subscriptions over a single socket and opens an extra pooled socket for each further 25, so
 * 50 or 1,000 subscriptions never fail silently. A hard socket cap turns an unreasonable request into an
 * explicit `SUBSCRIPTION_LIMIT_EXCEEDED` error frame for that subscription.
 */

import {
  RealtimeTransport,
  type RealtimeFrame,
  type RealtimeSubscriptionTarget,
  type RealtimeTransportOptions,
  type RealtimeTransportState,
} from "./realtime-transport.js";

/** Server-side `MAX_WS_SUBSCRIPTIONS_PER_CONN`. */
export const SUBSCRIPTIONS_PER_SOCKET = 25;
/** Default ceiling on pooled sockets per client (40 x 25 = 1,000 subscriptions). */
export const DEFAULT_MAX_POOLED_SOCKETS = 40;

/** The surface the client needs from a realtime transport. */
export interface RealtimeTransportPort {
  readonly state: RealtimeTransportState;
  connect(): Promise<void>;
  subscribe(subId: string, target: RealtimeSubscriptionTarget, resumeSeqId?: number | null): void;
  unsubscribe(subId: string): void;
  reauthenticate(): void;
  send(frame: RealtimeFrame): void;
  close(): void;
}

export interface PooledTransportOptions extends RealtimeTransportOptions {
  /** Subscriptions per socket. Defaults to 25 (the server limit). */
  subscriptionsPerSocket?: number;
  /** Maximum sockets. Defaults to 40. Set to 1 to disable pooling (the 26th subscription then errors explicitly). */
  maxSockets?: number;
}

interface Shard {
  transport: RealtimeTransport;
  subs: Set<string>;
}

export class PooledRealtimeTransport implements RealtimeTransportPort {
  private readonly options: PooledTransportOptions;
  private readonly perSocket: number;
  private readonly maxSockets: number;
  private readonly shards: Shard[] = [];
  private readonly shardOf = new Map<string, Shard>();
  private closed = false;

  public constructor(options: PooledTransportOptions) {
    this.options = options;
    this.perSocket = Math.max(1, options.subscriptionsPerSocket ?? SUBSCRIPTIONS_PER_SOCKET);
    this.maxSockets = Math.max(1, options.maxSockets ?? DEFAULT_MAX_POOLED_SOCKETS);
    this.addShard();
  }

  /** Number of underlying sockets currently allocated. */
  public get socketCount(): number {
    return this.shards.length;
  }

  public get state(): RealtimeTransportState {
    if (this.closed) return "closed";
    return this.shards[0]!.transport.state;
  }

  public toJSON(): { sockets: number; subscriptions: number; state: RealtimeTransportState } {
    return { sockets: this.shards.length, subscriptions: this.shardOf.size, state: this.state };
  }

  private addShard(): Shard {
    const index = this.shards.length;
    const transport = new RealtimeTransport({
      ...this.options,
      // Only the primary socket drives the client's connection state; pooled sockets report faults the same way.
      onStateChange: index === 0 ? (this.options.onStateChange ?? null) : null,
    });
    const shard: Shard = { transport, subs: new Set() };
    this.shards.push(shard);
    return shard;
  }

  public connect(): Promise<void> {
    return this.shards[0]!.transport.connect();
  }

  public subscribe(subId: string, target: RealtimeSubscriptionTarget, resumeSeqId: number | null = null): void {
    if (this.closed) return;
    let shard = this.shardOf.get(subId);
    if (!shard) {
      shard = this.shards.find((s) => s.subs.size < this.perSocket);
      if (!shard && this.shards.length < this.maxSockets) shard = this.addShard();
      if (!shard) {
        this.options.onFrame({
          type: "error",
          subId,
          code: "SUBSCRIPTION_LIMIT_EXCEEDED",
          limit: this.perSocket,
          message: `Maximum of ${this.perSocket * this.maxSockets} active subscriptions per client exceeded (${this.perSocket} per socket, ${this.maxSockets} sockets)`,
        });
        return;
      }
      shard.subs.add(subId);
      this.shardOf.set(subId, shard);
    }
    shard.transport.subscribe(subId, target, resumeSeqId);
  }

  public unsubscribe(subId: string): void {
    const shard = this.shardOf.get(subId);
    if (!shard) return;
    this.shardOf.delete(subId);
    shard.subs.delete(subId);
    shard.transport.unsubscribe(subId);
    // Close empty pooled sockets (never the primary) so idle sockets do not accumulate.
    if (shard !== this.shards[0] && shard.subs.size === 0) {
      shard.transport.close();
      this.shards.splice(this.shards.indexOf(shard), 1);
    }
  }

  public reauthenticate(): void {
    for (const s of this.shards) s.transport.reauthenticate();
  }

  public send(frame: RealtimeFrame): void {
    const subId = typeof frame["subId"] === "string" ? frame["subId"] : null;
    const shard = (subId && this.shardOf.get(subId)) || this.shards[0]!;
    shard.transport.send(frame);
  }

  public close(): void {
    this.closed = true;
    for (const s of this.shards) s.transport.close();
    this.shardOf.clear();
  }
}
