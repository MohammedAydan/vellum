/**
 * The master prompt for AI coding assistants. One source: rendered on the
 * "AI agents" page and written to /docs/agent-prompt.md and /docs/AGENTS.md
 * at build time, so the copy button, the page and the files never drift.
 */
export const DEFAULT_DOCS_ORIGIN = "https://vellum-console.vercel.app";

export function buildAgentPrompt(origin: string = DEFAULT_DOCS_ORIGIN): string {
  const docs = `${origin.replace(/\/$/, "")}/docs`;
  return `# Building with VELLUM

VELLUM is a PostgreSQL-native document database with a Firestore-style API: collections and documents, queries, composite indexes, security rules, end-user auth and realtime. You build against it with an official SDK or plain HTTP.

## Read the docs first

- Index of every page, as Markdown: ${docs}/llms.txt
- Everything in one file: ${docs}/llms-full.txt
- Any page as Markdown: append .md to its URL, for example ${docs}/query.md
- OpenAPI 3.1 for the HTTP API: ${docs}/openapi.json

Fetch the page for the task before you write code. Do not guess method names, operators or error codes. If the docs do not say it, say you are unsure.

## SDKs

- TypeScript / JavaScript: npm package @vellumdb/sdk-js. Docs: ${docs}/sdks/javascript.md
- Flutter / Dart: pub.dev package vellum_flutter (one package, everything included). Docs: ${docs}/sdks/flutter.md

## Connect

- endpoint is the API origin only, for example https://api.example.com. Never add /v1 or /auth. The SDK adds /v1/projects/PROJECT_ID.
- Over HTTP, send the key in the x-vellum-api-key header.
- Server code uses an sk_ key. Browser and mobile apps use a pk_ publishable key together with end-user sign-in. Never put an sk_ key in client code.
- Read the endpoint, project id and key from environment variables or build-time config. Never hard-code or print a key.

\`\`\`ts
import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: process.env.VELLUM_ENDPOINT!,
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_API_KEY!,
});

const ref = db.collection("tasks").doc("task_01");
await ref.set({ title: "Write docs", status: "open", createdAt: fieldOp.serverTimestamp() });
const snap = await ref.get();
await ref.update({ priority: fieldOp.increment(1) }, { ifVersion: snap.version });
const open = await db.collection("tasks").where("status", "==", "open").orderBy("createdAt", "desc").limit(20).get();
db.dispose(); // when the client is no longer needed
\`\`\`

## Rules that prevent most mistakes

- Paths alternate collection/document: users/u1 is a document, users/u1/orders is a collection.
- Use fieldOp sentinels (serverTimestamp, increment, arrayUnion and others) for atomic changes. Do not read, modify and write.
- Guard concurrent writes with ifVersion. Use batch writes or transactions for multi-document changes.
- Queries that combine filters with ordering can need a composite index. Read ${docs}/indexes.md and ${docs}/smart-indexing.md before adding one.
- Page large results with the returned cursor. Do not use offsets.
- Access is decided by security rules and the key type. Read ${docs}/security-rules.md before you write rules.
- End users sign in through db.auth (email and password, anonymous, or a provider token). Read ${docs}/end-user-auth.md.
- Realtime uses WebSocket with an automatic fallback. Read ${docs}/realtime.md.
- Handle errors by their canonical code and retry only where ${docs}/reference/errors.md says it is safe.
- Respect the quotas in ${docs}/errors-and-limits.md.

## When you are done

Say which docs pages you relied on, which parts you ran against a real project and which you did not.
`;
}

export const AGENT_PROMPT = buildAgentPrompt();
