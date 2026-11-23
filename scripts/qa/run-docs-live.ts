import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startNodeApiServer } from '../../apps/api/src/node-server.js';

// Caller runs migrations against disposable real PostgreSQL databases first.
if(process.env.DATABASE_MODE!=='postgres')throw new Error('DATABASE_MODE=postgres required');
const server=await startNodeApiServer({port:0});
const base=`http://127.0.0.1:${server.port}`;
const password=randomBytes(32).toString('hex');
const email=`docs-${randomBytes(6).toString('hex')}@example.invalid`;
async function json(path:string,body:unknown){
 const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r.json();
}
async function command(exe:string,args:string[],env:NodeJS.ProcessEnv){
 await new Promise<void>((resolve,reject)=>{const p=spawn(exe,args,{env,stdio:'inherit'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`${exe} exited ${code}`)));});
}
try {
 const health=await (await fetch(base+'/v1/health')).json();
 if(health.planes?.controlDb!=='connected'||health.planes?.dataDb!=='connected')throw new Error('PostgreSQL planes not connected');
 const user=await json('/v1/auth/sign-up/email',{name:'Docs examples',email,password});
 const env={...process.env,VELLUM_API_BASE:base,VELLUM_EMAIL:email,VELLUM_PASSWORD:password,VELLUM_PROJECT_ID:user.project.id};
 if(process.argv.includes('--requests-only')) {
   const { verifyDisplayedRulesRequests } = await import('./verify-docs-requests.mjs');
   const keyResponse=await fetch(`${base}/v1/console/projects/${user.project.id}/api-keys`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${user.token}`},body:JSON.stringify({name:'docs-requests',keyType:'server'})});
   if(!keyResponse.ok)throw new Error('Create docs request key failed');
   const key=await keyResponse.json();
   try{await verifyDisplayedRulesRequests(base,user.project.id,key.rawKey);}
   finally{await fetch(`${base}/v1/console/projects/${user.project.id}/api-keys/${key.apiKey.id}`,{method:'DELETE',headers:{authorization:`Bearer ${user.token}`}});}
 }else await command('node',['scripts/run-dart-examples.mjs'],env);
} finally {await server.stop();}
