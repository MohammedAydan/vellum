# ADR-000: Baseline Architecture Snapshot & Governance Foundation

## Status
Accepted

## Context
The Document Database SaaS repository was delivered with foundational architectural specifications (`document_database_saas_architecture_engineering_specification.md`).

Before beginning progressive compilation, hardening, and user interface delivery, a baseline audit of the existing codebase was performed. The repository contained complete DDL schemas for both `control_db` and `data_db`, reference JavaScript (`.mjs`) implementations of the core wire format, path parser, sort key encoder, query compilation, security rules AST evaluator, and WebSocket frame protocol, along with an initial passing test suite (10 test suites covering unit, integration, and security scenarios).

## Decision
We record and lock the initial repository state as the authoritative baseline for `v2.0` (commit tag `phase-0-baseline`).
1. All domain invariants in the specification remain non-negotiable.
2. The initial in-memory and SQL schema reference implementations serve as the behavioral specification and regression baseline.
3. Any divergence from the locked specification must be proposed and documented as an ADR before implementation.

## Consequences

### Positive
- Establishes a verifiable regression test baseline ensuring zero behavioral regressions during refactoring.
- Freezes system quotas, error codes, and wire format contracts to prevent scope creep.
- Provides a clean git tag (`phase-0-baseline`) for rollback if needed.

### Negative / Trade-offs
- The initial baseline contained legacy `.mjs` files with limited static type checking that must be systematically migrated to TypeScript.
- Dual-maintenance of `.mjs` regression suites alongside new TypeScript source files is required until full feature parity is proven.
