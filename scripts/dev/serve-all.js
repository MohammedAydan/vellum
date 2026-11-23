#!/usr/bin/env node
/**
 * Unified Multi-Service Runner for Document Database SaaS (`scripts/serve-all.js`)
 * Starts:
 *   - API Server (REST + WebSocket Gateway) on Port 8080
 *   - Customer Developer Dashboard (SPA) on Port 5173
 *   - Platform Owner Admin Console (SPA) on Port 5174
 *   - UI Storybook Component Catalog on Port 6006
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function createStaticSpaServer(distDir, port, name) {
  const indexHtml = fs.readFileSync(path.join(distDir, "index.html"));

  const server = http.createServer((req, res) => {
    // Add CORS headers for tunnel / cross-origin flexibility
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Proxy API requests to backend API server on port 8080
    if (req.url && (req.url.startsWith("/v1/") || req.url.startsWith("/api/"))) {
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: 8080,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: "127.0.0.1:8080",
            "x-forwarded-host": req.headers.host || "",
            "x-forwarded-proto": req.headers["x-forwarded-proto"] || "http",
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        console.error(`[vellum] Proxy error for ${req.url}:`, err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
      });
      req.pipe(proxyReq);
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    // Prevent directory traversal
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = path.join(distDir, safePath);

    // If requesting directory, look for index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: return index.html for non-asset routes
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml);
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url && req.url.startsWith("/v1/")) {
      const proxyReq = http.request({
        port: 8080,
        host: "127.0.0.1",
        method: "GET",
        path: req.url,
        headers: req.headers,
      });
      proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.entries(proxyRes.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n") +
            "\r\n\r\n"
        );
        if (proxyHead && proxyHead.length) socket.write(proxyHead);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on("error", () => socket.destroy());
      proxyReq.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`[vellum] ${name} listening on http://0.0.0.0:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

async function main() {
  console.log("============================================================");
  console.log("   Document Database SaaS — Production Service Stack");
  console.log("============================================================");

  // 1. Start API Server (Node process)
  console.log("[vellum] Launching API Server on port 8080...");
  const apiProc = spawn("node", ["apps/api/dist/node-server.js"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: { ...process.env, API_PORT: "8080", API_HOST: "0.0.0.0" },
  });

  apiProc.on("error", (err) => {
    console.error("[vellum] Failed to start API Server:", err);
  });

  // 2. Start Customer Developer Dashboard SPA (Port 5173)
  const dashboardDist = path.join(ROOT_DIR, "apps/dashboard/dist");
  const dashboardServer = await createStaticSpaServer(dashboardDist, 5173, "Customer Developer Dashboard");

  // 3. Start Platform Admin Console SPA (Port 5174)
  const adminDist = path.join(ROOT_DIR, "apps/admin/dist");
  const adminServer = await createStaticSpaServer(adminDist, 5174, "Platform Owner Admin Console");

  // 4. Start Storybook UI Catalog (Port 6006)
  const storybookDist = path.join(ROOT_DIR, "packages/ui/storybook-static");
  const storybookServer = await createStaticSpaServer(storybookDist, 6006, "UI Storybook Catalog");

  console.log("\n============================================================");
  console.log("  ALL SERVICES RUNNING SUCCESSFULLY (0.0.0.0)");
  console.log("  ----------------------------------------------------------");
  console.log("  * API REST & WebSocket:   http://localhost:8080");
  console.log("  * Customer Dashboard:     http://localhost:5173");
  console.log("  * Platform Admin:         http://localhost:5174");
  console.log("  * UI Storybook:           http://localhost:6006");
  console.log("============================================================\n");

  const cleanup = () => {
    console.log("\n[vellum] Shutting down services...");
    apiProc.kill("SIGTERM");
    dashboardServer.close();
    adminServer.close();
    storybookServer.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("[vellum] Startup failure:", err);
  process.exit(1);
});
