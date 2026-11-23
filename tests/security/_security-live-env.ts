/**
 * Live-security test environment bootstrap.
 *
 * `pnpm test:security` must run the tenant-isolation suite with zero skips, so
 * this module opts the suite into the repo-root live Neon fixtures before any
 * module that reads configuration is evaluated. Values are never logged.
 */
process.env.PHASE5_REAL = "1";

import { ensureLiveEnv } from "../integration/_live-env.js";

ensureLiveEnv();
