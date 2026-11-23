import type { ControlPlaneRepository } from '@vellum/database-control';
import { getQueryPool } from './usage.js';

/** Only project-scoped aggregate metadata. Never serialize keys or rule ASTs. */
export async function readTenantSecurity(store: ControlPlaneRepository, projectIds: string[]) {
  const observedAt = new Date().toISOString();
  const pool = getQueryPool(store);
  if (pool) {
    const result = await pool.query(`SELECT p.id,
      (SELECT count(*)::int FROM api_keys k WHERE k.project_id=p.id AND k.key_type='public' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())) AS "publishableKeys",
      (SELECT count(*)::int FROM api_keys k WHERE k.project_id=p.id AND k.key_type='server' AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())) AS "secretKeys",
      (SELECT max(version) FROM security_rulesets r WHERE r.project_id=p.id AND r.is_active) AS "rulesetVersion",
      (SELECT max(created_at) FROM security_rulesets r WHERE r.project_id=p.id AND r.is_active) AS "rulesPublishedAt"
      FROM projects p WHERE p.id=ANY($1::uuid[])`, [projectIds]);
    return { observedAt, source: 'PostgreSQL aggregate query', projects: result.rows };
  }
  return { observedAt, source: 'in-memory repository', projects: projectIds.map(id => {
    const keys = [...store.apiKeysById.values()].filter(k=>k.projectId===id && !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt)>Date.now()));
    const rule=store.getActiveRuleset(id);
    return {id,publishableKeys:keys.filter(k=>k.keyType==='public').length,secretKeys:keys.filter(k=>k.keyType==='server').length,rulesetVersion:rule?.version??null,rulesPublishedAt:rule?.createdAt??null};
  }) };
}
