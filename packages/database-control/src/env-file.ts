/**
 * `packages/database-control/src/env-file.ts`
 * Tiny, dependency-free `.env` parser used by migration tooling and the real E2E suite.
 *
 * We deliberately avoid adding `dotenv` as a dependency of this package: the file format
 * we need (`KEY=value`, `#` comments, optional surrounding quotes) is trivial, and this
 * keeps the production dependency surface unchanged.
 *
 * Values are NEVER logged by this module.
 */

import fs from "node:fs";
import path from "node:path";

export interface ParsedEnvFile {
  path: string;
  values: Record<string, string>;
}

const MAX_ENV_FILE_BYTES = 1_048_576; // 1 MiB safety cap against DoS
const MAX_ENV_LINES = 10_000;
const FORBIDDEN_ENV_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafePathSegment(candidate: string): boolean {
  return typeof candidate === "string" && candidate.length > 0 && !candidate.includes("\0");
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget === normalizedBase) return true;
  const prefix = normalizedBase.endsWith(path.sep) ? normalizedBase : `${normalizedBase}${path.sep}`;
  return normalizedTarget.startsWith(prefix);
}

/**
 * Parses `.env` file contents into a key/value map.
 * Supports `#` comments, blank lines, `KEY=value`, `KEY="value"`, `KEY='value'`,
 * and ignores `export ` prefixes.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  if (typeof contents !== "string") return {};
  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error(`Environment file exceeds maximum allowed size (${MAX_ENV_FILE_BYTES} bytes)`);
  }

  const values: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);
  if (lines.length > MAX_ENV_LINES) {
    throw new Error(`Environment file exceeds maximum allowed line count (${MAX_ENV_LINES})`);
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = /^export\s+/.test(line) ? line.replace(/^export\s+/, "") : line;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || FORBIDDEN_ENV_KEYS.has(key)) continue;

    let value = withoutExport.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value.includes("\0")) continue;

    Object.defineProperty(values, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return values;
}

/**
 * Loads the first existing file from `candidates` (relative to `cwd`) and copies its
 * values into `target` (defaults to `process.env`). Existing variables win unless
 * `override` is true.
 */
export function loadEnvFiles(
  candidates: string[],
  { cwd = process.cwd(), override = false, target = process.env }: {
    cwd?: string;
    override?: boolean;
    target?: NodeJS.ProcessEnv;
  } = {}
): ParsedEnvFile | null {
  if (!Array.isArray(candidates) || !isSafePathSegment(cwd)) return null;
  const resolvedBase = path.resolve(cwd);
  let realBase: string | null = null;
  try {
    realBase = fs.realpathSync(resolvedBase);
  } catch {
    realBase = resolvedBase;
  }

  for (const candidate of candidates) {
    if (!isSafePathSegment(candidate)) continue;
    const isAbs = path.isAbsolute(candidate);
    const fullPath = isAbs ? path.resolve(candidate) : path.resolve(resolvedBase, candidate);

    // Block path traversal out of `cwd` for relative candidate paths.
    if (!isAbs && !isWithinDirectory(resolvedBase, fullPath)) {
      throw new Error(`Refusing to load environment file outside base directory: ${candidate}`);
    }

    if (!fs.existsSync(fullPath)) continue;

    const realFile = fs.realpathSync(fullPath);
    if (!isAbs && realBase !== null && !isWithinDirectory(realBase, realFile)) {
      throw new Error(`Refusing to follow symlink outside base directory: ${candidate}`);
    }

    const stat = fs.statSync(realFile);
    if (!stat.isFile()) continue;
    if (stat.size > MAX_ENV_FILE_BYTES) {
      throw new Error(`Environment file exceeds maximum allowed size (${MAX_ENV_FILE_BYTES} bytes)`);
    }

    const values = parseEnvFile(fs.readFileSync(realFile, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (FORBIDDEN_ENV_KEYS.has(key)) continue;
      if (override || target[key] === undefined) {
        target[key] = value;
      }
    }
    return { path: fullPath, values };
  }
  return null;
}

/** Returns a redacted rendering of a connection string — never includes the password. */
export function redactConnectionString(connectionString: string): string {
  if (typeof connectionString !== "string") return "";
  // Match up to the last `@` in the authority component so passwords containing `@` are fully redacted.
  const withoutPassword = connectionString.replace(
    /(:\/\/[^:/?#@]*):[^/?#]*@/,
    "$1:[REDACTED]@"
  );
  return withoutPassword.replace(
    /([?&](?:password|sslpassword|pass|pwd|token|api_?key|secret)=)[^&#]*/gi,
    "$1[REDACTED]"
  );
}
