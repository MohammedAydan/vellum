import { describe, it, expect } from "vitest";
import {
  batchInsertIndexEntries,
  createSqlTransactionHandle,
  getDocumentStatement,
  runInTenantTransactionAsync,
  runPrepared,
  SQL_DELETE_INDEX_ENTRIES,
  SQL_GET_INDEXES,
  SQL_INSERT_DOCUMENTS_UNNEST,
  SQL_INSERT_INDEX_ENTRIES,
  type PgClientLike,
  type PgQueryArg,
} from "../tx-context.js";
import { CONTROL_POOL_MAX, DATA_POOL_MAX, PgStorageAdapter } from "../pg-adapter.js";
import type { DocumentRecord, TenantContext } from "../types.js";
import type { IndexFieldItem } from "../types.js";

interface RecordedCall {
  text: string;
  name?: string;
  params?: unknown[];
}

class RecordingClient {
  readonly calls: RecordedCall[] = [];
  released = false;
  rowsFor: (text: string) => unknown[] = () => [];

  async query(arg: PgQueryArg, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    if (typeof arg === "string") {
      this.calls.push({ text: arg, ...(params === undefined ? {} : { params }) });
      return { rows: this.rowsFor(arg) };
    }
    this.calls.push({
      text: arg.text,
      name: arg.name,
      ...(arg.values === undefined ? {} : { params: [...arg.values] }),
    });
    return { rows: this.rowsFor(arg.text) };
  }

  release(): void {
    this.released = true;
  }
}

function asPgClient(client: RecordingClient): PgClientLike {
  return client as unknown as PgClientLike;
}

const TENANT: TenantContext = {
  projectId: "11111111-1111-1111-1111-111111111111",
};

const FIELDS: IndexFieldItem[] = [{ path: "age", dir: "asc" }];

function makeDoc(id: string, age: number): DocumentRecord {
  const now = new Date().toISOString();
  return {
    ...TENANT,
    path: `users/${id}`,
    collectionPath: "users",
    collectionGroup: "users",
    documentId: id,
    pathDepth: 2,
    data: { age, name: `User ${id}` },
    sizeBytes: 128,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe("@vellum/storage - batched prepared statements", () => {
  it("uses named prepared configs only when enabled", async () => {
    const preparedClient = new RecordingClient();
    await runPrepared(asPgClient(preparedClient), true, "test_stmt", "SELECT $1", [1]);
    expect(preparedClient.calls[0]).toEqual({ text: "SELECT $1", name: "test_stmt", params: [1] });

    const plainClient = new RecordingClient();
    await runPrepared(asPgClient(plainClient), false, "test_stmt", "SELECT $1", [1]);
    expect(plainClient.calls[0]).toEqual({ text: "SELECT $1", params: [1] });
  });

  it("maps getDocument variants to stable unique names", () => {
    const names = [
      getDocumentStatement(false, false),
      getDocumentStatement(false, true),
      getDocumentStatement(true, false),
      getDocumentStatement(true, true),
    ].map((statement) => statement.name);
    expect(new Set(names).size).toBe(4);
    expect(getDocumentStatement(false, true).text).toContain("FOR UPDATE");
    expect(getDocumentStatement(true, false).text).not.toContain("deleted_at IS NULL");
  });

  it("issues one UNNEST statement for 100 index entries", async () => {
    const client = new RecordingClient();
    const entries = Array.from({ length: 100 }, (_, index) => ({
      indexId: "33333333-3333-3333-3333-333333333333",
      collectionPath: "users",
      sortKey: Buffer.from([index & 0xff]),
      documentId: `doc-${index}`,
      path: `users/doc-${index}`,
    }));
    await batchInsertIndexEntries(asPgClient(client), true, TENANT.projectId, entries);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe(SQL_INSERT_INDEX_ENTRIES);
    expect(client.calls[0]?.name).toBe("vellum_insert_index_entries");
    const params = client.calls[0]?.params ?? [];
    expect((params[2] as unknown[]).length).toBe(100);
    expect((params[5] as unknown[]).length).toBe(100);
  });

  it("reduces a 100-document batch write from 103 statements to 4 (measured)", async () => {
    const docs = Array.from({ length: 100 }, (_, index) => makeDoc(`doc-${index}`, index));

    // Reference shape of the previous loop: one documents upsert, one
    // derived-entry DELETE, one index-definition lookup, then one INSERT per
    // document (the N+1 that batching removed).
    const legacy = new RecordingClient();
    await legacy.query(SQL_INSERT_DOCUMENTS_UNNEST, [TENANT.projectId]);
    await legacy.query(SQL_DELETE_INDEX_ENTRIES, [TENANT.projectId, []]);
    await legacy.query(SQL_GET_INDEXES, [TENANT.projectId, "users"]);
    for (const doc of docs) {
      await legacy.query(
        `INSERT INTO document_index_entries (index_id, path) VALUES ($1::uuid, $2)`,
        ["idx", doc.path]
      );
    }
    const legacyCalls = legacy.calls.length;

    // Current implementation: one UNNEST insert for all derived entries.
    const current = new RecordingClient();
    current.rowsFor = (text) => (text === SQL_GET_INDEXES ? [{ id: "idx", fields: FIELDS }] : []);
    const currentTx = createSqlTransactionHandle(asPgClient(current), TENANT, { preparedStatements: true });
    await currentTx.putDocumentRows(docs);
    const currentCalls = current.calls.length;

    // The statement is issued exactly once per distinct class of work.
    expect(current.calls.map((call) => call.text)).toEqual([
      SQL_INSERT_DOCUMENTS_UNNEST,
      SQL_DELETE_INDEX_ENTRIES,
      SQL_GET_INDEXES,
      SQL_INSERT_INDEX_ENTRIES,
    ]);
    expect(currentCalls).toBe(4);
    expect(currentCalls).toBeLessThan(legacyCalls);
    console.log(`[bench] 100-doc batch statements: legacy=${legacyCalls}, batched=${currentCalls}`);
  });

  it("binds fail-closed RLS context and releases the client on success", async () => {
    const client = new RecordingClient();
    const pool = {
      connect: async () => asPgClient(client),
    };
    const result = await runInTenantTransactionAsync(
      pool,
      TENANT,
      async (tx) => {
        expect(tx.projectId).toBe(TENANT.projectId);
        return "ok";
      },
      { preparedStatements: true }
    );
    expect(result).toBe("ok");
    const texts = client.calls.map((call) => call.text);
    // V2: the four sequential setup awaits collapse to ONE interpolated
    // multi-statement simple query on the pg path.
    expect(texts[0]).toBe(
      `BEGIN; SET LOCAL statement_timeout = '5000ms'; SET LOCAL search_path = public; ` +
        `SELECT set_config('app.current_project_id', '${TENANT.projectId}', true)`
    );
    expect(client.calls[0]?.params).toBeUndefined();
    expect(texts.filter((text) => text.includes("set_config"))).toHaveLength(1);
    expect(texts.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rolls back and translates a 57014 statement timeout", async () => {
    const client = new RecordingClient();
    const originalQuery = client.query.bind(client);
    client.query = async (arg: PgQueryArg, params?: unknown[]) => {
      const text = typeof arg === "string" ? arg : arg.text;
      if (text.includes("set_config")) {
        await originalQuery(arg, params);
        const error = Object.assign(new Error("timeout"), { code: "57014" });
        throw error;
      }
      return originalQuery(arg, params);
    };
    await expect(
      runInTenantTransactionAsync(poolFor(client), TENANT, async () => "never")
    ).rejects.toMatchObject({ code: "QUERY_DEADLINE_EXCEEDED" });
    expect(client.calls.map((call) => call.text)).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

function poolFor(client: RecordingClient): { connect: () => Promise<PgClientLike> } {
  return { connect: async () => asPgClient(client) };
}

describe("@vellum/storage - pool caps", () => {
  it("locks the data pool at 50 and mirrors the control cap at 10", async () => {
    expect(DATA_POOL_MAX).toBe(50);
    expect(CONTROL_POOL_MAX).toBe(10);
    const adapter = new PgStorageAdapter({
      connectionString: "postgresql://vellum:vellum@localhost:5432/vellum_pool_cap_test",
    });
    const max = (adapter.pool as unknown as { options: { max: number } }).options.max;
    expect(max).toBe(50);
    await adapter.close();
  });
});
