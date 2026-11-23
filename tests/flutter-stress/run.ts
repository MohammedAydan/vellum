import { spawn } from 'node:child_process';
import { startNodeApiServer } from '../../apps/api/src/node-server.js';

// This harness must never accept an externally hosted database or API.
if (process.env.DATABASE_MODE !== 'postgres') throw new Error('DATABASE_MODE must be postgres');
for (const name of ['CONTROL_DATABASE_URL', 'DATA_DATABASE_URL']) {
  const url = new URL(process.env[name] ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${name} must be loopback`);
  if (!url.pathname.includes('flutter')) throw new Error(`${name} must name a disposable flutter database`);
}
// Prevent inherited runtime/direct/listener URLs from bypassing the guard.
process.env.CONTROL_DATABASE_URL_DIRECT = process.env.CONTROL_DATABASE_URL;
process.env.DATA_DATABASE_URL_DIRECT = process.env.DATA_DATABASE_URL;
process.env.CONTROL_DATABASE_APP_URL = process.env.CONTROL_DATABASE_URL;
process.env.DATA_DATABASE_APP_URL = process.env.DATA_DATABASE_URL;
process.env.DATA_DATABASE_URL_LISTEN = process.env.DATA_DATABASE_URL;
process.env.CONTROL_DATABASE_DRIVER = 'pg';
process.env.DATA_DATABASE_DRIVER = 'pg';
const server = await startNodeApiServer({port: 0, workerIntervalMs: 200});
try {
  const child = spawn(process.env.DART_BIN ?? 'dart', ['test', '--concurrency=1', '--reporter=expanded'], {
    cwd: new URL('.', import.meta.url),
    stdio: 'inherit',
    env: {...process.env, VELLUM_STRESS_ORIGIN: `http://127.0.0.1:${server.port}`},
  });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
} finally {
  await server.stop();
}
