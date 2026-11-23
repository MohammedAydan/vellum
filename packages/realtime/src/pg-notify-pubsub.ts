/**
 * @vellum/realtime - PostgreSQL LISTEN/NOTIFY Pub/Sub (broker-free)
 *
 * The LISTEN side owns a single, dedicated `pg.Client` (with TCP keepAlive)
 * that is never returned to a request pool. Publishing uses a lazy, tiny
 * dedicated `pg.Pool` so publish latency stays low without blocking the
 * listener or incurring a TCP/TLS handshake per notification. Notifications
 * are wake-ups only: durable outbox rows remain the source of truth.
 */

import pg from "pg";

/** Canonical channel the outbox INSERT trigger notifies on. */
export const PG_OUTBOX_CHANNEL = "vellum_outbox";

/** PostgreSQL caps NOTIFY payloads at 8000 bytes (including the NUL terminator). */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_999;
/** PostgreSQL identifiers are truncated to 63 bytes; reject longer channels. */
export const MAX_NOTIFY_CHANNEL_BYTES = 63;

const CREDENTIAL_URI_RE = /(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;
const SENSITIVE_QUERY_RE = /([?&](?:password|pass|pwd|secret|token|api_key)=)([^&\s]+)/gi;

export interface PgNotifyBus {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => void>;
  close(): Promise<void>;
}

export interface PgNotifyBusOptions {
  connectionString: string;
  /** Channels to LISTEN as soon as the dedicated client connects. */
  channels?: string[] | undefined;
  /** Reconnect backoff tuning (defaults: 250ms base, 10s ceiling). */
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
  /** Optional error sink. Never receives connection strings or secrets. */
  onError?: ((error: Error) => void) | undefined;
}

function redactErrorMessage(message: string): string {
  return message
    .replace(CREDENTIAL_URI_RE, "$1[REDACTED]$3")
    .replace(SENSITIVE_QUERY_RE, "$1[REDACTED]");
}

function sanitizeError(value: unknown): Error {
  if (value instanceof Error) {
    const cleanMsg = redactErrorMessage(value.message);
    if (cleanMsg === value.message) return value;
    const sanitized = new Error(cleanMsg);
    sanitized.name = value.name;
    return sanitized;
  }
  return new Error(redactErrorMessage(String(value)));
}

function assertValidConnectionString(connectionString: string): void {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("createPgNotifyBus requires a connectionString");
  }
  if (connectionString.includes("\u0000")) {
    throw new Error("connectionString must not contain NUL bytes");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("connectionString must be a valid PostgreSQL URI");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("connectionString must use postgres:// or postgresql:// protocol");
  }
}

export function assertValidNotifyChannel(channel: string): void {
  if (typeof channel !== "string" || channel.length === 0) {
    throw new Error("NOTIFY channel must be a non-empty string");
  }
  if (channel.includes("\u0000")) {
    throw new Error("NOTIFY channel must not contain NUL bytes");
  }
  if (Buffer.byteLength(channel, "utf8") > MAX_NOTIFY_CHANNEL_BYTES) {
    throw new Error(`NOTIFY channel exceeds ${MAX_NOTIFY_CHANNEL_BYTES} bytes`);
  }
}

export function assertValidNotifyPayload(payload: string): void {
  if (typeof payload !== "string") {
    throw new Error("NOTIFY payload must be a string");
  }
  if (payload.includes("\u0000")) {
    throw new Error("NOTIFY payload must not contain NUL bytes");
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new Error(`NOTIFY payload exceeds ${MAX_NOTIFY_PAYLOAD_BYTES} bytes`);
  }
}

/** Safely quote a channel name for use as a SQL identifier in LISTEN/UNLISTEN. */
export function quoteNotifyChannel(channel: string): string {
  assertValidNotifyChannel(channel);
  return `"${channel.replace(/"/g, '""')}"`;
}

class PgNotifyClient implements PgNotifyBus {
  private readonly connectionString: string;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private readonly listenedChannels = new Set<string>();

  private listenClient: pg.Client | null = null;
  private publishPool: pg.Pool | null = null;
  private connecting: Promise<void> | null = null;
  private closingPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;

  constructor(options: PgNotifyBusOptions) {
    this.connectionString = options.connectionString;
    const base = Number.isFinite(options.retryBaseMs) ? options.retryBaseMs! : 250;
    const max = Number.isFinite(options.retryMaxMs) ? options.retryMaxMs! : 10_000;
    this.retryBaseMs = Math.max(1, Math.trunc(base));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.trunc(max));
    this.onError = options.onError;
    for (const channel of options.channels ?? []) {
      assertValidNotifyChannel(channel);
      if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    }
  }

  private getPublishPool(): pg.Pool {
    if (!this.publishPool) {
      const pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 2,
        idleTimeoutMillis: 15_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on("error", (err: Error) => this.reportError(err));
      this.publishPool = pool;
    }
    return this.publishPool;
  }

  public async publish(channel: string, payload: string): Promise<void> {
    assertValidNotifyChannel(channel);
    assertValidNotifyPayload(payload);
    if (this.closed) throw new Error("PgNotifyBus is closed");

    const pool = this.getPublishPool();
    await pool.query("SELECT pg_notify($1, $2)", [channel, payload]);
  }

  public async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    assertValidNotifyChannel(channel);
    if (typeof handler !== "function") throw new Error("NOTIFY handler must be a function");
    if (this.closed) throw new Error("PgNotifyBus is closed");

    let bucket = this.handlers.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(channel, bucket);
    }
    bucket.add(handler);

    // Always ensure the dedicated listener exists — pre-registered channels
    // from `opts.channels` already have a bucket but have never connected.
    await this.ensureConnected();

    if (!this.closed && !this.listenedChannels.has(channel)) {
      const client = this.listenClient;
      if (client) {
        try {
          await client.query(`LISTEN ${quoteNotifyChannel(channel)}`);
          if (client === this.listenClient) {
            this.listenedChannels.add(channel);
          }
        } catch (err) {
          // A reconnect re-issues LISTEN for every registered channel from the registry.
          this.reportError(err);
        }
      }
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(channel);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.handlers.delete(channel);
        this.listenedChannels.delete(channel);
        const client = this.listenClient;
        if (client && !this.closed) {
          void client
            .query(`UNLISTEN ${quoteNotifyChannel(channel)}`)
            .catch((err: unknown) => this.reportError(err));
        }
      }
    };
  }

  public async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    if (this.closed) return;
    this.closed = true;

    this.closingPromise = (async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.handlers.clear();
      this.listenedChannels.clear();

      const client = this.listenClient;
      this.listenClient = null;
      this.connecting = null;

      const pool = this.publishPool;
      this.publishPool = null;

      if (client) {
        try {
          await client.query("UNLISTEN *");
        } catch {
          // Connection may already be gone.
        }
        try {
          await client.end();
        } catch {
          // Connection may already be gone.
        }
      }

      if (pool) {
        try {
          await pool.end();
        } catch {
          // Pool may already be ended.
        }
      }
    })();

    return this.closingPromise;
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("PgNotifyBus is closed"));
    if (this.connecting) return this.connecting;
    if (this.listenClient) return Promise.resolve();

    const client = new pg.Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    this.listenClient = client;
    this.listenedChannels.clear();

    client.on("notification", (msg: pg.Notification) => {
      if (this.closed) return;
      const bucket = this.handlers.get(msg.channel);
      if (!bucket || bucket.size === 0) return;
      const payload = msg.payload ?? "";
      for (const handler of [...bucket]) {
        try {
          handler(payload);
        } catch (err) {
          this.reportError(err);
        }
      }
    });

    let disconnectHandled = false;
    const onDisconnect = (cause: Error | undefined): void => {
      if (this.closed || disconnectHandled || client !== this.listenClient) return;
      disconnectHandled = true;
      this.reportError(cause ?? new Error("PgNotifyBus LISTEN connection ended"));
      this.listenClient = null;
      this.connecting = null;
      this.listenedChannels.clear();
      this.scheduleReconnect();
    };
    client.on("error", (err: Error) => onDisconnect(err));
    client.on("end", () => onDisconnect(undefined));

    const pending = (async () => {
      try {
        await client.connect();
        if (this.closed || client !== this.listenClient) {
          try {
            await client.end();
          } catch {
            /* ignore */
          }
          return;
        }
        for (const channel of [...this.handlers.keys()]) {
          if (this.closed || client !== this.listenClient) return;
          await client.query(`LISTEN ${quoteNotifyChannel(channel)}`);
          this.listenedChannels.add(channel);
        }
        this.attempt = 0;
      } catch (err) {
        if (client === this.listenClient) {
          this.listenClient = null;
          this.listenedChannels.clear();
          if (!this.closed) {
            this.scheduleReconnect();
          }
        }
        try {
          await client.end();
        } catch {
          /* ignore */
        }
        throw sanitizeError(err);
      }
    })();

    this.connecting = pending;
    const clear = (): void => {
      if (this.connecting === pending) this.connecting = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const expDelay = Math.min(this.retryBaseMs * 2 ** Math.min(this.attempt, 20), this.retryMaxMs);
    // Decorrelated jitter (50%-100%) prevents thundering-herd reconnect storms.
    const jitteredDelay = Math.max(1, Math.floor(expDelay * (0.5 + Math.random() * 0.5)));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.ensureConnected().catch((err: unknown) => this.reportError(err));
    }, jitteredDelay);
    // Never keep a process alive solely for a retry attempt.
    this.reconnectTimer.unref();
  }

  private reportError(value: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(sanitizeError(value));
    } catch {
      // Never allow an error sink callback to crash the event loop.
    }
  }
}

/**
 * Create a PostgreSQL NOTIFY bus with one dedicated LISTEN client and a
 * lazy pooled publish channel. Connection is established lazily on subscribe/publish.
 */
export function createPgNotifyBus(options: PgNotifyBusOptions): PgNotifyBus {
  if (!options) {
    throw new Error("createPgNotifyBus requires options");
  }
  assertValidConnectionString(options.connectionString);
  return new PgNotifyClient(options);
}
