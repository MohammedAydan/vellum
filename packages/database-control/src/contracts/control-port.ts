/**
 * @vellum/database-control - Canonical Control Plane Repository Ports
 */

import type { ControlPlaneRepository } from "../types.js";
import type { SecurityRepository } from "../security-repository.js";
import type { BillingRepository } from "../billing-repository.js";
import type { MigrationStatusRow } from "../migrations-runner.js";

/** Outbound Control Plane port implemented by Memory and PostgreSQL stores. */
export type ControlPlanePort = ControlPlaneRepository;

/** Outbound Security Fortress repository port. */
export type SecurityRepositoryPort = SecurityRepository;

/** Outbound Billing & Metering repository port. */
export type BillingRepositoryPort = BillingRepository;

/** Outbound database readiness probe port for health checks and migration verification. */
export interface ReadinessProbePort {
  /** Execute a lightweight SQL probe (e.g. `SELECT 1`) and return the first row, if any. */
  probeSql(query: string): Promise<Record<string, unknown> | null>;
  /** Verify PostgreSQL LISTEN capability on a probe channel. */
  probeListen?(channel: string): Promise<boolean>;
  /** Inspect applied schema migrations on the target database. */
  getMigrationStatus?(): Promise<MigrationStatusRow[]>;
  /** Release underlying probe resources when finished. */
  close?(): Promise<void>;
}
