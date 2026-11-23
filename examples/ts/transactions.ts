/**
 * OCC transactions — transfer funds between two accounts atomically.
 *
 * What you'll build: a balance transfer that debits one account and credits
 * another inside a single interactive OCC transaction.
 * Real-world scenario: a payments service reads both balances, stages the two
 * writes, and commits them together. A competing write that changes a read
 * balance before commit forces ABORTED_CONFLICT (409); a stale plain update
 * yields FAILED_PRECONDITION (412). The two are reported with distinct labels.
 */
import { harness, check } from "./_harness.js";

const h = await harness("transactions");
const col = h.prefix;
const fromPath = `${col}/account-a`;
const toPath = `${col}/account-b`;

try {
  h.log("=== OCC Transactions ===");

  await h.sdk.collection(col).doc("account-a").set({ owner: "ada", balance: 100 });
  await h.sdk.collection(col).doc("account-b").set({ owner: "ben", balance: 50 });

  const tx = await h.sdk.runTransaction(async (t) => {
    const from = await t.get<{ owner: string; balance: number }>(fromPath);
    const to = await t.get<{ owner: string; balance: number }>(toPath);
    const fromBefore = from.data().balance;
    const toBefore = to.data().balance;
    const amount = 50;
    t.update(fromPath, { balance: fromBefore - amount });
    t.update(toPath, { balance: toBefore + amount });
    return { amount, fromBefore, toBefore, fromAfter: fromBefore - amount, toAfter: toBefore + amount };
  });
  check(tx.result.fromAfter === 50 && tx.result.toAfter === 100, "transaction staged both balances");
  h.log({
    commit: "ok",
    transfer: tx.result,
    commitResponseKeys: Object.keys(tx.commit as object),
  });

  const fromFinal = await h.sdk.collection(col).doc("account-a").get();
  const toFinal = await h.sdk.collection(col).doc("account-b").get();
  check((fromFinal.data() as { balance: number }).balance === 50, "sender balance is debited");
  check((toFinal.data() as { balance: number }).balance === 100, "receiver balance is credited");
  h.log({
    fromBalance: (fromFinal.data() as { balance: number }).balance,
    toBalance: (toFinal.data() as { balance: number }).balance,
    version: fromFinal.version,
  });

  // Forced conflict: hold a transaction that read version N, mutate the sender
  // outside it, then commit with a stale ifVersion.
  const begin = await h.api.data<{ transactionToken: string }>("POST", "/transactions:begin", {});
  const token = begin.body.transactionToken;
  check(Boolean(token), "transaction token was issued");
  const held = await h.api.data<{ version: number }>(
    "GET",
    `/documents/${fromPath}?transactionToken=${encodeURIComponent(token)}`
  );
  const heldVersion = held.body.version;
  await h.sdk.collection(col).doc("account-a").update({ balance: 51 });
  const conflict = await h.api.data("POST", "/transactions:commit", {
    transactionToken: token,
    writes: [{ type: "update", path: fromPath, data: { balance: 200 }, ifVersion: heldVersion }],
  });
  check(conflict.status === 409, "forced conflict returns HTTP 409");
  const conflictCode = (conflict.body as { error?: { code?: string } })?.error?.code;
  check(conflictCode === "ABORTED_CONFLICT", "forced conflict code is ABORTED_CONFLICT");
  h.log({ scenario: "forced write/write conflict", status: conflict.status, code: conflictCode });

  // Deliberate stale-version precondition on an ordinary update.
  try {
    await h.sdk.collection(col).doc("account-a").update({ balance: 300 }, { ifVersion: 1 });
    throw new Error("stale update should have failed");
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    check(code === "FAILED_PRECONDITION", "stale ifVersion code is FAILED_PRECONDITION");
    h.log({ scenario: "stale-version precondition", code, status: (error as { status?: number }).status });
  }
} finally {
  await h.cleanup();
}
