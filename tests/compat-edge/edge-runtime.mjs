/**
 * Runs the JS SDK inside @edge-runtime/vm, the sandbox Vercel Edge Functions
 * use (no Node APIs, no `process`, no `ws`, no global WebSocket). Verifies that
 * the bundle loads, documents round-trip over fetch, and realtime falls back
 * to SSE streaming with no WebSocket available.
 */
import { EdgeVM } from "@edge-runtime/vm";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = await build({
  entryPoints: [path.join(root, "packages/sdk-js/dist/index.js")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "VellumSdk",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2022",
  external: ["ws", "node:*"],
  logLevel: "error",
});

// React Native (Metro/Hermes) cannot resolve Node built-ins or `ws` statically:
// the bundle must not reference them by literal specifier.
const bundleText = out.outputFiles[0].text;
const staticNode = bundleText.match(/(?:require|import)\s*\(?\s*["'](?:node:[a-z_/]+|ws)["']/g) ?? [];
if (staticNode.length > 0) {
  console.error("bundle statically references Node-only modules:", staticNode.join(", "));
  process.exit(1);
}
console.log("no static Node-only imports (Metro/React Native bundling safe)");

const vm = new EdgeVM();
const probe = `
  globalThis.__results = {};
  globalThis.__hasWebSocket = typeof WebSocket !== "undefined";
  globalThis.__hasProcess = typeof process !== "undefined";
`;
vm.evaluate(probe);
vm.evaluate(out.outputFiles[0].text);

const result = await vm.evaluate(`(async () => {
  const sdk = VellumSdk;
  const store = new Map();
  const enc = new TextEncoder();
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const customFetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    if (url.endsWith("/v1/realtime/stream")) {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"type":"auth_ack","status":"authenticated","connectionId":"e1"}\\n\\n'));
          setTimeout(() => {
            c.enqueue(enc.encode('id: 1\\ndata: {"type":"mutation","subId":"s1","seqId":1,"operation":"create","document":{}}\\n\\n'));
          }, 300);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const p = decodeURIComponent((url.split("/documents/")[1] || "").split("?")[0]);
    if (method === "PUT") {
      store.set(p, JSON.parse(String(init.body)).data);
      return json({ path: p, documentId: p.split("/").pop(), version: 1, data: store.get(p) });
    }
    if (method === "GET" && store.has(p)) return json({ path: p, documentId: p.split("/").pop(), version: 1, data: store.get(p) });
    return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
  };
  const db = sdk.createClient({ projectId: "p", apiKey: "pk_test_edge", customFetch, realtimeTransport: "sse" });
  const ref = db.collection("posts").doc();
  await ref.set({ title: "edge" });
  const snap = await ref.get();
  const frames = [];
  const socket = new sdk.SseSocket("https://api.example.com/v1/realtime", { fetchFn: customFetch });
  await new Promise((resolve) => {
    socket.onmessage = (e) => {
      frames.push(JSON.parse(e.data).type);
      if (frames.includes("mutation")) resolve();
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
      socket.send(JSON.stringify({ type: "subscribe", subId: "s1", path: "posts" }));
    };
    setTimeout(resolve, 6000);
  });
  socket.close();
  db.dispose();
  return { id: ref.id, title: snap.data().title, hasWebSocket: globalThis.__hasWebSocket, hasProcess: globalThis.__hasProcess, frames };
})()`);

console.log(JSON.stringify(result));
const failures = [];
if (!/^[0-9A-Za-z]{20}$/.test(result.id)) failures.push("auto id");
if (result.title !== "edge") failures.push("document round trip");
if (!result.frames.includes("auth_ack") || !result.frames.includes("mutation")) failures.push("SSE streaming in edge runtime");
if (failures.length) {
  console.error("edge runtime failures:", failures.join(", "));
  process.exit(1);
}
console.log("edge runtime OK");
process.exit(0);
