/** Shared view-model types for the customer dashboard. */

export interface OrganizationItem {
  id: string;
  slug: string;
  name: string;
  billingEmail: string;
  plan?: string;
  membersCount?: number;
  projectsCount?: number;
}

export interface ProjectItem {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  status: string;
  createdAt?: string;
}

export interface UsageMetricPoint {
  timestamp: string;
  reads?: number;
  writes?: number;
  storageMb?: number;
}

export interface UsageSummary {
  dailyReads: number;
  dailyWrites: number;
  storageMb: number;
  wsConnections: number;
  readQuota: number;
  writeQuota: number;
  storageQuotaMb: number;
  wsQuota: number;
  plan: string;
  trend: UsageMetricPoint[];
}
