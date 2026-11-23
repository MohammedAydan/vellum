#!/usr/bin/env node
/**
 * Zero-dependency static file server for the generated documentation site.
 * Used by `frontend-gateway.mjs --mode=dev` as the 127.0.0.1:5175 upstream.
 * Serves only apps/docs/dist — never falls back to index.html for assets.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySecurityHeaders, applyCacheHeaders, MIME_TYPES } from "./frontend-gateway.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "apps", "docs", "dist");
const PORT = Number(process.env.DOCS_DEV_PORT || 5175);
const HOST = "127.0.0.1";

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeRelative(input) {
  return path
    .normalize(input)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
}

function send(res, status, filePath, pathname) {
  if (!isFile(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 Not Found: ${pathname}\n`);
    return;
  }
  applyCacheHeaders(res, pathname);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(status, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("400 Bad Request\n");
    return;
  }

  const rel = safeRelative(pathname);
  const direct = path.join(DIST, rel);
  if (rel === "" || pathname.endsWith("/")) {
    return send(res, 200, path.join(DIST, "index.html"), pathname);
  }
  if (isFile(direct)) return send(res, 200, direct, pathname);
  // Pretty URLs: /guide -> guide.html, then guide/index.html.
  if (isFile(`${direct}.html`)) return send(res, 200, `${direct}.html`, pathname);
  if (isFile(path.join(direct, "index.html"))) {
    return send(res, 200, path.join(direct, "index.html"), pathname);
  }
  // React docs SPA: extensionless client-side routes fall back to the app
  // entry point. Missing assets still 404 — never fall back for files.
  if (!path.extname(rel)) {
    return send(res, 200, path.join(DIST, "index.html"), pathname);
  }
  return send(res, 404, path.join(DIST, "__missing__"), pathname);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[docs-dev] Port ${PORT} is already in use. Stop that process or set DOCS_DEV_PORT.`);
  } else {
    console.error(`[docs-dev] Server error: ${err.message}`);
  }
  process.exit(1);
});

if (!isFile(path.join(DIST, "index.html"))) {
  console.error("[docs-dev] apps/docs/dist/index.html is missing — build @vellum/docs first.");
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`[docs-dev] serving apps/docs/dist on http://${HOST}:${PORT}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
