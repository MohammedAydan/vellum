/**
 * OCC transactions (REST) — transfer funds between two accounts atomically.
 *
 * What you'll build: a balance transfer staged inside /transactions:begin and
 * committed with /transactions:commit, plus a forced write/write conflict and a
 * stale-version precondition.
 * Real-world scenario: a payments service debits one account and credits
 * another in one transaction; a competing write before commit aborts it.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("transactions");
const col = h.prefix;
const fromPath = `${col}/account-a`;
const toPath = `${col}/account-b`;

try {
  h.log("=== OCC Transactions ===");
  check((await h.api.data("POST", `/documents/${fromPath}`, { data: { owner: "ada", balance: 100 } })).status === 201, "seed sender");
  check((await h.api.data("POST", `/documents/${toPath}`, { data: { owner: "ben", balance: 50 } })).status === 201, "seed receiver");

  // --- Happy path: read both balances, stage two writes, commit together. ----
  const begin = await h.api.data("POST", "/transactions:begin", {});
  const token = begin.body.transactionToken;
  check(Boolean(token), "transaction token issued");
  const from = await h.api.data("GET", `/documents/${fromPath}?transactionToken=${encodeURIComponent(token)}`);
  const to = await h.api.data("GET", `/documents/${toPath}?transactionToken=${encodeURIComponent(token)}`);
  const fromBefore = from.body.data.balance;
  const toBefore = to.body.data.balance;
  const amount = 50;
  const transfer = { amount, fromBefore, toBefore, fromAfter: fromBefore - amount, toAfter: toBefore + amount };
  const commit = await h.api.data("POST", "/transactions:commit", {
    transactionToken: token,
    writes: [
      { type: "update", path: fromPath, data: { balance: transfer.fromAfter } },
      { type: "update", path: toPath, data: { balance: transfer.toAfter } },
    ],
  });
  check(commit.ok, "transaction committed");
  h.log({ commit: "ok", transfer, commitResponseKeys: Object.keys(commit.body) });

  const fromFinal = await h.api.data("GET", `/documents/${fromPath}`);
  const toFinal = await h.api.data("GET", `/documents/${toPath}`);
  check(fromFinal.body.data.balance === 50, "sender debited");
  check(toFinal.body.data.balance === 100, "receiver credited");
  h.log({
    fromBalance: fromFinal.body.data.balance,
    toBalance: toFinal.body.data.balance,
    version: fromFinal.body.version,
  });

  // --- Forced conflict: mutate a read doc before commit. --------------------
  const begin2 = await h.api.data("POST", "/transactions:begin", {});
  const token2 = begin2.body.transactionToken;
  const held = await h.api.data("GET", `/documents/${fromPath}?transactionToken=${encodeURIComponent(token2)}`);
  const heldVersion = held.body.version;
  const outside = await h.api.data("PATCH", `/documents/${fromPath}`, { data: { balance: 51 } });
  check(outside.ok, "outside write applied");
  const conflict = await h.api.data("POST", "/transactions:commit", {
    transactionToken: token2,
    writes: [{ type: "update", path: fromPath, data: { balance: 200 }, ifVersion: heldVersion }],
  });
  check(conflict.status === 409, "forced conflict returns HTTP 409");
  check(conflict.body?.error?.code === "ABORTED_CONFLICT", "conflict code is ABORTED_CONFLICT");
  h.log({ scenario: "forced write/write conflict", status: conflict.status, code: conflict.body.error.code });

  // --- Stale-version precondition on an ordinary PATCH. ---------------------
  const stale = await h.api.data("PATCH", `/documents/${fromPath}`, { data: { balance: 300 }, ifVersion: 1 });
  check(stale.status === 412 && stale.body?.error?.code === "FAILED_PRECONDITION", "stale patch rejected");
  h.log({ scenario: "stale-version precondition", code: stale.body.error.code, status: stale.status });
} finally {
  await h.cleanup();
}
