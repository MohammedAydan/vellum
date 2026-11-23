import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createClient } from "@vellumdb/sdk-js";
import { createFixture, TENANT } from "../../packages/document-engine/src/__tests__/_harness.js";

// Execute the actual published-compatible examples, not retyped copies.
describe("relationship creation guide examples", () => {
  for (const lang of ["en", "ar", "site"]) {
    it(`runs the ${lang} JavaScript guide through the SDK and document engine`, async () => {
      const { engine } = createFixture();
      const db = createClient({ projectId: TENANT.projectId, apiKey: "pk_test_relationship_guide", customFetch: (async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        let result: unknown;
        if (url.pathname.endsWith("/documents:referencedBy")) {
          result = await engine.referencedBy({ ...TENANT, request: body as { targetPath: string } });
        } else {
          const path = decodeURIComponent(url.pathname.split("/documents/")[1] ?? "");
          const data = (body["data"] ?? {}) as Record<string, unknown>;
          if (init?.method === "POST") result = await engine.createDocument({ ...TENANT, path, data });
          else if (init?.method === "PATCH") result = await engine.updateDocument({ ...TENANT, path, data });
          else result = await engine.getDocument({ ...TENANT, path, include: JSON.parse(url.searchParams.get("include") ?? "[]") });
        }
        return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
      }) as typeof fetch });
      const file = new URL(lang === "site" ? "../../apps/docs/src/relationship-creation.tsx" : `../../docs/guides/${lang === "ar" ? "ar/" : ""}creating-relationships.md`, import.meta.url);
      const source = readFileSync(file, "utf8").match(lang === "site" ? /const js = `([\s\S]*?)`;/ : /```ts\n([\s\S]*?)```/)?.[1];
      expect(source).toBeTruthy();
      const js = ts.transpile(source!, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
      const execute = new Function("db", "console", `return (async () => { ${js} })();`) as (db: unknown, log: unknown) => Promise<void>;
      const messages: unknown[] = [];
      await execute(db, { log: (...args: unknown[]) => messages.push(args) });
      expect(messages).toHaveLength(lang === "site" ? 1 : 3);
      expect((await engine.getDocument({ ...TENANT, path: "posts/p1" })).data["author"]).toBeNull();
      expect((await engine.getDocument({ ...TENANT, path: "users/u1" })).data["name"]).toBe("Ada");
    });
  }
});
