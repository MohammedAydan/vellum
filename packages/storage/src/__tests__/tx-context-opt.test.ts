import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import {
  SQL_BATCH_GET_DOCUMENTS,
  SQL_INSERT_DOCUMENTS_UNNEST,
  SQL_LIST_ACTIVE_DOCUMENTS,
  SQL_SET_TENANT_CONTEXT_PARAMETERIZED,
  buildPgTenantSetupSql,
  createSqlTransactionHandle,
  getDocumentStatement,
  runInTenantTransactionAsync,
  type PgClientLike,
  type PgQueryArg,
} from "../tx-context.js";
import type { DocumentRecord, TenantContext } from "../types.js";

interface RecordedCall {
  text: string;
  name?: string;
  params?: unknown[];
}

class RecordingClient {
  readonly calls: RecordedCall[] = [];
  released = false;
  rowsFor: (text: string, params?: unknown[]) => unknown[] = () => [];

  async query(arg: PgQueryArg, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    if (typeof arg === "string") {
      this.calls.push({ text: arg, ...(params === undefined ? {} : { params }) });
      return { rows: this.rowsFor(arg, params) };
    }
    this.calls.push({
      text: arg.text,
      name: arg.name,
      ...(arg.values === undefined ? {} : { params: [...arg.values] }),
    });
    return { rows: this.rowsFor(arg.text, arg.values ? [...arg.values] : undefined) };
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

function doc(path: string): DocumentRecord {
  const now = new Date().toISOString();
  return {
    ...TENANT,
    path,
    collectionPath: "users",
    collectionGroup: "users",
    documentId: path.split("/").at(-1) ?? path,
    pathDepth: 2,
    data: { name: path },
    sizeBytes: 64,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe("@vellum/storage V2 - batchGetDocuments (zero N+1)", () => {
  it("emits one ANY($2) statement for 20 paths and restores requested order", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `users/u_${String(i).padStart(2, "0")}`);
    expect(SQL_BATCH_GET_DOCUMENTS).toContain("path = ANY(");
    expect(SQL_BATCH_GET_DOCUMENTS).toContain("expires_at > now()");
    expect(SQL_BATCH_GET_DOCUMENTS).toContain("deleted_at IS NULL");

    const client = new RecordingClient();
    // Return rows in reverse order to prove the JS-side reorder works.
    client.rowsFor = () => [...paths].reverse().map(doc);
    const tx = createSqlTransactionHandle(asPgClient(client), TENANT, { preparedStatements: false });
    const result = await tx.batchGetDocuments!(paths);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe(SQL_BATCH_GET_DOCUMENTS);
    expect((client.calls[0]?.params?.[1] as string[]).length).toBe(20);
    expect(result.map((row) => row.path)).toEqual(paths);
  });

  it("deduplicates paths and short-circuits an empty request without any query", async () => {
    const client = new RecordingClient();
    const tx = createSqlTransactionHandle(asPgClient(client), TENANT, { preparedStatements: true });
    expect(await tx.batchGetDocuments!([])).toEqual([]);
    expect(client.calls).toHaveLength(0);

    await tx.batchGetDocuments!(["users/a", "users/a", "users/b"]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.name).toBe("vellum_batch_get_documents");
    expect(client.calls[0]?.params?.[1]).toEqual(["users/a", "users/b"]);
  });
});

describe("@vellum/storage V2 - tenant setup round-trip compression", () => {
  it("pg path uses ONE interpolated multi-statement query", async () => {
    const client = new RecordingClient();
    await runInTenantTransactionAsync(
      { connect: async () => asPgClient(client) },
      TENANT,
      async () => "ok",
      { preparedStatements: true }
    );
    expect(client.calls).toHaveLength(2); // setup + COMMIT
    expect(client.calls[0]?.text).toBe(buildPgTenantSetupSql(TENANT.projectId));
    expect(client.calls[0]?.params).toBeUndefined();
    expect(client.calls[1]?.text).toBe("COMMIT");
  });

  it("Neon/parameterized path uses at most two setup round trips", async () => {
    const client = new RecordingClient();
    await runInTenantTransactionAsync({ connect: async () => asPgClient(client) }, TENANT, async () => "ok");
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      SQL_SET_TENANT_CONTEXT_PARAMETERIZED,
      "COMMIT",
    ]);
    expect(client.calls[1]?.params).toEqual([TENANT.projectId]);
    expect(SQL_SET_TENANT_CONTEXT_PARAMETERIZED).toContain("set_config('statement_timeout', '5000ms', true)");
  });

  it("rejects non-UUID tenant ids before any interpolation or connection", async () => {
    const bad = { projectId: "x'; DROP TABLE documents; --" };
    expect(() => buildPgTenantSetupSql(bad.projectId)).toThrowError(VellumError);
    let connected = false;
    await expect(
      runInTenantTransactionAsync(
        {
          connect: async () => {
            connected = true;
            return asPgClient(new RecordingClient());
          },
        },
        bad,
        async () => "never",
        { preparedStatements: true }
      )
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(connected).toBe(false);
  });
});

describe("@vellum/storage V2 - TTL SQL surface", () => {
  it("filters expired and soft-deleted rows on live reads only", () => {
    const live = getDocumentStatement(false, false).text;
    const all = getDocumentStatement(true, false).text;
    expect(live).toContain("expires_at > now()");
    expect(live).toContain('expires_at::text AS "expiresAt"');
    expect(all).not.toContain("deleted_at IS NULL");
    expect(all).not.toContain("expires_at > now()");
    expect(SQL_LIST_ACTIVE_DOCUMENTS).toContain("expires_at > now()");
  });

  it("inserts expires_at as the 12th UNNEST array and persists it on conflict", () => {
    expect(SQL_INSERT_DOCUMENTS_UNNEST).toContain("$13::text[]");
    expect(SQL_INSERT_DOCUMENTS_UNNEST).toContain("u.expires_at::timestamptz");
    expect(SQL_INSERT_DOCUMENTS_UNNEST).toContain("expires_at = EXCLUDED.expires_at");
  });
});

describe('idempotent mutation serialization', () => {
  it('locks a tenant-scoped key before reading an absent replay row', async () => {
    const client = new RecordingClient();
    const tx = createSqlTransactionHandle(asPgClient(client), TENANT);
    expect(await tx.getIdempotencyResult?.('first-use-key')).toBeNull();
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.text).toContain('pg_advisory_xact_lock');
    expect(client.calls[0]?.params).toEqual([JSON.stringify([TENANT.projectId, 'first-use-key'])]);
    expect(client.calls[1]?.text).toContain('FROM batch_idempotency_keys');
  });
});
