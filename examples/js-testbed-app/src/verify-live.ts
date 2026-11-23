/**
 * CLI runner: bootstraps a fresh tenant, runs all 16 live scenarios in order
 * and prints a PASS/FAIL table with latency. Exits non-zero on any failure.
 *
 * Only status and latency are printed. Errors are redacted so no API key, JWT,
 * refresh token, email or database URL can reach the console.
 */
import { bootstrap, resolveBaseUrl } from "./bootstrap.js";
import { createScenarioContext, runAll } from "./scenarios.js";

async function main(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  console.log("Vellum JS SDK — live verification");
  console.log(`endpoint: ${baseUrl}`);

  const base = await bootstrap(baseUrl);
  console.log(`run id: ${base.runId}   project: ${base.projectId}`);
  console.log("");

  const ctx = createScenarioContext(base);
  const results = await runAll(ctx, (result) => {
    const marker = result.status === "PASS" ? "PASS" : "FAIL";
    console.log(
      `  ${String(result.id).padStart(2)}  ${result.name.padEnd(44)}  ${marker}  ${String(result.latencyMs).padStart(6)} ms`
    );
    if (result.error) console.log(`       ${result.error}`);
  });

  const passed = results.filter((result) => result.status === "PASS").length;
  console.log("");
  console.log(`${passed}/${results.length} scenarios passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bootstrap failed: ${message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt>").replace(/\b(pk|sk)_[A-Za-z0-9_-]+/g, "<api-key>")}`);
  process.exitCode = 1;
});
