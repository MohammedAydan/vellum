/**
 * `packages/database-control/src/security-repository.ts`
 * Security Fortress control-plane repositories (§2.1–2.4 of
 * `docs/SECURITY-BILLING-CONTRACT.md`).
 *
 * Two implementations of the same contract:
 *  - `createInMemorySecurityRepository()` — synchronous, bounded collections for tests
 *    and process-local development use.
 *  - `createPgSecurityRepository(pool)` — async, parameterised SQL against the
 *    `control_db`; row mapping follows `pg-store.ts` conventions (`iso`,
 *    `isoOrNull`, explicit camelCase aliases).
 *
 * The `security_audit_logs` table is append-only and hash-chained: callers must
 * compute `prevHash`/`entryHash` themselves (via `@vellum/security` hash-chain)
 * before calling `appendAuditLog`. Nothing here mutates or deletes audit rows.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Store methods are sync in memory and async on PostgreSQL (see `types.ts`). */
type MaybePromise<T> = T | Promise<T>;

export type AuditRealm = 'super_admin'|'customer_console'|'project_end_user'|'system'|'anonymous';
export type AuditOutcome = 'success'|'denied'|'error';
export interface SecurityAuditInput {
  actorRealm: AuditRealm; actorId?: string|null; orgId?: string|null; projectId?: string|null;
  action: string; resourceType: string; resourceId?: string|null;
  outcome: AuditOutcome; ipAddress?: string|null; userAgent?: string|null;
  details?: Record<string,unknown>; prevHash: string; entryHash: string;
}
export interface SecurityAuditRecord extends SecurityAuditInput {
  seq: number; id: string; createdAt: string;
  actorId: string|null; orgId: string|null; projectId: string|null;
  resourceId: string|null; ipAddress: string|null; userAgent: string|null; details: Record<string,unknown>;
}
export interface ThreatEventInput {
  severity:'low'|'medium'|'high'|'critical';
  category:'brute_force'|'token_replay'|'prototype_pollution'|'query_exhaustion'|'ssrf_attempt'|'cross_tenant_probe'|'ws_flood'|'quota_abuse';
  sourceIp?:string|null; actorId?:string|null; orgId?:string|null; projectId?:string|null;
  summary:string; evidence?:Record<string,unknown>; autoMitigated?:boolean;
  status?:'open'|'acknowledged'|'resolved';
}
export interface ThreatEventRecord extends ThreatEventInput {
  id:string; createdAt:string; autoMitigated:boolean; status:'open'|'acknowledged'|'resolved';
  sourceIp:string|null; actorId:string|null; orgId:string|null; projectId:string|null; evidence:Record<string,unknown>;
}
export type BlocklistTargetType = 'ip'|'api_key_id'|'org_id'|'project_id';
export interface BlocklistInput {
  targetType:BlocklistTargetType; targetValue:string; reason:string; createdBy:string;
  expiresAt?:string|null; active?:boolean;
}
export interface BlocklistRecord extends BlocklistInput {
  id:string; createdAt:string; expiresAt:string|null; active:boolean;
}
export interface SecurityAuditFilter {
  orgId?:string; action?:string; outcome?:AuditOutcome; from?:string; to?:string; limit?:number;
}
export interface ThreatFilter { status?:'open'|'acknowledged'|'resolved'; severity?:string; limit?:number; }

export interface SecurityRepository {
  getLastAuditHash(): MaybePromise<string|null>;                 // last entry_hash ordered by seq DESC, or null
  appendAuditLog(input:SecurityAuditInput): MaybePromise<SecurityAuditRecord>;
  listAuditLogs(filter?:SecurityAuditFilter): MaybePromise<SecurityAuditRecord[]>;
  recordThreat(input:ThreatEventInput): MaybePromise<ThreatEventRecord>;
  listThreats(filter?:ThreatFilter): MaybePromise<ThreatEventRecord[]>;
  updateThreatStatus(id:string,status:'acknowledged'|'resolved'): MaybePromise<ThreatEventRecord|null>;
  upsertBlocklist(input:BlocklistInput): MaybePromise<BlocklistRecord>;  // ON CONFLICT (target_type,target_value) DO UPDATE: reason, created_by, expires_at, active=TRUE
  listBlocklist(activeOnly?:boolean): MaybePromise<BlocklistRecord[]>;
  deactivateBlocklist(id:string): MaybePromise<BlocklistRecord|null>;
  deleteBlocklist(id:string): MaybePromise<boolean>;
  updateApiKeyRestrictions(keyId:string, patch:{allowedOrigins?:string[];allowedIps?:string[];expiresAt?:string|null}): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers (same semantics as `pg-store.ts`).
// ---------------------------------------------------------------------------

const AUDIT_LOG_CAP = 10_000;
const THREAT_CAP = 5_000;
const BLOCKLIST_CAP = 5_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_THREAT_UPDATES = new Set<string>(["acknowledged", "resolved"]);

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = sanitizeValue(entry, depth + 1);
  }
  return clean;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizeValue(value) as Record<string, unknown>;
  }
  return {};
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(value)));
}

function cloneAuditRecord(record: SecurityAuditRecord): SecurityAuditRecord {
  return { ...record, details: asObject(record.details) };
}

function cloneThreatRecord(record: ThreatEventRecord): ThreatEventRecord {
  return { ...record, evidence: asObject(record.evidence) };
}

function cloneBlocklistRecord(record: BlocklistRecord): BlocklistRecord {
  return { ...record };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

class InMemorySecurityRepository implements SecurityRepository {
  // Insertion-ordered Maps give O(1) lookup, O(1) append, and O(1) oldest eviction.
  private readonly auditLogs = new Map<number, SecurityAuditRecord>();
  private readonly threatsById = new Map<string, ThreatEventRecord>();
  private readonly blocklistById = new Map<string, BlocklistRecord>();
  private readonly blocklistByTarget = new Map<string, BlocklistRecord>();
  private lastAuditHash: string | null = null;
  private nextSeq = 1;

  private static targetKey(targetType: BlocklistTargetType, targetValue: string): string {
    return `${targetType}\0${targetValue}`;
  }

  public getLastAuditHash(): string | null {
    return this.lastAuditHash;
  }

  public appendAuditLog(input: SecurityAuditInput): SecurityAuditRecord {
    const seq = this.nextSeq++;
    const record: SecurityAuditRecord = {
      seq,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      actorRealm: input.actorRealm,
      actorId: input.actorId ?? null,
      orgId: input.orgId ?? null,
      projectId: input.projectId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      details: asObject(input.details),
      prevHash: input.prevHash,
      entryHash: input.entryHash,
    };
    this.auditLogs.set(seq, record);
    this.lastAuditHash = record.entryHash;
    if (this.auditLogs.size > AUDIT_LOG_CAP) {
      const oldest = this.auditLogs.keys().next();
      if (!oldest.done) this.auditLogs.delete(oldest.value);
    }
    return cloneAuditRecord(record);
  }

  public listAuditLogs(filter?: SecurityAuditFilter): SecurityAuditRecord[] {
    const limit = clampLimit(filter?.limit);
    const matched: SecurityAuditRecord[] = [];
    for (const row of this.auditLogs.values()) {
      if (filter?.orgId !== undefined && row.orgId !== filter.orgId) continue;
      if (filter?.action !== undefined && row.action !== filter.action) continue;
      if (filter?.outcome !== undefined && row.outcome !== filter.outcome) continue;
      // createdAt values are ISO-8601 UTC strings, so lexical order matches time order.
      if (filter?.from !== undefined && row.createdAt < filter.from) continue;
      if (filter?.to !== undefined && row.createdAt > filter.to) continue;
      matched.push(row);
    }
    // Map iterates in ascending seq order; reversing yields seq DESC without sorting.
    matched.reverse();
    return matched.slice(0, limit).map(cloneAuditRecord);
  }

  public recordThreat(input: ThreatEventInput): ThreatEventRecord {
    const record: ThreatEventRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      severity: input.severity,
      category: input.category,
      sourceIp: input.sourceIp ?? null,
      actorId: input.actorId ?? null,
      orgId: input.orgId ?? null,
      projectId: input.projectId ?? null,
      summary: input.summary,
      evidence: asObject(input.evidence),
      autoMitigated: input.autoMitigated ?? false,
      status: input.status ?? 'open',
    };
    this.threatsById.set(record.id, record);
    if (this.threatsById.size > THREAT_CAP) {
      const oldest = this.threatsById.keys().next();
      if (!oldest.done) this.threatsById.delete(oldest.value);
    }
    return cloneThreatRecord(record);
  }

  public listThreats(filter?: ThreatFilter): ThreatEventRecord[] {
    const limit = clampLimit(filter?.limit);
    const matched: ThreatEventRecord[] = [];
    for (const row of this.threatsById.values()) {
      if (filter?.status !== undefined && row.status !== filter.status) continue;
      if (filter?.severity !== undefined && row.severity !== filter.severity) continue;
      matched.push(cloneThreatRecord(row));
    }
    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matched.slice(0, limit);
  }

  public updateThreatStatus(
    id: string,
    status: 'acknowledged'|'resolved'
  ): ThreatEventRecord | null {
    if (!VALID_THREAT_UPDATES.has(status)) {
      throw new Error(`Invalid threat status: ${String(status)}`);
    }
    const record = this.threatsById.get(id);
    if (!record) return null;
    record.status = status;
    return cloneThreatRecord(record);
  }

  public upsertBlocklist(input: BlocklistInput): BlocklistRecord {
    const tKey = InMemorySecurityRepository.targetKey(input.targetType, input.targetValue);
    const existing = this.blocklistByTarget.get(tKey);
    const expiresAt = input.expiresAt ?? null;
    if (existing) {
      // Mirrors ON CONFLICT DO UPDATE: id/createdAt are preserved, active=TRUE.
      const updated: BlocklistRecord = {
        ...existing,
        reason: input.reason,
        createdBy: input.createdBy,
        expiresAt,
        active: true,
      };
      this.blocklistById.set(updated.id, updated);
      this.blocklistByTarget.set(tKey, updated);
      return cloneBlocklistRecord(updated);
    }
    const created: BlocklistRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      targetType: input.targetType,
      targetValue: input.targetValue,
      reason: input.reason,
      createdBy: input.createdBy,
      expiresAt,
      active: input.active ?? true,
    };
    this.blocklistById.set(created.id, created);
    this.blocklistByTarget.set(tKey, created);
    if (this.blocklistById.size > BLOCKLIST_CAP) {
      const oldest = this.blocklistById.keys().next();
      if (!oldest.done) {
        const evicted = this.blocklistById.get(oldest.value);
        this.blocklistById.delete(oldest.value);
        if (evicted) {
          this.blocklistByTarget.delete(
            InMemorySecurityRepository.targetKey(evicted.targetType, evicted.targetValue)
          );
        }
      }
    }
    return cloneBlocklistRecord(created);
  }

  public listBlocklist(activeOnly?: boolean): BlocklistRecord[] {
    const matched: BlocklistRecord[] = [];
    for (const row of this.blocklistById.values()) {
      if (activeOnly === true && !row.active) continue;
      matched.push(cloneBlocklistRecord(row));
    }
    return matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public deactivateBlocklist(id: string): BlocklistRecord | null {
    const record = this.blocklistById.get(id);
    if (!record) return null;
    record.active = false;
    return cloneBlocklistRecord(record);
  }

  public deleteBlocklist(id: string): boolean {
    const record = this.blocklistById.get(id);
    if (!record) return false;
    this.blocklistById.delete(id);
    this.blocklistByTarget.delete(
      InMemorySecurityRepository.targetKey(record.targetType, record.targetValue)
    );
    return true;
  }

  /**
   * Deliberately a no-op here: the in-memory API-key store (`memory-store.ts`)
   * owns `allowedOrigins`, `allowedIps` and `expiresAt` on its own key records.
   * Only the PostgreSQL repository persists these restriction columns.
   */
  public updateApiKeyRestrictions(
    _keyId: string,
    _patch: {allowedOrigins?:string[];allowedIps?:string[];expiresAt?:string|null}
  ): void {
    // No-op: nothing to update in this process-local repository.
  }
}

export function createInMemorySecurityRepository(): SecurityRepository {
  return new InMemorySecurityRepository();
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

// Select `seq` without `::int` truncation so BIGINT identity values > 2^31-1 never overflow.
const AUDIT_COLUMNS = `seq, id,
  actor_realm AS "actorRealm", actor_id AS "actorId", org_id AS "orgId",
  project_id AS "projectId", action,
  resource_type AS "resourceType", resource_id AS "resourceId", outcome,
  ip_address AS "ipAddress", user_agent AS "userAgent", details,
  prev_hash AS "prevHash", entry_hash AS "entryHash", created_at AS "createdAt"`;

const THREAT_COLUMNS = `id, severity, category, source_ip AS "sourceIp",
  actor_id AS "actorId", org_id AS "orgId", project_id AS "projectId", summary,
  evidence, auto_mitigated AS "autoMitigated", status, created_at AS "createdAt"`;

const BLOCKLIST_COLUMNS = `id, target_type AS "targetType",
  target_value AS "targetValue", reason, created_by AS "createdBy",
  expires_at AS "expiresAt", active, created_at AS "createdAt"`;

function mapAuditRow(row: Record<string, unknown>): SecurityAuditRecord {
  return {
    seq: Number(row["seq"]),
    id: String(row["id"]),
    actorRealm: row["actorRealm"] as AuditRealm,
    actorId: typeof row["actorId"] === "string" ? row["actorId"] : null,
    orgId: typeof row["orgId"] === "string" ? row["orgId"] : null,
    projectId: typeof row["projectId"] === "string" ? row["projectId"] : null,
    action: String(row["action"]),
    resourceType: String(row["resourceType"]),
    resourceId: typeof row["resourceId"] === "string" ? row["resourceId"] : null,
    outcome: row["outcome"] as AuditOutcome,
    ipAddress: typeof row["ipAddress"] === "string" ? row["ipAddress"] : null,
    userAgent: typeof row["userAgent"] === "string" ? row["userAgent"] : null,
    details: asObject(row["details"]),
    prevHash: String(row["prevHash"]),
    entryHash: String(row["entryHash"]),
    createdAt: iso(row["createdAt"]),
  };
}

function mapThreatRow(row: Record<string, unknown>): ThreatEventRecord {
  return {
    id: String(row["id"]),
    createdAt: iso(row["createdAt"]),
    severity: row["severity"] as ThreatEventInput["severity"],
    category: row["category"] as ThreatEventInput["category"],
    sourceIp: typeof row["sourceIp"] === "string" ? row["sourceIp"] : null,
    actorId: typeof row["actorId"] === "string" ? row["actorId"] : null,
    orgId: typeof row["orgId"] === "string" ? row["orgId"] : null,
    projectId: typeof row["projectId"] === "string" ? row["projectId"] : null,
    summary: String(row["summary"]),
    evidence: asObject(row["evidence"]),
    autoMitigated: Boolean(row["autoMitigated"]),
    status: row["status"] as ThreatEventRecord["status"],
  };
}

function mapBlocklistRow(row: Record<string, unknown>): BlocklistRecord {
  return {
    id: String(row["id"]),
    createdAt: iso(row["createdAt"]),
    targetType: row["targetType"] as BlocklistTargetType,
    targetValue: String(row["targetValue"]),
    reason: String(row["reason"]),
    createdBy: String(row["createdBy"]),
    expiresAt: isoOrNull(row["expiresAt"]),
    active: Boolean(row["active"]),
  };
}

/** Safely appends a value to a parameter array and returns its `$n` placeholder. */
function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

class PgSecurityRepository implements SecurityRepository {
  public readonly pool: pg.Pool;

  public constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  public async getLastAuditHash(): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT entry_hash FROM security_audit_logs ORDER BY seq DESC LIMIT 1`
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row && typeof row["entry_hash"] === "string" ? row["entry_hash"] : null;
  }

  public async appendAuditLog(input: SecurityAuditInput): Promise<SecurityAuditRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO security_audit_logs (
         actor_realm, actor_id, org_id, project_id, action,
         resource_type, resource_id, outcome, ip_address, user_agent,
         details, prev_hash, entry_hash
       ) VALUES (
         $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
         $11::jsonb, $12, $13
       )
       RETURNING ${AUDIT_COLUMNS}`,
      [
        input.actorRealm,
        input.actorId ?? null,
        input.orgId ?? null,
        input.projectId ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.outcome,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify(asObject(input.details)),
        input.prevHash,
        input.entryHash,
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("security_audit_logs INSERT returned no row");
    return mapAuditRow(row);
  }

  public async listAuditLogs(filter?: SecurityAuditFilter): Promise<SecurityAuditRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.orgId !== undefined) {
      conditions.push(`org_id = ${bind(params, filter.orgId)}::uuid`);
    }
    if (filter?.action !== undefined) {
      conditions.push(`action = ${bind(params, filter.action)}`);
    }
    if (filter?.outcome !== undefined) {
      conditions.push(`outcome = ${bind(params, filter.outcome)}`);
    }
    if (filter?.from !== undefined) {
      conditions.push(`created_at >= ${bind(params, filter.from)}::timestamptz`);
    }
    if (filter?.to !== undefined) {
      conditions.push(`created_at <= ${bind(params, filter.to)}::timestamptz`);
    }
    const limitPlaceholder = bind(params, clampLimit(filter?.limit));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM security_audit_logs ${where}
        ORDER BY seq DESC LIMIT ${limitPlaceholder}`,
      params
    );
    const result: SecurityAuditRecord[] = [];
    for (const row of rows as Record<string, unknown>[]) result.push(mapAuditRow(row));
    return result;
  }

  public async recordThreat(input: ThreatEventInput): Promise<ThreatEventRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO security_threat_events (
         severity, category, source_ip, actor_id, org_id, project_id,
         summary, evidence, auto_mitigated, status
       ) VALUES (
         $1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8::jsonb, $9, $10
       )
       RETURNING ${THREAT_COLUMNS}`,
      [
        input.severity,
        input.category,
        input.sourceIp ?? null,
        input.actorId ?? null,
        input.orgId ?? null,
        input.projectId ?? null,
        input.summary,
        JSON.stringify(asObject(input.evidence)),
        input.autoMitigated ?? false,
        input.status ?? 'open',
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("security_threat_events INSERT returned no row");
    return mapThreatRow(row);
  }

  public async listThreats(filter?: ThreatFilter): Promise<ThreatEventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.status !== undefined) {
      conditions.push(`status = ${bind(params, filter.status)}`);
    }
    if (filter?.severity !== undefined) {
      conditions.push(`severity = ${bind(params, filter.severity)}`);
    }
    const limitPlaceholder = bind(params, clampLimit(filter?.limit));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT ${THREAT_COLUMNS} FROM security_threat_events ${where}
        ORDER BY created_at DESC LIMIT ${limitPlaceholder}`,
      params
    );
    const result: ThreatEventRecord[] = [];
    for (const row of rows as Record<string, unknown>[]) result.push(mapThreatRow(row));
    return result;
  }

  public async updateThreatStatus(
    id: string,
    status: 'acknowledged'|'resolved'
  ): Promise<ThreatEventRecord | null> {
    if (!VALID_THREAT_UPDATES.has(status)) {
      throw new Error(`Invalid threat status: ${String(status)}`);
    }
    const { rows } = await this.pool.query(
      `UPDATE security_threat_events SET status = $2
        WHERE id = $1::uuid
        RETURNING ${THREAT_COLUMNS}`,
      [id, status]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapThreatRow(row) : null;
  }

  public async upsertBlocklist(input: BlocklistInput): Promise<BlocklistRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO security_blocklist (
         id, target_type, target_value, reason, created_by, expires_at, active
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6::timestamptz, $7
       )
       ON CONFLICT (target_type, target_value) DO UPDATE SET
         reason = EXCLUDED.reason,
         created_by = EXCLUDED.created_by,
         expires_at = EXCLUDED.expires_at,
         active = TRUE
       RETURNING ${BLOCKLIST_COLUMNS}`,
      [
        randomUUID(),
        input.targetType,
        input.targetValue,
        input.reason,
        input.createdBy,
        input.expiresAt ?? null,
        input.active ?? true,
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("security_blocklist INSERT returned no row");
    return mapBlocklistRow(row);
  }

  public async listBlocklist(activeOnly?: boolean): Promise<BlocklistRecord[]> {
    const where = activeOnly === true ? "WHERE active = TRUE" : "";
    const { rows } = await this.pool.query(
      `SELECT ${BLOCKLIST_COLUMNS} FROM security_blocklist ${where}
        ORDER BY created_at DESC`
    );
    const result: BlocklistRecord[] = [];
    for (const row of rows as Record<string, unknown>[]) result.push(mapBlocklistRow(row));
    return result;
  }

  public async deactivateBlocklist(id: string): Promise<BlocklistRecord | null> {
    const { rows } = await this.pool.query(
      `UPDATE security_blocklist SET active = FALSE
        WHERE id = $1::uuid
        RETURNING ${BLOCKLIST_COLUMNS}`,
      [id]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapBlocklistRow(row) : null;
  }

  public async deleteBlocklist(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `DELETE FROM security_blocklist WHERE id = $1::uuid RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /**
   * Builds a dynamic UPDATE from only the fields actually supplied. Values are
   * always bound as `$n` parameters — never interpolated into the SQL text.
   * `$1` is reserved for the key id.
   */
  public async updateApiKeyRestrictions(
    keyId: string,
    patch: {allowedOrigins?:string[];allowedIps?:string[];expiresAt?:string|null}
  ): Promise<void> {
    const assignments: string[] = [];
    const params: unknown[] = [keyId];
    if (patch.allowedOrigins !== undefined) {
      assignments.push(`allowed_origins = ${bind(params, JSON.stringify(patch.allowedOrigins))}::jsonb`);
    }
    if (patch.allowedIps !== undefined) {
      assignments.push(`allowed_ips = ${bind(params, JSON.stringify(patch.allowedIps))}::jsonb`);
    }
    if (patch.expiresAt !== undefined) {
      assignments.push(`expires_at = ${bind(params, patch.expiresAt)}::timestamptz`);
    }
    if (assignments.length === 0) return;
    await this.pool.query(
      `UPDATE api_keys SET ${assignments.join(", ")} WHERE id = $1::uuid`,
      params
    );
  }
}

export function createPgSecurityRepository(pool: pg.Pool): SecurityRepository {
  return new PgSecurityRepository(pool);
}
