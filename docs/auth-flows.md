# Authentication & Authorization Architecture

Document Database SaaS implements a multi-tiered security model separating platform developers, application workloads, and end-users.

---

## 1. Multi-Tier Security Overview

```mermaid
flowchart TD
    subgraph Tier1["Tier 1: Developer / Platform Session"]
        User["Developer / Operator"] -->|Better Auth /v1/auth/*| ControlDB[("control_db (users, orgs, sessions)")]
    end

    subgraph Tier2["Tier 2: Workload Authentication"]
        AppClient["Browser / Mobile Client"] -->|"X-Project-Key: pk_..."| GateKeeper{"API Gateway"}
        AppServer["Backend Service / Worker"] -->|"X-Project-Key: sk_..."| GateKeeper
        GateKeeper -->|Constant-Time SHA-256 + 30s Cache| ControlKeys[("control_db (api_keys)")]
    end

    subgraph Tier3["Tier 3: End-User Identity & AST Authorization"]
        EndUser["End-User Client"] -->|"Authorization: Bearer <JWT>"| GateKeeper
        GateKeeper -->|jose Remote JWKS / HMAC| AuthContext["Auth Context (uid, claims)"]
        AuthContext -->|In-Memory Synchronous Evaluation| AST["Security Rules AST Evaluator"]
        AST -->|"Allow / Deny"| DataDB[("data_db (documents, indexes)")]
    end
```

---

## 2. Tier 1: Developer & Organization Management (Better Auth)

Platform operators and customer developers authenticate using **Better Auth** mounted directly on Hono at `/v1/auth/*`.
- **Session Store:** Persisted in `control_db.users` and session tables.
- **Organization Plugin:** Enables multi-tenant team management, roles (`owner`, `admin`, `developer`, `billing_viewer`), and project ownership.
- **Zero Document Leakage:** Developer sessions never grant implicit bypass to customer document data in `data_db`.

---

## 3. Tier 2: Workload API Keys (`pk_` vs. `sk_`)

Workload requests authenticate using the `X-Project-Key` HTTP header (or WebSocket `auth` frame).

| Property | Public Key (`pk_`) | Server Key (`sk_`) |
| :--- | :--- | :--- |
| **Format** | `pk_<32-chars-base62>` | `sk_<48-chars-base62>` |
| **Target Clients** | Web apps, iOS/Android apps, IoT devices | Backend servers, microservices, Lambda functions |
| **Rule Evaluation** | **Unconditionally evaluates** active Security Rules AST | **Bypasses AST** if holding required scopes |
| **Scopes** | Restricted to document operations governed by AST | `documents:read`, `documents:write`, `indexes:manage` |
| **Index Management** | Prohibited (`403 PERMISSION_DENIED`) | Allowed |

### Security Invariants:
1. **Plaintext Secrets Never Stored:** Only a 16-character prefix `key_prefix` and a peppered SHA-256 hash `secret_hash` are persisted.
2. **Timing Attack Protection:** Hash comparison executes using `crypto.timingSafeEqual` in constant time.
3. **Low-Latency Verification:** Verified key records are cached in memory for 30 seconds (`VERIFIED_KEY_CACHE`), expiring automatically and invalidated immediately on key revocation.

---

## 4. Tier 3: End-User JWT Verification & Security Rules AST

When public keys (`pk_`) access documents, the request may supply an end-user identity token:
```http
X-Project-Key: pk_38d8f92193...
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Verification Pipeline:
1. **JWKS Resolution:** The API Gateway queries `projects.jwtJwksUrl` using `jose.createRemoteJWKSet` with HTTP caching and signature verification.
2. **Context Extraction:** The verified payload populates `authContext = { uid: payload.sub, claims: payload }`.
3. **AST Evaluation:** The active versioned ruleset AST from `control_db.security_rulesets` is evaluated synchronously in-memory:
   - **Zero `eval()`:** No dynamic code generation or untrusted code execution.
   - **Quotas:** Maximum AST depth $\le 10$, maximum node count $\le 100$.
   - **Evaluation Context:**
     ```typescript
     interface RuleEvaluationContext {
       auth: { uid: string | null; claims: Record<string, unknown> };
       pathParams: Record<string, string>;
       resourceData: Record<string, unknown> | null;
       requestData: Record<string, unknown> | null;
       requestTimeMs: number;
     }
     ```
4. **Evaluation Modes:**
   - If rule evaluates to `true` $\rightarrow$ operation allowed.
   - If rule evaluates to `false` or matches no rule $\rightarrow$ `403 PERMISSION_DENIED`.

---

## 5. Audit Logging Invariant

Every Control Plane mutation (`organization.created`, `project.created`, `api_key.created`, `api_key.revoked`, `ruleset.published`) synchronously writes an append-only row to `control_db.audit_logs`:
- `actorUserId`: The authenticated user ID (or `null` for API key).
- `actorType`: `"user"` | `"api_key"` | `"system"`.
- `organizationId`, `projectId`.
- `action`: Canonical action string.
- `metadata`: Sanitized JSON payload (secrets and passwords excluded).
- `ipAddress` & `userAgent`: Client provenance.
- `createdAt`: Tamper-proof UTC timestamp.
