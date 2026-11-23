#!/usr/bin/env tsx
/**
 * Contract-first OpenAPI 3.1.0 generator.
 *
 * Imports the canonical `generateOpenApiSpec` definition from
 * `packages/api-contract/src/openapi.ts` and writes a deterministically
 * key-sorted JSON artifact to `docs/api/openapi.generated.json`.
 *
 * Usage:
 *   tsx scripts/generate-openapi.ts          # write/update spec
 *   tsx scripts/generate-openapi.ts --check  # fail with exit code 1 on drift
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiSpec } from "../packages/api-contract/src/openapi.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs/api/openapi.generated.json");

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Recursively sorts all object keys lexicographically while preserving array
 * element order so JSON serialization is 100% deterministic across runtimes.
 */
function sortJsonKeys(value: unknown): JsonValue {
  if (value === null || typeof value !== "object") {
    return value as JsonValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item));
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry !== undefined) {
      sorted[key] = sortJsonKeys(entry);
    }
  }
  return sorted;
}

export function renderOpenApiJson(serverUrl?: string): string {
  const spec = generateOpenApiSpec(serverUrl);
  const canonical = sortJsonKeys(spec);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const expected = renderOpenApiJson();

  if (checkOnly) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        `[codegen:openapi] Drift detected: ${OUTPUT_PATH} does not exist. Run "pnpm codegen:openapi" to generate it.`,
      );
      process.exit(1);
    }

    const actual = readFileSync(OUTPUT_PATH, "utf8");
    if (actual !== expected) {
      console.error(
        `[codegen:openapi] Drift detected in ${OUTPUT_PATH}. Run "pnpm codegen:openapi" to regenerate.`,
      );
      process.exit(1);
    }

    console.log(`[codegen:openapi] OK: ${OUTPUT_PATH} is up to date.`);
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected, "utf8");
  console.log(`[codegen:openapi] Wrote ${OUTPUT_PATH}.`);
}

main();
