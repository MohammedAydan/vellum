// Run in a child process by tx-retry-process.test.ts. With nothing else on the event loop, the retry
// backoff timer is the only thing that can keep the process alive until the transaction commits.
import { createClient } from "../../index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let commits = 0;
const db = createClient({
  projectId: "p",
  apiKey: "key",
  maxRetries: 0,
  customFetch: async (url) => {
    const u = String(url);
    if (u.endsWith("/transactions:begin")) return json({ transactionToken: "t1" });
    if (u.endsWith("/transactions:commit")) {
      commits += 1;
      if (commits <= 2) return json({ error: { code: "ABORTED_CONFLICT", message: "conflict" } }, 409);
      return json({ status: "committed" });
    }
    return json({ status: "rolled_back" });
  },
});
const out = await db.runTransaction(async () => "ok", { maxAttempts: 5 });
console.log(`committed after ${commits} commit attempts: ${String(out.result)}`);
db.dispose();
