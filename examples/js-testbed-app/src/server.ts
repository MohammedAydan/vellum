/**
 * Zero-build dashboard for the live JS SDK testbed.
 *
 * Serves one HTML page with a row per scenario. Every button triggers the SAME
 * scenario functions used by `verify-live.ts` (from `scenarios.ts`), so the UI
 * and the CLI can never drift. No React build step, no bundler, no mocks.
 */
import http from "node:http";
import { bootstrap } from "./bootstrap.js";
import {
  createScenarioContext,
  redact,
  runAll,
  runById,
  SCENARIOS,
  type ScenarioContext,
  type ScenarioResult,
} from "./scenarios.js";

const PORT = Number(process.env["PORT"] ?? "8081");

let context: ScenarioContext | null = null;
let bootstrapError: string | null = null;

async function getContext(): Promise<ScenarioContext> {
  if (context) return context;
  if (bootstrapError) throw new Error(bootstrapError);
  try {
    const base = await bootstrap();
    context = createScenarioContext(base);
    return context;
  } catch (error: unknown) {
    bootstrapError = redact(error instanceof Error ? error.message : String(error));
    throw new Error(bootstrapError);
  }
}

function rows(): string {
  return SCENARIOS.map(
    (scenario) =>
      '<tr id="row-' +
      scenario.id +
      '"><td class="num">' +
      scenario.id +
      "</td><td>" +
      scenario.name +
      '</td><td class="status">pending</td><td class="latency">—</td>' +
      '<td><button data-id="' +
      scenario.id +
      '">Run</button></td></tr>'
  ).join("\n");
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vellum JS SDK — live testbed</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3; --muted:#8b949e; --pass:#3fb950; --fail:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  main { max-width:980px; margin:40px auto; padding:0 20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 24px; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:16px; }
  button { background:#21262d; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  button:hover { background:#30363d; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; }
  tr:last-child td { border-bottom:0; }
  .num { width:36px; color:var(--muted); }
  .status { width:72px; font-weight:700; }
  .latency { width:90px; color:var(--muted); text-align:right; }
  .PASS { color:var(--pass); }
  .FAIL { color:var(--fail); }
  .pending { color:var(--muted); }
  .err { color:var(--fail); font-size:12px; }
  #summary { margin-top:14px; color:var(--muted); }
  #boot { color:var(--fail); min-height:20px; }
</style>
</head>
<body>
<main>
  <h1>Vellum JS SDK — live verification</h1>
  <p class="sub">Real API only. No mocks, no skips. Credentials are never displayed or logged.</p>
  <div class="bar">
    <button id="bootstrap">1. Bootstrap tenant</button>
    <button id="runall" disabled>2. Run all 16</button>
    <span id="boot">not bootstrapped</span>
  </div>
  <table>
    <thead><tr><th>#</th><th>Scenario</th><th>Status</th><th>Latency</th><th>Action</th></tr></thead>
    <tbody>
__ROWS__
    </tbody>
  </table>
  <div id="summary"></div>
</main>
<script>
(function () {
  var busy = false;
  var allButtons = Array.prototype.slice.call(document.querySelectorAll('button'));

  function setBusy(value) {
    busy = value;
    allButtons.forEach(function (b) { b.disabled = value; });
    if (!value) {
      document.getElementById('runall').disabled = document.getElementById('boot').textContent !== 'ready';
    }
  }

  function row(id) { return document.getElementById('row-' + id); }

  function show(result) {
    var tr = row(result.id);
    if (!tr) return;
    var status = tr.querySelector('.status');
    var latency = tr.querySelector('.latency');
    status.textContent = result.status;
    status.className = 'status ' + result.status;
    latency.textContent = result.latencyMs + ' ms';
    var old = tr.parentNode.querySelector('.err-row-' + result.id);
    if (old) old.parentNode.removeChild(old);
    if (result.error) {
      var detail = document.createElement('tr');
      detail.className = 'err-row-' + result.id;
      var cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'err';
      cell.textContent = result.error;
      detail.appendChild(cell);
      tr.parentNode.insertBefore(detail, tr.nextSibling);
    }
  }

  function refreshSummary() {
    var statuses = Array.prototype.map.call(document.querySelectorAll('.status'), function (n) { return n.textContent; });
    var pass = statuses.filter(function (s) { return s === 'PASS'; }).length;
    var fail = statuses.filter(function (s) { return s === 'FAIL'; }).length;
    document.getElementById('summary').textContent = pass + ' passed, ' + fail + ' failed, ' + (statuses.length - pass - fail) + ' pending.';
  }

  async function post(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  document.getElementById('bootstrap').addEventListener('click', async function () {
    if (busy) return;
    setBusy(true);
    document.getElementById('boot').textContent = 'bootstrapping…';
    try {
      await post('/api/bootstrap');
      document.getElementById('boot').textContent = 'ready';
      document.getElementById('runall').disabled = false;
    } catch (e) {
      document.getElementById('boot').textContent = String(e && e.message ? e.message : e);
    } finally { setBusy(false); }
  });

  document.querySelectorAll('button[data-id]').forEach(function (button) {
    button.addEventListener('click', async function () {
      if (busy) return;
      var id = Number(button.getAttribute('data-id'));
      setBusy(true);
      var tr = row(id);
      tr.querySelector('.status').textContent = 'running';
      tr.querySelector('.status').className = 'status pending';
      try {
        show(await post('/api/run', { id: id }));
      } catch (e) {
        show({ id: id, status: 'FAIL', latencyMs: 0, error: String(e && e.message ? e.message : e) });
      } finally { setBusy(false); refreshSummary(); }
    });
  });

  document.getElementById('runall').addEventListener('click', async function () {
    if (busy) return;
    setBusy(true);
    try {
      var results = await post('/api/run-all');
      results.forEach(show);
    } catch (e) {
      document.getElementById('boot').textContent = String(e && e.message ? e.message : e);
    } finally { setBusy(false); refreshSummary(); }
  });
})();
</script>
</body>
</html>`;

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = (request.url ?? "/").split("?")[0] ?? "/";

  if (request.method === "GET" && url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(HTML.replace("__ROWS__", rows()));
    return;
  }

  if (request.method === "POST" && url === "/api/bootstrap") {
    await getContext();
    sendJson(response, 200, { ready: true });
    return;
  }

  if (request.method === "POST" && url === "/api/run") {
    const body = (await readBody(request)) || "{}";
    const parsed = JSON.parse(body) as { id?: number };
    const result: ScenarioResult = await runById(await getContext(), Number(parsed.id));
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url === "/api/run-all") {
    const results = await runAll(await getContext());
    sendJson(response, 200, results);
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) sendJson(response, 500, { error: message });
    else response.end();
  });
});

server.listen(PORT, () => {
  console.log(`Vellum JS SDK live testbed dashboard: http://127.0.0.1:${PORT}`);
});
