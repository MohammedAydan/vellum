import { describe, it, expect } from "vitest";
import {
  decideAutoIndex,
  decideAutoRetire,
  type AutoIndexCandidate,
  type AutoIndexProjectState,
} from "../auto-index-policy.js";

const NOW = Date.UTC(2026, 10, 28);
const cand = (o: Partial<AutoIndexCandidate> = {}): AutoIndexCandidate => ({
  fingerprint: "fp",
  collectionPath: "orders",
  fields: [{ path: "status", dir: "asc" }, { path: "total", dir: "asc" }],
  hits24h: 80,
  distinctHours24h: 6,
  p95Ms: 500,
  docCount: 20_000,
  blockedByScanCap: false,
  dismissed: false,
  alreadyCovered: false,
  ...o,
});
const proj = (o: Partial<AutoIndexProjectState> = {}): AutoIndexProjectState => ({
  projectOptedOut: false,
  planCap: 50,
  existingIndexCount: 3,
  autoIndexCount: 0,
  buildsToday: 0,
  buildInProgress: false,
  estimatedNewEntries: 40_000,
  estimatedAutoIndexBytes: 0,
  estimatedNewIndexBytes: 2_000_000,
  projectDataBytes: 100_000_000,
  hardStorageCapBytes: 0,
  loadGuardBusy: false,
  ...o,
});

describe("decideAutoIndex", () => {
  it("creates in live mode when all criteria hold", () => {
    const d = decideAutoIndex("live", cand(), proj(), NOW);
    expect(d.action).toBe("create");
  });
  it("dry-run reports would-create with the same evidence", () => {
    const d = decideAutoIndex("observe", cand(), proj(), NOW);
    expect(d).toMatchObject({ action: "create", mode: "observe", reason: "would_create_dry_run" });
  });
  it("never acts when off", () => {
    expect(decideAutoIndex("off", cand(), proj(), NOW)).toMatchObject({ action: "skip", reason: "engine_off" });
  });
  it.each([
    ["not_enough_hits", { hits24h: 49 }],
    ["not_enough_distinct_hours", { distinctHours24h: 2 }],
    ["query_not_costly", { docCount: 100, p95Ms: 20 }],
    ["dismissed_by_owner", { dismissed: true }],
    ["already_covered", { alreadyCovered: true }],
    ["too_many_fields", { fields: ["a", "b", "c", "d", "e"].map((path) => ({ path, dir: "asc" as const })) }],
    ["system_path", { fields: [{ path: "createdAt", dir: "asc" as const }] }],
    ["repeated_field", { fields: [{ path: "a", dir: "asc" as const }, { path: "a", dir: "desc" as const }] }],
    ["cooldown", { lastActionAtMs: NOW - 86_400_000 }],
  ])("skips: %s", (reason, over) => {
    expect(decideAutoIndex("live", cand(over as Partial<AutoIndexCandidate>), proj(), NOW)).toMatchObject({ action: "skip", reason });
  });
  it("scan-cap blocked query qualifies even when small and fast", () => {
    const d = decideAutoIndex("live", cand({ docCount: 10, p95Ms: 5, blockedByScanCap: true }), proj(), NOW);
    expect(d.action).toBe("create");
  });
  it.each([
    ["project_opted_out", { projectOptedOut: true }],
    ["auto_budget_exhausted", { autoIndexCount: 20 }],
    ["plan_cap_reached", { existingIndexCount: 50, autoIndexCount: 0 }],
    ["daily_build_limit", { buildsToday: 2 }],
    ["build_in_progress", { buildInProgress: true }],
    ["load_guard_busy", { loadGuardBusy: true }],
    ["storage_budget_exceeded", { estimatedNewIndexBytes: 25_000_000 }],
    ["storage_hard_cap_exceeded", { hardStorageCapBytes: 1_000_000 }],
  ])("project guard: %s", (reason, over) => {
    expect(decideAutoIndex("live", cand(), proj(over as Partial<AutoIndexProjectState>), NOW)).toMatchObject({ action: "skip", reason });
  });
  it("auto budget is 40% of plan cap", () => {
    expect(decideAutoIndex("live", cand(), proj({ planCap: 50, autoIndexCount: 19 }), NOW).action).toBe("create");
    expect(decideAutoIndex("live", cand(), proj({ planCap: 50, autoIndexCount: 20 }), NOW).action).toBe("skip");
  });
});

describe("decideAutoRetire", () => {
  const base = { autoCreated: true, pinned: false, lastUsedAtMs: NOW, createdAtMs: NOW - 5 * 86_400_000, improvementPct: 80, indexUsedInAfterPlan: true };
  it("keeps used, effective indexes", () => expect(decideAutoRetire(base, NOW).retire).toBe(false));
  it("never retires user-made or pinned", () => {
    expect(decideAutoRetire({ ...base, autoCreated: false, lastUsedAtMs: 0 }, NOW).retire).toBe(false);
    expect(decideAutoRetire({ ...base, pinned: true, lastUsedAtMs: 0 }, NOW).retire).toBe(false);
  });
  it("retires ineffective", () => {
    expect(decideAutoRetire({ ...base, improvementPct: 10 }, NOW)).toEqual({ retire: true, reason: "ineffective" });
    expect(decideAutoRetire({ ...base, indexUsedInAfterPlan: false }, NOW).reason).toBe("ineffective");
  });
  it("retires after 30 unused days", () => {
    expect(decideAutoRetire({ ...base, lastUsedAtMs: NOW - 31 * 86_400_000 }, NOW)).toEqual({ retire: true, reason: "unused" });
    expect(decideAutoRetire({ ...base, lastUsedAtMs: null, createdAtMs: NOW - 31 * 86_400_000, improvementPct: null, indexUsedInAfterPlan: null }, NOW).retire).toBe(true);
  });
});
