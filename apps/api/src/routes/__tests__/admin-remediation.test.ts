import { describe, it, expect, afterAll } from 'vitest';
import { createVellumPlatform } from '../../platform.js';
import { readTenantSecurity } from '../admin-metadata.js';
import { adminRuntimeTelemetry } from '../../admin-runtime-telemetry.js';
import { PgControlPlaneStore } from '@vellum/database-control/adapters';

// Runs in ordinary CI in memory, and against migrated PostgreSQL in the admin
// regression job. The same assertions prevent a mocked-only acceptance gate.
const postgres = process.env['ADMIN_PG_REAL'] === '1';
const store = postgres ? new PgControlPlaneStore({connectionString:process.env['CONTROL_DATABASE_URL']!}) : null;
let platform: ReturnType<typeof createVellumPlatform>;
let orgId = '';
let projectId = '';
let operatorId = '';
const exportAction = `regression.export.${Date.now()}`;
afterAll(async()=>{ await store?.close(); });

describe.sequential('admin truthfulness and metadata-only export',()=>{
  it('initializes an isolated tenant with no fabricated rules or keys',async()=>{
    await store?.initialize();
    platform=createVellumPlatform(store ? {controlStore:store} : {});
    const operator=await platform.controlStore.createUser({email:`admin-${Date.now()}@example.invalid`,name:'Regression operator',platformRole:'owner'});
    await platform.controlStore.setPlatformSuperAdmin(operator.id,true);operatorId=operator.id;
    const org=await platform.controlStore.createOrganization({slug:`adm-${Date.now()}`,name:'Admin regression',billingEmail:'qa@example.invalid'});
    const project=await platform.controlStore.createProject({organizationId:org.id,slug:'empty-project',name:'Empty project'});
    orgId=org.id;projectId=project.project.id;
    const result=await readTenantSecurity(platform.controlStore,[projectId]);
    expect(result.projects).toEqual([expect.objectContaining({id:projectId,publishableKeys:0,secretKeys:0,rulesetVersion:null,rulesPublishedAt:null})]);
  }, 60000);
  it('reflects persisted publish/revoke changes and never exposes key hashes or AST',async()=>{
    const key=await platform.controlStore.registerApiKey({projectId,name:'metadata test',keyType:'public',keyPrefix:`pk_${Date.now()}`,secretHash:'NEVER_EXPOSE_THIS_HASH'});
    await platform.controlStore.publishSecurityRuleset({projectId,rulesAst:{rules:[]}});
    let result=await readTenantSecurity(platform.controlStore,[projectId]);
    expect(result.projects[0]).toMatchObject({publishableKeys:1,secretKeys:0,rulesetVersion:1});
    expect(JSON.stringify(result)).not.toContain('NEVER_EXPOSE_THIS_HASH');
    expect(JSON.stringify(result)).not.toContain('rulesAst');
    await platform.controlStore.revokeApiKey(key.id);
    result=await readTenantSecurity(platform.controlStore,[projectId]);
    expect(result.projects[0]).toMatchObject({publishableKeys:0});
    expect((await readTenantSecurity(platform.controlStore,[])).projects).toEqual([]);
  }, 60000);
  it('requires operator auth and enforces project-scoped metadata',async()=>{
    expect((await platform.app.request(`/v1/admin/tenants/${orgId}/security-metadata`)).status).toBe(401);
    const token=platform.superAdminSessionService.signAccess({sub:operatorId,uid:operatorId,role:'support_readonly',orgIds:[]});
    const res=await platform.app.request(`/v1/admin/tenants/${orgId}/security-metadata`,{headers:{authorization:`Bearer ${token}`}});
    expect(res.status).toBe(200);expect((await res.json()).projects).toHaveLength(1);
  }, 60000);
  it('exports all pages with explicit scope and honest integrity, including read-only operators',async()=>{
    for(let i=0;i<52;i++)await platform.controlStore.recordAuditLog({actorType:'system',action:exportAction,organizationId:orgId,targetId:`target-${i}`,metadata:{beforeData:{private:'NEVER_EXPORT'},secretHash:'NEVER_EXPORT'}});
    const token=platform.superAdminSessionService.signAccess({sub:operatorId,uid:operatorId,role:'support_readonly',orgIds:[]});
    const res=await platform.app.request(`/v1/admin/audit-export?q=${exportAction}&actor=system`,{headers:{authorization:`Bearer ${token}`}});
    expect(res.status).toBe(200);const body=await res.json();
    expect(body.count).toBe(52);expect(body.scope.source).toBe('audit_logs');expect(body.scope.to).toBeTruthy();
    expect(body.integrity.status).toBe('not_available');expect(JSON.stringify(body)).not.toContain('NEVER_EXPORT');
    expect((await platform.app.request('/v1/admin/audit-export')).status).toBe(401);
    expect((await platform.app.request('/v1/admin/audit-export?from=bad',{headers:{authorization:`Bearer ${token}`}})).status).toBe(400);
  }, 60000);
  it('returns process-observed configuration rather than invented telemetry',async()=>{
    adminRuntimeTelemetry.maintenanceIntervalMs=12345;
    const token=platform.superAdminSessionService.signAccess({sub:operatorId,uid:operatorId,role:'owner',orgIds:[]});
    const response=await platform.app.request('/v1/admin/overview',{headers:{authorization:`Bearer ${token}`}});
    expect((await response.json()).telemetry.runtime.maintenanceIntervalMs).toBe(12345);
    adminRuntimeTelemetry.maintenanceIntervalMs=null;
  }, 60000);
});
