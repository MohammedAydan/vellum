/**
 * apps/dashboard - Customer Developer Dashboard Service
 * Specification Section 13.1
 */

import {
  generateProjectApiKey,
  validateSecurityRulesetAst,
  authorizeOperation,
  type ApiKeyRecord,
  type SecurityRulesetAst,
} from "@vellum/authorization";

export interface DashboardPlatform {
  controlStore: {
    getProject: (projectId: string) => {
      project: { id: string; name: string };
    };
    registerApiKey: (params: {
      projectId: string;
      name: string;
      keyType: "public" | "server";
      keyPrefix: string;
      secretHash: string;
      scopes: string[];
      createdBy?: string | null;
    }) => ApiKeyRecord;
    getActiveRuleset: (projectId: string) => { version: number } | null;
    usageDaily: Map<string, {
      documentReads: number;
      documentWrites: number;
      documentDeletes: number;
      realtimeMessagesSent: number;
      egressBytes: number;
      storageBytes: number;
    }>;
  };
  dataStore: {
    runInTenantTransaction: <T>(
      projectId: string,
      fn: (tx: { listIndexes: () => unknown[] }) => T
    ) => T;
  };
}

export interface SimulationResult {
  allowed: boolean;
  matchedRule?: string | undefined;
  code?: string | undefined;
  reason?: string | undefined;
}

export class CustomerDashboardService {
  public readonly platform: DashboardPlatform;

  constructor({ platform }: { platform: DashboardPlatform }) {
    this.platform = platform;
  }

  public simulateSecurityRule({
    rulesAst,
    operation,
    path,
    authUid = null,
    authClaims = {},
    resourceData = null,
    requestData = null,
  }: {
    rulesAst: SecurityRulesetAst;
    operation: "get" | "list" | "create" | "update" | "delete";
    path: string;
    authUid?: string | null;
    authClaims?: Record<string, unknown>;
    resourceData?: Record<string, unknown> | null;
    requestData?: Record<string, unknown> | null;
  }): SimulationResult {
    validateSecurityRulesetAst(rulesAst);
    try {
      const res = authorizeOperation({
        apiKeyRecord: {
          id: "sim_key",
          projectId: "sim",
          name: "sim",
          keyType: "public",
          keyPrefix: "pk_sim",
          secretHash: "sim",
          scopes: [],
          rateLimitRps: 100,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdBy: null,
          createdAt: new Date().toISOString(),
        },
        rulesetRecord: {
          id: "sim_ruleset",
          projectId: "sim",
          version: 1,
          rulesAst: { ...rulesAst },
          isActive: true,
          createdBy: null,
          createdAt: new Date().toISOString(),
        },

        operation,
        path,
        authContext: { uid: authUid, claims: authClaims },
        resourceData,
        requestData,
      });
      return { allowed: true, matchedRule: res.matchedRule };
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      return { allowed: false, code: error.code, reason: error.message };
    }
  }

  public createProjectApiKey({
    projectId,
    name,
    keyType,
    scopes,
    actorUserId,
  }: {
    projectId: string;
    name: string;
    keyType: "public" | "server";
    scopes: string[];
    actorUserId?: string | null;
  }): {
    apiKeyRecord: ApiKeyRecord;
    plaintextKeyOnce: string;
  } {
    const generated = generateProjectApiKey({ keyType });
    const record = this.platform.controlStore.registerApiKey({
      projectId,
      name,
      keyType,
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
      scopes,
      createdBy: actorUserId ?? null,
    });
    return {
      apiKeyRecord: record,
      plaintextKeyOnce: generated.fullKey,
    };
  }

  public getProjectOverview({
    projectId,
  }: {
    projectId: string;
  }): {
    project: { id: string; name: string };
    activeRulesetVersion: number | null;
    indexes: unknown[];
    usage: {
      documentReads: number;
      documentWrites: number;
      documentDeletes: number;
      realtimeMessagesSent: number;
      egressBytes: number;
      storageBytes: number;
    };
  } {
    const { project } = this.platform.controlStore.getProject(projectId);
    const activeRuleset = this.platform.controlStore.getActiveRuleset(projectId);
    const indexes = this.platform.dataStore.runInTenantTransaction(projectId, (tx) =>
      tx.listIndexes()
    );
    const today = new Date().toISOString().slice(0, 10);
    const usage = this.platform.controlStore.usageDaily.get(`${projectId}:${today}`) ?? {
      documentReads: 0,
      documentWrites: 0,
      documentDeletes: 0,
      realtimeMessagesSent: 0,
      egressBytes: 0,
      storageBytes: 0,
    };

    return {
      project,
      activeRulesetVersion: activeRuleset ? activeRuleset.version : null,
      indexes,
      usage,
    };
  }
}
