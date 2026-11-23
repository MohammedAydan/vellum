/**
 * Shared helper for real-backend E2E tests that query `data_db` directly.
 *
 * Since `0002_rls_hardening.sql` enables FORCE ROW LEVEL SECURITY, every raw
 * statement against tenant tables must run inside a transaction that first binds
 * the tenant GUC. This helper does exactly that and guarantees ROLLBACK on any
 * error so a failed assertion never leaves a half-applied transaction open.
 *
 * RLS is never disabled and no superuser/bypass role is used to pass tests.
 */
import type { RawPgClient } from "@vellum/database-control";

export async function withTenantData<T>(
  client: RawPgClient,
  projectId: string,
  work: (client: RawPgClient) => Promise<T>
): Promise<T> {
  if (!projectId) {
    throw new Error("withTenantData requires projectId");
  }
  await client.query("BEGIN");
  try {
    // set_config(..., true) is transaction-local: it cannot leak into the next
    // test on the same shared connection.
    await client.query("SELECT set_config('app.current_project_id', $1, true)", [projectId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}
