/**
 * Backend-only Vercel catch-all Function entry point.
 *
 * This canonical copy lives INSIDE the backend Vercel project rootDirectory
 * (`apps/api`), so the `vellum-api` project deploys independently of the
 * frontend. It re-exports the same `createVellumApp` core used by the standalone
 * Node and Cloudflare adapters — there is no separate backend implementation.
 * `vercel.json` rewrites `/v1/*` (and `/health` / `/ready`) here so the browser
 * keeps the canonical same-origin `/v1` URL.
 */
export { default } from "../../dist/runtime/vercel.js";
