/**
 * `packages/database-control/src/revocation-store.ts`
 * PostgreSQL-backed session revocation list (control_db `session_revocations`).
 *
 * Revocations are visible to every API instance immediately: there is no
 * in-process copy. `isRevoked` is a primary-key lookup on `jti`. Expired rows are
 * ignored on read and pruned opportunistically on write (bounded DELETE).
 */

import type pg from "pg";

export interface RevocationStorePort {
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

type Queryable = Pick<pg.Pool, "query">;

const PRUNE_BATCH = 200;

export function createPgRevocationStore(pool: Queryable, realm: string): RevocationStorePort {
  return {
    async revoke(jti: string, expiresAtMs: number): Promise<void> {
      if (!jti || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
      await pool.query(
        `INSERT INTO session_revocations (jti, realm, expires_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0))
         ON CONFLICT (jti) DO UPDATE SET expires_at = GREATEST(session_revocations.expires_at, EXCLUDED.expires_at)`,
        [jti, realm, expiresAtMs]
      );
      // Bounded cleanup using the expires_at index; failures must not fail the revoke.
      await pool
        .query(
          `DELETE FROM session_revocations WHERE jti IN (
             SELECT jti FROM session_revocations WHERE expires_at <= now() LIMIT ${PRUNE_BATCH})`
        )
        .catch(() => undefined);
    },
    async isRevoked(jti: string): Promise<boolean> {
      if (!jti) return false;
      const res = await pool.query(
        "SELECT 1 FROM session_revocations WHERE jti = $1 AND realm = $2 AND expires_at > now()",
        [jti, realm]
      );
      return (res.rowCount ?? res.rows.length) > 0;
    },
  };
}
