import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const tsx = [join(root, "node_modules", ".bin", "tsx"), join(here, "..", "..", "node_modules", ".bin", "tsx")].find(existsSync);

describe("a retrying transaction keeps a Node process alive", () => {
  it.skipIf(!tsx)("exits 0 after committing on the third attempt (never exit code 13)", () => {
    const run = spawnSync(tsx!, [join(here, "fixtures", "tx-retry-process.ts")], { encoding: "utf8", timeout: 30_000 });
    expect(run.stderr).not.toContain("unsettled top-level await");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("committed after 3 commit attempts: ok");
  });
});
