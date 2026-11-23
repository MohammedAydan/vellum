# ADR-003: Progressive TypeScript Migration Strategy

## Status
Superseded by [ADR-005](./ADR-005-full-typescript-purge.md) (Full TypeScript Purge & Parity Lock)

> [!NOTE]
> Progressive coexistence of `.mjs` and `.ts` was concluded at the end of Phase 2. All `.mjs` files across `packages/`, `apps/`, and `tests/` have been completely removed and replaced by strict TypeScript implementations and Vitest suites.

## Context
The codebase initial state included functioning in-memory and SQL integration tests implemented in ECMAScript modules (`.mjs`). While functional, strict type safety (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) is mandated by `AGENTS.md` and the architecture specification to eliminate runtime errors across the modular monolith.

A "big-bang" rewrite of all `.mjs` files at once introduces significant risk of breaking existing working semantics and losing regression visibility.

## Decision
We adopt an **Incremental, Checkpoint-Driven TypeScript Migration Strategy**:
1. **Preserve Regression Tests**: The existing `.mjs` unit, integration, and security tests under `tests/` remain intact and active as a non-negotiable safety net.
2. **Parallel Authoritative TS Sources**: For each package, TypeScript files (`src/**/*.ts`) are created alongside the legacy files. The `.ts` implementation becomes the canonical source of truth for all new developments.
3. **Build Artifacts & Exports**: Each package builds via `tsc` to `dist/`, exporting types via `dist/index.d.ts` and entry points via `dist/index.js` (or maintaining `.mjs` exports until compilation is fully wired).
4. **Gradual Decommissioning**: A legacy `.mjs` file is decommissioned only after:
   - Corresponding `.ts` implementation is complete.
   - Comprehensive Vitest unit/integration tests written in `.ts` cover 100% of its behavioral surface.
   - All regression tests pass without warnings.
5. **Execution Sequence**:
   `packages/core` → `packages/api-contract` → `packages/authorization` → `packages/storage` → `packages/query-engine` → `packages/document-engine` → `packages/realtime` → `packages/observability` → `packages/sdk-js` → `apps/api` → `apps/dashboard` / `apps/admin`.

## Consequences

### Positive
- Zero disruption to existing passing test suites during the transition.
- Immediate static type verification on each newly migrated module.
- Smooth compiler diagnostics instead of massive syntax breakage across all packages simultaneously.

### Negative / Trade-offs
- Temporary coexistence of `.mjs` and `.ts` files within package directories during active migration phases.
- Build scripts must account for dual-resolution during the intermediate migration phases.
