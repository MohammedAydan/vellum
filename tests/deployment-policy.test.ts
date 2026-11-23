import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('deployment documentation policy', () => {
  it('allows automatic Git deployment at both project roots', () => {
    for (const file of ['vercel.json', 'apps/api/vercel.json']) {
      expect(JSON.parse(readFileSync(file, 'utf8')).git?.deploymentEnabled ?? true).toBe(true);
    }
  });

  it('prints the pause before a non-mutating deployment plan', () => {
    const output = execFileSync(process.execPath, ['scripts/deploy-vercel.mjs'], {
      encoding: 'utf8', env: {},
    });
    expect(output).toContain('Automatic Vercel Git deployments are PAUSED');
    expect(output).toContain('It neither deploys nor re-enables automation.');
    expect(output).toContain('This helper does not deploy.');
  });

  it('retains alternative runtime configs and consolidated operating notes', () => {
    for (const file of [
      'docs/deployment/README.md', 'docs/DEPLOYMENT-SPLIT.md',
      'docs/deployment/cloudflare.md', 'docs/deployment/railway.md',
      'deploy/docker/Dockerfile.api', 'deploy/railway/railway.api.json',
      'deploy/render/render.yaml', 'wrangler.toml',
    ]) expect(existsSync(file), file).toBe(true);
  });
});
