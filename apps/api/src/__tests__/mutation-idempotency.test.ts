import { afterEach, describe, expect, it } from 'vitest';
import { createVellumPlatform } from '../index.js';

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => { for (const p of platforms.splice(0)) p.metering.stop(); });
async function fixture() {
  const p = createVellumPlatform(); platforms.push(p);
  const org = await p.controlStore.createOrganization({name: 'Replay', slug: `replay-${Date.now()}-${Math.floor(Math.random()*1000000)}`, planId: 'pro', billingEmail: 'test@example.test'});
  const {project} = await p.controlStore.createProject({organizationId: org.id, name: 'Replay', slug: 'replay'});
  const r = await p.fetch(new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name:'secret',keyType:'secret'})}));
  const {rawKey} = await r.json();
  const send = (method: string, path: string, body?: unknown, key = 'same-key') => p.fetch(new Request(`http://localhost/v1/projects/${project.id}${path}`, {method, headers: {'content-type':'application/json','x-project-key':rawKey,'Idempotency-Key':key}, ...(body === undefined ? {} : {body:JSON.stringify(body)})}));
  return {send};
}
describe('HTTP mutation idempotency', () => {
  it('replays creates and scopes keys to path and payload', async () => {
    const {send} = await fixture();
    const first = await send('POST','/documents/items/one',{data:{n:1}});
    expect(first.status).toBe(201); const initial = await first.json();
    const replay = await send('POST','/documents/items/one',{data:{n:1}});
    expect(replay.status).toBe(201); expect(await replay.json()).toEqual(initial);
    expect((await send('POST','/documents/items/two',{data:{n:1}})).status).toBe(201);
    expect((await send('POST','/documents/items/one',{data:{n:2}})).status).toBe(409);
  });
  it('increment PATCH, batch aliases and DELETE replay once', async () => {
    const {send} = await fixture();
    await send('PUT','/documents/items/one',{data:{n:0}});
    const body = {data:{n:{$op:'inc',by:1}}};
    const first = await send('PATCH','/documents/items/one',body); const expected = await first.json();
    expect((await send('PATCH','/documents/items/one',body)).status).toBe(200);
    expect(await (await send('PATCH','/documents/items/one',body)).json()).toEqual(expected);
    for (const route of ['/batchWrite','/documents:batchWrite']) {
      const payload = {writes:[{type:'update',path:'items/one',data:{n:{$op:'inc',by:1}}}]};
      const a = await send('POST',route,payload); const b = await send('POST',route,payload);
      expect(a.status).toBe(200); expect(await b.json()).toEqual(await a.json());
    }
    const del = await send('DELETE','/documents/items/one');
    expect(del.status).toBe(200); expect(await (await send('DELETE','/documents/items/one')).json()).toEqual(await del.json());
  });
  it('rejects oversized idempotency headers', async () => {
    const {send} = await fixture();
    expect((await send('POST','/documents/items/one',{data:{n:1}},'x'.repeat(257))).status).toBe(400);
  });
});
