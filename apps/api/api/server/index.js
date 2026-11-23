/**
 * Vellum backend Vercel Function entry.
 *
 * Vercel pre-parses POST bodies into `req.body` and leaves the Node request
 * stream un-ended, so Hono's Node adaptor cannot read them. Call the platform's
 * Web-standard `fetch` directly instead. Rewrites pass the original `/v1/...`
 * path as a `?path=` query because Vercel cannot route a multi-segment rewrite
 * destination to a single-segment Function.
 */
import { createVellumPlatformFromEnv } from "../../dist/index.js";

const platform = await createVellumPlatformFromEnv();

const ALLOWED_VERCEL_ORIGINS = new Set([
  "https://vellum-console.vercel.app",
  "https://vellum-console-mag-1.vercel.app",
]);

export default async function handler(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const target = url.searchParams.get("path") || "/";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, String(item));
    else if (value !== undefined && value !== null) headers.set(key, String(value));
  }

  const init = { method: req.method || "GET", headers };
  if (!["GET", "HEAD"].includes(init.method)) {
    const body = req.body;
    if (body !== undefined && body !== null) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  let response;
  try {
    response = await platform.fetch(new Request(new URL(target, "http://localhost"), init));
  } catch (err) {
    response = new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", reason: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  const origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_VERCEL_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.end(Buffer.from(await response.arrayBuffer()));
}
