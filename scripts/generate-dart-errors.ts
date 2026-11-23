#!/usr/bin/env tsx
/**
 * Contract-first Dart error codes generator.
 *
 * Parses `ERROR_HTTP_STATUS` directly from `packages/core/src/errors.ts`
 * (the single source of truth) and writes
 * `sdks/flutter/lib/generated/error_codes.g.dart`.
 *
 * Usage:
 *   tsx scripts/generate-dart-errors.ts          # write/update Dart file
 *   tsx scripts/generate-dart-errors.ts --check  # fail with exit code 1 on drift
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SOURCE_PATH = resolve(REPO_ROOT, "packages/core/src/errors.ts");
const OUTPUT_PATH = resolve(
  REPO_ROOT,
  "sdks/flutter/lib/generated/error_codes.g.dart",
);

export interface ErrorStatusEntry {
  readonly code: string;
  readonly status: number;
}

/**
 * Extracts `ERROR_HTTP_STATUS` entries directly from `packages/core/src/errors.ts`.
 */
export function parseErrorHttpStatus(source: string): ErrorStatusEntry[] {
  const blockMatch = source.match(
    /export\s+const\s+ERROR_HTTP_STATUS\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/,
  );
  if (!blockMatch) {
    throw new Error(
      `Could not locate "export const ERROR_HTTP_STATUS = { ... } as const;" in ${SOURCE_PATH}`,
    );
  }

  const body = blockMatch[1];
  const entries: ErrorStatusEntry[] = [];
  const seen = new Set<string>();
  const entryPattern = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d{3})\s*,?\s*$/gm;

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(body)) !== null) {
    const code = match[1];
    const status = Number.parseInt(match[2], 10);
    if (seen.has(code)) {
      throw new Error(`Duplicate error code "${code}" in ERROR_HTTP_STATUS`);
    }
    seen.add(code);
    entries.push({ code, status });
  }

  if (entries.length === 0) {
    throw new Error(`No error codes parsed from ERROR_HTTP_STATUS in ${SOURCE_PATH}`);
  }

  return entries;
}

/**
 * Converts a SCREAMING_SNAKE_CASE error code into a Dart-idiomatic lowerCamelCase
 * constant identifier compliant with `package:lints/recommended.yaml`.
 */
export function toLowerCamelCase(screamingSnake: string): string {
  const parts = screamingSnake.toLowerCase().split("_").filter(Boolean);
  return parts
    .map((part, index) =>
      index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`,
    )
    .join("");
}

export function renderDartErrorCodes(entries: readonly ErrorStatusEntry[]): string {
  const constLines = entries.map(
    ({ code }) => `  static const String ${toLowerCamelCase(code)} = '${code}';`,
  );

  const mapLines = entries.map(
    ({ code, status }) => `    ${toLowerCamelCase(code)}: ${status},`,
  );

  const setLines = entries.map(({ code }) => `    ${toLowerCamelCase(code)},`);

  return [
    "// GENERATED CODE - DO NOT MODIFY BY HAND.",
    "// Source of truth: packages/core/src/errors.ts (ERROR_HTTP_STATUS).",
    "// Regenerate with: pnpm codegen:dart-errors",
    "",
    "/// Canonical Document Database SaaS API error codes and HTTP status mappings.",
    "abstract final class VellumErrorCodes {",
    ...constLines,
    "",
    "  /// Canonical HTTP status code for each error code.",
    "  static const Map<String, int> httpStatusByCode = <String, int>{",
    ...mapLines,
    "  };",
    "",
    "  /// Complete set of canonical API error codes.",
    "  static const Set<String> all = <String>{",
    ...setLines,
    "  };",
    "",
    "  /// Returns `true` if [code] is a canonical Document Database error code.",
    "  static bool isKnown(String code) => httpStatusByCode.containsKey(code);",
    "",
    "  /// Returns the canonical HTTP status code for [code], or `null` if unknown.",
    "  static int? httpStatusFor(String code) => httpStatusByCode[code];",
    "}",
    "",
  ].join("\n");
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const source = readFileSync(SOURCE_PATH, "utf8");
  const entries = parseErrorHttpStatus(source);
  const expected = renderDartErrorCodes(entries);

  if (checkOnly) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        `[codegen:dart-errors] Drift detected: ${OUTPUT_PATH} does not exist. Run "pnpm codegen:dart-errors" to generate it.`,
      );
      process.exit(1);
    }

    const actual = readFileSync(OUTPUT_PATH, "utf8");
    if (actual !== expected) {
      console.error(
        `[codegen:dart-errors] Drift detected in ${OUTPUT_PATH}. Run "pnpm codegen:dart-errors" to regenerate.`,
      );
      process.exit(1);
    }

    console.log(
      `[codegen:dart-errors] OK: ${OUTPUT_PATH} is up to date (${entries.length} codes).`,
    );
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, expected, "utf8");
  console.log(
    `[codegen:dart-errors] Wrote ${OUTPUT_PATH} (${entries.length} codes).`,
  );
}

main();
