# TypeScript Standards & Governance Guide

## Overview

This document specifies the strict TypeScript standards and architecture rules governing the Document Database SaaS monorepo.

Following the successful completion of Phase 2 ([ADR-005](./decisions/ADR-005-full-typescript-purge.md)), the codebase operates with 100% end-to-end static type safety (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) across all backend packages, client SDKs, tests, and apps. All legacy `.mjs` files have been permanently decommissioned.

---

## Cardinal TypeScript Invariants

### Invariant 1: Zero `any` in Production Code
All external inputs, database records, and dynamic payloads must be parsed into typed structures or typed as `unknown` with narrowing type guards / Zod schemas.

### Invariant 2: Zero `@ts-ignore` and `@ts-expect-error`
No suppression comments are permitted in production source code. All edge cases must be modeled with proper TypeScript generics, conditional types, or discriminated unions.

### Invariant 3: Dual Declaration & Compilation Output
Every package builds via `tsc` to `./dist`, outputting ES2023 JavaScript (`.js`) and complete type declarations (`.d.ts`). Package manifests must declare:
```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
}
```

### Invariant 4: Vitest Native TypeScript Testing
All unit, integration, and security tests are written natively in TypeScript (`.test.ts`) and executed with Vitest.

---

## Compiler Standards (Non-Negotiable)

Every `tsconfig.json` extends `tsconfig.base.json` and enforces:
- `"strict": true` — No implicit `any`, strict null checks, strict function types.
- `"noUncheckedIndexedAccess": true` — Array and record indexing yields `T | undefined`.
- `"exactOptionalPropertyTypes": true` — Discriminated unions and optional properties cannot be assigned `undefined` unless explicitly declared.
- `"noImplicitOverride": true` — Class method overrides must use the `override` keyword.
- `"noFallthroughCasesInSwitch": true` — Exhaustive switch statements required.
