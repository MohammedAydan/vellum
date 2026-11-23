/**
 * @vellum/api - Edge platform assembly.
 *
 * Builds the SAME platform used by Node and Vercel, but with Neon's HTTP/WebSocket
 * driver instead of a TCP `pg` pool. No `node:fs`, no dotenv and no process
 * signal handlers are imported here, so this module is safe for Workers.
 */

import { neonConfig } from "@neondatabase/serverless";
import { createEdgeAdapters } from "../composition/root.js";
import { createVellumPlatform } from "../platform.js";

/** Environment bindings provided by the Cloudflare Worker. */
export interface EdgeBindings {
  readonly CONTROL_DATABASE_URL: string;
  readonly DATA_DATABASE_URL: string;
  readonly JWT_SECRET: string;
  readonly CURSOR_HMAC_SECRET: string;
  readonly TX_HMAC_SECRET?: string;
  readonly API_KEY_PEPPER?: string;
  readonly CONSOLE_JWT_SECRET?: string;
  readonly SUPER_ADMIN_JWT_SECRET?: string;
  readonly CORS_ALLOWED_ORIGINS?: string;
}

// Neon interactive transactions (BEGIN/COMMIT) require a WebSocket constructor
// in Workers; every Worker and Node 22 exposes a global WebSocket.
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket as unknown as typeof neonConfig.webSocketConstructor;
}

/** Build the full Vellum platform from Worker bindings (Neon for both planes). */
export function createEdgePlatform(env: EdgeBindings) {
  const adapters = createEdgeAdapters({
    controlConnectionString: env.CONTROL_DATABASE_URL,
    dataConnectionString: env.DATA_DATABASE_URL,
  });

  return createVellumPlatform({
    controlStore: adapters.controlStore,
    dataStore: adapters.dataStore,
    jwtSecret: env.JWT_SECRET,
    cursorSecret: env.CURSOR_HMAC_SECRET,
    txSecret: env.TX_HMAC_SECRET ?? env.CURSOR_HMAC_SECRET,
    ...(env.API_KEY_PEPPER ? { apiKeyPepper: env.API_KEY_PEPPER } : {}),
    ...(env.CONSOLE_JWT_SECRET ? { consoleJwtSecret: env.CONSOLE_JWT_SECRET } : {}),
    ...(env.SUPER_ADMIN_JWT_SECRET ? { superAdminJwtSecret: env.SUPER_ADMIN_JWT_SECRET } : {}),
    ...(env.CORS_ALLOWED_ORIGINS
      ? {
          corsOrigins: env.CORS_ALLOWED_ORIGINS.split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        }
      : {}),
  });
}
