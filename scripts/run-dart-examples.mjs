import { verifyDisplayedRulesRequests } from './qa/verify-docs-requests.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// All manifest entries run against a real, caller-provided PostgreSQL API.
// No keys are embedded in source, output, or command arguments.
const root=resolve(import.meta.dirname,'..');
const base=process.env.VELLUM_API_BASE;
const email=process.env.VELLUM_EMAIL;
const password=process.env.VELLUM_PASSWORD;
const projectId=process.env.VELLUM_PROJECT_ID;
if(process.env.CI && process.env.DOCS_EXAMPLE_FILTER)throw new Error('CI must execute all 13 manifest entries');
if(!base||!email||!password||!projectId)throw new Error('Set VELLUM_API_BASE, VELLUM_EMAIL, VELLUM_PASSWORD and VELLUM_PROJECT_ID');
async function request(method,path,body,token){
 const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw new Error(`${method} ${path}: HTTP ${response.status}`);return data;
}
const health=await request('GET','/v1/health');
if(health.planes?.controlDb!=='connected'||health.planes?.dataDb!=='connected')throw new Error('Both PostgreSQL planes must be connected');
const login=await request('POST','/v1/auth/sign-in/email',{email,password});
const keysPath=`/v1/console/projects/${projectId}/api-keys`;
const entries=JSON.parse(readFileSync(resolve(root,'examples/ts/manifest.json'),'utf8'));
if(entries.length!==13||entries.some(e=>!e.dart))throw new Error('Expected all 13 Dart manifest examples');
const analyze=spawnSync('flutter',['analyze','--fatal-infos'],{cwd:resolve(root,'examples/flutter'),stdio:'inherit'});
if(analyze.status!==0)throw new Error('Dart analysis failed');
const docsKey=await request('POST',keysPath,{name:'docs-displayed-requests',keyType:'server'},login.token);
try{await verifyDisplayedRulesRequests(base,projectId,docsKey.rawKey,process.env.DOCS_BASE_URL||'http://127.0.0.1:5175');}
finally{await request('DELETE',`${keysPath}/${docsKey.apiKey.id}`,undefined,login.token);}
let failed=0;
for(const entry of entries.filter(e=>!process.env.DOCS_EXAMPLE_FILTER||process.env.DOCS_EXAMPLE_FILTER.split(",").includes(e.id))){
 const key=await request('POST',keysPath,{name:`dart-manifest:${entry.id}`,keyType:'server'},login.token);
 try{
  // Examples accept runtime environment values and retain --define compatibility.
  // The examples import the app entry point (package:vellum_flutter/vellum_flutter.dart). On the plain Dart
  // VM (no dart:ui) they run against the same SDK through its core entry point.
  const runDir=resolve(root,'examples/flutter/.dart_tool/vm-run');mkdirSync(runDir,{recursive:true});
  const runFile=resolve(runDir,entry.dart.split('/').pop());
  writeFileSync(runFile,readFileSync(resolve(root,'examples',entry.dart),'utf8').replaceAll('package:vellum_flutter/vellum_flutter.dart','package:vellum_flutter/vellum_flutter_core.dart'));
  const run=spawnSync('dart',['--packages='+resolve(root,'examples/flutter/.dart_tool/package_config.json'),runFile],{cwd:resolve(root,'examples/flutter'),env:{...process.env,VELLUM_API_KEY:key.rawKey},encoding:'utf8',timeout:120000});
  const output=`${run.stdout||''}${run.stderr||''}`;
  const safe=output.replaceAll(key.rawKey,'[redacted]').replaceAll(password,'[redacted]').replaceAll(login.token,'[redacted]');
  console.log(`${run.status===0?'PASS':'FAIL'} ${entry.id}\n${safe}`);
  if(run.status!==0||run.error)failed++;
 } finally {
  // Also revoke any still-active key created by the auth example on an error path.
  const keys=await request('GET',keysPath,undefined,login.token);
  for(const existing of keys)if(!existing.revokedAt&&(existing.id===key.apiKey.id||existing.name==='examples:flutter-auth:ephemeral'))await request('DELETE',`${keysPath}/${existing.id}`,undefined,login.token);
 }
}
console.log(`Dart manifest failures: ${failed}; selected: ${process.env.DOCS_EXAMPLE_FILTER || "all 13"}`);
if(failed)process.exitCode=1;
