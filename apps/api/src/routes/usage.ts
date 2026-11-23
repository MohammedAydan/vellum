/**
 * @vellum/api - Usage & live telemetry queries (`apps/api/src/routes/usage.ts`)
 *
 * a single home for real PostgreSQL reads that back metering and
 * admin telemetry. Route handlers stay thin; all SQL compilation lives here.
 *
 * Sources (PostgreSQL only):
 *   - `project_usage_daily` (control plane) → metering / tenant usage
 *   - `pg_stat_activity`, `pg_stat_database`, `SHOW max_connections` → node health
 *   - pool counters (`totalCount`/`idleCount`/`waitingCount`) → connection health
 *   - `realtime_outbox.max(seq_id)` (data plane) → realtime outbox lag
 *
 * The data plane is only ever read through aggregate/system views — never
 * `documents.data`. This keeps the platform-operator privacy invariant intact.
 */

import { Hono } from "hono";
import { SYSTEM_LIMITS } from "@vellum/core";
import type { Role, SessionService } from "@vellum/authorization";
import type {
  AuditLogRecord,
  ControlPlaneRepository,
  FeatureFlagRecord,
  UsageDailyRecord,
} from "@vellum/database-control";
import {
  assertProjectAccess,
  requireSession,
} from "../middleware/session.js";
import { unwrapProject } from "../project-lookup.js";

// --------------------------------------------------------------------- types

/** Minimal structural view of a `pg.Pool`; avoids importing `pg` into the API. */
export interface QueryPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface DatabaseStats {
  activeConnections: number;
  maxConnections: number;
  xactCommit: number;
  xactRollback: number;
  blksHit: number;
  blksRead: number;
  uptimeSeconds: number;
}

export interface ClusterNode {
  id: string;
  role: string;
  type: "control" | "data";
  endpoint: string;
  status: "healthy" | "warning" | "error";
  cpuUsage: number;
  memoryUsage: number;
  activeConnections: number;
  maxConnections: number;
  uptime: string;
}

export interface UsageMetricPoint {
  time: string;
  qps: number;
  p95Ms: number;
  outboxLag: number;
  documentReads: number;
  documentWrites: number;
  storageBytes: number;
  source: "project_usage_daily";
}

export interface ClusterTelemetry {
  metrics: UsageMetricPoint[];
  nodes: ClusterNode[];
  telemetry: {
    controlDb: DatabaseStats;
    dataDb: DatabaseStats;
    pool: { control: PoolStats; data: PoolStats };
    outboxLagSeqId: number;
    usageTotals: {
      documentReads: number;
      documentWrites: number;
      documentDeletes: number;
      realtimeMessagesSent: number;
      egressBytes: number;
      storageBytes: number;
      days: number;
    };
  };
}

export interface TenantUsage {
  documentReads: number;
  documentWrites: number;
  documentDeletes: number;
  realtimeMessagesSent: number;
  egressBytes: number;
  storageBytes: number;
}

export interface AuditLogQuery {
  limit?: number;
  cursor?: string | null;
  action?: string | null;
  actorUserId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface AuditLogPage {
  logs: AuditLogRecord[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

// ------------------------------------------------------------------ internals

/** Extract a `pg.Pool`-shaped object from either store implementation. */
export function getQueryPool(store: unknown): QueryPool | null {
  if (!store || typeof store !== "object") return null;
  const pool = (store as { pool?: unknown }).pool;
  if (!pool || typeof pool !== "object") return null;
  const candidate = pool as QueryPool;
  return typeof candidate.query === "function" ? candidate : null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function poolStats(pool: QueryPool | null): PoolStats {
  return {
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "unknown";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function normalizeUsageRow(row: Record<string, unknown>): UsageDailyRecord {
  return {
    projectId: String(row["projectId"] ?? ""),
    usageDate: String(row["usageDate"] ?? ""),
    documentReads: toNumber(row["documentReads"]),
    documentWrites: toNumber(row["documentWrites"]),
    documentDeletes: toNumber(row["documentDeletes"]),
    realtimeMessagesSent: toNumber(row["realtimeMessagesSent"]),
    egressBytes: toNumber(row["egressBytes"]),
    storageBytes: toNumber(row["storageBytes"]),
    updatedAt: toIso(row["updatedAt"]),
  };
}

function hasUsageDailyMap(store: object): store is { usageDaily: Map<string, UsageDailyRecord> } {
  return "usageDaily" in store && store.usageDaily instanceof Map;
}

function hasDeleteFeatureFlag(
  store: object
): store is { deleteFeatureFlag: (key: string, updatedBy?: string | null) => Promise<FeatureFlagRecord | null> } {
  return "deleteFeatureFlag" in store && typeof store.deleteFeatureFlag === "function";
}

function hasFeatureFlagsRecordMap(
  store: object
): store is { featureFlags: Map<string, FeatureFlagRecord> } {
  return "featureFlags" in store && store.featureFlags instanceof Map;
}

function memoryUsageRows(controlStore: ControlPlaneRepository): UsageDailyRecord[] {
  return hasUsageDailyMap(controlStore) ? Array.from(controlStore.usageDaily.values()) : [];
}

// ------------------------------------------------------------- metering reads

/**
 * Reads durable daily usage. PostgreSQL is authoritative when the control
 * store is pool-backed; the in-memory mirror is the offline/test fallback.
 */
export async function readUsageRows(
  controlStore: ControlPlaneRepository,
  projectId: string,
  from: string | null = null,
  to: string | null = null
): Promise<UsageDailyRecord[]> {
  const pool = getQueryPool(controlStore);
  if (!pool) {
    return memoryUsageRows(controlStore)
      .filter((row) => row.projectId === projectId)
      .filter((row) => (from === null || row.usageDate >= from) && (to === null || row.usageDate <= to))
      .sort((a, b) => b.usageDate.localeCompare(a.usageDate));
  }
  const { rows } = await pool.query(
    `SELECT project_id AS "projectId",
            usage_date::text AS "usageDate",
            document_reads::bigint AS "documentReads",
            document_writes::bigint AS "documentWrites",
            document_deletes::bigint AS "documentDeletes",
            realtime_messages_sent::bigint AS "realtimeMessagesSent",
            egress_bytes::bigint AS "egressBytes",
            storage_bytes::bigint AS "storageBytes",
            updated_at AS "updatedAt"
       FROM project_usage_daily
      WHERE project_id = $1::uuid
        AND ($2::date IS NULL OR usage_date >= $2::date)
        AND ($3::date IS NULL OR usage_date <= $3::date)
      ORDER BY usage_date DESC
      LIMIT 1000`,
    [projectId, from, to]
  );
  return rows.map(normalizeUsageRow);
}

/** Aggregates tenant usage from `project_usage_daily` joined to `projects`. */
export async function aggregateTenantUsage(
  controlStore: ControlPlaneRepository,
  usageDate: string | null = null
): Promise<Map<string, TenantUsage>> {
  const result = new Map<string, TenantUsage>();
  const pool = getQueryPool(controlStore);
  if (!pool) {
    const projects = controlStore.projects;
    for (const row of memoryUsageRows(controlStore)) {
      if (usageDate !== null && row.usageDate !== usageDate) continue;
      const project = projects.get(row.projectId);
      if (!project) continue;
      const agg = result.get(project.organizationId) ?? emptyTenantUsage();
      addUsage(agg, row);
      result.set(project.organizationId, agg);
    }
    return result;
  }
  const { rows } = await pool.query(
    `SELECT p.organization_id AS "organizationId",
            COALESCE(SUM(u.document_reads), 0)::bigint AS "documentReads",
            COALESCE(SUM(u.document_writes), 0)::bigint AS "documentWrites",
            COALESCE(SUM(u.document_deletes), 0)::bigint AS "documentDeletes",
            COALESCE(SUM(u.realtime_messages_sent), 0)::bigint AS "realtimeMessagesSent",
            COALESCE(SUM(u.egress_bytes), 0)::bigint AS "egressBytes",
            COALESCE(SUM(u.storage_bytes), 0)::bigint AS "storageBytes"
       FROM project_usage_daily u
       JOIN projects p ON p.id = u.project_id
      WHERE ($1::date IS NULL OR u.usage_date = $1::date)
      GROUP BY p.organization_id`,
    [usageDate]
  );
  for (const row of rows) {
    const orgId = String(row["organizationId"] ?? "");
    if (!orgId) continue;
    result.set(orgId, {
      documentReads: toNumber(row["documentReads"]),
      documentWrites: toNumber(row["documentWrites"]),
      documentDeletes: toNumber(row["documentDeletes"]),
      realtimeMessagesSent: toNumber(row["realtimeMessagesSent"]),
      egressBytes: toNumber(row["egressBytes"]),
      storageBytes: toNumber(row["storageBytes"]),
    });
  }
  return result;
}

/** Usage totals for a single organization (today by default). */
export async function readOrganizationUsage(
  controlStore: ControlPlaneRepository,
  organizationId: string,
  usageDate: string | null = todayUtc()
): Promise<TenantUsage> {
  const all = await aggregateTenantUsage(controlStore, usageDate);
  return all.get(organizationId) ?? emptyTenantUsage();
}

function emptyTenantUsage(): TenantUsage {
  return {
    documentReads: 0,
    documentWrites: 0,
    documentDeletes: 0,
    realtimeMessagesSent: 0,
    egressBytes: 0,
    storageBytes: 0,
  };
}

function addUsage(target: TenantUsage, row: UsageDailyRecord): void {
  target.documentReads += row.documentReads;
  target.documentWrites += row.documentWrites;
  target.documentDeletes += row.documentDeletes;
  target.realtimeMessagesSent += row.realtimeMessagesSent;
  target.egressBytes += row.egressBytes;
  target.storageBytes += row.storageBytes;
}

// ------------------------------------------------------------- cluster reads

async function readDatabaseStats(pool: QueryPool | null): Promise<DatabaseStats> {
  const fallback: DatabaseStats = {
    activeConnections: 0,
    maxConnections: 0,
    xactCommit: 0,
    xactRollback: 0,
    blksHit: 0,
    blksRead: 0,
    uptimeSeconds: 0,
  };
  if (!pool) return fallback;
  try {
    const [activity, maxConn, dbStat, start] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS "activeConnections"
           FROM pg_stat_activity WHERE datname = current_database()`
      ),
      pool.query(`SELECT current_setting('max_connections')::int AS "maxConnections"`),
      pool.query(
        `SELECT xact_commit::bigint AS "xactCommit", xact_rollback::bigint AS "xactRollback",
                blks_hit::bigint AS "blksHit", blks_read::bigint AS "blksRead"
           FROM pg_stat_database WHERE datname = current_database()`
      ),
      pool.query(`SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS "uptimeSeconds"`),
    ]);
    const row = dbStat.rows[0] ?? {};
    return {
      activeConnections: toNumber(activity.rows[0]?.["activeConnections"]),
      maxConnections: toNumber(maxConn.rows[0]?.["maxConnections"]),
      xactCommit: toNumber(row["xactCommit"]),
      xactRollback: toNumber(row["xactRollback"]),
      blksHit: toNumber(row["blksHit"]),
      blksRead: toNumber(row["blksRead"]),
      uptimeSeconds: toNumber(start.rows[0]?.["uptimeSeconds"]),
    };
  } catch {
    return fallback;
  }
}

/**
 * Outbox high-water mark. `realtime_outbox` is RLS-protected with FORCE, so a
 * non-superuser telemetry role may see zero rows; in that case the sequence
 * high-water mark is used as an equivalent durable watermark. No document
 * payload is ever read.
 */
export async function readOutboxWatermark(dataStore: unknown): Promise<number> {
  const pool = getQueryPool(dataStore);
  if (!pool) return 0;
  try {
    const direct = await pool.query(
      `SELECT COALESCE(MAX(seq_id), 0)::bigint AS "maxSeq" FROM realtime_outbox`
    );
    const value = toNumber(direct.rows[0]?.["maxSeq"]);
    if (value > 0) return value;
  } catch {
    // RLS or a missing table: fall through to the sequence watermark.
  }
  try {
    const seq = await pool.query(
      `SELECT COALESCE(last_value, 0)::bigint AS "maxSeq"
         FROM pg_sequences
        WHERE schemaname = current_schema()
          AND sequencename = 'realtime_outbox_seq_id_seq'`
    );
    return toNumber(seq.rows[0]?.["maxSeq"]);
  } catch {
    return 0;
  }
}

function buildNode(
  id: string,
  role: string,
  type: ClusterNode["type"],
  stats: DatabaseStats
): ClusterNode {
  const saturated = stats.maxConnections > 0 && stats.activeConnections / stats.maxConnections > 0.9;
  return {
    id,
    role,
    type,
    // Static labels never expose a DSN (secret hygiene).
    endpoint: type === "control" ? "control-plane://postgresql" : "data-plane://postgresql",
    status: saturated ? "warning" : "healthy",
    // PostgreSQL does not export host CPU/RAM through SQL; 0 means "not measured",
    // never a fabricated percentage.
    cpuUsage: 0,
    memoryUsage: 0,
    activeConnections: stats.activeConnections,
    maxConnections: stats.maxConnections,
    uptime: formatUptime(stats.uptimeSeconds),
  };
}

/** Live cluster telemetry for `GET /v1/admin/overview`. */
export async function readClusterTelemetry(
  controlStore: ControlPlaneRepository,
  dataStore: unknown = null
): Promise<ClusterTelemetry> {
  const controlPool = getQueryPool(controlStore);
  const dataPool = getQueryPool(dataStore);
  const [controlDb, dataDb, outboxLag] = await Promise.all([
    readDatabaseStats(controlPool),
    readDatabaseStats(dataPool),
    readOutboxWatermark(dataStore),
  ]);

  let series: UsageDailyRecord[] = [];
  let totals = emptyTenantUsage();
  try {
    const pool = controlPool;
    if (pool) {
      const [seriesRes, totalsRes] = await Promise.all([
        pool.query(
          `SELECT usage_date::text AS "usageDate",
                  COALESCE(SUM(document_reads), 0)::bigint AS "documentReads",
                  COALESCE(SUM(document_writes), 0)::bigint AS "documentWrites",
                  COALESCE(SUM(document_deletes), 0)::bigint AS "documentDeletes",
                  COALESCE(SUM(realtime_messages_sent), 0)::bigint AS "realtimeMessagesSent",
                  COALESCE(SUM(egress_bytes), 0)::bigint AS "egressBytes",
                  COALESCE(SUM(storage_bytes), 0)::bigint AS "storageBytes",
                  MAX(updated_at) AS "updatedAt"
             FROM project_usage_daily
            GROUP BY usage_date
            ORDER BY usage_date DESC
            LIMIT 30`
        ),
        pool.query(
          `SELECT COALESCE(SUM(document_reads), 0)::bigint AS "documentReads",
                  COALESCE(SUM(document_writes), 0)::bigint AS "documentWrites",
                  COALESCE(SUM(document_deletes), 0)::bigint AS "documentDeletes",
                  COALESCE(SUM(realtime_messages_sent), 0)::bigint AS "realtimeMessagesSent",
                  COALESCE(SUM(egress_bytes), 0)::bigint AS "egressBytes",
                  COALESCE(SUM(storage_bytes), 0)::bigint AS "storageBytes",
                  COUNT(*)::int AS "days"
             FROM project_usage_daily`
        ),
      ]);
      series = seriesRes.rows.map((row) => normalizeUsageRow({
        projectId: "aggregated",
        ...row,
      }));
      const t = totalsRes.rows[0] ?? {};
      totals = {
        documentReads: toNumber(t["documentReads"]),
        documentWrites: toNumber(t["documentWrites"]),
        documentDeletes: toNumber(t["documentDeletes"]),
        realtimeMessagesSent: toNumber(t["realtimeMessagesSent"]),
        egressBytes: toNumber(t["egressBytes"]),
        storageBytes: toNumber(t["storageBytes"]),
      };
      // `days` is reported separately below via the series length fallback.
      void t["days"];
    } else {
      series = memoryUsageRows(controlStore);
      for (const row of series) addUsage(totals, row);
    }
  } catch {
    series = memoryUsageRows(controlStore);
    totals = emptyTenantUsage();
    for (const row of series) addUsage(totals, row);
  }

  const metrics: UsageMetricPoint[] = series.map((row) => ({
    time: row.usageDate,
    // Daily-average QPS derived from real counters (never invented).
    qps: Math.round(((row.documentReads + row.documentWrites) / 86_400) * 100) / 100,
    // p95 is unavailable without pg_stat_statements; 0 means "not measured".
    p95Ms: 0,
    outboxLag,
    documentReads: row.documentReads,
    documentWrites: row.documentWrites,
    storageBytes: row.storageBytes,
    source: "project_usage_daily",
  }));

  return {
    metrics,
    nodes: [
      buildNode("pg-control-primary", "Control Plane PostgreSQL (Primary)", "control", controlDb),
      buildNode("pg-data-primary", "Data Plane PostgreSQL + RLS", "data", dataDb),
    ],
    telemetry: {
      controlDb,
      dataDb,
      pool: { control: poolStats(controlPool), data: poolStats(dataPool) },
      outboxLagSeqId: outboxLag,
      usageTotals: { ...totals, days: series.length },
    },
  };
}

// ------------------------------------------------------------- audit-log reads

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null | undefined): { t: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["t"] !== "string" || typeof obj["id"] !== "string") return null;
    return { t: obj["t"], id: obj["id"] };
  } catch {
    return null;
  }
}

function normalizeAuditRow(row: Record<string, unknown>): AuditLogRecord {
  return {
    id: String(row["id"] ?? ""),
    actorUserId: isoOrNull(row["actorUserId"]),
    actorType: String(row["actorType"] ?? "system"),
    organizationId: isoOrNull(row["organizationId"]),
    projectId: isoOrNull(row["projectId"]),
    action: String(row["action"] ?? ""),
    targetId: isoOrNull(row["targetId"]),
    metadata: typeof row["metadata"] === "object" && row["metadata"] !== null
      ? row["metadata"] as Record<string, unknown>
      : {},
    ipAddress: isoOrNull(row["ipAddress"]),
    userAgent: isoOrNull(row["userAgent"]),
    createdAt: toIso(row["createdAt"]),
  };
}

/**
 * Server-side audit-log filtering + keyset pagination. The cursor is an
 * opaque base64url `(created_at, id)` pair ordered DESC; no SQL OFFSET is used
 * on the durable path.
 */
export async function queryAuditLogs(
  controlStore: ControlPlaneRepository,
  query: AuditLogQuery = {}
): Promise<AuditLogPage> {
  const requested = query.limit ?? 50;
  const limit = Math.max(1, Math.min(requested, SYSTEM_LIMITS.MAX_QUERY_LIMIT));
  const cursor = decodeCursor(query.cursor);
  const pool = getQueryPool(controlStore);

  if (!pool) {
    const all = [...controlStore.auditLogs]
      .filter((log) => !query.action || log.action === query.action)
      .filter((log) => !query.actorUserId || log.actorUserId === query.actorUserId)
      .filter((log) => !query.organizationId || log.organizationId === query.organizationId)
      .filter((log) => !query.projectId || log.projectId === query.projectId)
      .filter((log) => !query.from || log.createdAt >= query.from)
      .filter((log) => !query.to || log.createdAt <= query.to)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const total = all.length;
    const start = cursor
      ? all.findIndex((log) => log.createdAt === cursor.t && log.id === cursor.id) + 1
      : 0;
    const logs = all.slice(start, start + limit);
    const last = logs[logs.length - 1];
    const hasMore = start + logs.length < total && last !== undefined;
    return {
      logs,
      total,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];
  function addFilter(value: unknown): string {
    filterParams.push(value);
    return `$${filterParams.length}`;
  }
  if (query.action) filterConditions.push(`action = ${addFilter(query.action)}`);
  if (query.actorUserId) filterConditions.push(`actor_user_id = ${addFilter(query.actorUserId)}::uuid`);
  if (query.organizationId) {
    filterConditions.push(`organization_id = ${addFilter(query.organizationId)}::uuid`);
  }
  if (query.projectId) filterConditions.push(`project_id = ${addFilter(query.projectId)}::uuid`);
  if (query.from) filterConditions.push(`created_at >= ${addFilter(query.from)}::timestamptz`);
  if (query.to) filterConditions.push(`created_at <= ${addFilter(query.to)}::timestamptz`);
  const filterClause = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";

  // Keyset predicate and LIMIT use placeholders after the filter params.
  const pageParams: unknown[] = [...filterParams];
  let cursorClause = "";
  if (cursor) {
    const tParam = `$${pageParams.length + 1}`;
    const idParam = `$${pageParams.length + 2}`;
    pageParams.push(cursor.t, cursor.id);
    cursorClause = `${filterConditions.length > 0 ? "AND" : "WHERE"} (created_at, id) < (${tParam}::timestamptz, ${idParam}::uuid)`;
  }
  const limitParam = `$${pageParams.length + 1}`;
  pageParams.push(limit);

  const [pageRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, actor_user_id AS "actorUserId", actor_type AS "actorType",
              organization_id AS "organizationId", project_id AS "projectId", action,
              target_id AS "targetId", metadata, ip_address AS "ipAddress",
              user_agent AS "userAgent", created_at AS "createdAt"
         FROM audit_logs
         ${filterClause}
         ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitParam}`,
      pageParams
    ),
    pool.query(
      `SELECT COUNT(*)::int AS "total" FROM audit_logs ${filterClause}`,
      filterParams
    ),
  ]);

  const logs = pageRes.rows.map(normalizeAuditRow);
  const total = toNumber(countRes.rows[0]?.["total"]);
  const last = logs[logs.length - 1];
  // A full page is treated as "possibly more"; the next page returns an empty
  // array when the watermark is exhausted.
  const hasMore = logs.length === limit && last !== undefined;
  return {
    logs,
    total,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    hasMore,
  };
}

// ------------------------------------------------------- feature flag mutation

/**
 * Deletes a feature flag from PostgreSQL and the process-local mirror.
 * `PgControlPlaneStore` owns the method; the in-memory store falls back to its
 * cache so tests/offline mode keep working without a second implementation.
 */
export async function deleteFeatureFlagRecord(
  controlStore: ControlPlaneRepository,
  key: string,
  updatedBy: string | null = null
): Promise<FeatureFlagRecord | null> {
  if (hasDeleteFeatureFlag(controlStore)) {
    return controlStore.deleteFeatureFlag(key, updatedBy);
  }
  if (hasFeatureFlagsRecordMap(controlStore)) {
    const cached = controlStore.featureFlags.get(key) ?? null;
    if (cached) controlStore.featureFlags.delete(key);
    return cached;
  }
  return null;
}

// ------------------------------------------------------------------- routes

const READ_ROLES: readonly Role[] = ["owner", "admin", "support_readonly", "customer"];

/** Metering route factory. Mount with `app.route("/v1", ...)`. */
export function createUsageRoutes(
  controlStore: ControlPlaneRepository,
  sessionService: SessionService,
  _dataStore: unknown = null
) {
  const routes = new Hono();
  routes.get(
    "/projects/:projectId/usage",
    requireSession(sessionService, READ_ROLES),
    async (c) => {
      const projectId = c.req.param("projectId");
      const project = unwrapProject(controlStore.getProject(projectId));
      await assertProjectAccess(controlStore, c.get("session"), projectId);

      const url = new URL(c.req.url);
      const from = parseDateParam(url.searchParams.get("from"));
      const to = parseDateParam(url.searchParams.get("to"));
      const rows = await readUsageRows(controlStore, project.id, from, to);
      const totals = rows.reduce(
        (acc, row) => {
          addUsage(acc, row);
          return acc;
        },
        emptyTenantUsage()
      );
      return c.json({
        projectId: project.id,
        from,
        to,
        generatedAt: new Date().toISOString(),
        days: rows.length,
        totals,
        usage: rows,
      });
    }
  );
  return routes;
}
