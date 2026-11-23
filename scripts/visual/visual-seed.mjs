const base = "http://127.0.0.1:8080";
const call = async (path, init = {}, token) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const auth = await call("/v1/auth/sign-in/email", {
  method: "POST",
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
});
const token = auth.token;
const orgs = await call("/v1/console/organizations", {}, token);
const projects = await call(`/v1/console/organizations/${orgs[0].id}/projects`, {}, token);
const projectId = projects[0].id;
const key = await call(`/v1/console/projects/${projectId}/api-keys`, {
  method: "POST",
  body: JSON.stringify({ name: "Visual review key", keyType: "server" }),
}, token);

const docs = [
  ["users/usr_101", { name: "Ada Lovelace", email: "ada@example.com", role: "admin", active: true, age: 36, tags: ["pioneer", "algorithm"] }],
  ["users/usr_102", { name: "Grace Hopper", email: "grace@example.com", role: "engineer", active: true, age: 42, tags: ["compiler", "navy"] }],
  ["users/usr_103", { name: "Alan Turing", email: "alan@example.com", role: "researcher", active: false, age: 41, tags: ["computing", "codebreaking"] }],
  ["orders/ord_1001", { customer: "usr_101", total: 249.5, currency: "USD", status: "paid", items: 3 }],
  ["orders/ord_1002", { customer: "usr_102", total: 89.0, currency: "USD", status: "pending", items: 1 }],
  ["products/prod_01", { name: "Analyst Seat", price: 29, unit: "month", active: true }],
  ["products/prod_02", { name: "Team Workspace", price: 99, unit: "month", active: true }],
];

let written = 0;
for (const [docPath, data] of docs) {
  const res = await fetch(`${base}/v1/projects/${projectId}/documents/${docPath}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-project-key": key.rawKey },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`PUT ${docPath} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  written += 1;
}
console.log(JSON.stringify({ projectId, keyPrefix: key.apiKey.keyPrefix, written }));
