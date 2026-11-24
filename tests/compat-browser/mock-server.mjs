/**
 * Mock realtime host for the real-browser SDK compatibility tests.
 *
 *   /ws/...    WebSocket upgrade works, plus SSE.
 *   /nows/...  WebSocket upgrade is refused (like Vercel Functions), SSE works.
 *
 * It also serves the page and the SDK bundle built from packages/sdk-js/dist.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.COMPAT_PORT ?? 4510);

const bundle = await build({
  entryPoints: [path.join(root, "packages/sdk-js/dist/index.js")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "VellumSdk",
  platform: "browser",
  target: "es2020",
  external: ["ws"],
  logLevel: "error",
});
const bundleJs = bundle.outputFiles[0].text;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>compat</title></head><body><script src="/sdk.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" }).end(page);
    return;
  }
  if (url.pathname === "/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/v1/realtime/stream")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" });
      res.write(': stream-open\n\ndata: {"type":"auth_ack","status":"authenticated","connectionId":"c1"}\n\n');
      // A second frame much later proves the body is delivered incrementally.
      const t1 = setTimeout(() => {
        res.write('id: 1\ndata: {"type":"mutation","subId":"s1","seqId":1,"operation":"create","document":{}}\n\n');
      }, 1500);
      const t2 = setInterval(() => res.write(": keep-alive\n\n"), 500);
      res.on("close", () => {
        clearTimeout(t1);
        clearInterval(t2);
      });
    });
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/ws/")) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "auth") ws.send(JSON.stringify({ type: "auth_ack", status: "authenticated", connectionId: "w1" }));
    });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`compat mock listening on ${PORT}`));
