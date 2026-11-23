/**
 * apps/admin - Platform Owner Admin Dashboard Service
 * Specification Section 13.2
 *
 * Protected by `users.platform_role IN ('owner', 'admin', 'support_readonly')`.
 * Enforces Privacy-by-Default: Platform operators can inspect cluster health, tenant metadata,
 * quotas, and audit logs, but can NEVER view customer `documents.data`.
 */

import { VellumError } from "@vellum/core";

export type AdminPlatformRole = "owner" | "admin" | "support_readonly";

export interface AdminActorUser {
  id: string;
  platformRole: AdminPlatformRole | string;
}

export interface AdminPlatform {
  controlStore: {
    organizations: Map<string, unknown>;
    projects: Map<string, { id: string; organizationId: string; status: string; updatedAt: string }>;
    auditLogs: Array<{ projectId: string; [key: string]: unknown }>;
    recordAuditLog: (entry: {
      actorUserId: string;
      actorType: string;
      organizationId: string;
      projectId: string;
      action: string;
      targetId: string;
      metadata: Record<string, unknown>;
    }) => void;
  };
  dataStore: {
    documents: Map<string, { projectId: string; deletedAt: unknown; sizeBytes: number }>;
    indexes: Map<string, unknown>;
    outbox: unknown[];
  };
  realtimeHub: {
    connections: Map<string, unknown>;
  };
}

const ALLOWED_ADMIN_ROLES = new Set(["owner", "admin", "support_readonly"]);
const MUTATING_ADMIN_ROLES = new Set(["owner", "admin"]);

export class PlatformAdminService {
  public readonly platform: AdminPlatform;

  constructor({ platform }: { platform: AdminPlatform }) {
    this.platform = platform;
  }

  private requirePlatformRole(actorUser: AdminActorUser | null | undefined, requireWrite = false): void {
    if (!actorUser || !ALLOWED_ADMIN_ROLES.has(actorUser.platformRole)) {
      throw new VellumError("PERMISSION_DENIED", "Platform administrator privileges required");
    }
    if (requireWrite && !MUTATING_ADMIN_ROLES.has(actorUser.platformRole)) {
      throw new VellumError("PERMISSION_DENIED", "Role 'support_readonly' cannot perform mutating admin actions");
    }
  }

  public getClusterMetrics(actorUser: AdminActorUser): {
    totalOrganizations: number;
    totalProjects: number;
    totalStoredDocumentsCount: number;
    totalCompositeIndexesCount: number;
    outboxQueueDepth: number;
    activeWebsocketConnections: number;
  } {
    this.requirePlatformRole(actorUser, false);
    return {
      totalOrganizations: this.platform.controlStore.organizations.size,
      totalProjects: this.platform.controlStore.projects.size,
      totalStoredDocumentsCount: this.platform.dataStore.documents.size,
      totalCompositeIndexesCount: this.platform.dataStore.indexes.size,
      outboxQueueDepth: this.platform.dataStore.outbox.length,
      activeWebsocketConnections: this.platform.realtimeHub.connections.size,
    };
  }

  public inspectProjectMetadata(
    actorUser: AdminActorUser,
    projectId: string
  ): {
    project: unknown;
    stats: {
      documentCount: number;
      totalSizeBytes: number;
    };
  } {
    this.requirePlatformRole(actorUser, false);
    const project = this.platform.controlStore.projects.get(projectId);
    if (!project) {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    let documentCount = 0;
    let totalSizeBytes = 0;
    for (const row of this.platform.dataStore.documents.values()) {
      if (row.projectId === projectId && row.deletedAt === null) {
        documentCount += 1;
        totalSizeBytes += row.sizeBytes;
      }
    }
    return {
      project: structuredClone(project),
      stats: {
        documentCount,
        totalSizeBytes,
      },
    };
  }

  public setProjectStatus(
    actorUser: AdminActorUser,
    projectId: string,
    newStatus: "active" | "throttled" | "suspended" | string,
    reason = ""
  ): unknown {
    this.requirePlatformRole(actorUser, true);
    if (!["active", "throttled", "suspended"].includes(newStatus.toLowerCase())) {
      throw new VellumError("INVALID_ARGUMENT", `Unsupported project status '${newStatus}'`);
    }
    const project = this.platform.controlStore.projects.get(projectId);
    if (!project) {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    const previousStatus = project.status;
    project.status = newStatus;
    project.updatedAt = new Date().toISOString();

    this.platform.controlStore.recordAuditLog({
      actorUserId: actorUser.id,
      actorType: "platform_admin",
      organizationId: project.organizationId,
      projectId: project.id,
      action: "admin.project.status_changed",
      targetId: project.id,
      metadata: { previousStatus, newStatus, reason },
    });

    return structuredClone(project);
  }

  public listAuditLogs(
    actorUser: AdminActorUser,
    options: { projectId?: string | null; limit?: number } = {}
  ): unknown[] {
    this.requirePlatformRole(actorUser, false);
    const limit = options.limit ?? 100;
    const logs = this.platform.controlStore.auditLogs.filter(
      (l) => !options.projectId || l.projectId === options.projectId
    );
    return logs.slice(-limit).reverse();
  }
}
