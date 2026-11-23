const base = "http://127.0.0.1:8080";
const login = await fetch(`${base}/v1/auth/sign-in/email`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());
const h = { "content-type": "application/json", authorization: `Bearer ${login.token}` };
const call = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...h, ...(init.headers || {}) } });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

const orgs = (await call("/v1/console/organizations")).body;
const projects = (await call(`/v1/console/organizations/${orgs[0].id}/projects`)).body;
const pid = projects[0].id;
const p = `/v1/console/projects/${pid}`;
const out = {};

const key = await call(`${p}/api-keys`, { method: "POST", body: JSON.stringify({ name: "QA probe key", keyType: "server" }) });
out.apiKey = { create: key.status, listed: (await call(`${p}/api-keys`)).body.some((k) => k.id === key.body?.apiKey?.id) };
if (key.body?.apiKey?.id) await call(`${p}/api-keys/${key.body.apiKey.id}`, { method: "DELETE" });

const idx = await call(`${p}/indexes`, { method: "POST", body: JSON.stringify({ collectionPath: "qa_probe", fields: [{ path: "created", dir: "asc" }] }) });
const idxList = await call(`${p}/indexes`);
// 409 ALREADY_EXISTS is correct for a duplicate definition on repeated runs.
out.index = { create: idx.status, duplicateIsConflict: idx.status === 201 || idx.status === 409, listed: idx.status === 201 ? (Array.isArray(idxList.body?.indexes) ? idxList.body.indexes.some((i) => i.id === idx.body?.id) : JSON.stringify(idxList.body).includes(String(idx.body?.id))) : "already exists" };

const rules = await call(`${p}/rulesets`, { method: "POST", body: JSON.stringify({ rulesAst: { version: 1, rules: [] } }) });
out.ruleset = { create: rules.status, listed: JSON.stringify((await call(`${p}/rulesets`)).body).includes(String(rules.body?.id)) };

const doc = await call(`${p}/documents/qa_probe/item1`, { method: "PUT", body: JSON.stringify({ data: { ok: true } }) });
out.document = { create: doc.status, listed: JSON.stringify((await call(`${p}/documents/qa_probe`)).body).includes("item1") };
if (doc.status === 200) await call(`${p}/documents/qa_probe/item1`, { method: "DELETE" });

console.log(JSON.stringify(out));
