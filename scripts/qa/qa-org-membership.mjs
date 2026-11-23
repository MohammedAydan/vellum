const base = "http://127.0.0.1:8080";
const login = await fetch(`${base}/v1/auth/sign-in/email`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());
const h = { "content-type": "application/json", authorization: `Bearer ${login.token}` };
const slug = `membership-proof-${Date.now()}`;
const create = await fetch(`${base}/v1/organizations`, {
  method: "POST", headers: h,
  body: JSON.stringify({ name: "Membership Proof", slug, planTier: "free" }),
});
const created = await create.json();
const list = await fetch(`${base}/v1/console/organizations`, { headers: h }).then((r) => r.json());
console.log(JSON.stringify({ createStatus: create.status, listedAfterCreate: list.some((o) => o.id === created.id), orgCount: list.length }));
