/**
 * @vellum/document-engine - Native PostgreSQL OCC transactions
 *
 * An interactive transaction is a durable row in the Data Plane's `transactions`
 * table — never a process-local Map. The read set is persisted as JSONB and the
 * commit path takes `SELECT ... FOR UPDATE` on the transaction row and on every
 * read-set document in deterministic `path ASC` order before comparing observed
 * versions. PostgreSQL is therefore the single source of truth for both the
 * read set and the locks, so two engine instances sharing a Data Plane also
 * share OCC state. No Redis.
 *
 * The SQL handle capability comes from `@vellum/storage`'s tx-context (which
 * exposes a raw `query` on its transaction handle). The in-memory adapter has
 * no SQL interface; for that *test-only* adapter we use a module-scoped Map so
 * the fast unit suite stays deterministic. Production paths are 100% PG.
 */

import crypto from "node:crypto";
import { VellumError, SYSTEM_LIMITS } from "@vellum/core";
import type { StorageAdapter, TenantContext, TxHandle, SqlTxHandle } from "@vellum/storage";
import type { TransactionBeginResult } from "./types.js";

/** Status of a transaction row. */
export type TransactionStatus = "active" | "committed" | "rolled_back";

export interface TransactionRow {
  id: string;
  tokenHash: string;
  projectId: string;
  readSet: Record<string, number>;
  status: TransactionStatus;
  createdAt: string;
  expiresAt: string;
  /** Durable terminal timestamp, mirrors `transactions.committed_at` (SQL) in the memory adapter. */
  committedAt?: string | undefined;
  /** Durable terminal timestamp, mirrors `transactions.rolled_back_at` (SQL) in the memory adapter. */
  rolledBackAt?: string | undefined;
}

export interface VerifiedTransaction {
  tokenHash: string;
  readSet: Record<string, number>;
  expiresAt: string;
}

interface TxTokenPayload {
  txId: string;
  projectId: string;
  startedAtMs: number;
  expiresAtMs: number;
  /** API key the token was minted for; signed only when present. */
  apiKeyId?: string | undefined;
}

/** Tenant context that may carry the API key id used to bind an OCC token. */
type TokenTenantContext = TenantContext & { apiKeyId?: string | undefined };

/** Caller context accepted by token-verifying manager methods. */
type TokenCallerContext = TokenTenantContext;

export interface TransactionManagerOptions {
  dataStore: StorageAdapter;
  txSecret: string;
  /** Previous signing secret, still accepted until all in-flight tokens have rotated. */
  txSecretPrev?: string | undefined;
}

/** Fallback for the test-only in-memory adapter (which has no SQL interface). */
const memoryTransactions = new Map<string, TransactionRow>();

/** Terminal (`committed`/`rolled_back`) rows are retained for 7 days, matching the SQL cleanup. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard ceiling on raw serialized transaction token length to prevent decode DoS. */
const MAX_TX_TOKEN_LENGTH = 4096;

/** Hard ceiling on distinct paths tracked in a single transaction's read set. */
const MAX_TRANSACTION_READ_SET_SIZE = 1000;

/** Opportunistic eviction threshold for the test-only in-memory transaction map. */
const MAX_MEMORY_TRANSACTIONS = 10_000;

function isSqlHandle(tx: TxHandle): tx is SqlTxHandle {
  return typeof (tx as SqlTxHandle).query === "function";
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time HMAC comparison to prevent signature timing side-channels. */
function safeSignatureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Full-jitter exponential backoff delay (in ms) for retrying transient OCC
 * `ABORTED_CONFLICT` errors without thundering-herd lockstep collisions.
 */
export function computeRetryDelayMs(attempt: number, baseMs = 25, maxMs = 2_000): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), 20) : 0;
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 25;
  const safeMax = Number.isFinite(maxMs) && maxMs >= safeBase ? maxMs : Math.max(safeBase, 2_000);
  const ceiling = Math.min(safeMax, safeBase * 2 ** safeAttempt);
  return Math.floor(Math.random() * (ceiling + 1));
}

/**
 * Canonical JSON covered by the HMAC. `apiKeyId` is included only when present,
 * so tokens minted before key binding remain verifiable (and vice versa).
 */
function signature(payload: TxTokenPayload, secret: string): string {
  const canonical: Record<string, unknown> = {
    txId: payload.txId,
    projectId: payload.projectId,
    startedAtMs: payload.startedAtMs,
    expiresAtMs: payload.expiresAtMs,
  };
  if (payload.apiKeyId !== undefined) {
    canonical["apiKeyId"] = payload.apiKeyId;
  }
  return crypto.createHmac("sha256", secret).update(JSON.stringify(canonical)).digest("hex");
}

function signToken(payload: TxTokenPayload, secret: string): string {
  return Buffer.from(
    JSON.stringify({ ...payload, sig: signature(payload, secret) }),
    "utf8"
  ).toString("base64url");
}

/**
 * Verify the HMAC (primary secret, then the previous secret during rotation),
 * the tenant binding, and the optional API-key binding of an opaque token.
 */
export function decodeAndVerifyTransactionToken(
  token: string,
  secret: string,
  ctx: TokenTenantContext,
  previousSecret?: string | undefined
): TxTokenPayload {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TX_TOKEN_LENGTH) {
    throw new VellumError("INVALID_ARGUMENT", "Malformed transactionToken");
  }
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new VellumError("INVALID_ARGUMENT", "Malformed transactionToken");
  }
  if (rawParsed === null || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
    throw new VellumError("INVALID_ARGUMENT", "Malformed transactionToken payload");
  }
  const parsed = rawParsed as TxTokenPayload & { sig?: string };
  const { txId, projectId, startedAtMs, expiresAtMs, apiKeyId, sig } = parsed;
  if (
    typeof txId !== "string" ||
    txId.length === 0 ||
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs < startedAtMs ||
    typeof sig !== "string" ||
    sig.length === 0 ||
    (apiKeyId !== undefined && typeof apiKeyId !== "string")
  ) {
    throw new VellumError("INVALID_ARGUMENT", "Malformed transactionToken payload");
  }
  const payload: TxTokenPayload = { txId, projectId, startedAtMs, expiresAtMs };
  if (apiKeyId !== undefined) {
    payload.apiKeyId = apiKeyId;
  }

  const signedWithPrimary = safeSignatureEqual(sig, signature(payload, secret));
  const signedWithPrevious =
    !signedWithPrimary &&
    previousSecret !== undefined &&
    safeSignatureEqual(sig, signature(payload, previousSecret));
  if ((!signedWithPrimary && !signedWithPrevious) || projectId !== ctx.projectId) {
    throw new VellumError("INVALID_ARGUMENT", "Invalid transactionToken signature or tenant mismatch");
  }
  if (apiKeyId !== undefined && ctx.apiKeyId !== apiKeyId) {
    // Deliberately secret-free: never echo a key id, token or signature in errors.
    throw new VellumError("PERMISSION_DENIED", "Transaction token is bound to a different API key");
  }
  return payload;
}

/** SHA-256 of a transaction token — safe to use as a unique DB key. */
export function transactionTokenHash(token: string): string {
  return hashToken(token);
}

/** Map a terminal transaction status to its distinct, canonical error code. */
function assertActiveStatus(status: string | undefined): void {
  if (status === undefined) {
    throw new VellumError("NOT_FOUND", "Transaction not found");
  }
  if (status === "committed") {
    throw new VellumError("ALREADY_COMMITTED", "Transaction has already been committed");
  }
  if (status === "rolled_back") {
    throw new VellumError("ALREADY_ROLLED_BACK", "Transaction has already been rolled back");
  }
  if (status !== "active") {
    throw new VellumError(
      "FAILED_PRECONDITION",
      `Transaction is '${status}' (expected 'active') and cannot be used again`
    );
  }
}

/** Assert a row is still usable (active and unexpired) before mutating it. */
function requireActive(row: Pick<TransactionRow, "status" | "expiresAt"> | undefined): void {
  if (!row) {
    throw new VellumError("NOT_FOUND", "Transaction not found");
  }
  assertActiveStatus(row.status);
  if (Date.now() > Date.parse(row.expiresAt)) {
    throw new VellumError(
      "TRANSACTION_TIMEOUT",
      `Interactive transaction exceeded maximum duration of ${SYSTEM_LIMITS.MAX_TRANSACTION_DURATION_MS}ms`
    );
  }
}

/** Opportunistically evicts expired active and aged terminal rows in memory mode. */
function pruneMemoryTransactionsIfNeeded(): void {
  if (memoryTransactions.size < MAX_MEMORY_TRANSACTIONS) {
    return;
  }
  const now = Date.now();
  const terminalCutoff = now - TERMINAL_RETENTION_MS;
  for (const [hash, row] of memoryTransactions.entries()) {
    const expiredActive = row.status === "active" && now > Date.parse(row.expiresAt);
    const oldTerminal =
      (row.status === "committed" || row.status === "rolled_back") &&
      Date.parse(row.createdAt) < terminalCutoff;
    if (expiredActive || oldTerminal) {
      memoryTransactions.delete(hash);
    }
  }
}

/**
 * A conditional `UPDATE ... WHERE status = 'active'` that matched zero rows is
 * ambiguous: distinguish missing / committed / rolled-back rows before falling
 * back to FAILED_PRECONDITION. The lookup stays inside the same caller tx so
 * it observes the winner's committed status under the row lock.
 */
async function assertActiveUpdateApplied(
  tx: SqlTxHandle,
  rowCount: number | null | undefined,
  tokenHash: string,
  projectId: string
): Promise<void> {
  if ((rowCount ?? 0) > 0) {
    return;
  }
  const { rows } = await tx.query<{ status: string }>(
    `SELECT status FROM transactions WHERE token_hash = $1 AND project_id = $2::uuid`,
    [tokenHash, projectId]
  );
  assertActiveStatus(rows[0]?.status);
  throw new VellumError("FAILED_PRECONDITION", "Transaction is no longer active");
}

export interface TransactionManager {
  begin(ctx: TokenTenantContext): Promise<TransactionBeginResult>;
  recordRead(tx: TxHandle, token: string, ctx: TokenCallerContext, path: string, version: number): Promise<void>;
  verifyAndLock(token: string, ctx: TokenCallerContext, tx: TxHandle): Promise<VerifiedTransaction>;
  markCommitted(tx: TxHandle, tokenHash: string, ctx: TenantContext): Promise<void>;
  rollback(token: string, ctx: TokenCallerContext): Promise<void>;
  cleanupExpired(ctx: TenantContext, limit?: number): Promise<number>;
}

export function createTransactionManager(options: TransactionManagerOptions): TransactionManager {
  const { dataStore, txSecret, txSecretPrev } = options;
  const verifyToken = (token: string, ctx: TokenTenantContext): TxTokenPayload =>
    decodeAndVerifyTransactionToken(token, txSecret, ctx, txSecretPrev);

  return {
    async begin(ctx: TokenTenantContext): Promise<TransactionBeginResult> {
      const id = crypto.randomUUID();
      const txId = `tx_${id.replace(/-/g, "")}`;
      const startedAtMs = Date.now();
      const expiresAtMs = startedAtMs + SYSTEM_LIMITS.MAX_TRANSACTION_DURATION_MS;
      const payload: TxTokenPayload = {
        txId,
        projectId: ctx.projectId,
        startedAtMs,
        expiresAtMs,
      };
      if (ctx.apiKeyId !== undefined) {
        payload.apiKeyId = ctx.apiKeyId;
      }
      const transactionToken = signToken(payload, txSecret);
      const tokenHash = hashToken(transactionToken);
      const row: TransactionRow = {
        id,
        tokenHash,
        projectId: ctx.projectId,
        readSet: Object.create(null) as Record<string, number>,
        status: "active",
        createdAt: new Date(startedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };

      await dataStore.withTransaction(ctx, async (tx) => {
        if (isSqlHandle(tx)) {
          await tx.query(
            `INSERT INTO transactions (
               id, token_hash, project_id, read_set, status, created_at, expires_at
             ) VALUES (
               $1::uuid, $2, $3::uuid, '{}'::jsonb, 'active',
               to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000)
             )`,
            [id, tokenHash, ctx.projectId, startedAtMs, expiresAtMs]
          );
        } else {
          pruneMemoryTransactionsIfNeeded();
          memoryTransactions.set(tokenHash, row);
        }
      });

      return {
        transactionId: txId,
        transactionToken,
        expiresAt: row.expiresAt,
      };
    },

    async recordRead(
      tx: TxHandle,
      token: string,
      ctx: TokenCallerContext,
      path: string,
      version: number
    ): Promise<void> {
      verifyToken(token, ctx);
      if (typeof path !== "string" || path.length === 0) {
        throw new VellumError("INVALID_ARGUMENT", "Read path must be a non-empty string");
      }
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new VellumError("INVALID_ARGUMENT", "Document version must be a non-negative integer");
      }
      const tokenHash = hashToken(token);

      if (isSqlHandle(tx)) {
        // Put `read_set` on the RIGHT of `||` so the FIRST observed version for
        // `path` is preserved and a second read after a concurrent write cannot
        // silently mask an OCC conflict.
        const { rowCount } = await tx.query(
          `UPDATE transactions
              SET read_set = jsonb_build_object($3::text, $4::bigint) || read_set
            WHERE token_hash = $1
              AND project_id = $2::uuid
              AND status = 'active'
              AND expires_at > now()
              AND (
                read_set ? $3::text
                OR (SELECT count(*) FROM jsonb_object_keys(read_set)) < $5::int
              )`,
          [tokenHash, ctx.projectId, path, version, MAX_TRANSACTION_READ_SET_SIZE]
        );
        if ((rowCount ?? 0) === 0) {
          const { rows } = await tx.query<{ status: string; expires_at: string; read_count: string }>(
            `SELECT status, expires_at::text,
                    (SELECT count(*)::text FROM jsonb_object_keys(read_set)) AS read_count
               FROM transactions
              WHERE token_hash = $1 AND project_id = $2::uuid`,
            [tokenHash, ctx.projectId]
          );
          const found = rows[0];
          requireActive(found ? { status: found.status as TransactionStatus, expiresAt: found.expires_at } : undefined);
          if (found && Number(found.read_count) >= MAX_TRANSACTION_READ_SET_SIZE) {
            throw new VellumError(
              "FAILED_PRECONDITION",
              `Transaction read set exceeded maximum of ${MAX_TRANSACTION_READ_SET_SIZE} documents`
            );
          }
          throw new VellumError("FAILED_PRECONDITION", "Transaction is no longer active");
        }
      } else {
        const row = memoryTransactions.get(tokenHash);
        const scopedRow = row && row.projectId === ctx.projectId ? row : undefined;
        requireActive(scopedRow);
        if (!Object.prototype.hasOwnProperty.call(scopedRow!.readSet, path)) {
          if (Object.keys(scopedRow!.readSet).length >= MAX_TRANSACTION_READ_SET_SIZE) {
            throw new VellumError(
              "FAILED_PRECONDITION",
              `Transaction read set exceeded maximum of ${MAX_TRANSACTION_READ_SET_SIZE} documents`
            );
          }
          scopedRow!.readSet[path] = version;
        }
      }
    },

    async verifyAndLock(token: string, ctx: TokenCallerContext, tx: TxHandle): Promise<VerifiedTransaction> {
      verifyToken(token, ctx);
      const tokenHash = hashToken(token);

      if (isSqlHandle(tx)) {
        // INVARIANT — NEVER CHANGE THIS LOCK ORDER. The transaction row MUST be
        // locked with FOR UPDATE FIRST (serialising two commits on the same token
        // and a commit racing a rollback), and only THEN the read-set documents
        // in deterministic `path ASC` order. Reversing the order lets two OCC
        // commits acquire the same hot documents in opposite order and deadlock.
        const { rows: txRows } = await tx.query<{
          status: string;
          expires_at: string;
          read_set: Record<string, number>;
        }>(
          `SELECT status, expires_at::text, read_set
             FROM transactions
            WHERE token_hash = $1 AND project_id = $2::uuid
              FOR UPDATE`,
          [tokenHash, ctx.projectId]
        );
        const txRow = txRows[0];
        requireActive(txRow ? { status: txRow.status as TransactionStatus, expiresAt: txRow.expires_at } : undefined);

        const readSet = { ...(txRow!.read_set ?? {}) };

        // 2. Lock every observed document in a deterministic order so two OCC
        //    commits never deadlock on the same hot document set (see invariant above).
        const paths = Object.keys(readSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const actualVersions = new Map<string, number>();
        if (paths.length > 0) {
          const { rows: docRows } = await tx.query<{ path: string; version: string }>(
            `SELECT path, version::text
               FROM documents
              WHERE project_id = $1::uuid
                AND path = ANY($2::text[]) AND deleted_at IS NULL
              ORDER BY path ASC
               FOR UPDATE`,
            [ctx.projectId, paths]
          );
          for (const row of docRows) {
            actualVersions.set(row.path, Number(row.version));
          }
        }

        // 3. Compare every observed version against the locked current version.
        for (const path of paths) {
          const expectedVersion = Number(readSet[path] ?? 0);
          const actualVersion = actualVersions.get(path) ?? 0;
          if (actualVersion !== expectedVersion) {
            throw new VellumError(
              "ABORTED_CONFLICT",
              `Transaction aborted due to concurrent modification on '${path}' ` +
                `(expected version ${expectedVersion}, found ${actualVersion})`,
              { path, expectedVersion, actualVersion }
            );
          }
        }

        return { tokenHash, readSet, expiresAt: txRow!.expires_at };
      }

      // Memory adapter fallback (tests only).
      const row = memoryTransactions.get(tokenHash);
      const scopedRow = row && row.projectId === ctx.projectId ? row : undefined;
      requireActive(scopedRow);
      for (const path of Object.keys(scopedRow!.readSet).sort()) {
        const expectedVersion = scopedRow!.readSet[path] ?? 0;
        const doc = await tx.getDocument(path, false, true);
        const actualVersion = doc ? doc.version : 0;
        if (actualVersion !== expectedVersion) {
          throw new VellumError(
            "ABORTED_CONFLICT",
            `Transaction aborted due to concurrent modification on '${path}' ` +
              `(expected version ${expectedVersion}, found ${actualVersion})`,
            { path, expectedVersion, actualVersion }
          );
        }
      }
      return { tokenHash, readSet: { ...scopedRow!.readSet }, expiresAt: scopedRow!.expiresAt };
    },

    async markCommitted(tx: TxHandle, tokenHash: string, ctx: TenantContext): Promise<void> {
      if (isSqlHandle(tx)) {
        const { rowCount } = await tx.query(
          `UPDATE transactions SET status = 'committed', committed_at = now()
            WHERE token_hash = $1 AND project_id = $2::uuid
              AND status = 'active'`,
          [tokenHash, ctx.projectId]
        );
        await assertActiveUpdateApplied(tx, rowCount, tokenHash, ctx.projectId);
      } else {
        const row = memoryTransactions.get(tokenHash);
        const scopedRow = row && row.projectId === ctx.projectId ? row : undefined;
        requireActive(scopedRow);
        scopedRow!.status = "committed";
        scopedRow!.committedAt = new Date().toISOString();
      }
    },

    async rollback(token: string, ctx: TokenCallerContext): Promise<void> {
      verifyToken(token, ctx);
      const tokenHash = hashToken(token);
      await dataStore.withTransaction(ctx, async (tx) => {
        if (isSqlHandle(tx)) {
          const { rowCount } = await tx.query(
            `UPDATE transactions SET status = 'rolled_back', rolled_back_at = now()
              WHERE token_hash = $1 AND project_id = $2::uuid
                AND status = 'active'`,
            [tokenHash, ctx.projectId]
          );
          await assertActiveUpdateApplied(tx, rowCount, tokenHash, ctx.projectId);
        } else {
          const row = memoryTransactions.get(tokenHash);
          const scopedRow = row && row.projectId === ctx.projectId ? row : undefined;
          requireActive(scopedRow);
          scopedRow!.status = "rolled_back";
          scopedRow!.rolledBackAt = new Date().toISOString();
        }
      });
    },

    async cleanupExpired(ctx: TenantContext, limit = 1000): Promise<number> {
      const safeLimit =
        typeof limit === "number" && Number.isFinite(limit)
          ? Math.max(1, Math.min(Math.floor(limit), 10_000))
          : 1000;
      return dataStore.withTransaction(ctx, async (tx) => {
        if (isSqlHandle(tx)) {
          // $1 is the tenant scope; $2 is the bounded delete limit.
          // PostgreSQL has no DELETE ... LIMIT — bound via an id subquery.
          const { rowCount } = await tx.query(
            `DELETE FROM transactions
              WHERE id IN (
                SELECT id FROM transactions
                 WHERE project_id = $1::uuid
                   AND (
                     (status = 'active' AND expires_at < now())
                     OR (status IN ('committed', 'rolled_back') AND created_at < now() - interval '7 days')
                   )
                 ORDER BY created_at ASC
                 LIMIT $2::int
              )`,
            [ctx.projectId, safeLimit]
          );
          return rowCount ?? 0;
        }
        let removed = 0;
        const now = Date.now();
        const terminalCutoff = now - TERMINAL_RETENTION_MS;
        for (const [hash, row] of memoryTransactions.entries()) {
          if (row.projectId !== ctx.projectId) {
            continue;
          }
          const expiredActive = row.status === "active" && now > Date.parse(row.expiresAt);
          const oldTerminal =
            (row.status === "committed" || row.status === "rolled_back") &&
            Date.parse(row.createdAt) < terminalCutoff;
          if (!expiredActive && !oldTerminal) {
            continue;
          }
          memoryTransactions.delete(hash);
          removed += 1;
          if (removed >= safeLimit) {
            break;
          }
        }
        return removed;
      });
    },
  };
}

/**
 * Global cleanup for a maintenance worker. Takes a raw SQL client so it can
 * purge expired rows across tenants without a tenant GUC (the maintenance
 * connection is a trusted owner connection, never a customer request path).
 *
 * Drains in bounded batches until the DELETE affects no rows or the wall-clock
 * budget is exhausted, purging expired active rows and terminal rows older than
 * 7 days in the same loop.
 */
export async function runExpiredTransactionCleanup(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null | undefined }> },
  batchSize = 1000,
  maxMs = 2000
): Promise<number> {
  const safeBatchSize =
    typeof batchSize === "number" && Number.isFinite(batchSize)
      ? Math.max(1, Math.min(Math.floor(batchSize), 10_000))
      : 1000;
  const safeMaxMs =
    typeof maxMs === "number" && Number.isFinite(maxMs) && maxMs >= 0 ? maxMs : 2000;
  const start = Date.now();
  let purged = 0;
  for (;;) {
    const { rowCount } = await client.query(
      `DELETE FROM transactions
        WHERE id IN (
          SELECT id FROM transactions
           WHERE (status = 'active' AND expires_at < now())
              OR (status IN ('committed', 'rolled_back') AND created_at < now() - interval '7 days')
           LIMIT $1::int
        )`,
      [safeBatchSize]
    );
    const deleted = rowCount ?? 0;
    purged += deleted;
    if (deleted === 0 || Date.now() - start >= safeMaxMs) {
      break;
    }
  }
  return purged;
}
