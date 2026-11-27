import { describe, it, expect } from "vitest";
import {
  buildCollectionPathMatchSql,
  createSqlTransactionHandle,
  SQL_GET_INDEXES,
  SQL_INSERT_INDEX_ENTRIES,
  type PgClientLike,
} from "../tx-context.js";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111" };

describe("buildCollectionPathMatchSql (P1-3)", () => {
  it("emits plain equality for concrete paths", () => {
    const { clause, params } = buildCollectionPathMatchSql("messages", 2);
    expect(clause).toBe("collection_path = $2");
    expect(params).toEqual(["messages"]);
  });

  it("emits segment-wise comparisons for templates, literals bound as params", () => {
    const { clause, params } = buildCollectionPathMatchSql("chats/*/messages", 2);
    expect(clause).toContain("(LENGTH(collection_path) - LENGTH(REPLACE(collection_path, '/', ''))) = 2");
    expect(clause).toContain("split_part(collection_path, '/', 1) = $2");
    expect(clause).toContain("split_part(collection_path, '/', 3) = $3");
    expect(clause).not.toContain("LIKE");
    expect(params).toEqual(["chats", "messages"]);
  });

  it("honours the first parameter index for deeper templates", () => {
    const { clause, params } = buildCollectionPathMatchSql("a/*/b/*/c", 4);
    expect(clause).toContain("= 4"); // 5 segments -> 4 slashes
    expect(clause).toContain("split_part(collection_path, '/', 1) = $4");
    expect(clause).toContain("split_part(collection_path, '/', 3) = $5");
    expect(clause).toContain("split_part(collection_path, '/', 5) = $6");
    expect(params).toEqual(["a", "b", "c"]);
  });
});

describe("write-path index sync with wildcard templates (P1-3)", () => {
  class RecordingClient {
    readonly calls: { text: string; params?: unknown[] }[] = [];
    rowsFor: (text: string) => unknown[] = () => [];
    async query(arg: { text: string; values?: unknown[] } | string, params?: unknown[]) {
      if (typeof arg === "string") {
        this.calls.push({ text: arg, ...(params === undefined ? {} : { params }) });
        return { rows: this.rowsFor(arg) };
      }
      this.calls.push({ text: arg.text, ...(arg.values === undefined ? {} : { params: [...arg.values] }) });
      return { rows: this.rowsFor(arg.text) };
    }
  }

  const now = new Date().toISOString();
  const doc = (path: string, collectionPath: string) => ({
    ...TENANT,
    path,
    collectionPath,
    collectionGroup: collectionPath.split("/").pop()!,
    documentId: path.split("/").pop()!,
    pathDepth: path.split("/").length,
    data: { senderId: "u1", createdAt: 1 },
    sizeBytes: 64,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    expiresAt: null,
  });

  it("template definitions match concrete writes segment-wise; unrelated collections get no entries", async () => {
    const client = new RecordingClient();
    client.rowsFor = (text) =>
      text === SQL_GET_INDEXES
        ? [
            { id: "idx-template", fields: [{ path: "senderId", dir: "asc" }], collectionPath: "chats/*/messages" },
            { id: "idx-rooms", fields: [{ path: "senderId", dir: "asc" }], collectionPath: "rooms/*/messages" },
          ]
        : [];
    const tx = createSqlTransactionHandle(client as unknown as PgClientLike, TENANT, { preparedStatements: false });
    await tx.putDocumentRows([doc("chats/c1/messages/m1", "chats/c1/messages")]);

    const insert = client.calls.find((c) => c.text === SQL_INSERT_INDEX_ENTRIES);
    expect(insert).toBeDefined();
    const indexIds = insert!.params![1] as string[];
    const paths = insert!.params![5] as string[];
    expect(indexIds).toEqual(["idx-template"]);
    expect(paths).toEqual(["chats/c1/messages/m1"]);

    // A rooms write matches only the rooms template.
    const client2 = new RecordingClient();
    client2.rowsFor = client.rowsFor;
    const tx2 = createSqlTransactionHandle(client2 as unknown as PgClientLike, TENANT, { preparedStatements: false });
    await tx2.putDocumentRows([doc("rooms/r1/messages/m1", "rooms/r1/messages")]);
    const insert2 = client2.calls.find((c) => c.text === SQL_INSERT_INDEX_ENTRIES);
    expect((insert2!.params![1] as string[])).toEqual(["idx-rooms"]);
  });
});
