# ADR-005: Full TypeScript Purge & Monorepo Parity Lock

## Status
Accepted (Locked for v1)

## Context
During Phase 0 and Phase 1, ADR-003 governed a progressive coexistence strategy where legacy `.mjs` files functioned as an execution baseline alongside newly developed TypeScript modules. However, this dual-language state introduced maintenance overhead, ambiguous import resolutions, and risked violating the specification's locked TypeScript requirement.

Phase 2 was tasked with completing the full purge of all remaining `.mjs` files across all workspaces and tests, migrating every module to strict, production-grade TypeScript.

## Decision
1. **Total Decommissioning of `.mjs`**: Every `.mjs` source file, test file, and entrypoint across `packages/`, `apps/`, and `tests/` has been permanently converted to TypeScript (`.ts`) and the legacy files deleted.
2. **Zero-Tolerance Quality Gates**:
   - Zero `any` types in production source code (strictly typed with `unknown`, type guards, or Zod schemas).
   - Zero `@ts-ignore` or `@ts-expect-error` directives in production source code.
   - Strict compiler options enforced: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`.
3. **Unified Vitest Test Harness**: All unit, integration, and security tests run under Vitest with complete TypeScript type checking and execution parity.
4. **Clean Workspace Builds**: All 14 packages and apps compile cleanly via `tsc` to `./dist` with full declaration files (`.d.ts`).

## Consequences

### Positive
- 100% type safety and contract consistency across all 14 monorepo workspaces.
- Elimination of dual runtime paths, import confusion, and untyped regression bugs.
- Rapid deterministic test runs via Vitest (`pnpm test`, `test:unit`, `test:integration`, `test:security`).
- Full alignment with the architectural invariants.

### Negative / Trade-offs
- Strict optional property types (`exactOptionalPropertyTypes: true`) require explicit handling of `undefined` in request options and bodies, prohibiting properties with explicit `undefined` values.
