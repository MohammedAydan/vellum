// Starts the Vellum API from the repo build for the harsh suite.
// The per-key 100 rps limiter is disabled here (LOCAL TESTING ONLY) so the stress suite measures
// correctness rather than throttling. Run: node --env-file=<local.env> start-local-api.mjs
import { createVellumPlatformFromEnv } from "../../apps/api/dist/index.js";
import { startNodeApiServer } from "../../apps/api/dist/node-server.js";
if (!/127\.0\.0\.1|localhost/.test(process.env.CONTROL_DATABASE_URL ?? "")) throw new Error("refusing: control DB is not local");
const platform = await createVellumPlatformFromEnv();
platform.rateLimiter.checkAndConsume = () => {};
// Short worker interval (LOCAL TESTING ONLY) so the index-builder worker flips freshly
// created composite indexes from 'building' to 'ready' quickly; the production default is 30s.
const server = await startNodeApiServer({ platform, port: Number(process.env.API_PORT ?? 18080), workerIntervalMs: 200 });
console.log("listening", server.port);
