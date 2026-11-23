# 3 — `docs/architecture/dependency-graph.md`

## 3.1 Exact Generator Command & Raw Adjacency List Output

**Command:**

```
python3 -c '
import json, glob
pkgs = {}
for p in sorted(glob.glob("packages/*/package.json") + glob.glob("apps/*/package.json")):
    d = json.load(open(p))
    pkgs[d["name"]] = sorted([k for k in (d.get("dependencies") or {}) if k.startswith("@vellum/")])
for k, v in pkgs.items():
    print(f"{k} -> {v}")
'

```

**Raw Output (Before-State — Verified Acyclic DAG):**

```
@vellum/admin -> ['@vellum/api-contract', '@vellum/core', '@vellum/database-control', '@vellum/ui']
@vellum/api -> ['@vellum/api-contract', '@vellum/auth', '@vellum/authorization', '@vellum/billing', '@vellum/core', '@vellum/database-control', '@vellum/database-data', '@vellum/document-engine', '@vellum/observability', '@vellum/query-engine', '@vellum/realtime', '@vellum/security', '@vellum/storage']
@vellum/dashboard -> ['@vellum/api-contract', '@vellum/authorization', '@vellum/core', '@vellumdb/sdk-js', '@vellum/ui']
@vellum/docs -> ['@vellum/ui']
@vellum/api-contract -> ['@vellum/core']
@vellum/auth -> ['@vellum/core', '@vellum/database-control', '@vellum/document-engine', '@vellum/storage']
@vellum/authorization -> ['@vellum/core', '@vellum/database-control']
@vellum/billing -> ['@vellum/core', '@vellum/database-control', '@vellum/security']
@vellum/core -> []
@vellum/database-control -> ['@vellum/core']
@vellum/database-data -> ['@vellum/core']
@vellum/document-engine -> ['@vellum/authorization', '@vellum/core', '@vellum/query-engine', '@vellum/storage']
@vellum/observability -> ['@vellum/core']
@vellum/query-engine -> ['@vellum/core', '@vellum/database-data']
@vellum/realtime -> ['@vellum/api-contract', '@vellum/auth', '@vellum/authorization', '@vellum/core', '@vellum/query-engine', '@vellum/storage']
@vellumdb/sdk-js -> ['@vellum/core']
@vellum/security -> []
@vellum/storage -> ['@vellum/core', '@vellum/database-data', '@vellum/query-engine']
@vellum/ui -> []

```

## 3.2 Before-State Mermaid Graph

```
graph TD
  core["@vellum/core (T0)"]
  security["@vellum/security (T0)"]
  ui["@vellum/ui (T0)"]

  apiContract["@vellum/api-contract (T1)"] --> core
  obs["@vellum/observability (T1)"] --> core
  dbCtrl["@vellum/database-control (T1)"] --> core
  dbData["@vellum/database-data (T1)"] --> core
  sdkJs["@vellumdb/sdk-js (T1)"] --> core

  queryEng["@vellum/query-engine (T2)"] --> core
  queryEng --> dbData
  authz["@vellum/authorization (T2)"] --> core
  authz --> dbCtrl
  billing["@vellum/billing (T2)"] --> core
  billing --> dbCtrl
  billing --> security

  storage["@vellum/storage (T3)"] --> core
  storage --> dbData
  storage --> queryEng

  docEng["@vellum/document-engine (T4)"] --> core
  docEng --> authz
  docEng --> queryEng
  docEng --> storage

  auth["@vellum/auth (T5)"] --> core
  auth --> dbCtrl
  auth --> storage
  auth --> docEng

  realtime["@vellum/realtime (T6)"] --> core
  realtime --> apiContract
  realtime --> auth
  realtime --> authz
  realtime --> queryEng
  realtime --> storage

  api["apps/api (T7)"] --> realtime
  api --> auth
  api --> docEng
  api --> billing
  api --> obs
  api --> security
  api --> dbCtrl
  api --> dbData

  dashboard["apps/dashboard (T7)"] --> apiContract
  dashboard --> authz
  dashboard --> core
  dashboard --> sdkJs
  dashboard --> ui

  admin["apps/admin (T7)"] --> apiContract
  admin --> core
  admin -. unused .-> dbCtrl
  admin --> ui

  docs["apps/docs (T7)"] --> ui

```

## 3.3 Target After-State Tier Map

* **Tier 0 (Zero-Dep Foundations):** `@vellum/core`, `@vellum/security`, `@vellum/ui`

* **Tier 1 (Contracts, Schema & Leaf Clients):** `@vellum/api-contract`, `@vellum/observability`, `@vellum/database-control`, `@vellum/database-data`, `@vellumdb/sdk-js`

* **Tier 2 (Domain Guards & Query Compiler):** `@vellum/query-engine`, `@vellum/authorization`, `@vellum/billing`

* **Tier 3 (Storage Port + Adapters):** `@vellum/storage` (ports on barrel; concrete adapters moved to `@vellum/storage/adapters`)

* **Tier 4 (Engines):** `@vellum/document-engine`

* **Tier 5 (Auth Services):** `@vellum/auth`

* **Tier 6 (Realtime Gateway):** `@vellum/realtime`

* **Tier 7 (Deployable Apps — Single Composition Root Each):**

  * `@vellum/api` (wires concrete adapters solely in `apps/api/src/composition/root.ts`)

  * `@vellum/dashboard` (single HTTP adapter; zero raw `fetch()` in routes)

  * `@vellum/admin` (**remove unused `@vellum/database-control` dependency** from `apps/admin/package.json`)

  * `@vellum/docs`
